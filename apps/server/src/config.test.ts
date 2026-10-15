/**
 * The origin allowlist is the piece of deployment configuration that is a
 * security boundary rather than a convenience. Each case below is a claim the
 * README makes about `ALLOWED_ORIGINS`, or about the project board's
 * `PROJECT_BOARD_*` variables and `AGENT_COUNT`, which refuse to start the
 * server when they are wrong rather than polling a repository nobody meant or
 * hiring a staff nobody asked for, or about the live agents' `LIVE_AGENTS_*`,
 * which refuse a secret too short to be one. The agent work variables follow
 * the same rule: a model mode with no key stops the boot, not a ticket, and so
 * do the AI manager's `MOCK_MANAGER` and `MANAGER_*`.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_AGENT_COUNT, MAX_AGENT_COUNT } from "@sim/shared";

import {
  isOriginAllowed,
  readAgentCount,
  readAgentDebug,
  readAgentWorkConfig,
  readAllowedOrigins,
  readLiveAgentsConfig,
  readManagerConfig,
  readPort,
  readProjectBoardConfig,
} from "./config.js";

const SITE = "https://office.example.com";

describe("readPort", () => {
  it("defaults when unset or empty", () => {
    expect(readPort({})).toBe(2567);
    expect(readPort({ PORT: "" })).toBe(2567);
  });

  it("reads a platform-assigned port", () => {
    expect(readPort({ PORT: "8080" })).toBe(8080);
  });

  it.each(["0", "70000", "-1", "http"])("rejects %j", (value) => {
    expect(() => readPort({ PORT: value })).toThrow(/PORT/);
  });
});

describe("readAllowedOrigins", () => {
  it("falls back to the dev server when unset, and names no deployed origin", () => {
    const origins = readAllowedOrigins({});
    expect(origins).toContain("http://localhost:5173");
    expect(origins.every((origin) => new URL(origin).hostname !== "")).toBe(true);
    expect(origins).not.toContain("*");
  });

  it("splits a comma-separated list and trims it", () => {
    expect(readAllowedOrigins({ ALLOWED_ORIGINS: ` ${SITE} , https://staging.example.com ` })).toEqual([
      SITE,
      "https://staging.example.com",
    ]);
  });

  it("drops a trailing slash, so config and header spell the origin the same way", () => {
    expect(readAllowedOrigins({ ALLOWED_ORIGINS: `${SITE}/` })).toEqual([SITE]);
  });

  it("keeps a non-default port, which is part of the origin", () => {
    expect(readAllowedOrigins({ ALLOWED_ORIGINS: "http://localhost:4173" })).toEqual([
      "http://localhost:4173",
    ]);
  });

  it("refuses to start on an entry that is not an http(s) origin", () => {
    expect(() => readAllowedOrigins({ ALLOWED_ORIGINS: "office.example.com" })).toThrow();
    expect(() => readAllowedOrigins({ ALLOWED_ORIGINS: "wss://office.example.com" })).toThrow(
      /http\(s\)/,
    );
  });

  it("treats a list of nothing but separators as a misconfiguration", () => {
    expect(() => readAllowedOrigins({ ALLOWED_ORIGINS: " , " })).toThrow(/no origins/);
  });
});

describe("isOriginAllowed", () => {
  const allowed = readAllowedOrigins({ ALLOWED_ORIGINS: SITE });

  it("admits an allowlisted origin", () => {
    expect(isOriginAllowed(SITE, allowed)).toBe(true);
  });

  it("admits a request with no Origin header, which is not a browser", () => {
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
    expect(isOriginAllowed("", allowed)).toBe(true);
  });

  it.each([
    ["another site", "https://evil.example.com"],
    ["the same host over http", "http://office.example.com"],
    ["the same host on another port", "https://office.example.com:8443"],
    ["a subdomain", "https://www.office.example.com"],
    ["a prefix of the host", "https://office.example.com.evil.test"],
    ["the literal null origin a sandboxed page sends", "null"],
  ])("refuses %s", (_label, origin) => {
    expect(isOriginAllowed(origin, allowed)).toBe(false);
  });

  it("refuses everything when the allowlist is empty", () => {
    expect(isOriginAllowed(SITE, [])).toBe(false);
  });
});

describe("readProjectBoardConfig", () => {
  it("defaults to this repository, anonymously, every three minutes", () => {
    expect(readProjectBoardConfig({})).toEqual({
      repository: "krasovsky22/agent-office-sims",
      token: undefined,
      pollIntervalMs: 180_000,
    });
  });

  it("polls every minute by default once a token raises the rate limit", () => {
    expect(readProjectBoardConfig({ PROJECT_BOARD_TOKEN: " ghp_example " })).toMatchObject({
      token: "ghp_example",
      pollIntervalMs: 60_000,
    });
  });

  it("reads a repository and an interval", () => {
    expect(
      readProjectBoardConfig({ PROJECT_BOARD_REPO: "someone/some.repo", PROJECT_BOARD_POLL_SECONDS: "300" }),
    ).toMatchObject({ repository: "someone/some.repo", pollIntervalMs: 300_000 });
  });

  it.each(["off", "agent-office-sims", "a/b/c", "https://github.com/a/b", "a/b c"])(
    "refuses to start on repository %j",
    (value) => {
      expect(() => readProjectBoardConfig({ PROJECT_BOARD_REPO: value })).toThrow(/PROJECT_BOARD_REPO/);
    },
  );

  it.each(["5", "0", "-60", "1.5", "soon"])("refuses to start on interval %j", (value) => {
    expect(() => readProjectBoardConfig({ PROJECT_BOARD_POLL_SECONDS: value })).toThrow(
      /PROJECT_BOARD_POLL_SECONDS/,
    );
  });
});

describe("readAgentWorkConfig", () => {
  it("runs mock agents unless told otherwise", () => {
    expect(readAgentWorkConfig({})).toEqual({ mode: "mock" });
    expect(readAgentWorkConfig({ MOCK_AGENTS: "" })).toEqual({ mode: "mock" });
    expect(readAgentWorkConfig({ MOCK_AGENTS: "on", ANTHROPIC_API_KEY: "k" })).toEqual({ mode: "mock" });
  });

  it("uses the model, with default budgets, when mock is off and a key is present", () => {
    expect(readAgentWorkConfig({ MOCK_AGENTS: "off", ANTHROPIC_API_KEY: " sk-test " })).toEqual({
      mode: "model",
      apiKey: "sk-test",
      model: "claude-opus-5-5",
      callsPerDay: 200,
      callsPerRun: 1000,
    });
  });

  it("reads the model and budgets", () => {
    const config = readAgentWorkConfig({
      MOCK_AGENTS: "off",
      ANTHROPIC_API_KEY: "k",
      AGENT_MODEL: "claude-sonnet-5-5",
      AGENT_CALLS_PER_DAY: "20",
      AGENT_CALLS_PER_RUN: "0",
    });
    expect(config).toMatchObject({ model: "claude-sonnet-5-5", callsPerDay: 20, callsPerRun: 0 });
  });

  it("refuses to start in model mode without a key, and says how to fix it", () => {
    expect(() => readAgentWorkConfig({ MOCK_AGENTS: "off" })).toThrow(/ANTHROPIC_API_KEY.*MOCK_AGENTS on/);
    expect(() => readAgentWorkConfig({ MOCK_AGENTS: "off", ANTHROPIC_API_KEY: "  " })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it.each([
    [{ MOCK_AGENTS: "maybe" }, /MOCK_AGENTS/],
    [{ MOCK_AGENTS: "false", ANTHROPIC_API_KEY: "k" }, /MOCK_AGENTS/],
    [{ MOCK_AGENTS: "off", ANTHROPIC_API_KEY: "k", AGENT_CALLS_PER_DAY: "-1" }, /AGENT_CALLS_PER_DAY/],
    [{ MOCK_AGENTS: "off", ANTHROPIC_API_KEY: "k", AGENT_CALLS_PER_RUN: "lots" }, /AGENT_CALLS_PER_RUN/],
  ])("rejects %j", (env, pattern) => {
    expect(() => readAgentWorkConfig(env)).toThrow(pattern);
  });

  it("never puts the key in an error", () => {
    expect(() =>
      readAgentWorkConfig({ MOCK_AGENTS: "off", ANTHROPIC_API_KEY: "sk-secret", AGENT_CALLS_PER_DAY: "x" }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("sk-secret") }));
  });
});

describe("readManagerConfig", () => {
  it("answers by rule unless told otherwise, even when the agents use a model", () => {
    expect(readManagerConfig({})).toEqual({ mode: "mock" });
    expect(readManagerConfig({ MOCK_MANAGER: " On " })).toEqual({ mode: "mock" });
    expect(readManagerConfig({ MOCK_AGENTS: "off", ANTHROPIC_API_KEY: "k" })).toEqual({ mode: "mock" });
  });

  it("uses the model, with its own default budgets, when mock is off and a key is present", () => {
    expect(readManagerConfig({ MOCK_MANAGER: "off", ANTHROPIC_API_KEY: " sk-test " })).toEqual({
      mode: "model",
      apiKey: "sk-test",
      model: "claude-opus-5-5",
      callsPerDay: 150,
      callsPerRun: 1000,
    });
    expect(
      readManagerConfig({
        MOCK_MANAGER: "off",
        ANTHROPIC_API_KEY: "k",
        MANAGER_MODEL: "claude-sonnet-5-5",
        MANAGER_CALLS_PER_DAY: "5",
        MANAGER_CALLS_PER_RUN: "0",
      }),
    ).toMatchObject({ model: "claude-sonnet-5-5", callsPerDay: 5, callsPerRun: 0 });
  });

  it.each([
    [{ MOCK_MANAGER: "off" }, /ANTHROPIC_API_KEY.*MOCK_MANAGER on/],
    [{ MOCK_MANAGER: "sometimes" }, /MOCK_MANAGER/],
    [{ MOCK_MANAGER: "off", ANTHROPIC_API_KEY: "k", MANAGER_CALLS_PER_DAY: "1.5" }, /MANAGER_CALLS_PER_DAY/],
  ])("rejects %j", (env, pattern) => {
    expect(() => readManagerConfig(env)).toThrow(pattern);
  });

  it("never puts the key in an error", () => {
    expect(() =>
      readManagerConfig({ MOCK_MANAGER: "off", ANTHROPIC_API_KEY: "sk-secret", MANAGER_CALLS_PER_RUN: "x" }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("sk-secret") }));
  });
});

describe("readAgentCount", () => {
  it("defaults when unset or empty", () => {
    expect(readAgentCount({})).toBe(DEFAULT_AGENT_COUNT);
    expect(readAgentCount({ AGENT_COUNT: " " })).toBe(DEFAULT_AGENT_COUNT);
  });

  it("reads any whole count the roster can staff, none included", () => {
    expect(readAgentCount({ AGENT_COUNT: "0" })).toBe(0);
    expect(readAgentCount({ AGENT_COUNT: "3" })).toBe(3);
    expect(readAgentCount({ AGENT_COUNT: String(MAX_AGENT_COUNT) })).toBe(MAX_AGENT_COUNT);
  });

  it.each(["-1", "2.5", "five", String(MAX_AGENT_COUNT + 1)])("rejects %j", (value) => {
    expect(() => readAgentCount({ AGENT_COUNT: value })).toThrow(/AGENT_COUNT/);
  });
});

describe("readAgentDebug", () => {
  it("is off unless asked for, so a deployment never exposes it by accident", () => {
    expect(readAgentDebug({})).toBe(false);
    expect(readAgentDebug({ AGENT_DEBUG: " " })).toBe(false);
    expect(readAgentDebug({ AGENT_DEBUG: "off" })).toBe(false);
  });

  it("turns on by name, in any case", () => {
    expect(readAgentDebug({ AGENT_DEBUG: "on" })).toBe(true);
    expect(readAgentDebug({ AGENT_DEBUG: " ON " })).toBe(true);
  });

  it.each(["yes", "1", "true"])("rejects %j rather than guessing", (value) => {
    expect(() => readAgentDebug({ AGENT_DEBUG: value })).toThrow(/AGENT_DEBUG/);
  });
});

describe("readLiveAgentsConfig", () => {
  it("leaves the report route off without a secret, and times out after a minute", () => {
    expect(readLiveAgentsConfig({})).toEqual({ secret: undefined, timeoutMs: 60_000 });
    expect(readLiveAgentsConfig({ LIVE_AGENTS_SECRET: "  " }).secret).toBeUndefined();
  });

  it("reads a secret and a timeout", () => {
    expect(
      readLiveAgentsConfig({
        LIVE_AGENTS_SECRET: " 0123456789abcdef ",
        LIVE_AGENTS_TIMEOUT_SECONDS: "15",
      }),
    ).toEqual({ secret: "0123456789abcdef", timeoutMs: 15_000 });
  });

  it("refuses a short secret without printing it", () => {
    expect(() => readLiveAgentsConfig({ LIVE_AGENTS_SECRET: "hunter2" })).toThrow(
      /LIVE_AGENTS_SECRET must be at least 16 characters, got 7$/,
    );
  });

  it.each(["4", "1.5", "soon", "-30"])("refuses a timeout of %j", (value) => {
    expect(() => readLiveAgentsConfig({ LIVE_AGENTS_TIMEOUT_SECONDS: value })).toThrow(
      /LIVE_AGENTS_TIMEOUT_SECONDS/,
    );
  });
});
