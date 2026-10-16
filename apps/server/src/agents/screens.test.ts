/**
 * The screen store: what it keeps of each slot's screen, what it passes to
 * the rooms, and when it asks a runner for a whole screen instead.
 *
 * Driven with a stand-in for the runner link, so each test says exactly
 * which slots are reported and when one leaves.
 */

import type { ScreenFrame, ScreenFramesEvent, ScreenRun } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { ScreenStore, isScreenSource } from "./screens.js";

/** A runner link reporting exactly the slots in {@link reported}, as `runnerId/slotId`. */
function fakeSlots(initial: readonly string[]) {
  const reported = new Set(initial);
  const listeners = new Set<() => void>();
  return {
    reported,
    hasSlot: (runnerId: string, slotId: string) => reported.has(`${runnerId}/${slotId}`),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** A slot leaves, and the link says its slots changed. */
    leave(key: string) {
      reported.delete(key);
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function run(text: string, fg = -1): ScreenRun {
  return [text, fg, -1, 0];
}

function frame(lines: Record<number, ScreenRun[]>, changes: Partial<ScreenFrame> = {}): ScreenFrame {
  return { cols: 20, rows: 3, lines, full: false, cursor: [0, 0], ...changes };
}

const FULL = frame({ 0: [run("$ pnpm test")], 1: [run("running", 3)] }, { full: true, cursor: [7, 1] });

const OCCUPANT = "agent:runner:runner-1:slot-1";

function storeWithSlots(initial: readonly string[] = ["runner-1/slot-1", "runner-1/slot-2"]) {
  const slots = fakeSlots(initial);
  const store = new ScreenStore({ slots });
  const heard: ScreenFramesEvent[] = [];
  store.onScreens((event) => heard.push(event));
  return { slots, store, heard };
}

describe("ScreenStore", () => {
  it("keeps a full frame as the slot's screen, every row filled in", () => {
    const { store, heard } = storeWithSlots();
    expect(store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: FULL }] })).toEqual({ resend: [] });
    expect(heard).toEqual([{ screens: [{ occupantId: OCCUPANT, frame: FULL }] }]);
    expect(store.fullScreens()).toEqual({
      screens: [{ occupantId: OCCUPANT, frame: { ...FULL, lines: { 0: [run("$ pnpm test")], 1: [run("running", 3)], 2: [] } } }],
    });
  });

  it("merges a diff into the screen, replacing only the rows it carries", () => {
    const { store, heard } = storeWithSlots();
    store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: FULL }] });
    const diff = frame({ 1: [run("passed", 2)], 2: [run("$ ")] }, { cursor: [2, 2] });
    expect(store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: diff }] })).toEqual({ resend: [] });

    expect(heard.at(-1)).toEqual({ screens: [{ occupantId: OCCUPANT, frame: diff }] });
    expect(store.fullScreens().screens[0]?.frame).toEqual({
      cols: 20,
      rows: 3,
      lines: { 0: [run("$ pnpm test")], 1: [run("passed", 2)], 2: [run("$ ")] },
      full: true,
      cursor: [2, 2],
    });
  });

  it("blanks the rows a later full frame leaves out", () => {
    const { store } = storeWithSlots();
    store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: FULL }] });
    store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: frame({ 2: [run("fresh")] }, { full: true }) }] });
    expect(store.fullScreens().screens[0]?.frame.lines).toEqual({ 0: [], 1: [], 2: [run("fresh")] });
  });

  it("asks for a whole screen when a diff has nothing to apply to, and keeps and relays nothing", () => {
    const { store, heard } = storeWithSlots();
    const diff = frame({ 0: [run("half a screen")] });
    expect(store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: diff }] })).toEqual({
      resend: ["slot-1"],
    });
    expect(heard).toEqual([]);
    expect(store.fullScreens()).toEqual({ screens: [] });
  });

  it.each([
    ["rows", { rows: 4 }],
    ["columns", { cols: 30 }],
  ])("asks for a whole screen when a diff's %s differ from the screen's", (_label, size) => {
    const { store, heard } = storeWithSlots();
    store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: FULL }] });
    const diff = frame({ 0: [run("resized")] }, size);
    expect(store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: diff }] })).toEqual({
      resend: ["slot-1"],
    });
    expect(heard).toHaveLength(1);
    expect(store.fullScreens().screens[0]?.frame.lines[0]).toEqual([run("$ pnpm test")]);
  });

  it("asks for a slot the runner does not report whole, without keeping or relaying it", () => {
    const { store, heard } = storeWithSlots(["runner-1/slot-1"]);
    expect(
      store.accept({
        runnerId: "runner-1",
        screens: [
          { slotId: "slot-9", frame: FULL },
          { slotId: "slot-1", frame: FULL },
        ],
      }),
    ).toEqual({ resend: ["slot-9"] });
    expect(store.accept({ runnerId: "runner-2", screens: [{ slotId: "slot-1", frame: FULL }] })).toEqual({
      resend: ["slot-1"],
    });
    expect(heard).toEqual([{ screens: [{ occupantId: OCCUPANT, frame: FULL }] }]);
    expect(store.fullScreens().screens.map((screen) => screen.occupantId)).toEqual([OCCUPANT]);
  });

  it("passes a batch on as one event, with every frame it took", () => {
    const { store, heard } = storeWithSlots();
    store.accept({
      runnerId: "runner-1",
      screens: [
        { slotId: "slot-1", frame: FULL },
        { slotId: "slot-2", frame: frame({ 0: [run("no base")] }) },
      ],
    });
    expect(heard).toEqual([{ screens: [{ occupantId: OCCUPANT, frame: FULL }] }]);
  });

  it("drops a slot's screen when the slot leaves", () => {
    const { slots, store } = storeWithSlots();
    store.accept({
      runnerId: "runner-1",
      screens: [
        { slotId: "slot-1", frame: FULL },
        { slotId: "slot-2", frame: FULL },
      ],
    });
    slots.leave("runner-1/slot-1");
    expect(store.fullScreens().screens.map((screen) => screen.occupantId)).toEqual(["agent:runner:runner-1:slot-2"]);

    // Back again, it needs a whole screen before a diff means anything.
    slots.reported.add("runner-1/slot-1");
    expect(store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: frame({ 0: [run("x")] }) }] })).toEqual({
      resend: ["slot-1"],
    });
  });

  it("keeps telling the other rooms when one room's listener throws", () => {
    const { store, heard } = storeWithSlots();
    store.onScreens(() => {
      throw new Error("a broken room");
    });
    const later: ScreenFramesEvent[] = [];
    store.onScreens((event) => later.push(event));
    store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: FULL }] });
    expect(heard).toHaveLength(1);
    expect(later).toHaveLength(1);
  });

  it("stops telling a room that unsubscribed, and stops watching the link when stopped", () => {
    const { slots, store } = storeWithSlots();
    const heard: ScreenFramesEvent[] = [];
    const unsubscribe = store.onScreens((event) => heard.push(event));
    unsubscribe();
    store.accept({ runnerId: "runner-1", screens: [{ slotId: "slot-1", frame: FULL }] });
    expect(heard).toEqual([]);

    store.stop();
    slots.leave("runner-1/slot-1");
    expect(store.fullScreens().screens).toHaveLength(1);
  });

  it("is a screen source, and a client's join options are not", () => {
    expect(isScreenSource(storeWithSlots().store)).toBe(true);
    expect(isScreenSource({ fullScreens: "x", onScreens: "y" })).toBe(false);
    expect(isScreenSource(undefined)).toBe(false);
  });
});
