// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/workers/env.ts. See THIRD_PARTY_NOTICES.md.
/**
 * The environment an agent process starts with: an allowlist of the runner's
 * own, never the whole of it.
 *
 * The runner's environment holds its sync secret and whatever else its
 * operator set, and an agent runs whatever commands its task leads it to, so
 * only what an agent needs passes: where to find programs, its home, its
 * locale, the GitHub CLI's token and its own CLI's credential.
 */

/** Passed through by name, when set. */
const PASSED: ReadonlySet<string> = new Set(["PATH", "HOME", "LANG", "LANGUAGE", "GH_TOKEN"]);

/** Locale categories: `LC_ALL`, `LC_CTYPE` and the rest. */
const LOCALE_PREFIX = "LC_";

export interface ChildEnvOptions {
  /** The agent CLI's credential variables, passed when set: `ANTHROPIC_API_KEY`, say. */
  readonly credentials?: readonly string[];
  /** Never passed, whatever else says so: variables that would make the agent think it runs inside another session. */
  readonly scrub?: readonly string[];
  /** Set on top, for this process only: its terminal type and its hook route. */
  readonly set?: Readonly<Record<string, string>>;
}

/** The agent's environment, from `source` (the runner's own by default). */
export function childEnv(options: ChildEnvOptions = {}, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const credentials = new Set(options.credentials ?? []);
  const scrub = new Set(options.scrub ?? []);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const passed = PASSED.has(name) || name.startsWith(LOCALE_PREFIX) || credentials.has(name);
    if (value !== undefined && passed && !scrub.has(name)) {
      env[name] = value;
    }
  }
  return { ...env, ...options.set };
}
