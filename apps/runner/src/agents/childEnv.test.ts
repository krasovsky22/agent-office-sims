/**
 * An agent's environment holds only what it needs of the runner's: never
 * its sync secret, and never a parent session's markers.
 */

import { describe, expect, it } from "vitest";

import { childEnv } from "./childEnv.js";

const RUNNER_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/runner",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  GH_TOKEN: "gh-token",
  ANTHROPIC_API_KEY: "claude-key",
  RUNNER_SECRET: "the-runner-secret",
  AWS_SECRET_ACCESS_KEY: "aws",
  CLAUDECODE: "1",
  SHELL: "/bin/zsh",
  TERM: "screen",
};

describe("childEnv", () => {
  it("passes PATH, HOME, the locale and GH_TOKEN, and nothing else by default", () => {
    expect(childEnv({}, RUNNER_ENV)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/runner",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      GH_TOKEN: "gh-token",
    });
  });

  it("passes the agent's credential, and never what it scrubs", () => {
    const env = childEnv({ credentials: ["ANTHROPIC_API_KEY", "CLAUDECODE"], scrub: ["CLAUDECODE"] }, RUNNER_ENV);
    expect(env["ANTHROPIC_API_KEY"]).toBe("claude-key");
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("RUNNER_SECRET");
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it("sets its own variables on top", () => {
    const env = childEnv({ set: { TERM: "xterm-256color", SIMS_HOOK_URL: "http://127.0.0.1:1" } }, RUNNER_ENV);
    expect(env["TERM"]).toBe("xterm-256color");
    expect(env["SIMS_HOOK_URL"]).toBe("http://127.0.0.1:1");
  });
});
