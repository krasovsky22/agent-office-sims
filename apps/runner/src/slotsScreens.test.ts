/**
 * The screen each slot shows: waiting for work, what a run prints, the mock's
 * script, menu and question, and a desk session.
 */

import { DEFAULT_AGENT_TITLE } from "@sim/shared";
import { describe, expect, it, vi } from "vitest";

import { MOCK_PERMISSION, MOCK_PERMISSION_CHOICES, MOCK_QUESTION, MOCK_SESSION_ANSWER, MOCK_SESSION_HINT, createMockAgent } from "./agents/mock.js";
import type { Agent } from "./agents/types.js";
import { createRedactor } from "./redact.js";
import { TURN_DONE } from "./slotRuns.js";
import { NO_PULL_REQUEST, SlotPool } from "./slots.js";
import {
  ANSWER,
  FIRST,
  SECOND,
  START,
  TIMEOUT_MS,
  pool,
  slot,
  useSlotFixture,
  workEvents,
  workspaces,
} from "./slotPoolFixture.js";

describe("SlotPool screens", () => {
  // Real timers: xterm parses what it is fed on a timer of its own.
  useSlotFixture({ fakeTimers: false });

  /** The text on a slot's screen, row by row, as its next whole frame carries it. */
  async function screenText(slots: SlotPool, id = "slot-1"): Promise<string[]> {
    const mirror = new Map(slots.screens()).get(id);
    await mirror?.written();
    mirror?.sendWhole();
    const frame = mirror?.flush(0, createRedactor([]));
    return Object.values(frame?.lines ?? {})
      .map((runs) => runs.map((run) => run[0]).join(""))
      .filter((text) => text !== "");
  }

  /** An agent whose run prints whatever the test hands `print`, until it is stopped. */
  function printingAgent() {
    const printer: { print?: (data: string) => void } = {};
    const agent: Agent = {
      label: "Echo",
      start: (_task, reporter) => {
        printer.print = (data) => reporter.output(data);
        reporter.started();
        return { stop: () => Promise.resolve() };
      },
    };
    return { agent, printer };
  }

  it("gives every slot a screen that says it is waiting for work", async () => {
    const slots = pool();
    expect(slots.screens().map(([id]) => id)).toEqual(["slot-1", "slot-2"]);
    expect(await screenText(slots, "slot-2")).toEqual([`${SECOND} is waiting for work.`]);
  });

  it("shows what a run prints on a cleared screen, and keeps it there once the run ends", async () => {
    const { agent, printer } = printingAgent();
    const slots = pool("failed", agent);
    slots.handle(START);
    await vi.waitFor(() => expect(printer.print).toBeDefined());
    printer.print?.("\u001b[32mpnpm test\u001b[0m\r\npassed\r\n");
    expect(await screenText(slots)).toEqual(["pnpm test", "passed"]);

    slots.handle({ id: "command-2", slotId: "slot-1", kind: "stop", reason: "" });
    printer.print?.("after the end");
    expect(await screenText(slots)).toEqual(["pnpm test", "passed"]);
    expect(await screenText(slots, "slot-2")).toEqual([`${SECOND} is waiting for work.`]);
  });

  it("prints the mock agent's script", async () => {
    const slots = new SlotPool({
      count: 1,
      agent: createMockAgent({ outcome: "pr-opened", stepMs: 1 }),
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
    });
    slots.handle(START);
    await vi.waitFor(() => expect(slot(slots)?.status).toBe("needs-input"), { timeout: 10_000 });
    slots.handle(ANSWER);
    // `idle` is also the status just after `started`; the run is over once its pull request is handed in.
    await vi.waitFor(() => expect(workEvents(slots).map((event) => event.kind)).toContain("pr-opened"), {
      timeout: 10_000,
    });
    const screen = await screenText(slots);
    expect(screen.slice(0, 4)).toEqual([
      "mock agent on #39: Night shift",
      "for Dana",
      // The system prompt a real agent would be given, from its profile.
      `In this office your name is ${FIRST} and your title is ${DEFAULT_AGENT_TITLE}.`,
      "Your role, as the CEO describes it:",
    ]);
    expect(screen.slice(screen.indexOf("● Reading issue #39"))).toEqual([
      "● Reading issue #39",
      "● Edit: .sims-mock/issue-39.md",
      "● Bash: git commit",
      `? ${MOCK_PERMISSION}`,
      "  Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No, and tell the agent what to do differently (esc)",
      "  ↑/↓ to move · Enter to confirm · Esc to cancel",
      "> Go ahead.",
      "● Bash: pnpm test",
      "✓ Handed in a simulated pull request; nothing was opened on GitHub",
    ]);
    expect(screen.join("\n")).not.toContain("github.com");
  });

  it("draws the mock's permission menu, and moves its pointer as the CEO presses keys", async () => {
    const slots = new SlotPool({
      count: 1,
      agent: createMockAgent({ outcome: "pr-opened", stepMs: 1 }),
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
    });
    slots.handle(START);
    await vi.waitFor(() => expect(slot(slots)?.activity).toBe(MOCK_PERMISSION), { timeout: 10_000 });
    expect(await screenText(slots)).toEqual(
      expect.arrayContaining([`❯ 1. ${MOCK_PERMISSION_CHOICES[0]}`, `  2. ${MOCK_PERMISSION_CHOICES[1]}`]),
    );
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "key", key: "down", requestedBy: "Dana" });
    const text = await screenText(slots);
    expect(text).toEqual(expect.arrayContaining([`  1. ${MOCK_PERMISSION_CHOICES[0]}`, `❯ 2. ${MOCK_PERMISSION_CHOICES[1]}`]));
    // Drawn over itself: the menu is there once, its hint under it.
    expect(text.filter((line) => line.includes(MOCK_PERMISSION_CHOICES[0]))).toHaveLength(1);
    expect(text.at(-1)).toMatch(/Enter to confirm/);
  });

  it("prints the mock's question, and the CEO's answer typed to it", async () => {
    const slots = new SlotPool({
      count: 1,
      agent: createMockAgent({ outcome: "question", stepMs: 1 }),
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
    });
    slots.handle(START);
    await vi.waitFor(() => expect(slot(slots)?.activity).toBe(MOCK_PERMISSION), { timeout: 10_000 });
    slots.handle(ANSWER);
    await vi.waitFor(() => expect(slot(slots)?.activity).toBe(NO_PULL_REQUEST), { timeout: 10_000 });
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "prompt", text: "Yes.\nBoth cases.", requestedBy: "Dana", fromCeo: true });
    await vi.waitFor(() => expect(workEvents(slots).map((event) => event.kind)).toContain("pr-opened"), {
      timeout: 10_000,
    });
    const text = await screenText(slots);
    expect(text).toContain(`? ${MOCK_QUESTION}`);
    expect(text).toContain("> Yes.");
    expect(text).toContain("  Both cases.");
  });

  it("shows a desk session on a cleared screen, and the CEO's prompt and its answer", async () => {
    const slots = new SlotPool({
      count: 1,
      agent: createMockAgent({ outcome: "failed", stepMs: 1 }),
      workspaces: workspaces(),
      desks: { open: async () => "/desks/slot-1", close: async () => undefined },
      taskTimeoutMs: TIMEOUT_MS,
    });
    slots.handle({ id: "command-1", slotId: "slot-1", kind: "desk-open", seatId: "seat-desk-north-1-1", requestedBy: "Dana" });
    await vi.waitFor(() => expect(slot(slots)?.status).toBe("idle"), { timeout: 10_000 });
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "prompt", text: "List the routes.", requestedBy: "Dana", fromCeo: true });
    await vi.waitFor(() => expect(slot(slots)?.activity).toBe(TURN_DONE), { timeout: 10_000 });
    const text = await screenText(slots);
    expect(text).not.toContain(`${FIRST} is waiting for work.`);
    expect(text[0]).toBe("mock agent at Dana's desk");
    expect(text).toContain(MOCK_SESSION_HINT);
    expect(text).toContain("> List the routes.");
    expect(text).toContain(`✓ ${MOCK_SESSION_ANSWER}: List the routes.`);
  });
});
