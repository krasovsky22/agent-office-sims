/**
 * The HTTP routes an agent orchestrator talks to the office through: one to
 * report its agents, and one to collect the work the AI manager has assigned
 * them.
 *
 * `POST /agents/report` with `Authorization: Bearer <secret>` and a JSON body —
 * `{ "id", "name", "status": "working" | "idle" | "stopped", "task": { "title", "url" } }` —
 * one agent per request. The shape is `LiveAgentReport` in `@sim/shared`.
 *
 * The route is built to be cheap to refuse. Everything a stranger can send is
 * turned away before its body is read: a missing or wrong secret is checked off
 * the header alone, a body over the size limit is cut off as it arrives, and an
 * authenticated sender that outruns the rate limit is refused before parsing.
 * What gets through only records the report in the registry, which raises a
 * flag for the rooms; no request ever touches a room directly, so a flood is
 * load on Node's event loop and never a stall in the simulation tick.
 *
 * `POST /agents/assignments`, with the same secret and no body, hands over
 * every assignment the AI manager has queued since the last collection, as
 * `{ "assignments": [{ "id", "agentId", "kind", "number", "title", "url",
 * "requestedBy", "note", "assignedAt" }] }`. Each is handed out by exactly one
 * collection. After collecting, the orchestrator's next report for that agent
 * must already show it working on the item, or the assignment counts as not
 * taken and the manager says so; see `../manager/liveAssignments.ts`.
 *
 * The secret is compared in constant time, and it is never echoed, logged, or
 * sent anywhere a client can read.
 */

import { parseLiveAgentReport } from "@sim/shared";

import type { RouteHandler } from "../http.js";
import { type LiveAssignmentQueue, toWire } from "../manager/liveAssignments.js";
import { type TokenBucket, createTokenBucket, tryConsume } from "../sim/expression.js";
import type { LiveAgentRegistry } from "./registry.js";
import { declaresTooMuch, digest, isAuthorized, readBody, refuse, reply } from "./routeGuards.js";

export const LIVE_AGENT_REPORT_PATH = "/agents/report";

export const LIVE_AGENT_ASSIGNMENTS_PATH = "/agents/assignments";

/** Far above any real report, which is a few hundred bytes. */
export const MAX_REPORT_BYTES = 4096;

/**
 * Reports accepted back to back, and the rate they refill at, across every
 * sender at once.
 *
 * An orchestrator reports on a change and heartbeats every several seconds per
 * agent, so a dozen agents is a handful of requests a second; this is generous
 * headroom over that and a hard ceiling on what a leaked secret can push in.
 */
const REPORT_BURST = 60;
const REPORT_REFILL_PER_SECOND = 30;

/**
 * Collections accepted back to back, and their refill rate. An orchestrator
 * polls every few seconds; this leaves room for a restart's burst and no more.
 */
const COLLECT_BURST = 10;
const COLLECT_REFILL_PER_SECOND = 2;

export interface LiveAgentEndpointOptions {
  /** The shared secret an orchestrator sends as a bearer token. */
  readonly secret: string;
  readonly registry: Pick<LiveAgentRegistry, "report">;
  /** Milliseconds, for the rate limit. Injected so a test controls the clock. */
  readonly now?: () => number;
}

/** Builds the route's handler. */
export function createLiveAgentEndpoint(options: LiveAgentEndpointOptions): RouteHandler {
  const expected = digest(options.secret);
  const now = options.now ?? (() => Date.now());
  const bucket: TokenBucket = createTokenBucket(REPORT_BURST, REPORT_REFILL_PER_SECOND, now());

  return (req, res) => {
    if (req.method !== "POST") {
      refuse(res, 405, "method not allowed", { Allow: "POST" });
      return;
    }
    if (!isAuthorized(req, expected)) {
      refuse(res, 401, "unauthorized", { "WWW-Authenticate": "Bearer" });
      return;
    }
    if (declaresTooMuch(req, MAX_REPORT_BYTES)) {
      refuse(res, 413, "report too large");
      return;
    }
    if (!tryConsume(bucket, now())) {
      refuse(res, 429, "too many reports", { "Retry-After": "1" });
      return;
    }

    readBody(req, MAX_REPORT_BYTES, (body) => {
      if (body.failed !== undefined) {
        if (body.failed === "too-large") {
          refuse(res, 413, "report too large");
        } else {
          refuse(res, 408, "report timed out");
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
      const report = parseLiveAgentReport(raw);
      if (report === undefined) {
        reply(res, 400, { error: "not a live agent report" });
        return;
      }
      const outcome = options.registry.report(report);
      if (outcome === "full") {
        reply(res, 409, { error: "the office is full" });
        return;
      }
      reply(res, 200, { ok: true, id: report.id, status: report.status });
    });
  };
}

export interface AssignmentEndpointOptions {
  /** The same secret the report route takes. */
  readonly secret: string;
  readonly queue: Pick<LiveAssignmentQueue, "collect">;
  /** Milliseconds, for the rate limit. Injected so a test controls the clock. */
  readonly now?: () => number;
}

/**
 * Builds the collection route's handler.
 *
 * Refused exactly as a report is — method, then secret, then rate — and the
 * queue is only drained once all three have passed, so a refused request never
 * costs the orchestrator an assignment. The request body is never read, and
 * the reply closes the connection, so a sender cannot park one on it.
 */
export function createAssignmentEndpoint(options: AssignmentEndpointOptions): RouteHandler {
  const expected = digest(options.secret);
  const now = options.now ?? (() => Date.now());
  const bucket: TokenBucket = createTokenBucket(COLLECT_BURST, COLLECT_REFILL_PER_SECOND, now());

  return (req, res) => {
    if (req.method !== "POST") {
      refuse(res, 405, "method not allowed", { Allow: "POST" });
      return;
    }
    if (!isAuthorized(req, expected)) {
      refuse(res, 401, "unauthorized", { "WWW-Authenticate": "Bearer" });
      return;
    }
    if (!tryConsume(bucket, now())) {
      refuse(res, 429, "too many collections", { "Retry-After": "1" });
      return;
    }
    const assignments = options.queue.collect().map(toWire);
    reply(res, 200, { assignments }, { Connection: "close" });
  };
}
