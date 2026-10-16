// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/workers/terminal.ts. See THIRD_PARTY_NOTICES.md.
/**
 * A slot's terminal as the office mirrors it: a headless xterm fed whatever
 * the slot's agent prints, read off as screen frames for the game server.
 *
 * The runner interprets terminal bytes so that nothing downstream has to: a
 * frame carries styled runs of text by row, never an escape sequence. Only
 * the rows that changed since the last frame are sent, and every screen is
 * sent whole every {@link KEYFRAME_MS}, as well as whenever the server asks or
 * a frame may have been lost, so a server or client that missed a diff is
 * never wrong for long.
 *
 * Every frame passes through the runner's {@link Redactor} on its way out, so
 * no secret the runner holds is ever in one.
 */

import {
  MAX_SCREEN_TEXT_PER_COL,
  SCREEN_DEFAULT_COLOR,
  SCREEN_FLAG_BOLD,
  SCREEN_FLAG_DIM,
  SCREEN_FLAG_INVERSE,
  SCREEN_RGB_FLAG,
  type ScreenFrame,
  type SlotScreen,
} from "@sim/shared";
import xterm from "@xterm/headless";

import type { MutableRun, Redactor } from "./redact.js";

export type HeadlessTerminal = InstanceType<typeof xterm.Terminal>;

/** The size every slot's terminal is made at, and its agent's terminal with it. */
export const SCREEN_COLS = 100;
export const SCREEN_ROWS = 30;

/** How often each screen is sent whole, since a diff can be lost on the way. */
export const KEYFRAME_MS = 8000;

/**
 * Rows kept above the screen. Nothing reads them but the redactor, which
 * needs the start of a line wrapped in from above the top edge.
 */
const SCROLLBACK = 100;

export class ScreenMirror {
  public readonly term: HeadlessTerminal;
  /** Each row as last sent, serialised; empty to send the next frame whole. */
  private lastLines: string[] = [];
  private dirty = true;
  private keyframeAt: number;

  public constructor(now: number, cols = SCREEN_COLS, rows = SCREEN_ROWS) {
    this.term = new xterm.Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.keyframeAt = now;
  }

  /** Feeds the terminal what the agent printed. */
  public write(data: string | Uint8Array): void {
    // Marked once xterm has parsed it, which is not straight away, so a frame
    // taken in between is not mistaken for the last word on it.
    this.term.write(data, () => {
      this.dirty = true;
    });
  }

  /** Resolves once everything written so far has reached the screen. */
  public written(): Promise<void> {
    return new Promise((resolve) => {
      this.term.write("", resolve);
    });
  }

  /** Clears the screen, as for a new run. */
  public reset(): void {
    // A full reset sent as a sequence rather than `term.reset()`, which would
    // act at once, ahead of whatever is still waiting to be parsed.
    this.write("\u001bc");
  }

  /** Makes the next frame a whole screen. */
  public sendWhole(): void {
    this.lastLines = [];
    this.dirty = true;
  }

  /** The frame to send now, or `undefined` when nothing changed. */
  public flush(now: number, redactor: Redactor): ScreenFrame | undefined {
    // Diffs can be lost, so send the whole screen now and then.
    if (now - this.keyframeAt > KEYFRAME_MS) {
      this.keyframeAt = now;
      this.sendWhole();
    }
    if (!this.dirty) {
      return undefined;
    }
    this.dirty = false;
    return snapshotScreen(this.term, this.lastLines, redactor);
  }
}

/** A frame for every screen that changed, each through the redactor. */
export function flushScreens(
  mirrors: Iterable<readonly [slotId: string, mirror: ScreenMirror]>,
  now: number,
  redactor: Redactor,
): SlotScreen[] {
  const screens: SlotScreen[] = [];
  for (const [slotId, mirror] of mirrors) {
    const frame = mirror.flush(now, redactor);
    if (frame !== undefined) {
      screens.push({ slotId, frame });
    }
  }
  return screens;
}

/**
 * The rows of the screen that changed since `last` (all of them when its
 * size changed or `last` is empty), or `undefined` when none did. Updates
 * `last` to the screen as sent.
 */
export function snapshotScreen(term: HeadlessTerminal, last: string[], redactor: Redactor): ScreenFrame | undefined {
  const buf = term.buffer.active;
  const cols = term.cols;
  const rows = term.rows;
  const full = last.length !== rows;
  const screen: MutableRun[][] = [];
  const wrapped: boolean[] = [];
  const cell = buf.getNullCell();
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    const runs: MutableRun[] = [];
    wrapped.push(line?.isWrapped ?? false);
    if (line) {
      let cur: MutableRun | null = null;
      for (let x = 0; x < cols; x++) {
        line.getCell(x, cell);
        const width = cell.getWidth();
        if (width === 0) continue;
        const ch = cell.getChars() || " ";
        const fg = cell.isFgDefault() ? SCREEN_DEFAULT_COLOR : cell.isFgRGB() ? SCREEN_RGB_FLAG | cell.getFgColor() : cell.getFgColor();
        const bg = cell.isBgDefault() ? SCREEN_DEFAULT_COLOR : cell.isBgRGB() ? SCREEN_RGB_FLAG | cell.getBgColor() : cell.getBgColor();
        const flags =
          (cell.isBold() ? SCREEN_FLAG_BOLD : 0) | (cell.isInverse() ? SCREEN_FLAG_INVERSE : 0) | (cell.isDim() ? SCREEN_FLAG_DIM : 0);
        if (cur && cur[1] === fg && cur[2] === bg && cur[3] === flags) cur[0] += ch;
        else {
          cur = [ch, fg, bg, flags];
          runs.push(cur);
        }
      }
    }
    // Trim trailing default-styled whitespace to keep frames small.
    while (runs.length) {
      const r = runs[runs.length - 1];
      if (r === undefined || r[2] !== SCREEN_DEFAULT_COLOR || r[3] & SCREEN_FLAG_INVERSE) break;
      const trimmed = r[0].replace(/\s+$/, "");
      if (trimmed) {
        r[0] = trimmed;
        break;
      }
      runs.pop();
    }
    fitRow(runs, cols * MAX_SCREEN_TEXT_PER_COL);
    screen.push(runs);
  }
  redactor.redact(screen, wrapped, wrapped[0] === true ? textAbove(term, redactor.longest) : "");

  const lines: Record<number, MutableRun[]> = {};
  let changed = false;
  screen.forEach((runs, y) => {
    const key = JSON.stringify(runs);
    if (full || last[y] !== key) {
      lines[y] = runs;
      last[y] = key;
      changed = true;
    }
  });
  last.length = rows;
  if (!changed) return undefined;
  return { cols, rows, lines, full, cursor: [buf.cursorX, buf.cursorY] };
}

/**
 * The start of the line the screen's first row wraps on from, enough of it
 * to hold the longest secret.
 */
function textAbove(term: HeadlessTerminal, longest: number): string {
  const buf = term.buffer.active;
  const most = Math.ceil(longest / term.cols) + 1;
  let text = "";
  for (let y = buf.viewportY - 1, taken = 0; y >= 0 && taken < most; y -= 1, taken += 1) {
    const line = buf.getLine(y);
    if (line === undefined) {
      break;
    }
    text = line.translateToString(false) + text;
    if (!line.isWrapped) {
      break;
    }
  }
  return text;
}

/**
 * Cuts a row's text to what the contract allows. Only a row of cells each
 * holding a long run of combining marks gets near it.
 */
function fitRow(runs: MutableRun[], maxLength: number): void {
  let used = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (run === undefined) {
      continue;
    }
    if (used + run[0].length > maxLength) {
      run[0] = run[0].slice(0, maxLength - used);
      runs.length = run[0] === "" ? index : index + 1;
      return;
    }
    used += run[0].length;
  }
}
