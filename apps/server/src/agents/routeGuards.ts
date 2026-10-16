/**
 * What every authenticated agent route uses to turn a request away cheaply:
 * the bearer check, the replies, and a body reader with a hard size limit.
 *
 * Shared by the orchestrator's routes (`./endpoint.ts`) and the runner's
 * (`./runnerEndpoint.ts`), so each refuses in the same order and the same way:
 * method, then secret, then size, then rate, before a body is parsed.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** A body that has not finished arriving in this long is abandoned. */
const BODY_TIMEOUT_MS = 5000;

export function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Whether a request carries the secret whose {@link digest} is `expected`.
 *
 * Both sides are hashed first, so the comparison is of two equal-length
 * buffers and takes the same time whatever was sent, including a token of the
 * wrong length.
 */
export function isAuthorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  return timingSafeEqual(digest(header.slice("Bearer ".length)), expected);
}

export function reply(
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
export function refuse(
  res: ServerResponse,
  status: number,
  error: string,
  headers: Record<string, string> = {},
): void {
  reply(res, status, { error }, { Connection: "close", ...headers });
}

/** Whether a request's declared length is already over `maxBytes`. */
export function declaresTooMuch(req: IncomingMessage, maxBytes: number): boolean {
  const declared = Number(req.headers["content-length"] ?? 0);
  return Number.isFinite(declared) && declared > maxBytes;
}

export type Body =
  | { readonly failed: undefined; readonly text: string }
  | { readonly failed: "too-large" | "timed-out" };

/**
 * Collects a request body up to `maxBytes`.
 *
 * Calls back exactly once, and stops reading the moment the limit is passed,
 * so a sender streaming without end holds nothing but a socket that is about
 * to be closed. A body that stalls is abandoned after {@link BODY_TIMEOUT_MS}.
 */
export function readBody(req: IncomingMessage, maxBytes: number, done: (body: Body) => void): void {
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
    if (size > maxBytes) {
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
