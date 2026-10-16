/**
 * The terminal painter's maths, checked against a fake 2D context that only
 * records what it is asked to draw: which rows a desk's screen shows, where each
 * run lands, in what colour, and how often a screen is repainted.
 */

import {
  SCREEN_FLAG_BOLD,
  SCREEN_FLAG_DIM,
  SCREEN_FLAG_INVERSE,
  SCREEN_RGB_FLAG,
  type ScreenRun,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import type { TerminalScreen } from "../net/screens.js";
import {
  PALETTE,
  type ScreenContext,
  TERM_THEME,
  activeWindow,
  dueForRepaint,
  paintScreen,
  repaintIntervalMs,
  screenColor,
} from "./agentScreen.js";

interface Drawn {
  readonly op: "rect" | "text";
  readonly style: string;
  readonly font: string;
  readonly alpha: number;
  readonly x: number;
  readonly y: number;
  readonly text?: string;
  readonly w?: number;
}

/** A context that keeps a list of what was drawn, in what state. */
function fakeContext(): ScreenContext & { readonly drawn: Drawn[] } {
  const drawn: Drawn[] = [];
  const ctx = {
    drawn,
    fillStyle: "" as ScreenContext["fillStyle"],
    font: "",
    textAlign: "start" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    globalAlpha: 1,
    fillRect(x: number, y: number, w: number) {
      drawn.push({ op: "rect", style: String(ctx.fillStyle), font: ctx.font, alpha: ctx.globalAlpha, x, y, w });
    },
    fillText(text: string, x: number, y: number) {
      drawn.push({ op: "text", style: String(ctx.fillStyle), font: ctx.font, alpha: ctx.globalAlpha, x, y, text });
    },
  };
  return ctx;
}

function screenOf(lines: Record<number, readonly ScreenRun[]>, cols = 80, rows = 24): TerminalScreen {
  const all: (readonly ScreenRun[] | undefined)[] = [];
  for (const [row, runs] of Object.entries(lines)) {
    all[Number(row)] = runs;
  }
  return { cols, rows, lines: all, cursor: [0, 0], version: 1 };
}

const plain = (text: string): ScreenRun => [text, -1, -1, 0];

describe("screenColor", () => {
  it("reads the default, the palette and true colour", () => {
    expect(screenColor(-1, "fallback")).toBe("fallback");
    expect(screenColor(1, "fallback")).toBe(TERM_THEME.red);
    expect(screenColor(15, "fallback")).toBe(TERM_THEME.brightWhite);
    expect(screenColor(SCREEN_RGB_FLAG | 0x0a141e, "fallback")).toBe("rgb(10,20,30)");
  });

  it("holds 256 colours: the theme, a 6×6×6 cube, then greys", () => {
    expect(PALETTE).toHaveLength(256);
    expect(PALETTE[16]).toBe("rgb(0,0,0)");
    expect(PALETTE[16 + 36 * 5 + 6 * 0 + 1]).toBe("rgb(255,0,95)");
    expect(PALETTE[231]).toBe("rgb(255,255,255)");
    expect(PALETTE[232]).toBe("rgb(8,8,8)");
    expect(PALETTE[255]).toBe("rgb(238,238,238)");
  });
});

describe("activeWindow", () => {
  it("keeps the latest rows of a screen whose output has scrolled to the bottom", () => {
    const lines: Record<number, ScreenRun[]> = {};
    for (let row = 0; row < 40; row += 1) {
      lines[row] = [plain(`line ${row}`)];
    }
    const win = activeWindow(screenOf(lines, 80, 40), 1000, 600, 22);

    expect(win.top + win.rows).toBe(40);
    expect(win.last).toBe(39);
    expect(win.rows).toBeGreaterThanOrEqual(22);
  });

  it("starts at the top of a screen with only a few rows written", () => {
    const win = activeWindow(screenOf({ 0: [plain("$ mock")], 1: [plain("working")] }, 80, 40), 1000, 600, 22);

    expect(win.top).toBe(0);
    expect(win.first).toBe(0);
    expect(win.last).toBe(1);
  });

  it("shows no fewer than 56 columns, and no more than the terminal has", () => {
    expect(activeWindow(screenOf({ 0: [plain("hi")] }), 1000, 600, 22).cols).toBe(56);
    expect(activeWindow(screenOf({ 0: [plain("x".repeat(70))] }), 1000, 600, 22).cols).toBe(70);
    expect(activeWindow(screenOf({ 0: [plain("hi")] }, 40, 24), 1000, 600, 22).cols).toBe(40);
  });

  it("adds rows for a wide terminal so its cells keep their shape", () => {
    // 120 columns of 0.6 font-widths across 1000 px, at 1.25 font-heights a row.
    const win = activeWindow(screenOf({ 0: [plain("x".repeat(120))] }, 120, 60), 1000, 600, 22);

    expect(win.rows).toBe(Math.ceil((600 * 0.6 * 120) / (1000 * 1.25)));
  });

  it("counts a coloured background as content, and blank text as none", () => {
    const win = activeWindow(screenOf({ 2: [plain("   ")], 5: [[" ", -1, 4, 0]] }, 80, 30), 1000, 600, 12);

    expect(win.first).toBe(5);
    expect(win.last).toBe(5);
  });

  it("never reaches past the terminal's own rows", () => {
    const win = activeWindow(screenOf({ 0: [plain("a")] }, 80, 8), 1000, 600, 22);

    expect(win.rows).toBe(8);
    expect(win.top).toBe(0);
  });
});

describe("paintScreen", () => {
  it("paints the placeholder, centred, before the first frame", () => {
    const ctx = fakeContext();
    paintScreen(ctx, 1000, 600, undefined, "connecting…", 22);

    expect(ctx.drawn[0]).toMatchObject({ op: "rect", style: TERM_THEME.background, x: 0, y: 0, w: 1000 });
    expect(ctx.drawn[1]).toMatchObject({ op: "text", text: "connecting…", x: 500, y: 300 });
    expect(ctx.drawn).toHaveLength(2);
  });

  it("lays runs out a cell per character, left to right", () => {
    const ctx = fakeContext();
    // 56 columns across 1040 px less 2% padding a side; width, not height, sets the cell.
    paintScreen(ctx, 1040, 1000, screenOf({ 0: [plain("ab"), ["→c", 2, -1, 0]] }, 56, 10), "", 22);

    const texts = ctx.drawn.filter((entry) => entry.op === "text");
    expect(texts.map((entry) => entry.text)).toEqual(["ab", "→c"]);
    const pad = 1040 * 0.02;
    const cell = (1040 - pad * 2) / 56;
    expect(texts[0]!.x).toBeCloseTo(pad);
    // Two cells on, counting the arrow as one character.
    expect(texts[1]!.x - texts[0]!.x).toBeCloseTo(2 * cell);
    expect(texts[0]!.font).toContain(`${cell / 0.6}px`);
    expect(texts[0]!.style).toBe(TERM_THEME.foreground);
    expect(texts[1]!.style).toBe(TERM_THEME.green);
  });

  it("fills a run's background, swaps colours for inverse, and sets bold and dim", () => {
    const ctx = fakeContext();
    paintScreen(
      ctx,
      1040,
      1000,
      screenOf({ 0: [["on", 1, 4, 0], ["inv", 3, -1, SCREEN_FLAG_INVERSE], ["b", -1, -1, SCREEN_FLAG_BOLD | SCREEN_FLAG_DIM]] }, 56, 10),
      "",
      22,
    );

    const [, onBg, onText, invBg, invText, bold] = ctx.drawn;
    expect(onBg).toMatchObject({ op: "rect", style: TERM_THEME.blue });
    expect(onText).toMatchObject({ op: "text", style: TERM_THEME.red, alpha: 1 });
    expect(invBg).toMatchObject({ op: "rect", style: TERM_THEME.yellow });
    expect(invText).toMatchObject({ op: "text", style: TERM_THEME.background });
    expect(bold).toMatchObject({ op: "text", text: "b", alpha: 0.55 });
    expect(bold!.font.startsWith("700 ")).toBe(true);
    expect(onText!.font.startsWith("400 ")).toBe(true);
  });

  it("draws only the window's rows", () => {
    const lines: Record<number, ScreenRun[]> = {};
    for (let row = 0; row < 40; row += 1) {
      lines[row] = [plain(`line ${row}`)];
    }
    const ctx = fakeContext();
    paintScreen(ctx, 1000, 600, screenOf(lines, 80, 40), "", 22);

    const texts = ctx.drawn.filter((entry) => entry.op === "text").map((entry) => entry.text);
    expect(texts.at(-1)).toBe("line 39");
    expect(texts).not.toContain("line 0");
    // Top to bottom, a line apart.
    const ys = ctx.drawn.filter((entry) => entry.op === "text").map((entry) => entry.y);
    expect(ys.every((y, i) => i === 0 || y > ys[i - 1]!)).toBe(true);
  });
});

describe("repaint throttle", () => {
  it("repaints near screens often and far ones rarely", () => {
    expect(repaintIntervalMs(2)).toBe(150);
    expect(repaintIntervalMs(10)).toBe(600);
    expect(repaintIntervalMs(30)).toBe(2000);
  });

  it("paints the first frame over the placeholder at once", () => {
    expect(dueForRepaint(-1, 1, 1000, 1001, 30)).toBe(true);
  });

  it("waits out the interval for a changed screen, and never repaints an unchanged one", () => {
    expect(dueForRepaint(4, 5, 1000, 1100, 2)).toBe(false);
    expect(dueForRepaint(4, 5, 1000, 1151, 2)).toBe(true);
    expect(dueForRepaint(4, 5, 1000, 1500, 10)).toBe(false);
    expect(dueForRepaint(5, 5, 1000, 9000, 2)).toBe(false);
  });
});
