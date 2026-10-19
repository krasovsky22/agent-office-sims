/**
 * One sync with the game server: post the runner's state, read back the
 * commands waiting for it.
 *
 * The server is the runner's to trust with commands, but its reply still
 * arrives over a network, so every command is rebuilt through the contract's
 * own `toRunnerCommand` before a slot sees it; one the runner cannot read is
 * reported back by id so it can be acked and stop coming.
 */

import {
  RUNNER_COMMAND_KIND,
  RUNNER_SYNC_PATH,
  type RunnerCommand,
  type RunnerCommandDraft,
  type RunnerSync,
  isAgentKey,
  isStandingTaskCommandKind,
  toRunnerCommand,
} from "@sim/shared";

/** A sync that has not been answered in this long is abandoned and retried. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** A command's id, as a sync may ack it; acking anything else would get the whole sync refused. */
const COMMAND_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** What the server answered. */
export interface SyncReply {
  readonly commands: readonly RunnerCommand[];
  /** Ids of commands the runner could not read, to ack so the server stops sending them. */
  readonly unreadable: readonly string[];
  /** A standup is on in the office: the agents pause for it. Absent means none. */
  readonly standup?: boolean;
}

/** A sync the server refused or never answered. */
export class SyncError extends Error {
  /** The HTTP status, or `undefined` when there was no answer at all. */
  public readonly status: number | undefined;

  public constructor(message: string, status?: number) {
    super(message);
    this.name = "SyncError";
    this.status = status;
  }
}

export interface SyncClientOptions {
  /** The server's origin. */
  readonly serverUrl: URL;
  readonly secret: string;
  readonly requestTimeoutMs?: number;
  /** Injected so a test can answer for the server. */
  readonly fetch?: typeof fetch;
}

export type SyncClient = (sync: RunnerSync) => Promise<SyncReply>;

export function createSyncClient(options: SyncClientOptions): SyncClient {
  const url = new URL(RUNNER_SYNC_PATH, options.serverUrl);
  const send = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return async (sync) => {
    let response: Response;
    try {
      response = await send(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(sync),
        signal: AbortSignal.timeout(timeoutMs),
        // The secret goes to this origin only, never to wherever a redirect points.
        redirect: "error",
      });
    } catch (error) {
      throw new SyncError(`could not reach ${url.origin}: ${describe(error)}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new SyncError(`unreadable reply (HTTP ${response.status}): ${describe(error)}`, response.status);
    }
    if (!response.ok) {
      const reason = isRecord(body) && typeof body["error"] === "string" ? body["error"] : "no reason given";
      throw new SyncError(`refused with HTTP ${response.status}: ${reason}`, response.status);
    }
    if (!isRecord(body) || body["ok"] !== true || !Array.isArray(body["commands"])) {
      throw new SyncError("the reply is not a sync reply", response.status);
    }
    const reply = readCommands(body["commands"]);
    return body["standup"] === true ? { ...reply, standup: true } : reply;
  };
}

/** Rebuilds every command, setting aside the ones that cannot be. */
export function readCommands(raw: readonly unknown[]): SyncReply {
  const commands: RunnerCommand[] = [];
  const unreadable: string[] = [];
  for (const item of raw) {
    const command = readCommand(item);
    if (command !== undefined) {
      commands.push(command);
    } else if (isRecord(item) && typeof item["id"] === "string" && COMMAND_ID.test(item["id"])) {
      unreadable.push(item["id"]);
    }
  }
  return { commands, unreadable };
}

function readCommand(raw: unknown): RunnerCommand | undefined {
  if (!isRecord(raw) || typeof raw["id"] !== "string") {
    return undefined;
  }
  const draft = typeof raw["slotId"] === "string" ? readDraft(raw, raw["slotId"]) : readStandingDraft(raw);
  return draft === undefined ? undefined : toRunnerCommand(raw["id"], draft);
}

/** A command that names no slot, a standing task's or an issue's state; its fields are proved by `toRunnerCommand`. */
function readStandingDraft(raw: Record<string, unknown>): RunnerCommandDraft | undefined {
  const { kind, requestedBy } = raw;
  if (typeof requestedBy !== "string") {
    return undefined;
  }
  if (kind === RUNNER_COMMAND_KIND.standingSet) {
    return { kind, spec: raw["spec"] as never, requestedBy };
  }
  if (isStandingTaskCommandKind(kind) && typeof raw["taskId"] === "string") {
    return { kind, taskId: raw["taskId"], requestedBy };
  }
  // Its number and state are proved by `toRunnerCommand`.
  if (kind === RUNNER_COMMAND_KIND.issueState) {
    return { kind, issueNumber: raw["issueNumber"] as number, state: raw["state"] as never, requestedBy };
  }
  return undefined;
}

function readDraft(raw: Record<string, unknown>, slotId: string): RunnerCommandDraft | undefined {
  const { kind } = raw;
  switch (kind) {
    case RUNNER_COMMAND_KIND.start: {
      const { issueNumber, title, url, note, requestedBy } = raw;
      if (
        typeof issueNumber !== "number" ||
        typeof title !== "string" ||
        typeof url !== "string" ||
        typeof note !== "string" ||
        typeof requestedBy !== "string"
      ) {
        return undefined;
      }
      return { kind, slotId, issueNumber, title, url, note, requestedBy };
    }
    case RUNNER_COMMAND_KIND.stop:
      return typeof raw["reason"] === "string" ? { kind, slotId, reason: raw["reason"] } : undefined;
    case RUNNER_COMMAND_KIND.prompt: {
      const { text, requestedBy } = raw;
      if (typeof text !== "string" || typeof requestedBy !== "string") {
        return undefined;
      }
      if (raw["fromCeo"] !== true) {
        return { kind, slotId, text, requestedBy };
      }
      return raw["queue"] === true ? { kind, slotId, text, requestedBy, fromCeo: true, queue: true } : { kind, slotId, text, requestedBy, fromCeo: true };
    }
    case RUNNER_COMMAND_KIND.key: {
      const { key, requestedBy } = raw;
      return isAgentKey(key) && typeof requestedBy === "string" ? { kind, slotId, key, requestedBy } : undefined;
    }
    case RUNNER_COMMAND_KIND.profile: {
      const { name, title, description, requestedBy } = raw;
      if (typeof name !== "string" || typeof title !== "string" || typeof description !== "string" || typeof requestedBy !== "string") {
        return undefined;
      }
      return { kind, slotId, name, title, description, requestedBy };
    }
    case RUNNER_COMMAND_KIND.deskOpen: {
      const { seatId, requestedBy } = raw;
      return typeof seatId === "string" && typeof requestedBy === "string" ? { kind, slotId, seatId, requestedBy } : undefined;
    }
    case RUNNER_COMMAND_KIND.deskClose: {
      const { seatId, reason } = raw;
      return typeof seatId === "string" && typeof reason === "string" ? { kind, slotId, seatId, reason } : undefined;
    }
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // `fetch` hides the useful part, e.g. ECONNREFUSED, in its cause.
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
  }
  return String(error);
}
