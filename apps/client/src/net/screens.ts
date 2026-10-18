// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/client/state/core.ts. See THIRD_PARTY_NOTICES.md.
/**
 * The live agents' terminals as this client holds them, built up from the
 * server's `screens` messages.
 *
 * The server sends a joining client every screen whole, then relays the diffs
 * it accepts, so a screen is the last full frame with every later diff's rows
 * written over it. Every tab applies the same frames in the same order, which
 * is what keeps two tabs showing the same terminal.
 *
 * Each screen keeps its scrollback beside it, as the server does: the rows
 * every frame carries as history, the newest `MAX_SCREEN_HISTORY` of them.
 * The server's whole screen on joining carries its whole scrollback, in place
 * of whatever this client held.
 *
 * A screen carries a version that goes up with every frame, so a renderer can
 * tell whether there is anything new to paint without comparing rows.
 */

import { type ScreenFrame, type ScreenRun, appendScreenHistory } from "@sim/shared";

/** One terminal, whole: every row the frames so far have written. */
export interface TerminalScreen {
  cols: number;
  rows: number;
  /** Rows by index from the top; a row no frame has written is blank. */
  lines: (readonly ScreenRun[] | undefined)[];
  cursor: readonly [x: number, y: number];
  /** Rows scrolled off the top, oldest first. */
  history: (readonly ScreenRun[])[];
  /**
   * Rows ever added to {@link history} since it was last emptied, the ones
   * since let go included, so a reader scrolled back can stay on what it was
   * reading as rows arrive under it.
   */
  historyAdded: number;
  /** Goes up with every frame applied. */
  version: number;
}

/**
 * Writes one frame onto the screen it was taken against.
 *
 * A full frame, or one of another size, starts the screen afresh. A diff with
 * no screen under it, which only a missed frame leaves, is drawn on a blank
 * one: the rows it carries are still the agent's latest.
 *
 * The scrollback goes on from one screen to the next, whatever the frame.
 *
 * @returns the screen to keep, which is `held` itself whenever the frame is a
 * diff of it.
 */
export function applyScreenFrame(held: TerminalScreen | undefined, frame: ScreenFrame): TerminalScreen {
  let screen = held;
  if (screen === undefined || frame.full || screen.cols !== frame.cols || screen.rows !== frame.rows) {
    screen = {
      cols: frame.cols,
      rows: frame.rows,
      lines: [],
      cursor: frame.cursor,
      history: held?.history ?? [],
      historyAdded: held?.historyAdded ?? 0,
      version: held?.version ?? 0,
    };
  }
  for (const [row, runs] of Object.entries(frame.lines)) {
    screen.lines[Number(row)] = runs;
  }
  if (frame.historyCleared === true) {
    screen.historyAdded = 0;
  }
  screen.historyAdded += appendScreenHistory(screen.history, frame);
  screen.cursor = frame.cursor;
  screen.version += 1;
  return screen;
}
