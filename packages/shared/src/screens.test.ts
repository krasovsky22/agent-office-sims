/**
 * The screen frames' wire contract.
 *
 * A batch crosses the same trust boundary a runner's sync does, so anything
 * the parser returns must be safe to store and relay to every client: bounded
 * in size, every colour one a client can draw, and no control character left
 * to move or restyle what it is drawn on.
 */

import { describe, expect, it } from "vitest";

import { MAX_RUNNER_SLOTS } from "./runner.js";
import {
  MAX_SCREEN_COLS,
  MAX_SCREEN_ROWS,
  MAX_SCREEN_TEXT_PER_COL,
  SCREEN_FLAG_BOLD,
  SCREEN_FLAG_DIM,
  SCREEN_FLAG_INVERSE,
  SCREEN_RGB_FLAG,
  parseScreenFrame,
  parseScreenFrames,
} from "./screens.js";

const FRAME = {
  cols: 80,
  rows: 24,
  lines: {
    0: [
      ["$ ", -1, -1, 0],
      ["pnpm test", 2, -1, SCREEN_FLAG_BOLD],
    ],
    3: [["passed", SCREEN_RGB_FLAG | 0x22aa44, 236, SCREEN_FLAG_DIM | SCREEN_FLAG_INVERSE]],
    23: [],
  },
  full: false,
  cursor: [11, 0],
};

function frameWith(changes: Record<string, unknown>): Record<string, unknown> {
  return { ...FRAME, ...changes };
}

describe("parseScreenFrame", () => {
  it("takes a well-formed diff as it is", () => {
    expect(parseScreenFrame(FRAME)).toEqual(FRAME);
  });

  it("takes a full frame, and a frame that changed no row", () => {
    expect(parseScreenFrame(frameWith({ full: true, lines: {} }))).toEqual({ ...FRAME, full: true, lines: {} });
  });

  it.each([
    ["not an object", "frame"],
    ["an array", [FRAME]],
    ["no lines", frameWith({ lines: undefined })],
    ["lines as an array", frameWith({ lines: [[["a", -1, -1, 0]]] })],
    ["full as a string", frameWith({ full: "yes" })],
    ["no cursor", frameWith({ cursor: undefined })],
    ["a cursor with three numbers", frameWith({ cursor: [1, 2, 3] })],
    ["a cursor past the last row", frameWith({ cursor: [0, 24] })],
    ["a cursor past the last column and its wrap", frameWith({ cursor: [81, 0] })],
    ["a negative cursor", frameWith({ cursor: [-1, 0] })],
    ["a fractional width", frameWith({ cols: 80.5 })],
    ["zero rows", frameWith({ rows: 0, lines: {}, cursor: [0, 0] })],
    ["a row past the bottom", frameWith({ lines: { 24: [] } })],
    ["a row key with a leading zero", frameWith({ lines: { "03": [] } })],
    ["a negative row key", frameWith({ lines: { "-1": [] } })],
    ["a row key that is not a number", frameWith({ lines: { top: [] } })],
    ["a row that is not a list", frameWith({ lines: { 0: "$ pnpm test" } })],
    ["a run with three parts", frameWith({ lines: { 0: [["a", -1, -1]] } })],
    ["a run whose text is a number", frameWith({ lines: { 0: [[7, -1, -1, 0]] } })],
  ])("refuses a frame with %s", (_label, raw) => {
    expect(parseScreenFrame(raw)).toBeUndefined();
  });

  it.each([
    ["a palette index past 255", 256],
    ["a colour below the default", -2],
    ["a fractional colour", 1.5],
    ["true colour past 24 bits", SCREEN_RGB_FLAG + 0x1000000],
    ["a colour as a string", "red"],
  ])("refuses %s", (_label, color) => {
    expect(parseScreenFrame(frameWith({ lines: { 0: [["a", color, -1, 0]] } }))).toBeUndefined();
    expect(parseScreenFrame(frameWith({ lines: { 0: [["a", -1, color, 0]] } }))).toBeUndefined();
  });

  it("takes every colour a terminal can show", () => {
    for (const color of [-1, 0, 255, SCREEN_RGB_FLAG, SCREEN_RGB_FLAG | 0xffffff]) {
      expect(parseScreenFrame(frameWith({ lines: { 0: [["a", color, color, 0]] } }))).toBeDefined();
    }
  });

  it("refuses a flag it does not know", () => {
    expect(parseScreenFrame(frameWith({ lines: { 0: [["a", -1, -1, 8]] } }))).toBeUndefined();
    expect(parseScreenFrame(frameWith({ lines: { 0: [["a", -1, -1, -1]] } }))).toBeUndefined();
  });

  it("caps the screen's size", () => {
    const empty = { lines: {}, cursor: [0, 0] };
    expect(parseScreenFrame(frameWith({ ...empty, cols: MAX_SCREEN_COLS, rows: MAX_SCREEN_ROWS }))).toBeDefined();
    expect(parseScreenFrame(frameWith({ ...empty, cols: MAX_SCREEN_COLS + 1 }))).toBeUndefined();
    expect(parseScreenFrame(frameWith({ ...empty, rows: MAX_SCREEN_ROWS + 1 }))).toBeUndefined();
  });

  it("caps a row's runs at its columns", () => {
    const runs = (count: number): unknown[] =>
      Array.from({ length: count }, (_, index) => ["x", index % 2 === 0 ? 1 : 2, -1, 0]);
    expect(parseScreenFrame(frameWith({ lines: { 0: runs(80) } }))).toBeDefined();
    expect(parseScreenFrame(frameWith({ lines: { 0: runs(81) } }))).toBeUndefined();
  });

  it("caps a row's text", () => {
    const budget = 80 * MAX_SCREEN_TEXT_PER_COL;
    expect(parseScreenFrame(frameWith({ lines: { 0: [["x".repeat(budget), -1, -1, 0]] } }))).toBeDefined();
    expect(
      parseScreenFrame(frameWith({ lines: { 0: [["x".repeat(budget), -1, -1, 0], ["y", 1, -1, 0]] } })),
    ).toBeUndefined();
  });

  it("strips control characters from every run", () => {
    const frame = parseScreenFrame(
      frameWith({
        lines: {
          0: [
            ["\u001b[2Jwiped\u0007", -1, -1, 0],
            ["\u009b31mred\u007f", 1, -1, 0],
          ],
          1: [["‮evil‬ txt", -1, -1, 0]],
        },
      }),
    );
    expect(frame?.lines).toEqual({
      0: [
        ["[2Jwiped", -1, -1, 0],
        ["31mred", 1, -1, 0],
      ],
      1: [["evil txt", -1, -1, 0]],
    });
  });

  it("drops a run that held nothing but control characters", () => {
    const frame = parseScreenFrame(frameWith({ lines: { 0: [["\u001b\u0007", -1, -1, 0], ["ok", -1, -1, 0]] } }));
    expect(frame?.lines).toEqual({ 0: [["ok", -1, -1, 0]] });
  });

  it("keeps wide and accented text", () => {
    const frame = parseScreenFrame(frameWith({ lines: { 0: [["日本 café ✓", -1, -1, 0]] } }));
    expect(frame?.lines[0]).toEqual([["日本 café ✓", -1, -1, 0]]);
  });
});

describe("parseScreenFrames", () => {
  const BATCH = {
    runnerId: "runner-1",
    screens: [
      { slotId: "slot-1", frame: FRAME },
      { slotId: "slot-2", frame: { ...FRAME, full: true } },
    ],
  };

  it("takes a well-formed batch", () => {
    expect(parseScreenFrames(BATCH)).toEqual(BATCH);
  });

  it("takes a batch with no screens", () => {
    expect(parseScreenFrames({ runnerId: "runner-1", screens: [] })).toEqual({ runnerId: "runner-1", screens: [] });
  });

  it.each([
    ["not an object", null],
    ["no runner id", { ...BATCH, runnerId: undefined }],
    ["a runner id with a colon", { ...BATCH, runnerId: "runner:1" }],
    ["screens that are not a list", { ...BATCH, screens: { "slot-1": FRAME } }],
    ["a slot id with a space", { ...BATCH, screens: [{ slotId: "slot 1", frame: FRAME }] }],
    ["a screen with no frame", { ...BATCH, screens: [{ slotId: "slot-1" }] }],
    ["one malformed frame among good ones", { ...BATCH, screens: [...BATCH.screens.slice(0, 1), { slotId: "slot-2", frame: { ...FRAME, cols: 0 } }] }],
    ["the same slot twice", { ...BATCH, screens: [BATCH.screens[0], BATCH.screens[0]] }],
    [
      "more screens than a runner has slots",
      {
        ...BATCH,
        screens: Array.from({ length: MAX_RUNNER_SLOTS + 1 }, (_, index) => ({ slotId: `slot-${index}`, frame: FRAME })),
      },
    ],
  ])("refuses a batch with %s", (_label, raw) => {
    expect(parseScreenFrames(raw)).toBeUndefined();
  });
});
