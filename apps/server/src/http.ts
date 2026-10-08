/**
 * The HTTP half of the listener.
 *
 * The WebSocket transport and the matchmaking endpoint already share one port,
 * and a hosting platform needs a plain HTTP URL it can probe to decide whether
 * this process is alive. That is the whole HTTP surface: a health check, and a
 * 404 for everything else. The client bundle is served as static files from
 * somewhere else entirely.
 *
 * **Order matters.** `new Server({ transport })` takes over the transport's
 * `request` event and re-dispatches anything that is not a matchmaking URL to
 * the listeners that were already attached. So the health route has to be on
 * this server before the Colyseus `Server` is constructed, or it never runs.
 */

import { type Server as HttpServer, type IncomingMessage, type ServerResponse, createServer } from "node:http";

export const HEALTH_PATH = "/health";

/**
 * Creates the HTTP server the transport will listen on, with the health route
 * already attached.
 */
export function createHealthServer(): HttpServer {
  const server = createServer();
  server.on("request", handleRequest);
  return server;
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (pathOf(req.url) !== HEALTH_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" });
    res.end("method not allowed\n");
    return;
  }

  // Deliberately says nothing about the rooms inside. The probe runs every few
  // seconds and only ever needs to know that the process is answering; reading
  // room state to answer it would put the health check on the path of the
  // simulation rather than beside it.
  const body = `${JSON.stringify({ status: "ok" })}\n`;
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/** The path alone, since probes and proxies both append query strings. */
function pathOf(url: string | undefined): string {
  if (url === undefined) {
    return "";
  }
  const queryAt = url.indexOf("?");
  return queryAt === -1 ? url : url.slice(0, queryAt);
}
