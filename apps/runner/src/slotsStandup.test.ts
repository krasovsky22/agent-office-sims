/**
 * The slot pool during a standup: its agents paused before their next step and
 * their task timeouts held, and the CEO's directions typed at once or kept until
 * an agent can take them.
 */

import type { RunnerPromptCommand } from "@sim/shared";
import { describe, expect, it, vi } from "vitest";

import type { AnswerRequest, AnswerResult, Answerer } from "./agents/answer.js";
import { MOCK_PERMISSION, MOCK_PERMISSION_GRANTED } from "./agents/mock.js";
import type { Agent, AgentReporter } from "./agents/types.js";
import { SpendLedger } from "./budget.js";
import { TURN_DONE } from "./slotRuns.js";
import { SlotPool } from "./slots.js";
import {
  FROM_ANSWER_MS,
  START,
  STEP_MS,
  TIMEOUT_MS,
  TO_WAIT_MS,
  pool,
  settle,
  slot,
  useSlotFixture,
  workEvents,
  workspaces,
} from "./slotPoolFixture.js";

describe("SlotPool during a standup", () => {
  useSlotFixture();

  let nextCommand = 100;
  function direction(text: string): RunnerPromptCommand {
    nextCommand += 1;
    return { id: `command-${nextCommand}`, slotId: "slot-1", kind: "prompt", text, requestedBy: "Dana", fromCeo: true, queue: true };
  }

  /** A terminal agent driven by the test, which cannot pause, recording what is typed into it. */
  function realAgent() {
    const typed: string[] = [];
    const handle: { reporter?: AgentReporter } = {};
    const agent: Agent = {
      label: "Claude",
      start: (_task, reporter) => {
        handle.reporter = reporter;
        return { stop: () => Promise.resolve(), prompt: (text) => typed.push(text) };
      },
    };
    return { agent, typed, handle };
  }

  it("pauses the mock before its next step, nothing undone, and lets it carry on from there once it is over", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Reading issue #39" });

    slots.setStandup(true);
    await vi.advanceTimersByTimeAsync(STEP_MS * 20);
    expect(slot(slots)).toMatchObject({ status: "working", issueNumber: 39, activity: "Reading issue #39" });
    expect(workEvents(slots).map((event) => event.kind)).toEqual(["started"]);

    slots.setStandup(false);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Edit: .sims-mock/issue-39.md" });
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: MOCK_PERMISSION });
  });

  it("has a mock whose permission the CEO gives during the standup back at work, and paused before its next step", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: MOCK_PERMISSION });
    slots.setStandup(true);
    slots.handle({ id: "command-key", slotId: "slot-1", kind: "key", key: "enter", requestedBy: "Dana" });
    expect(slot(slots)).toMatchObject({ status: "working", activity: MOCK_PERMISSION_GRANTED });
    await vi.advanceTimersByTimeAsync(STEP_MS * 10);
    expect(slot(slots)).toMatchObject({ status: "working", activity: MOCK_PERMISSION_GRANTED });

    slots.setStandup(false);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Bash: pnpm test" });
  });

  it("holds the task timeout for as long as it lasts, and lets it run on from where it was", async () => {
    const slots = pool();
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    slots.setStandup(true);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(slot(slots)).toMatchObject({ issueNumber: 39 });

    slots.setStandup(false);
    // It carries on to its wait on a person, which holds the timeout again.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39 });
  });

  it("pauses an agent started while it is on, before its first step", async () => {
    const slots = pool();
    slots.setStandup(true);
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS * 10);
    // Up, holding the issue, and no step taken.
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: "" });
    slots.setStandup(false);
    await vi.advanceTimersByTimeAsync(STEP_MS * 2);
    expect(slot(slots)?.activity).toBe("Edit: .sims-mock/issue-39.md");
  });

  it("types a direction at once for an agent at its prompt", async () => {
    const { agent, typed, handle } = realAgent();
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    handle.reporter?.turnDone();
    await settle();
    slots.setStandup(true);
    const now = direction("Skip the server part and open the PR.");
    slots.handle(now);
    expect(typed).toEqual(["Skip the server part and open the PR."]);
    expect(slots.pendingPromptOutcomes()).toEqual([{ commandId: now.id, slotId: "slot-1", outcome: "delivered" }]);
  });

  it("keeps a direction for an agent in a turn, and types it once the standup is over and its turn is done", async () => {
    const { agent, typed, handle } = realAgent();
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    handle.reporter?.progress("Bash: pnpm test");
    slots.setStandup(true);
    const kept = direction("Open the PR.");
    slots.handle(kept);
    expect(typed).toEqual([]);
    expect(slots.pendingPromptOutcomes()).toEqual([{ commandId: kept.id, slotId: "slot-1", outcome: "queued" }]);

    // Its turn ends during the standup: it waits there, the direction still kept.
    handle.reporter?.turnDone();
    await settle();
    expect(typed).toEqual([]);

    slots.setStandup(false);
    expect(typed).toEqual(["Open the PR."]);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Open the PR." });
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["queued", "delivered"]);
  });

  it("keeps a direction for an agent at a choice screen until it is at its prompt, one at a time", async () => {
    const { agent, typed, handle } = realAgent();
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    handle.reporter?.needsInput("Wants permission: Bash: git push");
    slots.setStandup(true);
    slots.handle(direction("First."));
    slots.handle(direction("Second."));
    slots.setStandup(false);
    expect(typed).toEqual([]);

    handle.reporter?.progress("Bash: git push");
    handle.reporter?.turnDone();
    await settle();
    expect(typed).toEqual(["First."]);
    handle.reporter?.turnDone();
    await settle();
    expect(typed).toEqual(["First.", "Second."]);
  });

  it("types a kept direction as the answer to a mock waiting on a person, once the standup is over", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(STEP_MS);
    slots.setStandup(true);
    const kept = direction("Go ahead and run the tests.");
    slots.handle(kept);
    slots.setStandup(false);
    await vi.advanceTimersByTimeAsync(STEP_MS * 3);
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["queued", "delivered"]);
    await vi.advanceTimersByTimeAsync(FROM_ANSWER_MS + STEP_MS);
    expect(slot(slots)).toMatchObject({ status: "idle", activity: TURN_DONE, pr: { simulated: true } });
  });

  it("says a kept direction is unavailable when the work ends first, and refuses one for a slot with no work", async () => {
    const { agent, typed, handle } = realAgent();
    const slots = pool("failed", agent);
    const idle = direction("Anyone?");
    slots.handle(idle);
    slots.handle(START);
    await settle();
    handle.reporter?.progress("Bash: pnpm test");
    slots.setStandup(true);
    slots.handle(direction("Open the PR."));
    slots.handle({ id: "command-stop", slotId: "slot-1", kind: "stop", reason: "unassigned" });
    expect(typed).toEqual([]);
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["unavailable", "queued", "unavailable"]);
  });

  it("forgets only the outcomes a sync carried, when one direction is reported twice", async () => {
    const { agent, handle } = realAgent();
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    handle.reporter?.progress("Bash: pnpm test");
    slots.setStandup(true);
    slots.handle(direction("Open the PR."));
    const carried = [...slots.pendingPromptOutcomes()];
    slots.setStandup(false);
    handle.reporter?.turnDone();
    await settle();
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["queued", "delivered"]);

    slots.delivered(new Set(carried.map((outcome) => outcome.commandId)), carried);
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["delivered"]);
  });

  describe("a direction for an agent with no session", () => {
    /** An answerer the test settles, recording what it was asked. */
    function answerer() {
      const asked: AnswerRequest[] = [];
      const finish: { answer?: (result: AnswerResult) => void } = {};
      const answers: Answerer = {
        answer: (request) => {
          asked.push(request);
          return new Promise((resolve) => {
            finish.answer = resolve;
          });
        },
      };
      return { answers, asked, finish };
    }

    function answering(answers: Answerer, budgetUsd?: number) {
      const ledger = new SpendLedger({ budgetUsd });
      const slots = new SlotPool({ count: 2, agent: realAgent().agent, workspaces: workspaces(), taskTimeoutMs: TIMEOUT_MS, ledger, answerer: answers });
      return { slots, ledger };
    }

    const outcomes = (slots: SlotPool) => slots.pendingPromptOutcomes().map(({ outcome, text }) => (text === undefined ? outcome : `${outcome}: ${text}`));

    it("is answered by its agent from its status, as itself, and what it spent is booked", async () => {
      const { answers, asked, finish } = answerer();
      const { slots, ledger } = answering(answers);
      slots.setStandup(true);
      slots.handle({ ...direction("What's the status?"), context: "Your update at this standup: No issue in hand, free for one. No blockers." });
      expect(outcomes(slots)).toEqual(["answering"]);
      expect(asked).toMatchObject([
        { question: "What's the status?", askedBy: "Dana", context: "Your update at this standup: No issue in hand, free for one. No blockers." },
      ]);
      expect(asked[0]?.systemPrompt).toContain(`your name is ${slot(slots)?.name}`);

      asked[0]?.spent(0.02);
      finish.answer?.({ ok: true, text: "I'm free and ready for an issue.", why: "" });
      await settle();
      expect(outcomes(slots)).toEqual(["answering", "answered: I'm free and ready for an issue."]);
      expect(ledger.report().spentUsd).toBeCloseTo(0.02);
      // Nothing about the slot changed: it is still free.
      expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: undefined });
    });

    it("says why it could not answer", async () => {
      const { answers, finish } = answerer();
      const { slots } = answering(answers);
      slots.handle(direction("What's the status?"));
      finish.answer?.({ ok: false, text: "", why: "it ran past its 1 minute" });
      await settle();
      expect(outcomes(slots)).toEqual(["answering", "not-answered: it ran past its 1 minute"]);
    });

    it("is not answered once the day's budget is spent", async () => {
      const { answers, asked } = answerer();
      const { slots, ledger } = answering(answers, 1);
      ledger.add(1);
      slots.handle(direction("What's the status?"));
      await settle();
      expect(asked).toEqual([]);
      expect(outcomes(slots)[0]).toMatch(/^not-answered: /);
    });

    it("leaves an agent with a session as it was: typed at its prompt, never answered", async () => {
      const { answers, asked } = answerer();
      const { agent, typed, handle } = realAgent();
      const slots = new SlotPool({ count: 2, agent, workspaces: workspaces(), taskTimeoutMs: TIMEOUT_MS, answerer: answers });
      slots.handle(START);
      await settle();
      handle.reporter?.turnDone();
      await settle();
      slots.setStandup(true);
      slots.handle(direction("Open the PR."));
      expect(typed).toEqual(["Open the PR."]);
      expect(asked).toEqual([]);
      expect(outcomes(slots)).toEqual(["delivered"]);
    });
  });
});
