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

import { AGENT_KEYS } from "./agentPrompt.js";
import { MAX_AGENT_DESCRIPTION_BYTES } from "./agentProfile.js";
import { MAX_AGENT_PROMPT_LENGTH, MAX_CHAT_LENGTH } from "./constants.js";
import {
  EMOTE,
  MAX_TITLE_LENGTH,
  EMOTES,
  parseAgentKeyMessage,
  parseAgentProfileMessage,
  parseAgentPromptMessage,
  parseChatMessage,
  parseDeskTerminalSizeMessage,
  parseEmoteMessage,
  parseInteractMessage,
  parsePoseMessage,
  sanitizeChatText,
  sanitizeName,
  sanitizePromptText,
  sanitizeTitle,
} from "./messages.js";
import { MAX_SCREEN_COLS, MAX_SCREEN_ROWS, MIN_TERMINAL_COLS, MIN_TERMINAL_ROWS } from "./screens.js";
import { ANIMATION_STATE } from "./state.js";

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

describe("the one-line sanitizers", () => {
  it("strip C1 controls and the bidi marks from a name, a chat line and a title", () => {
    for (const sanitize of [sanitizeName, sanitizeChatText, sanitizeTitle]) {
      expect(sanitize("ab\u202ecd\u2066e\u0085f\u200eg")).toBe("ab cd e f g");
    }
  });

  it("cut a title between emoji, never inside one", () => {
    const title = sanitizeTitle(`a${"\u{1f600}".repeat(MAX_TITLE_LENGTH)}`);
    expect(Array.from(title)).toHaveLength(MAX_TITLE_LENGTH);
    expect(title.endsWith("\u{1f600}")).toBe(true);
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

describe("parsePoseMessage", () => {
  for (const animation of [ANIMATION_STATE.idle, ANIMATION_STATE.walking]) {
    it(`accepts a pose reporting ${animation}`, () => {
      expect(parsePoseMessage({ x: 1, z: 2, yaw: 0, animation })).toEqual({
        x: 1,
        z: 2,
        yaw: 0,
        animation,
      });
    });
  }

  // Sitting is the server's consequence of a granted interact. A client that
  // could report it would be seated at a desk from across the room.
  for (const animation of [ANIMATION_STATE.sitting, ANIMATION_STATE.typing]) {
    it(`rejects a pose claiming ${animation}`, () => {
      expect(parsePoseMessage({ x: 1, z: 2, yaw: 0, animation })).toBeUndefined();
    });
  }
});

describe("parseInteractMessage", () => {
  it("accepts a target id", () => {
    expect(parseInteractMessage({ target: "seat-desk-north-1-1" })).toEqual({
      target: "seat-desk-north-1-1",
    });
  });

  it("carries only the target, whatever else the client sends", () => {
    expect(parseInteractMessage({ target: "coffee-machine", x: 0, z: 0, seated: true })).toEqual({
      target: "coffee-machine",
    });
  });

  const rejected: readonly [string, unknown][] = [
    ["an empty target", { target: "" }],
    ["an over-long target", { target: "x".repeat(65) }],
    ["a non-string target", { target: 7 }],
    ["a missing target", {}],
    ["a bare string", "coffee-machine"],
    ["null", null],
  ];

  for (const [description, raw] of rejected) {
    it(`rejects ${description}`, () => {
      expect(parseInteractMessage(raw)).toBeUndefined();
    });
  }
});

describe("sanitizePromptText", () => {
  it("keeps printable text and its lines", () => {
    expect(sanitizePromptText("  Yes, cover the empty case.\nThen push.  ")).toBe("Yes, cover the empty case.\nThen push.");
    expect(sanitizePromptText("ünïcode — ok ✓")).toBe("ünïcode — ok ✓");
  });

  it("normalises line endings and turns a tab into a space", () => {
    expect(sanitizePromptText("one\r\ntwo\rthree\tfour")).toBe("one\ntwo\nthree four");
  });

  it("drops every control character, so nothing can end the paste it is typed in", () => {
    const hostile = "ok\u001b[201~\u0003\u0004\u0007\u0008\u007f\u0085\u009b31m\u0000done";
    const clean = sanitizePromptText(hostile);
    expect(clean).toBe("ok[201~31mdone");
    // eslint-disable-next-line no-control-regex -- checking for control characters is the point
    expect(clean).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });

  it("drops the marks that reorder text for whoever reads it", () => {
    expect(sanitizePromptText("a‮b⁦c‏d")).toBe("abcd");
  });

  it("is empty for anything that is not a string", () => {
    expect(sanitizePromptText(42)).toBe("");
    expect(sanitizePromptText(undefined)).toBe("");
  });
});

describe("parseAgentPromptMessage", () => {
  const agentId = "agent:runner:host-1:slot-1";

  it("accepts a prompt for an agent, sanitized", () => {
    expect(parseAgentPromptMessage({ agentId, text: "  answer:\r\nyes\u0007 " })).toEqual({ agentId, text: "answer:\nyes" });
  });

  it("accepts a prompt of exactly the longest length", () => {
    const text = "x".repeat(MAX_AGENT_PROMPT_LENGTH);
    expect(parseAgentPromptMessage({ agentId, text })?.text).toBe(text);
  });

  const rejected: readonly [string, unknown][] = [
    ["a prompt past the longest length", { agentId, text: "x".repeat(MAX_AGENT_PROMPT_LENGTH + 1) }],
    ["a prompt of control characters only", { agentId, text: "\u001b\u0000\n\t " }],
    ["an empty prompt", { agentId, text: "" }],
    ["a prompt that is not a string", { agentId, text: ["yes"] }],
    ["no agent", { text: "yes" }],
    ["an empty agent id", { agentId: "", text: "yes" }],
    ["an agent id past any occupant key", { agentId: "a".repeat(97), text: "yes" }],
    ["an agent id that is not a string", { agentId: 7, text: "yes" }],
    ["null", null],
    ["a bare string", "yes"],
  ];
  for (const [label, raw] of rejected) {
    it(`rejects ${label}`, () => {
      expect(parseAgentPromptMessage(raw)).toBeUndefined();
    });
  }
});

describe("parseDeskTerminalSizeMessage", () => {
  it("accepts a whole size within what a terminal may be given", () => {
    expect(parseDeskTerminalSizeMessage({ cols: 150, rows: 40 })).toEqual({ cols: 150, rows: 40 });
    expect(parseDeskTerminalSizeMessage({ cols: MIN_TERMINAL_COLS, rows: MAX_SCREEN_ROWS })).toEqual({ cols: MIN_TERMINAL_COLS, rows: MAX_SCREEN_ROWS });
  });

  const rejected: readonly [string, unknown][] = [
    ["nothing", undefined],
    ["a size as text", { cols: "150", rows: 40 }],
    ["part of a cell", { cols: 150.5, rows: 40 }],
    ["wider than a frame carries", { cols: MAX_SCREEN_COLS + 1, rows: 40 }],
    ["too narrow to lay out", { cols: MIN_TERMINAL_COLS - 1, rows: 40 }],
    ["too short to lay out", { cols: 150, rows: MIN_TERMINAL_ROWS - 1 }],
  ];
  for (const [label, raw] of rejected) {
    it(`rejects ${label}`, () => {
      expect(parseDeskTerminalSizeMessage(raw)).toBeUndefined();
    });
  }
});

describe("parseAgentKeyMessage", () => {
  const agentId = "agent:runner:host-1:slot-1";

  for (const key of AGENT_KEYS) {
    it(`accepts ${key}`, () => {
      expect(parseAgentKeyMessage({ agentId, key })).toEqual({ agentId, key });
    });
  }

  const rejected: readonly [string, unknown][] = [
    ["a key that types text", { agentId, key: "y" }],
    ["a raw escape sequence", { agentId, key: "\u001b[A" }],
    ["a digit past the choices", { agentId, key: "0" }],
    ["a key that is not a string", { agentId, key: 1 }],
    ["no key", { agentId }],
    ["no agent", { key: "enter" }],
    ["an agent id past any occupant key", { agentId: "a".repeat(97), key: "enter" }],
    ["null", null],
  ];
  for (const [label, raw] of rejected) {
    it(`rejects ${label}`, () => {
      expect(parseAgentKeyMessage(raw)).toBeUndefined();
    });
  }
});

describe("parseAgentProfileMessage", () => {
  const MESSAGE = { agentId: "agent:runner:box:slot-1", name: "Grace", title: "Release Engineer", description: "Keeps it green." };

  it("reads an edit, sanitised", () => {
    expect(parseAgentProfileMessage({ ...MESSAGE, name: " Grace " })).toEqual(MESSAGE);
  });

  it.each([
    ["not an object", "Grace"],
    ["no agent", { ...MESSAGE, agentId: "" }],
    ["an agent key longer than any", { ...MESSAGE, agentId: "a".repeat(97) }],
    ["a name that is not a string", { ...MESSAGE, name: ["Grace"] }],
    ["no description at all", { agentId: MESSAGE.agentId, name: "Grace", title: "Release Engineer" }],
    ["a description far past its budget", { ...MESSAGE, description: "d".repeat(4 * MAX_AGENT_DESCRIPTION_BYTES + 1) }],
    ["an empty title", { ...MESSAGE, title: "" }],
  ])("refuses %s", (_label, raw) => {
    expect(parseAgentProfileMessage(raw)).toBeUndefined();
  });
});
