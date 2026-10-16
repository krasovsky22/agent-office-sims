/**
 * Everything the runner reads out of its environment, read and validated once
 * at boot.
 *
 * The runner spends money and holds a secret, so a misconfigured one refuses
 * to start with the reason rather than start and sync into refusals: a `409`
 * a second from a runner configured above the floor's slot cap looks like a
 * full office, not a typo.
 */

import { homedir, hostname } from "node:os";
import { isAbsolute, join } from "node:path";

import { MAX_RUNNER_SLOTS } from "@sim/shared";

import { MOCK_OUTCOMES, type MockOutcome } from "./agents/mock.js";

/** The agents a slot can run. Real ones arrive with their own issues; `mock` needs no credentials. */
export const RUNNER_AGENT_KINDS = ["mock"] as const;

export type RunnerAgentKind = (typeof RUNNER_AGENT_KINDS)[number];

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
  /** Slots, from 1 to `MAX_RUNNER_SLOTS`. */
  readonly maxAgents: number;
  /** Longest one task may run before its slot stops it. */
  readonly taskTimeoutMs: number;
  /**
   * Who this runner is to the server. Stable across restarts, so a restarted
   * runner replaces its own slots rather than adding a second set beside the
   * ones still waiting out the timeout.
   */
  readonly runnerId: string;
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
 *   default) or `pr-opened` with a fake pull request.
 * - `RUNNER_MAX_AGENTS`: slots, from 1 to `MAX_RUNNER_SLOTS`, defaulting to 2.
 * - `RUNNER_TASK_TIMEOUT_MINUTES`: whole minutes, at least 1, defaulting to 60.
 *
 * @throws an `Error` naming the variable for anything else. The secret itself
 * stays out of every message.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env, host: string = hostname()): RunnerConfig {
  return {
    serverUrl: readServerUrl(env),
    secret: readSecret(env),
    repo: readRepository(env),
    dataDir: readDataDir(env),
    agent: readAgent(env),
    mockOutcome: readMockOutcome(env),
    maxAgents: readMaxAgents(env),
    taskTimeoutMs: readTaskTimeoutMinutes(env) * 60_000,
    runnerId: runnerIdFor(host),
  };
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

/** The machine's name, narrowed to what a runner id may hold. */
export function runnerIdFor(host: string): string {
  const id = host
    .split(".")[0]
    ?.replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, RUNNER_ID_LENGTH);
  return id === undefined || id === "" ? "runner" : id;
}
