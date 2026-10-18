/**
 * The panel's view of a terminal: which rows it shows, scrolled how far, at
 * what size, and what a wheel does to it.
 */

import type { ScreenRun } from "@sim/shared";
import { describe, expect, it } from "vitest";

import type { TerminalScreen } from "./net/screens.js";
import type { ScreenContext } from "./scene/agentScreen.js";
import {
  TERMINAL_FONT_PX,
  paintTerminal,
  screenRowsShown,
  terminalRow,
  terminalViewport,
  wheelRows,
} from "./terminalView.js";

const plain = (text: string): ScreenRun[] => [[text, -1, -1, 0]];

function screenOf(
  lines: Record<number, readonly ScreenRun[]>,
  history: (readonly ScreenRun[])[] = [],
  cursor: readonly [number, number] = [0, 0],
  cols = 100,
  rows = 30,
): TerminalScreen {
  const all: (readonly ScreenRun[] | undefined)[] = [];
  for (const [row, runs] of Object.entries(lines)) {
    all[Number(row)] = runs;
  }
  return { cols, rows, lines: all, cursor, history, historyAdded: history.length, version: 1 };
}

/** A context that keeps the text drawn and where, and the last font. */
function fakeContext(): ScreenContext & { readonly texts: { text: string; y: number }[] } {
  const texts: { text: string; y: number }[] = [];
  return {
    texts,
    fillStyle: "",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    fillRect() {},
    fillText(text: string, _x: number, y: number) {
      texts.push({ text, y });
    },
  };
}

describe("screenRowsShown", () => {
  it("leaves out the blank rows below the cursor and the last row with anything in it", () => {
    expect(screenRowsShown(screenOf({ 0: plain("$ ls") }, [], [2, 0]))).toBe(1);
    expect(screenRowsShown(screenOf({ 0: plain("$ ls"), 4: plain("done"), 5: plain("  ") }, [], [0, 2]))).toBe(5);
    expect(screenRowsShown(screenOf({ 0: plain("$") }, [], [0, 9]))).toBe(10);
    expect(screenRowsShown(screenOf({ 29: [[" ", -1, 4, 0]] }))).toBe(30);
  });
});

describe("terminalRow", () => {
  it("reads the scrollback, then the screen", () => {
    const screen = screenOf({ 0: plain("screen") }, [plain("old"), plain("older")]);
    expect(terminalRow(screen, 0)).toEqual(plain("old"));
    expect(terminalRow(screen, 1)).toEqual(plain("older"));
    expect(terminalRow(screen, 2)).toEqual(plain("screen"));
  });
});

describe("terminalViewport", () => {
  it("shows the newest rows unscrolled, and holds a scroll to what there is", () => {
    expect(terminalViewport(100, 30, 0)).toEqual({ first: 70, offset: 0, maxOffset: 70 });
    expect(terminalViewport(100, 30, 10)).toEqual({ first: 60, offset: 10, maxOffset: 70 });
    expect(terminalViewport(100, 30, 500)).toEqual({ first: 0, offset: 70, maxOffset: 70 });
    expect(terminalViewport(100, 30, Number.POSITIVE_INFINITY)).toEqual({ first: 0, offset: 70, maxOffset: 70 });
    expect(terminalViewport(100, 30, -4)).toEqual({ first: 70, offset: 0, maxOffset: 70 });
    expect(terminalViewport(10, 30, 5)).toEqual({ first: 0, offset: 0, maxOffset: 0 });
  });
});

describe("wheelRows", () => {
  it("scrolls back for a wheel turned up, and forward for one turned down, in pixels, lines or pages", () => {
    expect(wheelRows(-42, 0, 14, 30)).toBe(3);
    expect(wheelRows(28, 0, 14, 30)).toBe(-2);
    expect(wheelRows(-3, 1, 14, 30)).toBe(3);
    expect(wheelRows(1, 2, 14, 30)).toBe(-30);
  });
});

describe("paintTerminal", () => {
  const history = Array.from({ length: 200 }, (_, row) => plain(`history ${row}`));
  const screen = screenOf({ 0: plain("$ claude"), 1: plain("● Working") }, history, [0, 1]);

  it("paints the newest rows at the panel's small size, as many as fit", () => {
    const ctx = fakeContext();
    const layout = paintTerminal(ctx, 1000, 400, 1, screen, 0);
    expect(ctx.font).toContain(`${TERMINAL_FONT_PX}px`);
    expect(layout.visibleRows).toBe(Math.floor((400 - 16) / (TERMINAL_FONT_PX * 1.25)));
    expect(layout.offset).toBe(0);
    const texts = ctx.texts.map((drawn) => drawn.text);
    expect(texts.at(-1)).toBe("● Working");
    expect(texts).toHaveLength(layout.visibleRows);
    expect(texts[0]).toBe(`history ${202 - layout.visibleRows}`);
  });

  it("paints older rows scrolled back, says how far, and holds the scroll to the oldest", () => {
    const back = fakeContext();
    paintTerminal(back, 1000, 400, 1, screen, 50);
    expect(back.texts.map((drawn) => drawn.text)).toContain("history 151");
    expect(back.texts.map((drawn) => drawn.text)).not.toContain("● Working");
    expect(back.texts.at(-1)?.text).toMatch(/^50 lines below/);

    const oldest = fakeContext();
    const layout = paintTerminal(oldest, 1000, 400, 1, screen, 10_000);
    expect(layout.offset).toBe(202 - layout.visibleRows);
    expect(oldest.texts[0]?.text).toBe("history 0");
  });

  it("paints a short terminal from the top, with nothing to scroll", () => {
    const ctx = fakeContext();
    const layout = paintTerminal(ctx, 2000, 400, 2, screenOf({ 0: plain("$ ls") }), 5);
    expect(layout.offset).toBe(0);
    // At twice the pixels: below the padding, centred in its line.
    const fontSize = TERMINAL_FONT_PX * 2;
    expect(ctx.texts).toEqual([{ text: "$ ls", y: 16 + (fontSize * 1.25 - fontSize) / 2 }]);
  });

  it("shrinks the text only when the terminal's full width would not fit", () => {
    const ctx = fakeContext();
    paintTerminal(ctx, 500, 400, 1, screen, 0);
    const size = Number(/ ([\d.]+)px/.exec(ctx.font)?.[1]);
    expect(size).toBeLessThan(TERMINAL_FONT_PX);
    expect(size * 0.6 * 100).toBeLessThanOrEqual(500 - 16 - 5);
  });
});
