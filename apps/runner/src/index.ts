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
 * finds each task's pull request with them (`./github.ts`).
 *
 * What the agents spend is booked against `RUNNER_DAILY_BUDGET_USD`, which
 * refuses new starts once it is spent (`./budget.ts`).
 *
 * A misconfigured runner exits at once with the reason; see `./config.ts`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { formatUsd } from "@sim/shared";

import { claudeAdapter } from "./agents/claude.js";
import { HookServer } from "./agents/hookServer.js";
import { createMockAgent } from "./agents/mock.js";
import { createPtyAgent } from "./agents/ptyAgent.js";
import type { Agent } from "./agents/types.js";
import { SpendLedger } from "./budget.js";
import { type RunnerConfig, readConfig } from "./config.js";
import { NO_GITHUB, type TaskGithub, createTaskGithub } from "./github.js";
import { GITHUB_TOKEN_ENV, GithubAppCredentials, type GithubCredentials } from "./githubApp.js";
import { PersonalGithubCredentials } from "./githubPersonal.js";
import { createRedactor, runnerSecrets } from "./redact.js";
import { ScreenLoop } from "./screenLoop.js";
import { createScreensClient } from "./screensClient.js";
import { SlotWorktrees } from "./slotWorktrees.js";
import { SlotPool } from "./slots.js";
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

/** Longest a shutdown waits for worktrees being made or removed to finish. */
const SHUTDOWN_GRACE_MS = 10_000;

// Private to the runner's user: its clone and its tasks' worktrees live here.
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

const workspaces = new SlotWorktrees({
  worktrees: new Worktrees({
    repoDir: join(config.dataDir, "repo"),
    worktreesDir: join(config.dataDir, "worktrees"),
    ceilingDir: config.dataDir,
    clone: ghClone(config.repo),
    log,
  }),
  stateFile: join(config.dataDir, "worktrees.json"),
  log,
});

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
      return { agent, github: createTaskGithub({ repo: runnerConfig.repo, label: runnerConfig.issueLabel, env: () => githubEnv(app) }) };
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

const pool = new SlotPool({
  count: config.maxAgents,
  agent,
  workspaces,
  taskTimeoutMs: config.taskTimeoutMs,
  github,
  redactor,
  ledger: new SpendLedger({ budgetUsd: config.dailyBudgetUsd }),
  log,
  debug,
});
const loop = new SyncLoop({
  runnerId: config.runnerId,
  repo: config.repo,
  pool,
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

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    loop.stop();
    screens.stop();
    credentials?.stop();
    pool.stopAll();
    // A worktree left half-removed would read as work to keep, so let removals finish.
    const grace = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    void workspaces.settled().finally(() => {
      clearTimeout(grace);
      process.exit(0);
    });
  });
}

log(
  `${config.runnerId}: ${config.maxAgents} ${config.agent} ${config.maxAgents === 1 ? "slot" : "slots"} ` +
    `for ${config.repo}, syncing with ${config.serverUrl.origin}`,
);
log(`data in ${config.dataDir}; a task stops after ${config.taskTimeoutMs / 60_000} minutes`);
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
  log(`issues need the "${config.issueLabel}" label; agents push and open pull requests as ${githubIdentity()}`);
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
if (config.logLevel === "debug") {
  log("logging every step the agents report (RUNNER_LOG_LEVEL=debug)");
}
credentials?.start();
await workspaces.reattach();
loop.start();
screens.start();
