/**
 * Where the client looks for the office.
 *
 * The bundle is static — once built, nothing in it can be reconfigured — so the
 * server URL is baked in at build time from `VITE_SERVER_URL`. That makes the
 * build the last moment anyone can catch a wrong one, which is why the rules
 * live here rather than being discovered as a failed connection in a browser
 * console.
 *
 * This module is imported by both the runtime and `vite.config.ts`, so the URL
 * the build checks and the URL the client dials are the same string decided by
 * the same code.
 */

/** Matches the server's own default port, so `pnpm dev` needs no configuration. */
export const DEV_SERVER_URL = "ws://localhost:2567";

/**
 * Hosts that may be reached over an unencrypted socket.
 *
 * Only a development machine talking to itself. Anywhere else, the page is
 * served over HTTPS and the browser refuses a `ws://` socket from it as mixed
 * content — the connection does not fail slowly or partly, it is never made.
 */
const LOCAL_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]", "::1"];

/** The URL the running client should dial, given what the build baked in. */
export function resolveServerUrl(configured: string | undefined): string {
  return configured === undefined || configured === "" ? DEV_SERVER_URL : configured;
}

/**
 * Checks `VITE_SERVER_URL` for a production build, throwing with the reason.
 *
 * A static bundle that silently defaults to localhost is the worst outcome
 * available: it builds, deploys, serves, and then every visitor gets a
 * connection failure pointing at their own machine. So a build refuses rather
 * than falls back.
 *
 * @returns the URL, unchanged, so a caller can log what it is building against.
 */
export function assertDeployableServerUrl(configured: string | undefined): string {
  if (configured === undefined || configured === "") {
    throw new Error(
      "VITE_SERVER_URL is required for a production build. Set it to the deployed " +
        "server's WebSocket URL, e.g. VITE_SERVER_URL=wss://office.example.com — a " +
        "bundle built without it would ask every visitor's own machine for the office.",
    );
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`VITE_SERVER_URL is not a URL: "${configured}"`);
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(
      `VITE_SERVER_URL must be a ws:// or wss:// URL, got "${configured}". The ` +
        "client speaks Colyseus over a WebSocket; it does not fetch pages from the server.",
    );
  }

  if (url.protocol === "ws:" && !LOCAL_HOSTNAMES.includes(url.hostname)) {
    throw new Error(
      `VITE_SERVER_URL must use wss:// for a remote host, got "${configured}". A page ` +
        "served over HTTPS cannot open an insecure WebSocket, and a hosting platform " +
        "serves the client over HTTPS. The platform proxy terminates TLS, so the server " +
        "itself still listens on plain HTTP behind it.",
    );
  }

  return configured;
}
