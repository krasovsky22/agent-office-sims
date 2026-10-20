/**
 * Desk sessions: an idle slot lent to the CEO's desk, its session sized,
 * typed into and closed as asked, and refused or ended with a reason.
 */

import type { RunnerSlotCommand } from "@sim/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockAgent } from "./agents/mock.js";
import type { Agent } from "./agents/types.js";
import { SpendLedger } from "./budget.js";
import { TURN_DONE } from "./slotRuns.js";
import { SlotPool } from "./slots.js";
import { SCREEN_COLS, SCREEN_ROWS } from "./terminal.js";
import {
  DEFAULT_PROFILE,
  FIRST,
  START,
  STEP_MS,
  TIMEOUT_MS,
  settle,
  slot,
  useSlotFixture,
  workspaces,
} from "./slotPoolFixture.js";

describe("SlotPool desk sessions", () => {
  const OPEN: RunnerSlotCommand = { id: "command-desk", slotId: "slot-1", kind: "desk-open", seatId: "seat-desk-north-1-1", requestedBy: "Dana" };
  const CLOSE: RunnerSlotCommand = { id: "command-close", slotId: "slot-1", kind: "desk-close", seatId: "seat-desk-north-1-1", reason: "the CEO stood up" };
  const PROMPT: RunnerSlotCommand = { id: "command-p", slotId: "slot-1", kind: "prompt", text: "List the routes.", requestedBy: "Dana", fromCeo: true };

  /** The desk worktrees the pool asked for and gave back, in order. */
  let deskAsked: string[];

  function deskPool(options: { failOpen?: string; ledger?: SpendLedger; agent?: Agent } = {}) {
    let nextId = 1;
    return new SlotPool({
      count: 2,
      agent: options.agent ?? createMockAgent({ outcome: "pr-opened", stepMs: STEP_MS }),
      workspaces: workspaces(),
      desks: {
        open: async (slotId) => {
          deskAsked.push(`open ${slotId}`);
          if (options.failOpen !== undefined) {
            throw new Error(options.failOpen);
          }
          return `/desks/${slotId}`;
        },
        close: async (workdir) => {
          deskAsked.push(`close ${workdir}`);
        },
      },
      taskTimeoutMs: TIMEOUT_MS,
      eventId: () => `event-${nextId++}`,
      ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    });
  }

  function deskEvents(slots: SlotPool) {
    return slots.pendingEvents().filter((event) => event.kind === "desk-ended");
  }

  useSlotFixture();
  beforeEach(() => {
    deskAsked = [];
  });

  it("lends an idle slot to a desk: a fresh session on a cleared screen, at its prompt, with no issue", async () => {
    const slots = deskPool();
    slots.handle(OPEN);
    expect(slot(slots)).toMatchObject({ status: "starting", issueNumber: undefined, desk: { seatId: "seat-desk-north-1-1" } });
    await settle();
    expect(deskAsked).toEqual(["open slot-1"]);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined, pr: undefined, desk: { seatId: "seat-desk-north-1-1" } });
    // Nothing about an issue, and no work events.
    expect(slots.pendingEvents()).toEqual([]);
    expect(slots.freeForStanding()).toEqual(["slot-2"]);
  });

  it("sizes the session's terminal and its agent to the CEO's panel, from the start if asked first, and back once it closes", async () => {
    const resized: string[] = [];
    const mock = createMockAgent({ outcome: "pr-opened", stepMs: STEP_MS });
    const agent: Agent = {
      ...mock,
      startSession: (session, reporter) => ({
        ...mock.startSession!(session, reporter),
        resize: (cols, rows) => resized.push(`${cols}x${rows}`),
      }),
    };
    const slots = deskPool({ agent });
    const resize = (cols: number, rows: number, seatId = "seat-desk-north-1-1"): RunnerSlotCommand => ({
      id: `command-${cols}`,
      slotId: "slot-1",
      kind: "desk-resize",
      seatId,
      cols,
      rows,
    });
    slots.handle(resize(90, 25));
    slots.handle(OPEN);
    slots.handle(resize(150, 40));
    const term = slots.screens()[0]![1].term;
    expect([term.cols, term.rows]).toEqual([150, 40]);
    await settle();
    expect(resized).toEqual(["150x40"]);
    slots.handle(resize(120, 30));
    slots.handle(resize(60, 20, "seat-desk-north-1-2"));
    expect(resized).toEqual(["150x40", "120x30"]);
    expect([term.cols, term.rows]).toEqual([120, 30]);
    slots.handle(CLOSE);
    expect([term.cols, term.rows]).toEqual([SCREEN_COLS, SCREEN_ROWS]);
  });

  it("types the CEO's prompt only while the session waits at its prompt, and reports each", async () => {
    const slots = deskPool();
    slots.handle(OPEN);
    slots.handle({ ...PROMPT, id: "command-early" });
    await settle();
    await vi.advanceTimersByTimeAsync(STEP_MS);
    slots.handle(PROMPT);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Thinking: List the routes." });
    slots.handle({ ...PROMPT, id: "command-busy" });
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "idle", activity: TURN_DONE });
    expect(slots.pendingPromptOutcomes()).toEqual([
      { commandId: "command-early", slotId: "slot-1", outcome: "busy" },
      { commandId: "command-p", slotId: "slot-1", outcome: "delivered" },
      { commandId: "command-busy", slotId: "slot-1", outcome: "busy" },
    ]);
  });

  it("presses no key on a session that waits on no choice", async () => {
    const slots = deskPool();
    slots.handle(OPEN);
    await settle();
    await vi.advanceTimersByTimeAsync(STEP_MS);
    slots.handle({ id: "command-k", slotId: "slot-1", kind: "key", key: "enter", requestedBy: "Dana" });
    expect(slots.pendingPromptOutcomes()).toEqual([{ commandId: "command-k", slotId: "slot-1", outcome: "unavailable" }]);
  });

  it("closes the session the server asks to, and only for that desk, discarding its worktree and saying nothing", async () => {
    const slots = deskPool();
    slots.handle(OPEN);
    await settle();
    await vi.advanceTimersByTimeAsync(STEP_MS);
    slots.handle({ ...CLOSE, seatId: "seat-desk-north-2-1" });
    expect(slot(slots)?.desk).toEqual({ seatId: "seat-desk-north-1-1" });
    slots.handle(CLOSE);
    await settle();
    expect(slot(slots)).toEqual({ id: "slot-1", name: FIRST, ...DEFAULT_PROFILE, status: "idle", issueNumber: undefined, activity: "", pr: undefined });
    expect(deskAsked).toEqual(["open slot-1", "close /desks/slot-1"]);
    expect(slots.pendingEvents()).toEqual([]);
  });

  it("gives the desk up to an issue's start, saying why, as a standing run does", async () => {
    const slots = deskPool();
    slots.handle(OPEN);
    await settle();
    await vi.advanceTimersByTimeAsync(STEP_MS);
    slots.handle(START);
    expect(slot(slots)).toMatchObject({ status: "starting", issueNumber: 39 });
    expect(slot(slots)?.desk).toBeUndefined();
    expect(deskEvents(slots)).toEqual([
      { id: "event-1", kind: "desk-ended", slotId: "slot-1", seatId: "seat-desk-north-1-1", message: `${FIRST} was taken back for issue #39` },
    ]);
  });

  it("refuses a desk for a slot on an issue, or past the day's budget, saying why", async () => {
    const ledger = new SpendLedger({ budgetUsd: 0 });
    const broke = deskPool({ ledger });
    broke.handle(OPEN);
    expect(slot(broke)?.desk).toBeUndefined();
    expect(deskEvents(broke)[0]).toMatchObject({ kind: "desk-ended", seatId: "seat-desk-north-1-1" });

    const busy = deskPool();
    busy.handle(START);
    busy.handle(OPEN);
    expect(slot(busy)).toMatchObject({ issueNumber: 39 });
    expect(deskEvents(busy)).toEqual([
      { id: "event-1", kind: "desk-ended", slotId: "slot-1", seatId: "seat-desk-north-1-1", message: `${FIRST} is busy with #39` },
    ]);
  });

  it("refuses a desk for a slot on a standing run, leaving the run on it", () => {
    const slots = deskPool();
    const lease = slots.leaseForStanding("slot-1", { taskId: "nightly", pr: undefined }, "Reviewing");
    slots.handle(OPEN);
    expect(lease?.signal.aborted).toBe(false);
    expect(slot(slots)).toMatchObject({ status: "working", standing: { taskId: "nightly" } });
    expect(slot(slots)?.desk).toBeUndefined();
    expect(deskEvents(slots)).toEqual([
      { id: "event-1", kind: "desk-ended", slotId: "slot-1", seatId: "seat-desk-north-1-1", message: `${FIRST} is busy with nightly` },
    ]);
  });

  it("ends a session whose worktree could not be made, saying why", async () => {
    const slots = deskPool({ failOpen: "no clone" });
    slots.handle(OPEN);
    await settle();
    expect(slot(slots)?.desk).toBeUndefined();
    expect(deskEvents(slots)[0]).toMatchObject({ message: "No worktree: no clone" });
  });

  it("refuses a desk for an agent that takes no desk sessions", () => {
    const agent: Agent = { label: "Plain", start: () => ({ stop: () => Promise.resolve() }) };
    const slots = deskPool({ agent });
    slots.handle(OPEN);
    expect(deskEvents(slots)[0]).toMatchObject({ message: "The Plain agent takes no desk sessions on this runner" });
  });
});
