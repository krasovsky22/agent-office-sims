/**
 * The HTTP route an agent runner posts its slots' terminal screens to.
 *
 * `POST /agents/runner/screens` with `Authorization: Bearer <RUNNER_SECRET>`
 * and a JSON body — `{ "runnerId", "screens": [{ "slotId", "frame" }] }`, the
 * shape `RunnerScreens` in `@sim/shared` — answered with
 * `{ "ok": true, "resend": [slotIds] }`: the slots whose frame the server could
 * not take, which the runner sends whole next. A batch from a runner whose
 * sync the link does not hold is refused with `409`. See `./screens.ts` for what
 * the store does with a batch.
 *
 * Refused the way the sync route is (`./runnerEndpoint.ts`): method, then
 * secret, then size as the body arrives, then rate, all before anything is
 * parsed. What gets through only updates the store, which hands the frames to
 * the rooms to broadcast; nothing here touches a room's tick, so a flood is
 * load on Node's event loop and never a stall in the simulation.
 */

import { MAX_RUNNER_SCREENS_BYTES, parseScreenFrames } from "@sim/shared";

import type { RouteHandler } from "../http.js";
import { type TokenBucket, createTokenBucket, tryConsume } from "../sim/expression.js";
import { declaresTooMuch, digest, isAuthorized, readBody, refuse, reply } from "./routeGuards.js";
import type { ScreenStore } from "./screens.js";

/**
 * Batches accepted back to back, and the rate they refill at, across every
 * runner at once. A runner posts about four times a second; this covers two
 * runners at that rate and puts a ceiling on what a leaked secret can make
 * every client download.
 */
const SCREENS_BURST = 16;
const SCREENS_REFILL_PER_SECOND = 8;

export interface ScreensEndpointOptions {
  /** `RUNNER_SECRET`, which the runner sends as a bearer token. */
  readonly secret: string;
  readonly store: Pick<ScreenStore, "accept">;
  /** Milliseconds, for the rate limit. Injected so a test controls the clock. */
  readonly now?: () => number;
}

/** Builds the route's handler. */
export function createScreensEndpoint(options: ScreensEndpointOptions): RouteHandler {
  const expected = digest(options.secret);
  const now = options.now ?? (() => Date.now());
  const bucket: TokenBucket = createTokenBucket(SCREENS_BURST, SCREENS_REFILL_PER_SECOND, now());

  return (req, res) => {
    if (req.method !== "POST") {
      refuse(res, 405, "method not allowed", { Allow: "POST" });
      return;
    }
    if (!isAuthorized(req, expected)) {
      refuse(res, 401, "unauthorized", { "WWW-Authenticate": "Bearer" });
      return;
    }
    if (declaresTooMuch(req, MAX_RUNNER_SCREENS_BYTES)) {
      refuse(res, 413, "screens too large");
      return;
    }
    if (!tryConsume(bucket, now())) {
      refuse(res, 429, "too many screens", { "Retry-After": "1" });
      return;
    }

    readBody(req, MAX_RUNNER_SCREENS_BYTES, (body) => {
      if (body.failed !== undefined) {
        if (body.failed === "too-large") {
          refuse(res, 413, "screens too large");
        } else {
          refuse(res, 408, "screens timed out");
        }
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(body.text);
      } catch {
        reply(res, 400, { error: "body is not JSON" });
        return;
      }
      const batch = parseScreenFrames(raw);
      if (batch === undefined) {
        reply(res, 400, { error: "not a batch of screens" });
        return;
      }
      const outcome = options.store.accept(batch);
      if (outcome === undefined) {
        reply(res, 409, { error: "runner not synced" });
        return;
      }
      reply(res, 200, { ok: true, resend: outcome.resend });
    });
  };
}
