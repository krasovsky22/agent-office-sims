// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/shared/protocol/workers.ts. See THIRD_PARTY_NOTICES.md.
/**
 * Agent terminals as the office carries them: a screen frame, the batch a
 * runner posts, and the message every client gets.
 *
 * A runner mirrors each slot's terminal and sends the rows that changed as
 * styled runs of text, never terminal bytes, so nothing downstream of the
 * runner interprets an escape sequence. The game server only validates,
 * stores and relays frames. A frame still arrives over HTTP from a process
 * nobody in the office controls, so {@link parseScreenFrames} proves its shape,
 * caps its size, checks every colour and strips control characters from every
 * run before the server keeps or relays any of it.
 *
 * Shared because the frame is the contract the runner writes, the server
 * checks, and the client draws.
 */

import { MAX_RUNNER_SLOTS, isRunnerName } from "./runner.js";

/** The route a runner posts its screens to, on the game server. */
export const RUNNER_SCREENS_PATH = "/agents/runner/screens";

/**
 * A run of same-styled text on one row: `[text, fg, bg, flags]`.
 *
 * A colour is `-1` for the terminal's default, `0` to `255` for its palette,
 * or {@link SCREEN_RGB_FLAG} with a 24-bit `0xRRGGBB` for true colour.
 */
export type ScreenRun = readonly [text: string, fg: number, bg: number, flags: number];

/** A colour that is the terminal's default. */
export const SCREEN_DEFAULT_COLOR = -1;
/** Set on a colour that is `0xRRGGBB` rather than a palette index. */
export const SCREEN_RGB_FLAG = 0x1000000;
export const SCREEN_FLAG_BOLD = 1;
export const SCREEN_FLAG_INVERSE = 2;
export const SCREEN_FLAG_DIM = 4;

/**
 * One look at a terminal.
 *
 * A diff carries only the rows that changed since the frame before it. A
 * `full` frame carries the whole screen, and a row it leaves out is blank.
 */
export interface ScreenFrame {
  readonly cols: number;
  readonly rows: number;
  /** Rows by index from the top, each its runs left to right, trailing blanks trimmed. */
  readonly lines: Readonly<Record<number, readonly ScreenRun[]>>;
  readonly full: boolean;
  /** `[x, y]`, in cells from the top left. */
  readonly cursor: readonly [x: number, y: number];
}

/** One slot's frame, in a runner's batch. */
export interface SlotScreen {
  readonly slotId: string;
  readonly frame: ScreenFrame;
}

/** What a runner posts: a frame for each slot whose screen changed, at most one each. */
export interface RunnerScreens {
  readonly runnerId: string;
  readonly screens: readonly SlotScreen[];
}

/** The server's reply to a batch. */
export interface RunnerScreensReply {
  readonly ok: true;
  /**
   * Slots whose frame the server did not take: a diff it could not apply,
   * because it holds no screen for the slot yet or the size changed, or any
   * frame, full or a diff, for a slot the runner has not reported yet. The
   * runner sends each a full frame next.
   */
  readonly resend: readonly string[];
}

/** One agent's frame, as a client receives it. */
export interface OccupantScreen {
  /** The agent's occupant id, as in the replicated state. */
  readonly occupantId: string;
  readonly frame: ScreenFrame;
}

/**
 * The `screens` server message: diffs as the server accepts them, broadcast
 * to every client, or a full frame for every screen, sent to a client as it
 * joins.
 */
export interface ScreenFramesEvent {
  readonly screens: readonly OccupantScreen[];
}

/**
 * Largest batch the server takes. A runner posts every slot's changed rows at
 * once, a few times a second; a diff is a few rows and a full screen of plain
 * text a few kilobytes, so this holds a full screen of every slot. The runner
 * fits each batch to it, so the bound is the runner's to keep as well as the
 * server's to enforce.
 */
export const MAX_RUNNER_SCREENS_BYTES = 64 * 1024;

/** Widest screen carried; wider than any terminal an agent is run in. */
export const MAX_SCREEN_COLS = 200;

/** Tallest screen carried. */
export const MAX_SCREEN_ROWS = 60;

/**
 * UTF-16 code units a row's text may hold for each of its columns. A cell
 * holds one character, a wide one spans two cells, and combining marks add to
 * a cell's text, so honest rows sit far below this.
 */
export const MAX_SCREEN_TEXT_PER_COL = 4;

/**
 * C0 and C1 controls and DEL, which would make a run move or restyle what it
 * is drawn on, and the bidirectional overrides, which would make a row read
 * in an order other than its cells'.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const SCREEN_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** A row index as a JSON key: a whole number with no leading zero. */
const ROW_KEY = /^(?:0|[1-9][0-9]*)$/;

const ALL_FLAGS = SCREEN_FLAG_BOLD | SCREEN_FLAG_INVERSE | SCREEN_FLAG_DIM;

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function isWholeNumberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function isScreenColor(value: unknown): value is number {
  return (
    value === SCREEN_DEFAULT_COLOR ||
    isWholeNumberIn(value, 0, 255) ||
    isWholeNumberIn(value, SCREEN_RGB_FLAG, SCREEN_RGB_FLAG | 0xffffff)
  );
}

/** A run's text with every control character taken out. */
export function stripScreenControls(text: string): string {
  return text.replace(SCREEN_CONTROL_CHARACTERS, "");
}

/**
 * One row's runs, or `undefined` for a malformed one. A run left empty once
 * its controls are stripped is dropped, since it draws nothing.
 */
function parseRow(raw: unknown, cols: number): ScreenRun[] | undefined {
  if (!Array.isArray(raw) || raw.length > cols) {
    return undefined;
  }
  const runs: ScreenRun[] = [];
  let textLength = 0;
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 4) {
      return undefined;
    }
    const [text, fg, bg, flags] = item as unknown[];
    if (typeof text !== "string" || !isScreenColor(fg) || !isScreenColor(bg) || !isWholeNumberIn(flags, 0, ALL_FLAGS)) {
      return undefined;
    }
    textLength += text.length;
    if (textLength > cols * MAX_SCREEN_TEXT_PER_COL) {
      return undefined;
    }
    const clean = stripScreenControls(text);
    if (clean !== "") {
      runs.push([clean, fg, bg, flags]);
    }
  }
  return runs;
}

/**
 * Validates one frame.
 *
 * @returns the frame with every run's controls stripped, or `undefined` for a
 * malformed one: a size past {@link MAX_SCREEN_COLS} or {@link MAX_SCREEN_ROWS},
 * a row outside the screen, more runs in a row than it has columns, a row's
 * text past {@link MAX_SCREEN_TEXT_PER_COL}, a colour or flag that is not one,
 * or a cursor off the screen.
 */
export function parseScreenFrame(raw: unknown): ScreenFrame | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined) {
    return undefined;
  }
  const { cols, rows, full, cursor } = candidate;
  if (!isWholeNumberIn(cols, 1, MAX_SCREEN_COLS) || !isWholeNumberIn(rows, 1, MAX_SCREEN_ROWS) || typeof full !== "boolean") {
    return undefined;
  }
  if (!Array.isArray(cursor) || cursor.length !== 2) {
    return undefined;
  }
  const [x, y] = cursor as unknown[];
  // xterm leaves the cursor one past the last column while a wrap is pending.
  if (!isWholeNumberIn(x, 0, cols) || !isWholeNumberIn(y, 0, rows - 1)) {
    return undefined;
  }
  const rawLines = asRecord(candidate["lines"]);
  if (rawLines === undefined) {
    return undefined;
  }
  const lines: Record<number, readonly ScreenRun[]> = {};
  for (const [key, rawRow] of Object.entries(rawLines)) {
    const index = Number(key);
    if (!ROW_KEY.test(key) || index >= rows) {
      return undefined;
    }
    const row = parseRow(rawRow, cols);
    if (row === undefined) {
      return undefined;
    }
    lines[index] = row;
  }
  return { cols, rows, lines, full, cursor: [x, y] };
}

/**
 * Validates a runner's batch of frames.
 *
 * Refuses the whole batch for any malformed frame, more frames than a runner
 * has slots, or a slot named twice; the runner answers a refusal with full
 * frames, so nothing half-read is kept.
 *
 * @returns the batch, or `undefined` if the payload is not one.
 */
export function parseScreenFrames(raw: unknown): RunnerScreens | undefined {
  const candidate = asRecord(raw);
  if (candidate === undefined || !isRunnerName(candidate["runnerId"])) {
    return undefined;
  }
  const rawScreens = candidate["screens"];
  if (!Array.isArray(rawScreens) || rawScreens.length > MAX_RUNNER_SLOTS) {
    return undefined;
  }
  const screens: SlotScreen[] = [];
  for (const item of rawScreens) {
    const screen = asRecord(item);
    const slotId = screen?.["slotId"];
    const frame = parseScreenFrame(screen?.["frame"]);
    if (!isRunnerName(slotId) || frame === undefined || screens.some((other) => other.slotId === slotId)) {
      return undefined;
    }
    screens.push({ slotId, frame });
  }
  return { runnerId: candidate["runnerId"], screens };
}
