/**
 * Prompts typed to a slot's agent: typed once its turn is done or as the answer
 * to a wait on a person, refused where they cannot go, and what came of each
 * reported.
 */

import type { RunnerSlotCommand } from "@sim/shared";
import { describe, expect, it, vi } from "vitest";

import { MOCK_PERMISSION } from "./agents/mock.js";
import type { Agent, AgentReporter } from "./agents/types.js";
import { TURN_DONE } from "./slotRuns.js";
import { NO_PULL_REQUEST } from "./slots.js";
import {
  FROM_ANSWER_MS,
  REPO,
  START,
  STEP_MS,
  TIMEOUT_MS,
  TO_WAIT_MS,
  pool,
  runScript,
  settle,
  slot,
  useSlotFixture,
  workEvents,
} from "./slotPoolFixture.js";

describe("SlotPool prompts from the CEO", () => {
  useSlotFixture();

  let nextCommand = 10;
  function ceoPrompt(text: string): RunnerSlotCommand {
    nextCommand += 1;
    return { id: `command-${nextCommand}`, slotId: "slot-1", kind: "prompt", text, requestedBy: "Dana", fromCeo: true };
  }

  /** A terminal agent driven by the test, recording what is typed into it. */
  function promptedAgent(takesPrompts = true) {
    const typed: string[] = [];
    const handle: { reporter?: AgentReporter } = {};
    const agent: Agent = {
      label: "Claude",
      start: (_task, reporter) => {
        handle.reporter = reporter;
        return takesPrompts ? { stop: () => Promise.resolve(), prompt: (text) => typed.push(text) } : { stop: () => Promise.resolve() };
      },
    };
    return { agent, typed, handle };
  }

  it("types a prompt only once the agent's turn is done, and says what came of each", async () => {
    const { agent, typed, handle } = promptedAgent();
    const slots = pool("failed", agent);
    const outcomes = () => slots.pendingPromptOutcomes().map((outcome) => outcome.outcome);

    // No task to be at a prompt for.
    slots.handle(ceoPrompt("anyone there?"));
    slots.handle(START);
    // Still checking the issue and starting.
    slots.handle(ceoPrompt("hurry"));
    await settle();
    slots.handle(ceoPrompt("hurry up"));
    handle.reporter?.progress("Bash: pnpm test");
    slots.handle(ceoPrompt("stop that"));
    handle.reporter?.needsInput("Wants permission: Bash: git push");
    slots.handle(ceoPrompt("yes"));
    // Its turn ended: while it looks for the pull request it is still busy.
    handle.reporter?.turnDone();
    slots.handle(ceoPrompt("well?"));
    expect(typed).toEqual([]);
    expect(outcomes()).toEqual(["unavailable", "busy", "busy", "busy", "needs-input", "busy"]);

    await settle();
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: NO_PULL_REQUEST });
    const answer = ceoPrompt("Yes, cover the empty case.\nThen open the pull request.");
    slots.handle(answer);
    expect(typed).toEqual(["Yes, cover the empty case.\nThen open the pull request."]);
    expect(slot(slots)).toMatchObject({ status: "working", issueNumber: 39, activity: "Yes, cover the empty case." });
    expect(slots.pendingPromptOutcomes().at(-1)).toEqual({ commandId: answer.id, slotId: "slot-1", outcome: "delivered" });

    // Back at its prompt after a turn with its work handed in, it is free again.
    handle.reporter?.prOpened({ number: 41, title: "Night shift", url: `https://github.com/${REPO}/pull/41` });
    handle.reporter?.turnDone();
    slots.handle(ceoPrompt("thanks"));
    expect(typed).toHaveLength(2);
    expect(outcomes().at(-1)).toBe("delivered");
  });

  it("types the CEO's prompt as the answer to a mock waiting on a person, and refuses it at a real agent's permission", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: MOCK_PERMISSION });
    const answer = ceoPrompt("Go ahead and run the tests.");
    slots.handle(answer);
    expect(slots.pendingPromptOutcomes()).toEqual([{ commandId: answer.id, slotId: "slot-1", outcome: "delivered" }]);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Go ahead and run the tests." });
    await vi.advanceTimersByTimeAsync(FROM_ANSWER_MS);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE, pr: { simulated: true } });

    // A dialog would take the Enter after the paste as its choice, whatever the prompt said.
    const { agent, typed, handle } = promptedAgent();
    const real = pool("failed", agent);
    real.handle(START);
    await settle();
    handle.reporter?.needsInput("Wants permission: Bash: git push");
    real.handle(ceoPrompt("No, don't push."));
    expect(typed).toEqual([]);
    expect(real.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["needs-input"]);
  });

  it("forgets the outcomes a sync delivered, by their command's id", () => {
    const slots = pool();
    const first = ceoPrompt("one");
    const second = ceoPrompt("two");
    slots.handle(first);
    slots.handle(second);
    slots.delivered(new Set([first.id]));
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.commandId)).toEqual([second.id]);
  });

  it("refuses a prompt for an agent that takes none", async () => {
    const { agent, handle } = promptedAgent(false);
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    handle.reporter?.turnDone();
    await settle();
    slots.handle(ceoPrompt("hello"));
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["unavailable"]);
  });

  it("still gives the office's own rework prompt whatever the agent is doing, and reports nothing for it", async () => {
    const { agent, typed, handle } = promptedAgent();
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    handle.reporter?.progress("Bash: pnpm test");
    slots.handle({ id: "command-2", slotId: "slot-1", kind: "prompt", text: "Rework it.", requestedBy: "Dana" });
    expect(typed).toEqual(["Rework it."]);
    expect(slots.pendingPromptOutcomes()).toEqual([]);
  });

  it("has a mock asking a question wait at its desk until the CEO answers, then hand in", async () => {
    const slots = pool("question");
    slots.handle(START);
    await runScript(slots);
    // Its turn is over with nothing handed in: it waits at its prompt, holding the issue.
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39, activity: NO_PULL_REQUEST, pr: undefined });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS / 2);
    expect(slot(slots)?.issueNumber).toBe(39);

    const answer = ceoPrompt("Yes, the empty case too.");
    slots.handle(answer);
    expect(slots.pendingPromptOutcomes()).toEqual([{ commandId: answer.id, slotId: "slot-1", outcome: "delivered" }]);
    expect(slot(slots)).toMatchObject({ status: "working", activity: "Yes, the empty case too." });
    await vi.advanceTimersByTimeAsync(STEP_MS * 6);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE, pr: { number: 1_000_039 } });
    expect(workEvents(slots).map((event) => event.kind)).toEqual(["started", "pr-opened"]);
  });
});
