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
  type TerminalScroll,
  scrollTerminal,
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
  return { cols, rows, lines: all, cursor, history, historyAdded: history.length, historyEpoch: 0, version: 1 };
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
    expect(terminalViewport(100, 30, undefined)).toEqual({ first: 70, top: undefined, bottom: 70 });
    expect(terminalViewport(100, 30, 60)).toEqual({ first: 60, top: 60, bottom: 70 });
    expect(terminalViewport(100, 30, -500)).toEqual({ first: 0, top: 0, bottom: 70 });
    expect(terminalViewport(100, 30, Number.NEGATIVE_INFINITY)).toEqual({ first: 0, top: 0, bottom: 70 });
    expect(terminalViewport(100, 30, 74)).toEqual({ first: 70, top: undefined, bottom: 70 });
    expect(terminalViewport(10, 30, 5)).toEqual({ first: 0, top: undefined, bottom: 0 });
  });

});

describe("scrollTerminal", () => {
  const live = (): TerminalScroll => ({ following: true, top: 0, liveTop: 170, oldest: 20, carry: 0 });

  it("adds up a trackpad's small steps back from the newest rows until they make a row", () => {
    const scroll = live();
    scrollTerminal(scroll, 0.3);
    scrollTerminal(scroll, 0.3);
    scrollTerminal(scroll, 0.3);
    expect(scroll.following).toBe(true);
    scrollTerminal(scroll, 0.3);
    expect(scroll).toMatchObject({ following: false, top: 169 });
    expect(scroll.carry).toBeCloseTo(0.2);
  });

  it("follows the newest rows again once small steps down reach them", () => {
    const scroll = live();
    scrollTerminal(scroll, 2);
    for (let step = 0; step < 6; step += 1) {
      scrollTerminal(scroll, -0.3);
    }
    expect(scroll).toMatchObject({ following: false, top: 169 });
    for (let step = 0; step < 4; step += 1) {
      scrollTerminal(scroll, -0.3);
    }
    expect(scroll).toMatchObject({ following: true, carry: 0 });

    // Scrolling down while following stores nothing to undo first.
    scrollTerminal(scroll, -5);
    scrollTerminal(scroll, 1);
    expect(scroll).toMatchObject({ following: false, top: 169 });
  });

  it("goes to the oldest row and back to the newest", () => {
    const scroll = live();
    scrollTerminal(scroll, Number.POSITIVE_INFINITY);
    expect(scroll).toMatchObject({ following: false, top: 20 });
    scrollTerminal(scroll, 1000);
    expect(scroll).toMatchObject({ following: false, top: 20 });
    scrollTerminal(scroll, -1);
    expect(scroll.top).toBe(21);
    scrollTerminal(scroll, Number.NEGATIVE_INFINITY);
    expect(scroll.following).toBe(true);
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
    const layout = paintTerminal(ctx, 1000, 400, 1, screen, undefined);
    expect(ctx.font).toContain(`${TERMINAL_FONT_PX}px`);
    expect(layout.visibleRows).toBe(Math.floor((400 - 16) / (TERMINAL_FONT_PX * 1.25)));
    expect(layout.top).toBeUndefined();
    const texts = ctx.texts.map((drawn) => drawn.text);
    expect(texts.at(-1)).toBe("● Working");
    expect(texts).toHaveLength(layout.visibleRows);
    expect(texts[0]).toBe(`history ${202 - layout.visibleRows}`);
  });

  it("paints older rows scrolled back, says how far, and holds the scroll to the oldest", () => {
    const { bottom, visibleRows } = paintTerminal(fakeContext(), 1000, 400, 1, screen, undefined);
    expect(bottom).toBe(202 - visibleRows);
    const back = fakeContext();
    paintTerminal(back, 1000, 400, 1, screen, bottom - 50);
    expect(back.texts.map((drawn) => drawn.text)).toContain("history 151");
    expect(back.texts.map((drawn) => drawn.text)).not.toContain("● Working");
    expect(back.texts.at(-1)?.text).toMatch(/^50 lines below/);

    const oldest = fakeContext();
    const layout = paintTerminal(oldest, 1000, 400, 1, screen, Number.NEGATIVE_INFINITY);
    expect(layout.top).toBe(0);
    expect(oldest.texts[0]?.text).toBe("history 0");
  });

  it("stays on the rows it shows as the screen grows and the oldest rows are let go", () => {
    const top = 120;
    const before = fakeContext();
    paintTerminal(before, 1000, 400, 1, screen, top);
    expect(before.texts[0]?.text).toBe("history 120");

    // A line printed below without scrolling: the screen shows one more row.
    const grown = screenOf({ 0: plain("$ claude"), 1: plain("● Working"), 2: plain("● Done") }, history, [0, 2]);
    const after = fakeContext();
    expect(paintTerminal(after, 1000, 400, 1, grown, top).top).toBe(top);
    expect(after.texts[0]?.text).toBe("history 120");

    // Ten more rows scrolled off, and the ten oldest let go.
    const scrolled = { ...grown, history: [...history.slice(10), ...history.slice(0, 10)], historyAdded: 210 };
    const later = fakeContext();
    expect(paintTerminal(later, 1000, 400, 1, scrolled, top).top).toBe(top);
    expect(later.texts[0]?.text).toBe("history 120");
  });

  it("paints a short terminal from the top, with nothing to scroll", () => {
    const ctx = fakeContext();
    const layout = paintTerminal(ctx, 2000, 400, 2, screenOf({ 0: plain("$ ls") }), 5);
    expect(layout.top).toBeUndefined();
    // At twice the pixels: below the padding, centred in its line.
    const fontSize = TERMINAL_FONT_PX * 2;
    expect(ctx.texts).toEqual([{ text: "$ ls", y: 16 + (fontSize * 1.25 - fontSize) / 2 }]);
  });

  it("shrinks the text only when the terminal's full width would not fit", () => {
    const ctx = fakeContext();
    paintTerminal(ctx, 500, 400, 1, screen, undefined);
    const size = Number(/ ([\d.]+)px/.exec(ctx.font)?.[1]);
    expect(size).toBeLessThan(TERMINAL_FONT_PX);
    expect(size * 0.6 * 100).toBeLessThanOrEqual(500 - 16 - 5);
  });
});
