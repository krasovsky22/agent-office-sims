/**
 * Everything the server reads out of its environment, read and validated once
 * at boot.
 *
 * A deployment that is misconfigured should refuse to start rather than start
 * and then refuse every connection: a container that exits with a clear reason
 * is a line in the platform's log, while one that boots healthy and rejects
 * joins looks like a client bug.
 */

import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readAgentRestrictLabel } from "@sim/shared";

const DEFAULT_PORT = 2567;

/**
 * Origins allowed when `ALLOWED_ORIGINS` is unset.
 *
 * Both spellings of the Vite dev server, so `pnpm dev` needs no configuration.
 * A deployment names its own origin instead — this default deliberately does
 * not include one.
 */
const DEV_ORIGINS: readonly string[] = ["http://localhost:5173", "http://127.0.0.1:5173"];

/**
 * What a cross-origin response says when the origin is not on the allowlist.
 *
 * Not `null`: a sandboxed iframe or `data:` URL sends a literal `Origin: null`
 * header, and the Fetch spec's CORS-check matches that against an
 * `Access-Control-Allow-Origin: null` reply. This string can never be a real
 * request's serialized origin, so no browser's CORS check can ever match it.
 * The socket upgrade is the real gate; this only stops the matchmaking reply
 * from being readable.
 */
export const DISALLOWED_ORIGIN = "https://disallowed.invalid";

/** The repository whose issues the project board shows when none is configured: this one. */
const DEFAULT_PROJECT_REPOSITORY = "krasovsky22/agent-office-sims";

/**
 * Seconds between polls when no interval is configured.
 *
 * Anonymous REST requests get 60 an hour per address, a `304` included, and a
 * poll costs at least two, so three minutes spends two thirds of that and
 * leaves the rest for a second page or a restart; a token raises the budget to
 * 5000 an hour, which a minute's interval does not come close to.
 */
const DEFAULT_POLL_SECONDS_ANONYMOUS = 180;
const DEFAULT_POLL_SECONDS_WITH_TOKEN = 60;

/** Below this a poll interval is hammering GitHub for news that changes in minutes. */
const MIN_POLL_SECONDS = 15;

/** `owner/name`, in the characters GitHub allows in each. */
const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Where the project board reads its issues from. */
export interface ProjectBoardConfig {
  /** `owner/name`. */
  readonly repository: string;
  /**
   * Optional, and server-side only: it is read here, used in request headers
   * by the GitHub client, and never sent to a browser.
   */
  readonly token: string | undefined;
  readonly pollIntervalMs: number;
}

/**
 * Shortest secret the live agents' report route will accept.
 *
 * The route is reachable by anyone who can reach the server, so the secret is
 * all that stands between a stranger and the people on the floor; a short one
 * is a configuration mistake worth refusing to boot over.
 */
const MIN_LIVE_AGENTS_SECRET_LENGTH = 16;

/** Silence after which a live agent leaves, when none is configured. */
const DEFAULT_LIVE_AGENTS_TIMEOUT_SECONDS = 60;

/** Below this, one late heartbeat takes an agent off the floor. */
const MIN_LIVE_AGENTS_TIMEOUT_SECONDS = 5;

/** The live agents' report route. */
export interface LiveAgentsConfig {
  /**
   * The shared secret an orchestrator reports with, or `undefined` to leave the
   * route switched off. Server-side only: it is compared against request
   * headers and never sent to a browser.
   */
  readonly secret: string | undefined;
  /** Silence after which an agent is taken off the floor. */
  readonly timeoutMs: number;
}

/** The runner link's sync route. */
export interface RunnerConfig {
  /**
   * The shared secret an agent runner syncs with, or `undefined` to leave the
   * route switched off. Server-side only, like the live agents' secret.
   */
  readonly secret: string | undefined;
  /** The label that keeps an issue from a runner's agent; every other open issue may go to one. */
  readonly restrictLabel: string;
}

export interface ServerConfig {
  readonly port: number;
  /** Origins permitted to matchmake and open a socket, already normalized. */
  readonly allowedOrigins: readonly string[];
  readonly projectBoard: ProjectBoardConfig;
  readonly liveAgents: LiveAgentsConfig;
  readonly runner: RunnerConfig;
  readonly manager: ManagerConfig;
  /** Where the server keeps the little it must not lose on a restart; see {@link readDataDir}. */
  readonly dataDir: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: readPort(env),
    allowedOrigins: readAllowedOrigins(env),
    projectBoard: readProjectBoardConfig(env),
    liveAgents: readLiveAgentsConfig(env),
    runner: readRunnerConfig(env),
    manager: readManagerConfig(env),
    dataDir: readDataDir(env),
  };
}

/** The server package's own `.data/`, which `.gitignore` keeps out of the repository. */
const DEFAULT_DATA_DIR = join(fileURLToPath(new URL("..", import.meta.url)), ".data");

/**
 * Reads where the server keeps its files: today only the CEO's edits to the
 * agents' profiles, so one survives a restart before its runner has it.
 *
 * - `SERVER_DATA_DIR`: an absolute path, defaulting to `apps/server/.data`.
 */
export function readDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["SERVER_DATA_DIR"]?.trim() ?? "";
  if (raw === "") {
    return DEFAULT_DATA_DIR;
  }
  if (!isAbsolute(raw)) {
    throw new Error(`SERVER_DATA_DIR must be an absolute path, got "${raw}"`);
  }
  return raw;
}

/** The model the manager uses when `MANAGER_MODEL` is unset. */
const DEFAULT_MANAGER_MODEL = "claude-opus-5-5";

/**
 * Model calls the AI manager may make when no budget is configured. One call
 * answers one message from the CEO, so a day's worth is a long day of
 * questions; the per-run figure bounds a server left up for weeks.
 */
const DEFAULT_MANAGER_CALLS_PER_DAY = 150;
const DEFAULT_MANAGER_CALLS_PER_RUN = 1000;

/**
 * How the AI manager answers: from live state by rule, for free, or through a
 * real model that costs money.
 */
export type ManagerConfig =
  | { readonly mode: "mock" }
  | {
      readonly mode: "model";
      /**
       * Server-side only: read here, handed to the model client, and never
       * logged or sent to a browser.
       */
      readonly apiKey: string;
      readonly model: string;
      readonly callsPerDay: number;
      readonly callsPerRun: number;
    };

/**
 * Reads how the AI manager answers.
 *
 * - `MOCK_MANAGER`: `on` (the default) or `off`. On, the manager answers from
 *   the office's live state by rule and makes no network call.
 * - `ANTHROPIC_API_KEY`: required when `MOCK_MANAGER` is off.
 * - `MANAGER_MODEL`: optional, defaulting to {@link DEFAULT_MANAGER_MODEL}.
 * - `MANAGER_CALLS_PER_DAY`, `MANAGER_CALLS_PER_RUN`: optional call budgets.
 */
export function readManagerConfig(env: NodeJS.ProcessEnv = process.env): ManagerConfig {
  const rawMock = env["MOCK_MANAGER"]?.trim().toLowerCase() ?? "";
  if (rawMock === "" || rawMock === "on") {
    return { mode: "mock" };
  }
  if (rawMock !== "off") {
    throw new Error(`MOCK_MANAGER must be on or off, got "${env["MOCK_MANAGER"]}"`);
  }

  const apiKey = env["ANTHROPIC_API_KEY"]?.trim() ?? "";
  if (apiKey === "") {
    throw new Error(
      "MOCK_MANAGER is off but ANTHROPIC_API_KEY is not set: set the key as a platform secret, " +
        "or leave MOCK_MANAGER on to have the manager answer without a model",
    );
  }

  const rawModel = env["MANAGER_MODEL"]?.trim() ?? "";
  return {
    mode: "model",
    apiKey,
    model: rawModel === "" ? DEFAULT_MANAGER_MODEL : rawModel,
    callsPerDay: readCallBudget(env, "MANAGER_CALLS_PER_DAY", DEFAULT_MANAGER_CALLS_PER_DAY),
    callsPerRun: readCallBudget(env, "MANAGER_CALLS_PER_RUN", DEFAULT_MANAGER_CALLS_PER_RUN),
  };
}

function readCallBudget(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") {
    return fallback;
  }
  const calls = Number(raw);
  if (!Number.isInteger(calls) || calls < 0) {
    throw new Error(`${name} must be a whole number of calls, got "${raw}"`);
  }
  return calls;
}

/**
 * Reads the live agents' report route settings.
 *
 * - `LIVE_AGENTS_SECRET`: optional, at least {@link MIN_LIVE_AGENTS_SECRET_LENGTH}
 *   characters. Without it the route does not exist and no live agent appears.
 * - `LIVE_AGENTS_TIMEOUT_SECONDS`: optional, at least
 *   {@link MIN_LIVE_AGENTS_TIMEOUT_SECONDS}. Defaults to a minute.
 */
export function readLiveAgentsConfig(env: NodeJS.ProcessEnv = process.env): LiveAgentsConfig {
  const rawSecret = env["LIVE_AGENTS_SECRET"]?.trim() ?? "";
  const secret = rawSecret === "" ? undefined : rawSecret;
  if (secret !== undefined && secret.length < MIN_LIVE_AGENTS_SECRET_LENGTH) {
    // The value itself stays out of the message, which lands in a platform log.
    throw new Error(
      `LIVE_AGENTS_SECRET must be at least ${MIN_LIVE_AGENTS_SECRET_LENGTH} characters, got ${secret.length}`,
    );
  }

  const rawSeconds = env["LIVE_AGENTS_TIMEOUT_SECONDS"]?.trim() ?? "";
  let seconds = DEFAULT_LIVE_AGENTS_TIMEOUT_SECONDS;
  if (rawSeconds !== "") {
    seconds = Number(rawSeconds);
    if (!Number.isInteger(seconds) || seconds < MIN_LIVE_AGENTS_TIMEOUT_SECONDS) {
      throw new Error(
        `LIVE_AGENTS_TIMEOUT_SECONDS must be a whole number of seconds, at least ${MIN_LIVE_AGENTS_TIMEOUT_SECONDS}, got "${rawSeconds}"`,
      );
    }
  }

  return { secret, timeoutMs: seconds * 1000 };
}

/**
 * Reads the runner link's settings.
 *
 * - `RUNNER_SECRET`: optional, at least {@link MIN_LIVE_AGENTS_SECRET_LENGTH}
 *   characters, for the same reason. Without it the runner link's route does
 *   not exist and no runner's slots appear.
 * - `REAL_AGENT_RESTRICT_LABEL`: the label that keeps an issue from a runner's
 *   agent, `agent-restricted` by default; see `readAgentRestrictLabel`.
 */
export function readRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const raw = env["RUNNER_SECRET"]?.trim() ?? "";
  const secret = raw === "" ? undefined : raw;
  if (secret !== undefined && secret.length < MIN_LIVE_AGENTS_SECRET_LENGTH) {
    // The value itself stays out of the message, which lands in a platform log.
    throw new Error(
      `RUNNER_SECRET must be at least ${MIN_LIVE_AGENTS_SECRET_LENGTH} characters, got ${secret.length}`,
    );
  }
  return { secret, restrictLabel: readAgentRestrictLabel(env["REAL_AGENT_RESTRICT_LABEL"]) };
}

/**
 * Reads the project board's feed settings.
 *
 * - `PROJECT_BOARD_REPO`: `owner/name`, defaulting to this repository.
 * - `PROJECT_BOARD_TOKEN`: optional. Raises the rate limit and turns on check
 *   status and sidebar-linked pull requests, which only GraphQL can answer.
 * - `PROJECT_BOARD_POLL_SECONDS`: optional, at least {@link MIN_POLL_SECONDS}.
 */
export function readProjectBoardConfig(env: NodeJS.ProcessEnv = process.env): ProjectBoardConfig {
  const rawRepository = env["PROJECT_BOARD_REPO"]?.trim() ?? "";
  const repository = rawRepository === "" ? DEFAULT_PROJECT_REPOSITORY : rawRepository;
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`PROJECT_BOARD_REPO must be owner/name, got "${rawRepository}"`);
  }

  const rawToken = env["PROJECT_BOARD_TOKEN"]?.trim() ?? "";
  const token = rawToken === "" ? undefined : rawToken;

  const rawSeconds = env["PROJECT_BOARD_POLL_SECONDS"]?.trim() ?? "";
  let seconds = token === undefined ? DEFAULT_POLL_SECONDS_ANONYMOUS : DEFAULT_POLL_SECONDS_WITH_TOKEN;
  if (rawSeconds !== "") {
    seconds = Number(rawSeconds);
    if (!Number.isInteger(seconds) || seconds < MIN_POLL_SECONDS) {
      throw new Error(
        `PROJECT_BOARD_POLL_SECONDS must be a whole number of seconds, at least ${MIN_POLL_SECONDS}, got "${rawSeconds}"`,
      );
    }
  }

  return { repository, token, pollIntervalMs: seconds * 1000 };
}

export function readPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["PORT"];
  if (raw === undefined || raw === "") {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`PORT must be a valid port number, got "${raw}"`);
  }
  return parsed;
}

/**
 * Parses `ALLOWED_ORIGINS`, a comma-separated list of origins.
 *
 * There is no wildcard. An origin the operator did not write down is one the
 * browser cannot use, which is the whole point of the variable existing.
 */
export function readAllowedOrigins(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env["ALLOWED_ORIGINS"];
  if (raw === undefined || raw.trim() === "") {
    return DEV_ORIGINS;
  }

  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(normalizeOrigin);

  if (origins.length === 0) {
    throw new Error("ALLOWED_ORIGINS was set but listed no origins");
  }
  return origins;
}

/**
 * Whether a request carrying this `Origin` header may talk to the room.
 *
 * An absent header is allowed. `Origin` is something browsers attach and
 * browsers enforce; a request without one is not a page acting on a user's
 * behalf, so there is no cross-origin trust to withhold from it. Everything
 * else must match an allowlisted origin exactly, scheme and port included.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined || origin === "") {
    return true;
  }
  let normalized: string;
  try {
    normalized = normalizeOrigin(origin);
  } catch {
    // Not a parseable origin, so it matches nothing on the list.
    return false;
  }
  return allowedOrigins.includes(normalized);
}

/**
 * Reduces an origin to the `scheme://host[:port]` form the `Origin` header
 * uses, so that a configured `https://office.example.com/` and a browser's
 * `https://office.example.com` are the same entry.
 */
function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${value}" is not a valid origin (expected e.g. https://office.example.com)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`"${value}" is not an http(s) origin`);
  }
  return `${url.protocol}//${url.host}`;
}
