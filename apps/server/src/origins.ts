/**
 * Who is allowed to talk to this server, enforced in the two places a browser
 * actually reaches it.
 *
 * Joining a room is two requests, not one. First an HTTP POST to
 * `/matchmake/joinOrCreate/office`, which hands back a seat reservation; then a
 * WebSocket upgrade carrying that reservation. Colyseus leaves both open by
 * default — it echoes whatever `Origin` it is given back as
 * `Access-Control-Allow-Origin`, which is a wildcard wearing a disguise, and
 * the upgrade is not checked at all.
 *
 * So both get the allowlist:
 *
 * - the matchmaking response is only made readable to an allowed origin, which
 *   is all CORS can ever do, since the request itself has already run;
 * - the upgrade is refused outright for a disallowed origin, which is the gate
 *   that matters — without a socket there is no room.
 *
 * Neither is a defence against a non-browser client, and nothing here pretends
 * to be: `Origin` is a header a browser attaches and a browser enforces. This
 * keeps someone else's page from quietly driving your office, which is the
 * threat a prototype with no accounts actually has.
 */

import { matchMaker } from "@colyseus/core";
import type { IncomingMessage } from "node:http";

import { DISALLOWED_ORIGIN, isOriginAllowed } from "./config.js";

/**
 * Narrows the matchmaking endpoint's cross-origin headers to `allowedOrigins`.
 *
 * Mutates the shared controller, so it has to run before the server starts
 * answering requests. Colyseus merges this over its own permissive defaults,
 * which is why a disallowed origin gets {@link DISALLOWED_ORIGIN} rather than
 * no header at all: the key is already in the default set and the merge can
 * only overwrite it, never remove it.
 */
export function restrictMatchmakingOrigins(allowedOrigins: readonly string[]): void {
  matchMaker.controller.getCorsHeaders = (req: IncomingMessage): Record<string, string> => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      // No browser involved, so there is no cross-origin reply to withhold.
      return {};
    }
    if (!isOriginAllowed(origin, allowedOrigins)) {
      return { "Access-Control-Allow-Origin": DISALLOWED_ORIGIN };
    }
    // `Vary` because the answer depends on the request's origin, and a cache in
    // front of this must not hand one origin's response to another.
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  };
}

/**
 * The `ws` handshake check: `true` accepts the upgrade, `false` answers 401.
 *
 * `info.origin` is typed as a string but is absent for any client that does not
 * send the header, which {@link isOriginAllowed} treats as not-a-browser.
 */
export function verifyOrigin(
  allowedOrigins: readonly string[],
): (info: { origin: string; secure: boolean; req: IncomingMessage }) => boolean {
  return (info) => isOriginAllowed(info.origin, allowedOrigins);
}
