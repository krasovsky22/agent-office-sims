/**
 * The HTTP route an agent orchestrator reports its agents through.
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
 * The secret is compared in constant time, and it is never echoed, logged, or
 * sent anywhere a client can read.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { parseLiveAgentReport } from "@sim/shared";

import type { RouteHandler } from "../http.js";
import { type TokenBucket, createTokenBucket, tryConsume } from "../sim/expression.js";
import type { LiveAgentRegistry } from "./registry.js";

export const LIVE_AGENT_REPORT_PATH = "/agents/report";

/** Far above any real report, which is a few hundred bytes. */
export const MAX_REPORT_BYTES = 4096;

/** A body that has not finished arriving in this long is abandoned. */
const BODY_TIMEOUT_MS = 5000;

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

export interface LiveAgentEndpointOptions {
  /** The shared secret an orchestrator sends as a bearer token. */
  readonly secret: string;
  readonly registry: Pick<LiveAgentRegistry, "report">;
  /** Milliseconds, for the rate limit. Injected so a test controls the clock. */
  readonly now?: () => number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Whether a request carries the secret.
 *
 * Both sides are hashed first, so the comparison is of two equal-length
 * buffers and takes the same time whatever was sent, including a token of the
 * wrong length.
 */
function isAuthorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  return timingSafeEqual(digest(header.slice("Bearer ".length)), expected);
}

function reply(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(text);
}

/**
 * Turns a request away without reading what it is sending.
 *
 * `Connection: close` so the socket goes with the reply, rather than Node
 * draining an unwanted body to keep the connection alive for the next one.
 */
function refuse(
  res: ServerResponse,
  status: number,
  error: string,
  headers: Record<string, string> = {},
): void {
  reply(res, status, { error }, { Connection: "close", ...headers });
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
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) {
      refuse(res, 413, "report too large");
      return;
    }
    if (!tryConsume(bucket, now())) {
      refuse(res, 429, "too many reports", { "Retry-After": "1" });
      return;
    }

    readBody(req, (body) => {
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

type Body =
  | { readonly failed: undefined; readonly text: string }
  | { readonly failed: "too-large" | "timed-out" };

/**
 * Collects a request body up to {@link MAX_REPORT_BYTES}.
 *
 * Calls back exactly once, and stops reading the moment the limit is passed,
 * so a sender streaming without end holds nothing but a socket that is about
 * to be closed. A body that stalls is abandoned after {@link BODY_TIMEOUT_MS}.
 */
function readBody(req: IncomingMessage, done: (body: Body) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const timer = setTimeout(() => {
    finish({ failed: "timed-out" });
  }, BODY_TIMEOUT_MS);
  timer.unref();

  function finish(body: Body): void {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    done(body);
  }

  req.on("data", (chunk: Buffer) => {
    if (settled) {
      return;
    }
    size += chunk.length;
    if (size > MAX_REPORT_BYTES) {
      finish({ failed: "too-large" });
      req.pause();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    finish({ failed: undefined, text: Buffer.concat(chunks).toString("utf8") });
  });
  req.on("error", () => {
    settled = true;
    clearTimeout(timer);
  });
}
