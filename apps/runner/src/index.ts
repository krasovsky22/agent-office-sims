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
 * requires: the runner mints its tokens and keeps them fresh
 * (`./githubApp.ts`), and checks each issue's label and finds each task's
 * pull request with them (`./github.ts`).
 *
 * A misconfigured runner exits at once with the reason; see `./config.ts`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { claudeAdapter } from "./agents/claude.js";
import { HookServer } from "./agents/hookServer.js";
import { createMockAgent } from "./agents/mock.js";
import { createPtyAgent } from "./agents/ptyAgent.js";
import type { Agent } from "./agents/types.js";
import { type RunnerConfig, readConfig } from "./config.js";
import { NO_GITHUB, type TaskGithub, createTaskGithub } from "./github.js";
import { GITHUB_TOKEN_ENV, GithubAppCredentials } from "./githubApp.js";
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

const credentials =
  config.githubApp === undefined
    ? undefined
    : new GithubAppCredentials({
        app: config.githubApp,
        repo: config.repo,
        configDir: join(config.dataDir, "gh"),
        // Its tokens are secrets the runner did not start with: masked as they are minted.
        onToken: (token) => redactor.add(token),
        log,
      });

/** The environment for the runner's own `gh` and `git` calls: as the App, with a fresh token. */
async function githubEnv(app: GithubAppCredentials): Promise<NodeJS.ProcessEnv> {
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
      // It never touches GitHub: its pull request is a fake, and it spends nothing on an unlabelled issue.
      return { agent: createMockAgent({ outcome: runnerConfig.mockOutcome, repo: runnerConfig.repo }), github: NO_GITHUB };
    case "claude": {
      // readConfig refuses a claude agent without the App; this only narrows the type.
      const app = credentials;
      if (app === undefined) {
        throw new Error("a claude agent needs the runner's GitHub App");
      }
      const agent = createPtyAgent({
        adapter: claudeAdapter({ repo: runnerConfig.repo, ...(runnerConfig.model === undefined ? {} : { model: runnerConfig.model }) }),
        dataDir: runnerConfig.dataDir,
        hooks: await HookServer.start(),
        github: { env: app.env(), scrub: GITHUB_TOKEN_ENV },
      });
      return { agent, github: createTaskGithub({ repo: runnerConfig.repo, label: runnerConfig.issueLabel, env: () => githubEnv(app) }) };
    }
  }
}

let agent: Agent;
let github: TaskGithub;
try {
  // A first token now, so an App GitHub will not answer for stops the runner at boot.
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
  log,
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
if (config.agent !== "mock") {
  log(`issues need the "${config.issueLabel}" label; agents push and open pull requests as GitHub App ${config.githubApp?.appId ?? ""}`);
}
credentials?.start();
await workspaces.reattach();
loop.start();
screens.start();
