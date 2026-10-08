/**
 * The origin allowlist is the one piece of deployment configuration that is a
 * security boundary rather than a convenience, so it is the one piece with
 * tests. Each case below is a claim the README makes about `ALLOWED_ORIGINS`.
 */

import { describe, expect, it } from "vitest";

import { isOriginAllowed, readAllowedOrigins, readPort } from "./config.js";

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
