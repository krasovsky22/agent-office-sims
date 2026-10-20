/**
 * The slot pool's spending: each task's running total booked once, the mock's
 * pretend spend counted step by step, and a start refused once the day's
 * budget is gone.
 */

import { describe, expect, it } from "vitest";

import { MOCK_STEP_USD, createMockAgent } from "./agents/mock.js";
import type { Agent, AgentReporter } from "./agents/types.js";
import { SpendLedger } from "./budget.js";
import { SlotPool } from "./slots.js";
import {
  START,
  STEP_MS,
  TIMEOUT_MS,
  asked,
  runScript,
  settle,
  slot,
  useSlotFixture,
  workEvents,
  workspaces,
} from "./slotPoolFixture.js";

describe("SlotPool spend", () => {
  useSlotFixture();

  /** An agent that is up and waits, handing its reporter out so a test can speak for it. */
  function waitingAgent(reporters: AgentReporter[]): Agent {
    return {
      label: "Paid",
      start: (_task, reporter) => {
        reporters.push(reporter);
        reporter.started();
        return { stop: () => Promise.resolve() };
      },
    };
  }

  function budgeted(agent: Agent, budgetUsd: number | undefined) {
    let nextId = 1;
    return new SlotPool({
      count: 2,
      agent,
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
      eventId: () => `event-${nextId++}`,
      ledger: new SpendLedger({ budgetUsd, now: () => new Date(2026, 9, 16, 12) }),
    });
  }

  it("books each task's running total once, its last turn too after it was stopped", async () => {
    const reporters: AgentReporter[] = [];
    const slots = budgeted(waitingAgent(reporters), undefined);
    slots.handle(START);
    slots.handle({ ...START, id: "command-2", slotId: "slot-2", issueNumber: 40 });
    await settle();
    const [first, second] = reporters;
    first?.spent(0.5);
    first?.spent(1.25);
    second?.spent(0.25);
    expect(slots.spend()).toEqual({ spentUsd: 1.5, budgetUsd: undefined });

    slots.handle({ id: "command-3", slotId: "slot-1", kind: "stop", reason: "" });
    first?.spent(1.5);
    expect(slots.spend().spentUsd).toBe(1.75);
  });

  it("counts the mock's pretend spend, step by step", async () => {
    const slots = budgeted(createMockAgent({ outcome: "failed", stepMs: STEP_MS }), undefined);
    slots.handle(START);
    await settle();
    await runScript(slots);
    expect(slots.spend().spentUsd).toBeCloseTo(4 * MOCK_STEP_USD);
  });

  it("refuses a start once the day's budget is spent, as a failed start marked as the budget's", async () => {
    const reporters: AgentReporter[] = [];
    const slots = budgeted(waitingAgent(reporters), 2);
    slots.handle(START);
    await settle();
    reporters[0]?.spent(2.5);
    slots.delivered(new Set(workEvents(slots).map((event) => event.id)));

    slots.handle({ ...START, id: "command-2", slotId: "slot-2", issueNumber: 40 });
    await settle();
    expect(reporters).toHaveLength(1);
    expect(slot(slots, "slot-2")).toMatchObject({ status: "idle", issueNumber: undefined });
    expect(asked).toEqual(["open slot-1 #39"]);
    expect(workEvents(slots)).toEqual([
      {
        id: "event-2",
        kind: "failed",
        slotId: "slot-2",
        issueNumber: 40,
        pr: undefined,
        message: "The runner's daily budget of $2.00 is spent ($2.50 today), so it starts no new work until midnight on its machine",
        refusal: "budget",
      },
    ]);
    // Work already under way carries on, and a start it already holds is not new work.
    slots.handle({ ...START, id: "command-3" });
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39 });
    expect(workEvents(slots).filter((event) => event.refusal !== undefined)).toHaveLength(1);
  });
});
