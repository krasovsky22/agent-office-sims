/**
 * One post of the slots' screens to the game server.
 *
 * The same secret and the same care as a sync (`./syncClient.ts`): the
 * secret goes to the server's origin only, never to wherever a redirect
 * points, and a request that hangs is abandoned. The reply names the slots
 * the server could not apply a diff for, which the screen loop sends whole.
 */

import { RUNNER_SCREENS_PATH, type RunnerScreens } from "@sim/shared";

import { SyncError } from "./syncClient.js";

/** A post that has not been answered in this long is abandoned; a newer screen is on its way. */
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/** A slot id, as the reply may name one. */
const SLOT_ID = /^[A-Za-z0-9._-]{1,32}$/;

export interface ScreensReply {
  /** Slots to send whole next. */
  readonly resend: readonly string[];
}

export interface ScreensClientOptions {
  /** The server's origin. */
  readonly serverUrl: URL;
  readonly secret: string;
  readonly requestTimeoutMs?: number;
  /** Injected so a test can answer for the server. */
  readonly fetch?: typeof fetch;
}

export type ScreensClient = (screens: RunnerScreens) => Promise<ScreensReply>;

/**
 * @throws a `SyncError` carrying the HTTP status for a refusal, so the loop
 * can tell being rate-limited from being unreachable.
 */
export function createScreensClient(options: ScreensClientOptions): ScreensClient {
  const url = new URL(RUNNER_SCREENS_PATH, options.serverUrl);
  const send = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return async (screens) => {
    let response: Response;
    try {
      response = await send(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(screens),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new SyncError(`could not reach ${url.origin}: ${error instanceof Error ? error.message : String(error)}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SyncError(`unreadable reply to screens (HTTP ${response.status})`, response.status);
    }
    if (!response.ok) {
      const reason = isRecord(body) && typeof body["error"] === "string" ? body["error"] : "no reason given";
      throw new SyncError(`screens refused with HTTP ${response.status}: ${reason}`, response.status);
    }
    if (!isRecord(body) || body["ok"] !== true || !Array.isArray(body["resend"])) {
      throw new SyncError("the reply is not a screens reply", response.status);
    }
    return {
      resend: body["resend"].filter((id): id is string => typeof id === "string" && SLOT_ID.test(id)),
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
