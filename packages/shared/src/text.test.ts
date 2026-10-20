/**
 * The text policy every sanitizer shares. Control characters are written as
 * escapes, so a reader can tell which one a case is about.
 */

import { describe, expect, it } from "vitest";

import { MAX_ISSUE_NUMBER, asRecord, hasControls, isIssueNumber, replaceControls, truncate } from "./text.js";

describe("replaceControls", () => {
  it("replaces C0, DEL, C1 and every bidi mark", () => {
    const controls = "\u0000\u001f\u007f\u0080\u009f‎‏‪‮⁦⁩";
    expect(replaceControls(`a${controls}b`, "")).toBe("ab");
    expect(replaceControls("a‮b", " ")).toBe("a b");
  });

  it("keeps printable text, including right-to-left letters", () => {
    expect(replaceControls("café שלום \u{1f600}", "")).toBe("café שלום \u{1f600}");
  });

  it("lets newlines through only when asked", () => {
    expect(replaceControls("a\nb\tc", " ")).toBe("a b c");
    expect(replaceControls("a\nb\tc", " ", true)).toBe("a\nb c");
  });
});

describe("hasControls", () => {
  it("finds a control on every call, not only the first", () => {
    expect(hasControls("a‮b")).toBe(true);
    expect(hasControls("a‮b")).toBe(true);
    expect(hasControls("plain")).toBe(false);
  });
});

describe("truncate", () => {
  it("counts code points, so an emoji is kept whole or not at all", () => {
    expect(truncate("ab\u{1f600}\u{1f600}", 3)).toBe("ab\u{1f600}");
    expect(truncate("short", 10)).toBe("short");
  });
});

describe("asRecord", () => {
  it("takes an object and refuses null, arrays and primitives", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    for (const raw of [null, undefined, [], [1], "x", 1]) {
      expect(asRecord(raw)).toBeUndefined();
    }
  });
});

describe("isIssueNumber", () => {
  it("takes a positive whole number up to the uint32 cap", () => {
    expect(isIssueNumber(1)).toBe(true);
    expect(isIssueNumber(MAX_ISSUE_NUMBER)).toBe(true);
    for (const value of [0, -1, 1.5, MAX_ISSUE_NUMBER + 1, Number.NaN, "1"]) {
      expect(isIssueNumber(value)).toBe(false);
    }
  });
});
