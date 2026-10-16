/**
 * The HTTP route an agent runner syncs through.
 *
 * `POST /agents/runner/sync` with `Authorization: Bearer <RUNNER_SECRET>` and a
 * JSON body — `{ "runnerId", "repo", "acked": [ids], "slots": [...], "events": [...] }`,
 * the shape `RunnerSync` in `@sim/shared` — answered with
 * `{ "ok": true, "commands": [...] }`: every command queued for that runner it
 * has not yet acked. See `./runnerLink.ts` for what a sync does.
 *
 * HTTP rather than a socket because Colyseus' transport takes every WebSocket
 * upgrade on the shared server. The route is refused the way the
 * orchestrator's report route is (`./endpoint.ts`) and for the same reasons:
 * method, then secret off the header alone, then size as the body arrives,
 * then rate, all before anything is parsed. What gets through only updates the
 * runner link, which raises a flag for the rooms; no request touches a room,
 * so a flood is load on Node's event loop and never a stall in the tick.
 *
 * The secret is compared in constant time, and it is never echoed, logged, or
 * sent anywhere a client can read.
 */

import { parseRunnerSync } from "@sim/shared";

import type { RouteHandler } from "../http.js";
import { type TokenBucket, createTokenBucket, tryConsume } from "../sim/expression.js";
import { declaresTooMuch, digest, isAuthorized, readBody, refuse, reply } from "./routeGuards.js";
import type { RunnerLink } from "./runnerLink.js";

export const RUNNER_SYNC_PATH = "/agents/runner/sync";

/** A full sync of sixteen slots and thirty-two events fits with room to spare. */
export const MAX_SYNC_BYTES = 16 * 1024;

/**
 * Syncs accepted back to back, and the rate they refill at, across every
 * runner at once. A runner syncs about once a second and a few may share a
 * server; this leaves headroom for retries and a hard ceiling on what a leaked
 * secret can push in.
 */
const SYNC_BURST = 20;
const SYNC_REFILL_PER_SECOND = 10;

export interface RunnerEndpointOptions {
  /** `RUNNER_SECRET`, which the runner sends as a bearer token. */
  readonly secret: string;
  readonly link: Pick<RunnerLink, "sync">;
  /** Milliseconds, for the rate limit. Injected so a test controls the clock. */
  readonly now?: () => number;
}

/** Builds the route's handler. */
export function createRunnerEndpoint(options: RunnerEndpointOptions): RouteHandler {
  const expected = digest(options.secret);
  const now = options.now ?? (() => Date.now());
  const bucket: TokenBucket = createTokenBucket(SYNC_BURST, SYNC_REFILL_PER_SECOND, now());

  return (req, res) => {
    if (req.method !== "POST") {
      refuse(res, 405, "method not allowed", { Allow: "POST" });
      return;
    }
    if (!isAuthorized(req, expected)) {
      refuse(res, 401, "unauthorized", { "WWW-Authenticate": "Bearer" });
      return;
    }
    if (declaresTooMuch(req, MAX_SYNC_BYTES)) {
      refuse(res, 413, "sync too large");
      return;
    }
    if (!tryConsume(bucket, now())) {
      refuse(res, 429, "too many syncs", { "Retry-After": "1" });
      return;
    }

    readBody(req, MAX_SYNC_BYTES, (body) => {
      if (body.failed !== undefined) {
        if (body.failed === "too-large") {
          refuse(res, 413, "sync too large");
        } else {
          refuse(res, 408, "sync timed out");
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
      const sync = parseRunnerSync(raw);
      if (sync === undefined) {
        reply(res, 400, { error: "not a runner sync" });
        return;
      }
      const outcome = options.link.sync(sync);
      switch (outcome.kind) {
        case "wrong-repo":
          reply(res, 403, { error: "this server works on another repository" });
          return;
        case "full":
          reply(res, 409, { error: "the office is full" });
          return;
        case "accepted":
          reply(res, 200, { ok: true, commands: outcome.commands });
      }
    });
  };
}
