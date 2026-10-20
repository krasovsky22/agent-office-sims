/**
 * Agent runner boot.
 *
 * The runner is the process that owns coding agents, kept out of the game
 * server because the game server is public: it reads its configuration,
 * takes back the worktrees its last run left, makes its slots, and syncs with
 * the server until it is told to stop. The
 * server learns of it only through those syncs, so a runner that dies
 * without a word leaves the floor once the server's timeout passes. Beside
 * the syncs, it posts its slots' terminal screens a few times a second, with
 * every secret it holds masked out of them.
 *
 * A real agent works as the runner's GitHub App, which its configuration
 * requires unless the operator chose a person's own login instead: the runner
 * mints the App's tokens and keeps them fresh (`./githubApp.ts`), or hands on
 * the person's (`./githubPersonal.ts`), and checks each issue's label and
 * finds each task's pull request with them (`./github.ts`). The same identity
 * closes and reopens issues the CEO drags across the office's board
 * (`./issueStates.ts`), since the game server never writes to GitHub.
 *
 * What the agents spend is booked against `RUNNER_DAILY_BUDGET_USD`, which
 * refuses new starts once it is spent (`./budget.ts`).
 *
 * Beside the slots' issue work, the runner keeps its standing tasks
 * (`./standing/`): recurring jobs the CEO set up, such as watching for new
 * pull requests, each run a fresh, short, capped agent run on a free slot. A
 * real agent's runner takes them only once `RUNNER_STANDING_DAILY_BUDGET_USD`
 * is set.
 *
 * A slot holding nothing can also be lent to a desk in the office, where the
 * CEO sitting there prompts a fresh session of its agent directly; its
 * worktree is a scratch one, discarded as the session ends
 * (`./deskWorktrees.ts`).
 *
 * A misconfigured runner exits at once with the reason; see `./config.ts`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { STANDING_OFF, formatUsd, retiredAgentIssueLabelNotice } from "@sim/shared";

import { claudeAdapter } from "./agents/claude.js";
import { HookServer } from "./agents/hookServer.js";
import { createMockAgent } from "./agents/mock.js";
import { killLiveGroups } from "./agents/processGroups.js";
import { createPtyAgent, findOnPath } from "./agents/ptyAgent.js";
import type { Agent } from "./agents/types.js";
import { SpendLedger } from "./budget.js";
import { type RunnerConfig, readConfig } from "./config.js";
import { deskWorktrees } from "./deskWorktrees.js";
import { NO_GITHUB, type TaskGithub, createTaskGithub, runCommand } from "./github.js";
import { GITHUB_TOKEN_ENV, GithubAppCredentials, type GithubCredentials } from "./githubApp.js";
import { PersonalGithubCredentials } from "./githubPersonal.js";
import { SlotIdStore } from "./slotIds.js";
import { ProfileStore } from "./profiles.js";
import { IssueStateDesk, ghIssueState } from "./issueStates.js";
import { createRedactor, runnerSecrets } from "./redact.js";
import { ScreenLoop } from "./screenLoop.js";
import { createScreensClient } from "./screensClient.js";
import { createShutdown } from "./shutdown.js";
import { SlotWorktrees } from "./slotWorktrees.js";
import { SlotPool } from "./slots.js";
import { createClaudeStandingRunners } from "./standing/claude.js";
import { createMockStandingRunners } from "./standing/mock.js";
import { githubPullSource } from "./standing/pulls.js";
import { createReviewGithub } from "./standing/review.js";
import { StandingScheduler } from "./standing/scheduler.js";
import { StandingStore } from "./standing/store.js";
import type { StandingRunners } from "./standing/types.js";
import { createSyncClient } from "./syncClient.js";
import { SyncLoop } from "./syncLoop.js";
import { Worktrees, ghClone } from "./worktrees.js";

/* eslint-disable no-console -- the runner's log is its console, read by its operator */
function log(line: string): void {
  console.log(`[runner] ${line}`);
}

let config: RunnerConfig;
try {
  config = readConfig();
} catch (error) {
  console.error(`[runner] refusing to start: ${(error as Error).message}`);
  process.exit(1);
}
/* eslint-enable no-console */

/** Every step an agent reports: only with `RUNNER_LOG_LEVEL=debug`. */
const debug = config.logLevel === "debug" ? (line: string) => log(`debug: ${line}`) : () => undefined;

/** Longest a shutdown waits for its agents to exit and worktrees being made or removed to finish. */
const SHUTDOWN_GRACE_MS = 10_000;

// Private to the runner's user: its clone and its tasks' worktrees live here.
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

const worktrees = new Worktrees({
  repoDir: join(config.dataDir, "repo"),
  worktreesDir: join(config.dataDir, "worktrees"),
  ceilingDir: config.dataDir,
  clone: ghClone(config.repo),
  log,
});
const workspaces = new SlotWorktrees({ worktrees, stateFile: join(config.dataDir, "worktrees.json"), log });
const desks = deskWorktrees({ worktrees, root: join(config.dataDir, "desks"), log });

const redactor = createRedactor(runnerSecrets(process.env, [config.secret]));

const ghConfigDir = join(config.dataDir, "gh");

// A token from `gh auth token` is a secret the runner's environment does not name: masked like the App's.
if (config.personalGithub !== undefined) {
  redactor.add(config.personalGithub.token);
}

const personalCredentials =
  config.personalGithub === undefined ? undefined : new PersonalGithubCredentials({ personal: config.personalGithub, configDir: ghConfigDir });

const credentials: GithubCredentials | undefined =
  config.githubApp === undefined
    ? personalCredentials
    : new GithubAppCredentials({
        app: config.githubApp,
        repo: config.repo,
        configDir: ghConfigDir,
        // Its tokens are secrets the runner did not start with: masked as they are minted.
        onToken: (token) => redactor.add(token),
        log,
      });

/** The environment for the runner's own `gh` and `git` calls: as the agents' identity, with a fresh token. */
async function githubEnv(app: GithubCredentials): Promise<NodeJS.ProcessEnv> {
  const base: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  await app.fresh();
  for (const name of GITHUB_TOKEN_ENV) {
    delete base[name];
  }
  return { ...base, ...app.env() };
}

async function createAgent(runnerConfig: RunnerConfig): Promise<{ agent: Agent; github: TaskGithub }> {
  switch (runnerConfig.agent) {
    case "mock":
      // It never touches GitHub: its pull request is simulated, and it spends nothing on an unlabelled issue.
      return { agent: createMockAgent({ outcome: runnerConfig.mockOutcome }), github: NO_GITHUB };
    case "claude": {
      // readConfig refuses a claude agent with no GitHub identity; this only narrows the type.
      const app = credentials;
      if (app === undefined) {
        throw new Error("a claude agent needs a GitHub identity: the runner's GitHub App or RUNNER_GITHUB_AUTH=personal");
      }
      const agent = createPtyAgent({
        adapter: claudeAdapter({
          repo: runnerConfig.repo,
          permissions: runnerConfig.agentPermissions,
          ...(runnerConfig.model === undefined ? {} : { model: runnerConfig.model }),
        }),
        dataDir: runnerConfig.dataDir,
        hooks: await HookServer.start(),
        github: { env: app.env(), scrub: GITHUB_TOKEN_ENV },
      });
      return { agent, github: createTaskGithub({ repo: runnerConfig.repo, label: runnerConfig.restrictLabel, env: () => githubEnv(app) }) };
    }
  }
}

/** Who the agents are on GitHub, for the boot log; a person's login comes with what that means. */
function githubIdentity(): string {
  if (config.personalGithub === undefined) {
    return `GitHub App ${config.githubApp?.appId ?? ""}`;
  }
  const login = personalCredentials?.login;
  return (
    `${login === undefined ? "a personal GitHub login" : `the personal GitHub login of ${login}`} (token from ${config.personalGithub.source}), ` +
    "not an App: they act with that account's full access, on every repository and organisation it can reach"
  );
}

let agent: Agent;
let github: TaskGithub;
try {
  // A first token now, so an identity GitHub will not answer for stops the runner at boot.
  await credentials?.fresh();
  ({ agent, github } = await createAgent(config));
} catch (error) {
  // eslint-disable-next-line no-console -- the runner's log is its console, read by its operator
  console.error(`[runner] refusing to start: ${(error as Error).message}`);
  process.exit(1);
}

/** How the standing tasks' runs are done: the mock's script, or Claude Code, headless. */
function createStandingRunners(runnerConfig: RunnerConfig): StandingRunners {
  if (runnerConfig.agent === "mock" || credentials === undefined) {
    return createMockStandingRunners();
  }
  const app = credentials;
  const command = findOnPath("claude");
  if (command === undefined) {
    throw new Error("claude is not on PATH; install it or put it there");
  }
  return createClaudeStandingRunners({
    command,
    dataDir: runnerConfig.dataDir,
    model: runnerConfig.model,
    permissions: runnerConfig.agentPermissions,
    worktrees,
    github: createReviewGithub({
      repo: runnerConfig.repo,
      author: () => (runnerConfig.githubApp === undefined ? { login: personalCredentials?.login } : { appId: runnerConfig.githubApp.appId }),
      env: () => githubEnv(app),
      run: runCommand,
    }),
    identity: { env: app.env(), scrub: GITHUB_TOKEN_ENV },
    log,
  });
}

// One set of books for issue work and standing tasks alike.
const ledger = new SpendLedger({ budgetUsd: config.dailyBudgetUsd });
const pool = new SlotPool({
  count: config.maxAgents,
  agent,
  runnerId: config.runnerId,
  profiles: new ProfileStore({ file: join(config.dataDir, "profiles.json"), log }),
  fired: new SlotIdStore({ file: join(config.dataDir, "fired.json"), list: "fired", log }),
  hired: new SlotIdStore({ file: join(config.dataDir, "hired.json"), list: "hired", log }),
  workspaces,
  desks,
  taskTimeoutMs: config.taskTimeoutMs,
  github,
  redactor,
  ledger,
  log,
  debug,
});
let standing: StandingScheduler;
try {
  standing = new StandingScheduler({
    store: new StandingStore({ file: join(config.dataDir, "standing.json"), log }),
    pool,
    runners: createStandingRunners(config),
    // The agents' identity for a real runner; the mock asks anonymously.
    pulls: githubPullSource({
      repo: config.repo,
      ...(credentials === undefined || config.agent === "mock"
        ? {}
        : {
            token: async () => {
              await credentials.fresh();
              return credentials.token();
            },
          }),
    }),
    ledger,
    budgetUsd: config.standingDailyBudgetUsd,
    off: config.agent !== "mock" && config.standingDailyBudgetUsd === undefined ? STANDING_OFF.noBudget : undefined,
    maxConcurrent: config.standingMaxConcurrent,
    redactor,
    log,
    debug,
  });
} catch (error) {
  // eslint-disable-next-line no-console -- the runner's log is its console, read by its operator
  console.error(`[runner] refusing to start: ${(error as Error).message}`);
  process.exit(1);
}
// A real agent's identity closes and reopens issues for the CEO; the mock never touches GitHub.
const issueDesk =
  config.agent === "mock" || credentials === undefined
    ? undefined
    : new IssueStateDesk({ set: ghIssueState({ repo: config.repo, env: () => githubEnv(credentials) }), log });
const loop = new SyncLoop({
  runnerId: config.runnerId,
  repo: config.repo,
  pool,
  standing,
  ...(issueDesk === undefined ? {} : { issues: issueDesk }),
  client: createSyncClient({ serverUrl: config.serverUrl, secret: config.secret }),
  log,
});
const screens = new ScreenLoop({
  runnerId: config.runnerId,
  screens: () => pool.screens(),
  redactor,
  client: createScreensClient({ serverUrl: config.serverUrl, secret: config.secret }),
  log,
});

const shutdown = createShutdown({
  stop: () => {
    loop.stop();
    screens.stop();
    credentials?.stop();
    return Promise.all([standing.stop(), pool.stopAll()]);
  },
  settled: () => workspaces.settled(),
  graceMs: SHUTDOWN_GRACE_MS,
  kill: killLiveGroups,
  exit: (code) => process.exit(code),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(0));
}
// A crash stops the agents too, rather than leaving them to work on unseen.
for (const crash of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(crash, (error: unknown) => {
    log(`crashed, stopping every agent: ${redactor.redactText(error instanceof Error ? (error.stack ?? error.message) : String(error))}`);
    shutdown(1);
  });
}

log(
  `${config.runnerId}: ${config.maxAgents} ${config.agent} ${config.maxAgents === 1 ? "slot" : "slots"} ` +
    `for ${config.repo}, syncing with ${config.serverUrl.origin}`,
);
log(`data in ${config.dataDir}; a task stops after ${config.taskTimeoutMs / 60_000} minutes`);
const retiredLabel = retiredAgentIssueLabelNotice(process.env);
if (retiredLabel !== undefined) {
  log(retiredLabel);
}
log(
  config.dailyBudgetUsd === undefined
    ? "no daily budget (RUNNER_DAILY_BUDGET_USD is not set): spend is counted, and nothing is refused"
    : `new starts are refused once the agents have spent ${formatUsd(config.dailyBudgetUsd)} today`,
);
if (config.agent === "mock") {
  // The default, and easy to take for real work: a task "handed in" here was never worked.
  for (const line of [
    "=".repeat(72),
    "WARNING: this runner runs the MOCK agent (RUNNER_AGENT is not claude).",
    `No real coding happens: it plays a script, and any pull request it hands in is simulated (RUNNER_MOCK_OUTCOME=${config.mockOutcome}).`,
    "For real work set RUNNER_AGENT=claude and the RUNNER_GITHUB_APP_* variables, or RUNNER_GITHUB_AUTH=personal; see the README.",
    "=".repeat(72),
  ]) {
    log(line);
  }
} else {
  log(`agents run ${config.agent} with ${config.model === undefined ? "its default model" : `model ${config.model}`}`);
  log(`agents take any open issue without the "${config.restrictLabel}" label; they push and open pull requests as ${githubIdentity()}`);
  log(
    `the CEO's board drops close and reopen issues as the same identity` +
      (config.githubApp === undefined ? "" : ", which needs the App's Issues: Read and write permission"),
  );
  if (config.agentPermissions === "all") {
    // Opted into, and easy to forget it is on: every agent can run anything here, and no prompt will say so.
    for (const line of [
      "=".repeat(72),
      "WARNING: agents run EVERY command without asking (RUNNER_AGENT_PERMISSIONS=all).",
      "Each Claude runs in bypassPermissions: it can run anything on this machine as this user, unprompted.",
      "Unset RUNNER_AGENT_PERMISSIONS, or set it to allowlist, to go back to the allowlist and its prompts.",
      "=".repeat(72),
    ]) {
      log(line);
    }
  }
}
if (config.agent !== "mock" && config.standingDailyBudgetUsd === undefined) {
  log("standing tasks: off (RUNNER_STANDING_DAILY_BUDGET_USD is not set), so the office cannot set any up on this runner");
} else {
  log(
    `standing tasks: up to ${config.standingMaxConcurrent} ${config.standingMaxConcurrent === 1 ? "run" : "runs"} at once, ` +
      (config.standingDailyBudgetUsd === undefined
        ? "no standing budget of their own"
        : `${formatUsd(config.standingDailyBudgetUsd)} a day for all of them together`) +
      `; kept in ${join(config.dataDir, "standing.json")}`,
  );
}
if (config.logLevel === "debug") {
  log("logging every step the agents report (RUNNER_LOG_LEVEL=debug)");
}
credentials?.start();
await workspaces.reattach();
standing.start();
loop.start();
screens.start();
