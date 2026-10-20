/**
 * The readers both config files lean on: each case is a refusal or default the
 * server and the runner would otherwise each have to get right on their own.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_REPOSITORY, REPOSITORY_PATTERN, readChoice, readWholeNumber } from "./env.js";

describe("REPOSITORY_PATTERN", () => {
  it("takes the default and refuses names past GitHub's lengths", () => {
    expect(REPOSITORY_PATTERN.test(DEFAULT_REPOSITORY)).toBe(true);
    expect(REPOSITORY_PATTERN.test(`${"a".repeat(39)}/${"b".repeat(100)}`)).toBe(true);
    expect(REPOSITORY_PATTERN.test(`${"a".repeat(40)}/b`)).toBe(false);
    expect(REPOSITORY_PATTERN.test(`a/${"b".repeat(101)}`)).toBe(false);
  });
});

describe("readWholeNumber", () => {
  const range = { fallback: 3, min: 1, max: 5, means: "from 1 to 5" };

  it("reads a trimmed number and falls back when unset or blank", () => {
    expect(readWholeNumber({ N: " 4 " }, "N", range)).toBe(4);
    expect(readWholeNumber({}, "N", range)).toBe(3);
    expect(readWholeNumber({ N: "  " }, "N", range)).toBe(3);
  });

  it.each(["0", "6", "1.5", "-1", "two"])("refuses %j, naming the variable", (raw) => {
    expect(() => readWholeNumber({ N: raw }, "N", range)).toThrow(`N must be a whole number from 1 to 5, got "${raw}"`);
  });
});

describe("readChoice", () => {
  const levels = ["info", "debug"] as const;

  it("matches without regard to case and falls back when unset", () => {
    expect(readChoice({ L: " DEBUG " }, "L", levels, "info")).toBe("debug");
    expect(readChoice({}, "L", levels, "info")).toBe("info");
  });

  it("refuses anything else, listing the choices", () => {
    expect(() => readChoice({ L: "trace" }, "L", levels, "info")).toThrow('L must be one of info, debug, got "trace"');
  });
});
