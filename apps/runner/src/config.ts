/**
 * Everything the runner reads out of its environment, read and validated once
 * at boot.
 *
 * The runner spends money and holds a secret, so a misconfigured one refuses
 * to start with the reason rather than start and sync into refusals: a `409`
 * a second from a runner configured above the floor's slot cap looks like a
 * full office, not a typo.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join } from "node:path";

import { MAX_RUNNER_SLOTS, MAX_RUNNER_USD, readAgentIssueLabel } from "@sim/shared";

import { MOCK_OUTCOMES, type MockOutcome } from "./agents/mock.js";
import type { GithubAppConfig } from "./githubApp.js";
import type { PersonalGithubConfig } from "./githubPersonal.js";

/** The agents a slot can run: `mock` needs no credentials and spends nothing; `claude` is Claude Code. */
export const RUNNER_AGENT_KINDS = ["mock", "claude"] as const;

export type RunnerAgentKind = (typeof RUNNER_AGENT_KINDS)[number];

/** How much the runner logs: `debug` adds every step an agent reports to `info`'s lifecycle lines. */
export const RUNNER_LOG_LEVELS = ["info", "debug"] as const;

export type RunnerLogLevel = (typeof RUNNER_LOG_LEVELS)[number];
/**
 * Who a real agent is on GitHub: `app`, the runner's GitHub App, or
 * `personal`, a person's own login, which the agent then acts as with all of
 * that account's access.
 */
export const RUNNER_GITHUB_AUTHS = ["app", "personal"] as const;

export type RunnerGithubAuth = (typeof RUNNER_GITHUB_AUTHS)[number];

/**
 * What a real agent may run without asking: `allowlist`, the short list its
 * adapter names, or `all`, every command, unprompted, on the runner's machine.
 */
export const RUNNER_AGENT_PERMISSIONS = ["allowlist", "all"] as const;

export type RunnerAgentPermissions = (typeof RUNNER_AGENT_PERMISSIONS)[number];

/** Where the runner finds the game server when `RUNNER_SERVER_URL` is unset: `pnpm dev`'s. */
const DEFAULT_SERVER_URL = "http://localhost:2567";

/** The repository the runner works on when none is configured: this one, as the server's board defaults to. */
const DEFAULT_REPOSITORY = "krasovsky22/agent-office-sims";

const DEFAULT_MAX_AGENTS = 2;

const DEFAULT_TASK_TIMEOUT_MINUTES = 60;

/** Shortest secret the server accepts for its sync route; a shorter one could never be right. */
const MIN_SECRET_LENGTH = 16;

/** `owner/name`, as the sync contract accepts it. */
const REPOSITORY_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** A model name or alias as Claude Code takes it: `sonnet`, `claude-sonnet-4-5`, `opus[1m]`. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;

/** A runner id, as the sync contract accepts it. */
const RUNNER_ID_LENGTH = 32;

/** Hosts the secret may be sent to over plain `http:`, since it never leaves the machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface RunnerConfig {
  /** The game server's origin, e.g. `https://office-server.fly.dev`. */
  readonly serverUrl: URL;
  /**
   * The bearer token the server's sync route checks. Sent only to
   * {@link serverUrl}, never logged.
   */
  readonly secret: string;
  /** `owner/name`; the server refuses a runner on any other repository. */
  readonly repo: string;
  /** Absolute; the runner's own files: its clone and its tasks' worktrees. */
  readonly dataDir: string;
  readonly agent: RunnerAgentKind;
  /** How the `mock` agent's work ends. */
  readonly mockOutcome: MockOutcome;
  /** The model a real agent runs; its CLI's own default when `undefined`. */
  readonly model: string | undefined;
  /** What a real agent may run without a permission prompt. */
  readonly agentPermissions: RunnerAgentPermissions;
  /** Slots, from 1 to `MAX_RUNNER_SLOTS`. */
  readonly maxAgents: number;
  /** Longest one task may run before its slot stops it. */
  readonly taskTimeoutMs: number;
  /**
   * US dollars the agents may spend in a day before new starts are refused;
   * `undefined` for no budget.
   */
  readonly dailyBudgetUsd: number | undefined;
  /**
   * Who this runner is to the server. Stable across restarts, so a restarted
   * runner replaces its own slots rather than adding a second set beside the
   * ones still waiting out the timeout.
   */
  readonly runnerId: string;
  /** The label an issue must carry on GitHub before an agent starts on it. */
  readonly issueLabel: string;
  /**
   * The GitHub App the agents push and open pull requests as, with
   * `RUNNER_GITHUB_AUTH=app`. A real agent has exactly one of this and
   * {@link personalGithub}; the `mock` never touches GitHub and has neither.
   */
  readonly githubApp: GithubAppConfig | undefined;
  /** How much the runner logs. */
  readonly logLevel: RunnerLogLevel;
  /** The person's token the agents push and open pull requests with, with `RUNNER_GITHUB_AUTH=personal`. */
  readonly personalGithub: PersonalGithubConfig | undefined;
}

/**
 * Reads and validates the runner's configuration.
 *
 * - `RUNNER_SERVER_URL`: the server's `http(s)` origin, defaulting to
 *   {@link DEFAULT_SERVER_URL}. Plain `http:` only for this machine, since
 *   every sync carries the secret.
 * - `RUNNER_SECRET`: required, at least {@link MIN_SECRET_LENGTH} characters;
 *   the server's own `RUNNER_SECRET`.
 * - `RUNNER_REPO`: `owner/name`, defaulting to this repository.
 * - `RUNNER_DATA_DIR`: an absolute path, defaulting to `~/.sim-runner`.
 * - `RUNNER_AGENT`: one of {@link RUNNER_AGENT_KINDS}, defaulting to `mock`.
 * - `RUNNER_MOCK_OUTCOME`: how a `mock` agent's work ends, `failed` (the
 *   default), `pr-opened` with a simulated pull request, opened nowhere, or
 *   `question`, waiting at its prompt for an answer before it hands one in.
 * - `RUNNER_MODEL`: the model a `claude` agent runs, its `--model`; unset,
 *   Claude Code's default.
 * - `RUNNER_AGENT_PERMISSIONS`: one of {@link RUNNER_AGENT_PERMISSIONS},
 *   defaulting to `allowlist`; `all` lets a `claude` agent run anything
 *   without a permission prompt.
 * - `RUNNER_MAX_AGENTS`: slots, from 1 to `MAX_RUNNER_SLOTS`, defaulting to 2.
 * - `RUNNER_TASK_TIMEOUT_MINUTES`: whole minutes, at least 1, defaulting to 60.
 * - `RUNNER_DAILY_BUDGET_USD`: US dollars, `0` or more, the agents may spend
 *   in a day before the runner refuses new starts; unset, no budget.
 * - `REAL_AGENT_ISSUE_LABEL`: the label an issue needs, as the server reads it,
 *   defaulting to `agent-ready`.
 * - `RUNNER_GITHUB_AUTH`: one of {@link RUNNER_GITHUB_AUTHS}, defaulting to
 *   `app`; who a `claude` agent is on GitHub.
 * - `RUNNER_GITHUB_APP_ID`, `RUNNER_GITHUB_APP_INSTALLATION_ID` and
 *   `RUNNER_GITHUB_APP_PRIVATE_KEY_FILE`: the GitHub App, all three or none;
 *   required for a `claude` agent with `app`, ignored with `personal`.
 * - `RUNNER_GITHUB_TOKEN`: the token a `claude` agent uses with `personal`;
 *   unset, the machine's own `gh auth token`.
 * - `RUNNER_LOG_LEVEL`: one of {@link RUNNER_LOG_LEVELS}, defaulting to `info`.
 *
 * @param ghToken the machine's `gh` login token, `undefined` when there is
 * none; injected so a test never reads the real one.
 * @throws an `Error` naming the variable for anything else. The secret itself
 * stays out of every message.
 */
export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  host: string = hostname(),
  ghToken: () => string | undefined = ghAuthToken,
): RunnerConfig {
  const agent = readAgent(env);
  const auth = readGithubAuth(env);
  return {
    serverUrl: readServerUrl(env),
    secret: readSecret(env),
    repo: readRepository(env),
    dataDir: readDataDir(env),
    agent,
    mockOutcome: readMockOutcome(env),
    model: readModel(env),
    agentPermissions: readAgentPermissions(env),
    maxAgents: readMaxAgents(env),
    taskTimeoutMs: readTaskTimeoutMinutes(env) * 60_000,
    dailyBudgetUsd: readDailyBudget(env),
    runnerId: runnerIdFor(host),
    issueLabel: readAgentIssueLabel(env["REAL_AGENT_ISSUE_LABEL"]),
    githubApp: auth === "app" ? readGithubApp(env, agent) : undefined,
    personalGithub: auth === "personal" && agent !== "mock" ? readPersonalGithub(env, ghToken) : undefined,
    logLevel: readLogLevel(env),
  };
}

function readGithubAuth(env: NodeJS.ProcessEnv): RunnerGithubAuth {
  const raw = read(env, "RUNNER_GITHUB_AUTH").toLowerCase();
  if (raw === "") {
    return "app";
  }
  const auth = RUNNER_GITHUB_AUTHS.find((candidate) => candidate === raw);
  if (auth === undefined) {
    throw new Error(`RUNNER_GITHUB_AUTH must be one of ${RUNNER_GITHUB_AUTHS.join(", ")}, got "${env["RUNNER_GITHUB_AUTH"]}"`);
  }
  return auth;
}

/**
 * A person's token, chosen explicitly: the App's settings are ignored even
 * when set, so which identity the agents have is never a guess. Read now, so
 * a machine with no login refuses at boot rather than at an agent's push.
 */
function readPersonalGithub(env: NodeJS.ProcessEnv, ghToken: () => string | undefined): PersonalGithubConfig {
  const token = read(env, "RUNNER_GITHUB_TOKEN");
  if (token !== "") {
    return { token, source: "RUNNER_GITHUB_TOKEN" };
  }
  const machine = ghToken()?.trim() ?? "";
  if (machine === "") {
    throw new Error(
      "RUNNER_GITHUB_AUTH=personal needs a token: set RUNNER_GITHUB_TOKEN, or sign this machine's GitHub CLI in with `gh auth login`",
    );
  }
  return { token: machine, source: "gh auth token" };
}

/** The token this machine's `gh` is signed in to github.com with; `undefined` when it is not, or there is no `gh`. */
function ghAuthToken(): string | undefined {
  try {
    return execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
  } catch {
    return undefined;
  }
}

const GITHUB_APP_VARIABLES = ["RUNNER_GITHUB_APP_ID", "RUNNER_GITHUB_APP_INSTALLATION_ID", "RUNNER_GITHUB_APP_PRIVATE_KEY_FILE"] as const;

/**
 * The GitHub App, read whole or not at all: two of its three settings is a
 * runner that would push as the wrong identity, so it refuses to start, and
 * so does a real agent without it, which would have no identity of its own.
 * The key is read here, so a missing or unreadable file is said at boot.
 */
function readGithubApp(env: NodeJS.ProcessEnv, agent: RunnerAgentKind): GithubAppConfig | undefined {
  const [appId, installationId, keyFile] = GITHUB_APP_VARIABLES.map((name) => read(env, name));
  const set = GITHUB_APP_VARIABLES.filter((name) => read(env, name) !== "");
  if (set.length === 0) {
    if (agent === "mock") {
      return undefined;
    }
    throw new Error(
      `RUNNER_AGENT=${agent} pushes and opens pull requests as the runner's GitHub App, so it needs ${GITHUB_APP_VARIABLES.join(", ")}; ` +
        `see the README's "The runner's GitHub App", or set RUNNER_GITHUB_AUTH=personal to use your own GitHub login instead`,
    );
  }
  if (set.length !== GITHUB_APP_VARIABLES.length || appId === undefined || installationId === undefined || keyFile === undefined) {
    const missing = GITHUB_APP_VARIABLES.filter((name) => read(env, name) === "");
    throw new Error(`the GitHub App takes all of ${GITHUB_APP_VARIABLES.join(", ")}; ${missing.join(", ")} not set`);
  }
  for (const [name, value] of [
    ["RUNNER_GITHUB_APP_ID", appId],
    ["RUNNER_GITHUB_APP_INSTALLATION_ID", installationId],
  ] as const) {
    if (!/^[1-9][0-9]{0,19}$/.test(value)) {
      throw new Error(`${name} must be the App's numeric id from GitHub, got "${value}"`);
    }
  }
  if (!isAbsolute(keyFile)) {
    throw new Error(`RUNNER_GITHUB_APP_PRIVATE_KEY_FILE must be an absolute path, got "${keyFile}"`);
  }
  let privateKey: string;
  try {
    privateKey = readFileSync(keyFile, "utf8");
  } catch (error) {
    throw new Error(`RUNNER_GITHUB_APP_PRIVATE_KEY_FILE could not be read: ${(error as Error).message}`);
  }
  if (!/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(privateKey)) {
    throw new Error("RUNNER_GITHUB_APP_PRIVATE_KEY_FILE is not a PEM private key; download one from the App's settings");
  }
  return { appId, installationId, privateKey };
}

function read(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() ?? "";
}

function readServerUrl(env: NodeJS.ProcessEnv): URL {
  const raw = read(env, "RUNNER_SERVER_URL");
  if (raw === "") {
    return new URL(DEFAULT_SERVER_URL);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`RUNNER_SERVER_URL must be a URL such as https://office-server.example, got "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`RUNNER_SERVER_URL must be http(s), got "${raw}"`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`RUNNER_SERVER_URL must be https for any host but this machine, since it carries the secret; got "${raw}"`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("RUNNER_SERVER_URL must not carry credentials; the secret goes in RUNNER_SECRET");
  }
  return new URL(url.origin);
}

function readSecret(env: NodeJS.ProcessEnv): string {
  const secret = read(env, "RUNNER_SECRET");
  if (secret === "") {
    throw new Error("RUNNER_SECRET is not set: set it to the game server's RUNNER_SECRET");
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`RUNNER_SECRET must be at least ${MIN_SECRET_LENGTH} characters, got ${secret.length}`);
  }
  return secret;
}

function readRepository(env: NodeJS.ProcessEnv): string {
  const raw = read(env, "RUNNER_REPO");
  if (raw === "") {
    return DEFAULT_REPOSITORY;
  }
  if (!REPOSITORY_PATTERN.test(raw)) {
    throw new Error(`RUNNER_REPO must be owner/name, got "${raw}"`);
  }
  return raw;
}

function readDataDir(env: NodeJS.ProcessEnv): string {
  const raw = read(env, "RUNNER_DATA_DIR");
  if (raw === "") {
    return join(homedir(), ".sim-runner");
  }
  if (!isAbsolute(raw)) {
    throw new Error(`RUNNER_DATA_DIR must be an absolute path, got "${raw}"`);
  }
  return raw;
}

function readAgent(env: NodeJS.ProcessEnv): RunnerAgentKind {
  const raw = read(env, "RUNNER_AGENT").toLowerCase();
  if (raw === "") {
    return "mock";
  }
  const kind = RUNNER_AGENT_KINDS.find((candidate) => candidate === raw);
  if (kind === undefined) {
    throw new Error(`RUNNER_AGENT must be one of ${RUNNER_AGENT_KINDS.join(", ")}, got "${env["RUNNER_AGENT"]}"`);
  }
  return kind;
}

function readAgentPermissions(env: NodeJS.ProcessEnv): RunnerAgentPermissions {
  const raw = read(env, "RUNNER_AGENT_PERMISSIONS").toLowerCase();
  if (raw === "") {
    return "allowlist";
  }
  const permissions = RUNNER_AGENT_PERMISSIONS.find((candidate) => candidate === raw);
  if (permissions === undefined) {
    throw new Error(
      `RUNNER_AGENT_PERMISSIONS must be one of ${RUNNER_AGENT_PERMISSIONS.join(", ")}, got "${env["RUNNER_AGENT_PERMISSIONS"]}"`,
    );
  }
  return permissions;
}

function readLogLevel(env: NodeJS.ProcessEnv): RunnerLogLevel {
  const raw = read(env, "RUNNER_LOG_LEVEL").toLowerCase();
  if (raw === "") {
    return "info";
  }
  const level = RUNNER_LOG_LEVELS.find((candidate) => candidate === raw);
  if (level === undefined) {
    throw new Error(`RUNNER_LOG_LEVEL must be one of ${RUNNER_LOG_LEVELS.join(", ")}, got "${env["RUNNER_LOG_LEVEL"]}"`);
  }
  return level;
}

function readMockOutcome(env: NodeJS.ProcessEnv): MockOutcome {
  const raw = read(env, "RUNNER_MOCK_OUTCOME").toLowerCase();
  if (raw === "") {
    return "failed";
  }
  const outcome = MOCK_OUTCOMES.find((candidate) => candidate === raw);
  if (outcome === undefined) {
    throw new Error(`RUNNER_MOCK_OUTCOME must be one of ${MOCK_OUTCOMES.join(", ")}, got "${env["RUNNER_MOCK_OUTCOME"]}"`);
  }
  return outcome;
}

function readModel(env: NodeJS.ProcessEnv): string | undefined {
  const raw = read(env, "RUNNER_MODEL");
  if (raw === "") {
    return undefined;
  }
  if (!MODEL_PATTERN.test(raw)) {
    throw new Error(`RUNNER_MODEL must be a model name such as sonnet or claude-sonnet-4-5, got "${raw}"`);
  }
  return raw;
}

/**
 * Above `MAX_RUNNER_SLOTS` is refused rather than capped: the server would
 * refuse every sync from a runner reporting more, and an operator who asked
 * for six and got four would be looking for the bug in the wrong place.
 */
function readMaxAgents(env: NodeJS.ProcessEnv): number {
  const raw = read(env, "RUNNER_MAX_AGENTS");
  if (raw === "") {
    return DEFAULT_MAX_AGENTS;
  }
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_RUNNER_SLOTS) {
    throw new Error(
      `RUNNER_MAX_AGENTS must be a whole number from 1 to ${MAX_RUNNER_SLOTS}, the server's slot cap; got "${raw}"`,
    );
  }
  return count;
}

function readTaskTimeoutMinutes(env: NodeJS.ProcessEnv): number {
  const raw = read(env, "RUNNER_TASK_TIMEOUT_MINUTES");
  if (raw === "") {
    return DEFAULT_TASK_TIMEOUT_MINUTES;
  }
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new Error(`RUNNER_TASK_TIMEOUT_MINUTES must be a whole number of minutes, at least 1, got "${raw}"`);
  }
  return minutes;
}

/** A plain amount of dollars, `5` or `12.50`: no sign, exponent or thousands separator. */
const DOLLARS = /^\d+(?:\.\d+)?$/;

function readDailyBudget(env: NodeJS.ProcessEnv): number | undefined {
  const raw = read(env, "RUNNER_DAILY_BUDGET_USD");
  if (raw === "") {
    return undefined;
  }
  const usd = Number(raw);
  if (!DOLLARS.test(raw) || !Number.isFinite(usd) || usd > MAX_RUNNER_USD) {
    throw new Error(`RUNNER_DAILY_BUDGET_USD must be an amount of US dollars from 0 to ${MAX_RUNNER_USD}, such as 5 or 12.50; got "${raw}"`);
  }
  return usd;
}

/** The machine's name, narrowed to what a runner id may hold. */
export function runnerIdFor(host: string): string {
  const id = host
    .split(".")[0]
    ?.replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, RUNNER_ID_LENGTH);
  return id === undefined || id === "" ? "runner" : id;
}
