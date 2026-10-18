/**
 * An agent's terminal as its panel shows it: the scrollback and the screen
 * as one column of rows, at a small fixed size, scrolled back as far as the
 * CEO has wheeled it.
 *
 * A desk's monitor zooms in on the screen's busy rows so they read from
 * across the room. The panel is read up close, so it does the opposite: the
 * smallest text that still reads well, and as many rows of it as the panel
 * has room for, the newest at the bottom. Scrolled back, the view stays on
 * the rows it shows as new ones arrive under it, the way a terminal's does;
 * scrolled to the bottom, it follows the agent live.
 */

import { SCREEN_DEFAULT_COLOR, type ScreenRun } from "@sim/shared";

import type { TerminalScreen } from "./net/screens.js";
import { CHAR_WIDTH, LINE_HEIGHT, type ScreenContext, TERM_THEME, paintRow } from "./scene/agentScreen.js";

/** The panel's text size, in CSS pixels: small, to show more, and still easy to read. */
export const TERMINAL_FONT_PX = 11;

/** Smallest text a narrow panel shrinks to so the terminal's full width still fits. */
const MIN_FONT_PX = 7;

/** Space around the rows, and the scrollbar's width, in CSS pixels. */
const PAD_PX = 8;
const SCROLLBAR_PX = 5;

/** Whether a row has anything to show: text, or a coloured background. */
function isBlank(runs: readonly ScreenRun[] | undefined): boolean {
  return runs?.some((run) => run[0].trim() !== "" || run[2] !== SCREEN_DEFAULT_COLOR) !== true;
}

/**
 * Rows of the screen worth showing: down to the cursor or the last row with
 * anything in it, so the blank rows below a short screen do not push the
 * scrollback out of view.
 */
export function screenRowsShown(screen: TerminalScreen): number {
  let last = Math.min(screen.cursor[1], screen.rows - 1);
  for (let y = screen.rows - 1; y > last; y -= 1) {
    if (!isBlank(screen.lines[y])) {
      last = y;
      break;
    }
  }
  return last + 1;
}

/** Row `index` of the scrollback followed by the screen. */
export function terminalRow(screen: TerminalScreen, index: number): readonly ScreenRun[] | undefined {
  const scrolled = screen.history.length;
  return index < scrolled ? screen.history[index] : screen.lines[index - scrolled];
}

/** Which rows a view of `visible` rows shows, of `total`, scrolled back `offset` rows from the bottom. */
export interface TerminalViewport {
  /** First row shown. */
  readonly first: number;
  /** How far back the view is scrolled, held to what there is to scroll through. */
  readonly offset: number;
  /** Furthest back the view can scroll. */
  readonly maxOffset: number;
}

export function terminalViewport(total: number, visible: number, offset: number): TerminalViewport {
  const maxOffset = Math.max(0, total - visible);
  const held = Math.max(0, Math.min(maxOffset, Math.round(offset)));
  return { first: maxOffset - held, offset: held, maxOffset };
}

/**
 * Rows a wheel event scrolls the view back by: negative scrolls towards the
 * newest. A wheel can count in pixels, lines or pages.
 *
 * @param lineHeightPx a row's height, in CSS pixels.
 * @param pageRows rows a page holds.
 */
export function wheelRows(deltaY: number, deltaMode: number, lineHeightPx: number, pageRows: number): number {
  const rows = deltaMode === 1 ? deltaY : deltaMode === 2 ? deltaY * pageRows : deltaY / lineHeightPx;
  return -rows;
}

/** How a panel's terminal was laid out, for scrolling it by a page. */
export interface TerminalLayout {
  /** Rows the panel has room for. */
  readonly visibleRows: number;
  /** A row's height, in CSS pixels. */
  readonly lineHeightPx: number;
  /** The scroll actually painted, once held to what there is. */
  readonly offset: number;
}

/**
 * Paints `screen` onto a canvas `w` by `h` device pixels, `scale` of them to
 * a CSS pixel, scrolled back `offset` rows from the newest.
 *
 * The text is {@link TERMINAL_FONT_PX}, smaller only if the terminal's full
 * width would not fit otherwise. While there is more than fits, a scrollbar
 * says where the view is; scrolled back, a note at the bottom says how far.
 */
export function paintTerminal(
  ctx: ScreenContext,
  w: number,
  h: number,
  scale: number,
  screen: TerminalScreen,
  offset: number,
): TerminalLayout {
  ctx.fillStyle = TERM_THEME.background;
  ctx.fillRect(0, 0, w, h);
  const pad = PAD_PX * scale;
  const bar = SCROLLBAR_PX * scale;
  const fitWidth = (w - pad * 2 - bar) / (screen.cols * CHAR_WIDTH);
  const fontSize = Math.max(MIN_FONT_PX * scale, Math.min(TERMINAL_FONT_PX * scale, fitWidth));
  const lineH = fontSize * LINE_HEIGHT;
  const visibleRows = Math.max(1, Math.floor((h - pad * 2) / lineH));
  const total = screen.history.length + screenRowsShown(screen);
  const view = terminalViewport(total, visibleRows, offset);

  ctx.textBaseline = "top";
  for (let y = 0; y < visibleRows && view.first + y < total; y += 1) {
    const runs = terminalRow(screen, view.first + y);
    if (runs !== undefined) {
      paintRow(ctx, runs, pad, pad + y * lineH, fontSize);
    }
  }

  if (view.maxOffset > 0) {
    const trackH = h - pad * 2;
    const thumbH = Math.max(trackH * (visibleRows / total), 16 * scale);
    const thumbTop = pad + (trackH - thumbH) * (view.first / view.maxOffset);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = TERM_THEME.brightBlack;
    ctx.fillRect(w - bar - 2 * scale, thumbTop, bar, thumbH);
    ctx.globalAlpha = 1;
  }

  if (view.offset > 0) {
    const note = `${view.offset} ${view.offset === 1 ? "line" : "lines"} below · scroll down or End to follow`;
    ctx.font = `400 ${fontSize}px ui-monospace, Menlo, Consolas, monospace`;
    const noteW = note.length * fontSize * CHAR_WIDTH + pad * 2;
    const noteH = lineH + pad;
    const noteLeft = w - noteW - bar - pad;
    const noteTop = h - noteH - pad / 2;
    ctx.fillStyle = TERM_THEME.black;
    ctx.fillRect(noteLeft, noteTop, noteW, noteH);
    ctx.fillStyle = TERM_THEME.yellow;
    ctx.fillText(note, noteLeft + pad, noteTop + (noteH - fontSize) / 2);
  }

  return { visibleRows, lineHeightPx: lineH / scale, offset: view.offset };
}
