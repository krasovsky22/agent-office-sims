/**
 * Everything the server reads out of its environment, read and validated once
 * at boot.
 *
 * A deployment that is misconfigured should refuse to start rather than start
 * and then refuse every connection: a container that exits with a clear reason
 * is a line in the platform's log, while one that boots healthy and rejects
 * joins looks like a client bug.
 */

const DEFAULT_PORT = 2567;

/**
 * Origins allowed when `ALLOWED_ORIGINS` is unset.
 *
 * Both spellings of the Vite dev server, so `pnpm dev` needs no configuration.
 * A deployment names its own origin instead — this default deliberately does
 * not include one.
 */
const DEV_ORIGINS: readonly string[] = ["http://localhost:5173", "http://127.0.0.1:5173"];

/**
 * What a cross-origin response says when the origin is not on the allowlist.
 *
 * Not `null`: a sandboxed iframe or `data:` URL sends a literal `Origin: null`
 * header, and the Fetch spec's CORS-check matches that against an
 * `Access-Control-Allow-Origin: null` reply. This string can never be a real
 * request's serialized origin, so no browser's CORS check can ever match it.
 * The socket upgrade is the real gate; this only stops the matchmaking reply
 * from being readable.
 */
export const DISALLOWED_ORIGIN = "https://disallowed.invalid";

export interface ServerConfig {
  readonly port: number;
  /** Origins permitted to matchmake and open a socket, already normalized. */
  readonly allowedOrigins: readonly string[];
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: readPort(env),
    allowedOrigins: readAllowedOrigins(env),
  };
}

export function readPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["PORT"];
  if (raw === undefined || raw === "") {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`PORT must be a valid port number, got "${raw}"`);
  }
  return parsed;
}

/**
 * Parses `ALLOWED_ORIGINS`, a comma-separated list of origins.
 *
 * There is no wildcard. An origin the operator did not write down is one the
 * browser cannot use, which is the whole point of the variable existing.
 */
export function readAllowedOrigins(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env["ALLOWED_ORIGINS"];
  if (raw === undefined || raw.trim() === "") {
    return DEV_ORIGINS;
  }

  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(normalizeOrigin);

  if (origins.length === 0) {
    throw new Error("ALLOWED_ORIGINS was set but listed no origins");
  }
  return origins;
}

/**
 * Whether a request carrying this `Origin` header may talk to the room.
 *
 * An absent header is allowed. `Origin` is something browsers attach and
 * browsers enforce; a request without one is not a page acting on a user's
 * behalf, so there is no cross-origin trust to withhold from it. Everything
 * else must match an allowlisted origin exactly, scheme and port included.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === undefined || origin === "") {
    return true;
  }
  let normalized: string;
  try {
    normalized = normalizeOrigin(origin);
  } catch {
    // Not a parseable origin, so it matches nothing on the list.
    return false;
  }
  return allowedOrigins.includes(normalized);
}

/**
 * Reduces an origin to the `scheme://host[:port]` form the `Origin` header
 * uses, so that a configured `https://office.example.com/` and a browser's
 * `https://office.example.com` are the same entry.
 */
function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`"${value}" is not a valid origin (expected e.g. https://office.example.com)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`"${value}" is not an http(s) origin`);
  }
  return `${url.protocol}//${url.host}`;
}
