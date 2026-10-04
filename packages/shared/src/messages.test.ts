/**
 * The parsers are the only thing standing between a hostile payload and the
 * rest of the server, so the cases here are mostly the payloads a browser would
 * never send by accident.
 *
 * Control characters are written as escapes rather than literals: a literal one
 * in this file would be invisible to the next reader, who would have no way to
 * tell which character a case is about.
 */

import { describe, expect, it } from "vitest";

import { MAX_CHAT_LENGTH } from "./constants.js";
import {
  EMOTE,
  EMOTES,
  parseChatMessage,
  parseEmoteMessage,
  sanitizeChatText,
} from "./messages.js";

describe("parseEmoteMessage", () => {
  for (const emote of EMOTES) {
    it(`accepts ${emote}`, () => {
      expect(parseEmoteMessage({ emote })).toEqual({ emote });
    });
  }

  const rejected: readonly [string, unknown][] = [
    ["an emote outside the vocabulary", { emote: "dab" }],
    ["a non-string emote", { emote: 3 }],
    ["a missing emote", {}],
    ["a bare string", EMOTE.wave],
    ["null", null],
    ["undefined", undefined],
  ];

  for (const [description, raw] of rejected) {
    it(`rejects ${description}`, () => {
      expect(parseEmoteMessage(raw)).toBeUndefined();
    });
  }
});

describe("sanitizeChatText", () => {
  it("keeps an ordinary line unchanged", () => {
    expect(sanitizeChatText("standup in five?")).toBe("standup in five?");
  });

  it("replaces newlines with spaces, so one line cannot become several", () => {
    expect(sanitizeChatText("line one\nline two end")).toBe("line one line two end");
  });

  it("strips the C0 range and DEL", () => {
    expect(sanitizeChatText("a\u0000b\u0007c\u001bd\u007fe")).toBe("a b c d e");
  });

  it("collapses whitespace runs, including tabs", () => {
    expect(sanitizeChatText("  too\t\t  many   gaps  ")).toBe("too many gaps");
  });

  it("truncates to the length cap", () => {
    const text = sanitizeChatText("a".repeat(MAX_CHAT_LENGTH * 3));
    expect(text).toHaveLength(MAX_CHAT_LENGTH);
  });

  it("does not leave a trailing space when truncation lands on one", () => {
    const text = sanitizeChatText(`${"a".repeat(MAX_CHAT_LENGTH - 1)} tail`);
    expect(text.endsWith(" ")).toBe(false);
  });

  it("reduces a line of only control characters to nothing", () => {
    expect(sanitizeChatText("\u0000\u0001\u001b\u007f")).toBe("");
  });

  it("returns nothing for a value that is not a string", () => {
    expect(sanitizeChatText(42)).toBe("");
    expect(sanitizeChatText(undefined)).toBe("");
  });
});

describe("parseChatMessage", () => {
  it("returns the sanitized text", () => {
    expect(parseChatMessage({ text: "  hello   there " })).toEqual({ text: "hello there" });
  });

  it("passes markup through as the text it is", () => {
    // The renderers take text, not markup, so there is nothing to escape; what
    // matters is that the characters survive rather than being mangled.
    const raw = "<script>alert(1)</script>";
    expect(parseChatMessage({ text: raw })).toEqual({ text: raw });
  });

  const rejected: readonly [string, unknown][] = [
    ["an empty message", { text: "" }],
    ["a whitespace-only message", { text: "   \t  " }],
    ["a control-character-only message", { text: "\u0000\u0004\u001f" }],
    ["a non-string message", { text: { toString: () => "nice try" } }],
    ["a missing message", {}],
    ["null", null],
  ];

  for (const [description, raw] of rejected) {
    it(`rejects ${description}`, () => {
      expect(parseChatMessage(raw)).toBeUndefined();
    });
  }
});
