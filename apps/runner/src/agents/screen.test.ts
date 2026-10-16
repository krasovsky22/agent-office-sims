/**
 * The screen reader finds OSC 9;4 progress however the output is cut into
 * chunks, and keeps the output as text a person would read on the screen.
 */

import { describe, expect, it } from "vitest";

import { ScreenReader } from "./screen.js";

describe("ScreenReader", () => {
  it("reads OSC 9;4 progress: 0 is idle, anything else busy, the last one in a chunk counting", () => {
    const screen = new ScreenReader();
    expect(screen.feed("hello")).toBeUndefined();
    expect(screen.feed("\x1b]9;4;3;\x07")).toBe(true);
    expect(screen.feed("\x1b]9;4;1;40\x1b\\")).toBe(true);
    expect(screen.feed("\x1b]9;4;0;\x07")).toBe(false);
    expect(screen.feed("\x1b]9;4;3;\x07 then \x1b]9;4;0;\x07")).toBe(false);
  });

  it("ignores other OSC 9 messages", () => {
    expect(new ScreenReader().feed("\x1b]9;Build finished\x07")).toBeUndefined();
  });

  it("holds back a sequence cut across chunks until the rest arrives", () => {
    const screen = new ScreenReader();
    expect(screen.feed("before\x1b]9;4")).toBeUndefined();
    expect(screen.feed(";3")).toBeUndefined();
    expect(screen.feed(";\x07after\x1b")).toBe(true);
    expect(screen.feed("[2mdim")).toBeUndefined();
    expect(screen.text).toBe("beforeafterdim");
  });

  it("keeps the output as plain text, cursor moves read as spaces and line breaks", () => {
    const screen = new ScreenReader();
    screen.feed("\x1b[?25l\x1b[1;1H\x1b[38;5;208mDo\x1b[1Cyou trust\x1b[0m the files\x1b[2;1H in this folder?\r\n\x1b(B> 1. Yes\x07");
    expect(screen.text).toBe("\nDo you trust the files\n in this folder?\n> 1. Yes");
  });

  it("keeps only recent output, and forgets it when cleared", () => {
    const screen = new ScreenReader();
    screen.feed("x".repeat(5000));
    expect(screen.text).toHaveLength(4096);
    screen.clear();
    expect(screen.text).toBe("");
  });
});
