/**
 * Frames applied the way the server sends them: a full screen, then diffs.
 */

import type { ScreenFrame, ScreenRun } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { applyScreenFrame } from "./screens.js";

function run(text: string): ScreenRun {
  return [text, -1, -1, 0];
}

function frame(lines: ScreenFrame["lines"], full: boolean, size: { cols: number; rows: number } = { cols: 80, rows: 24 }): ScreenFrame {
  return { ...size, lines, full, cursor: [0, 0] };
}

describe("applyScreenFrame", () => {
  it("writes a diff's rows over the screen it was taken against", () => {
    const held = applyScreenFrame(undefined, frame({ 0: [run("$ ls")], 1: [run("a b")] }, true));
    const next = applyScreenFrame(held, { ...frame({ 1: [run("a b c")], 2: [run("$")] }, false), cursor: [1, 2] });

    expect(next).toBe(held);
    expect(next.lines).toEqual([[run("$ ls")], [run("a b c")], [run("$")]]);
    expect(next.cursor).toEqual([1, 2]);
  });

  it("starts afresh on a full frame, keeping no row it leaves out", () => {
    const held = applyScreenFrame(undefined, frame({ 0: [run("old")], 5: [run("old")] }, true));
    const next = applyScreenFrame(held, frame({ 1: [run("new")] }, true));

    expect(next.lines[0]).toBeUndefined();
    expect(next.lines[1]).toEqual([run("new")]);
    expect(next.lines[5]).toBeUndefined();
  });

  it("starts afresh when the terminal is resized", () => {
    const held = applyScreenFrame(undefined, frame({ 0: [run("old")] }, true));
    const next = applyScreenFrame(held, frame({ 1: [run("new")] }, false, { cols: 100, rows: 30 }));

    expect(next).not.toBe(held);
    expect(next).toMatchObject({ cols: 100, rows: 30 });
    expect(next.lines[0]).toBeUndefined();
  });

  it("draws a diff with nothing under it on a blank screen", () => {
    const screen = applyScreenFrame(undefined, frame({ 3: [run("late")] }, false));

    expect(screen.lines[3]).toEqual([run("late")]);
    expect(screen.lines[0]).toBeUndefined();
  });

  it("moves the version on with every frame, a fresh screen included", () => {
    const first = applyScreenFrame(undefined, frame({}, true));
    const firstVersion = first.version;
    const diff = applyScreenFrame(first, frame({}, false)).version;
    const full = applyScreenFrame(first, frame({}, true)).version;

    expect(diff).toBeGreaterThan(firstVersion);
    expect(full).toBeGreaterThan(diff);
  });
});
