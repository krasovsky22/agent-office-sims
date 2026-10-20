/**
 * Keys the CEO presses for a slot's agent: pressed only while it waits on a
 * person, and answering the mock's permission menu.
 */

import type { AgentKey, RunnerSlotCommand } from "@sim/shared";
import { describe, expect, it, vi } from "vitest";

import { MOCK_PERMISSION } from "./agents/mock.js";
import type { Agent, AgentReporter } from "./agents/types.js";
import { TURN_DONE } from "./slotRuns.js";
import { NO_PULL_REQUEST, SlotPool } from "./slots.js";
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
  workspaces,
} from "./slotPoolFixture.js";

describe("SlotPool keys from the CEO", () => {
  useSlotFixture();

  let nextCommand = 100;
  function ceoKey(key: AgentKey): RunnerSlotCommand {
    nextCommand += 1;
    return { id: `command-${nextCommand}`, slotId: "slot-1", kind: "key", key, requestedBy: "Dana" };
  }

  /** A terminal agent driven by the test, recording the keys pressed in it. */
  function keyedAgent(takesKeys = true) {
    const pressed: AgentKey[] = [];
    const handle: { reporter?: AgentReporter } = {};
    const agent: Agent = {
      label: "Claude",
      start: (_task, reporter) => {
        handle.reporter = reporter;
        return takesKeys ? { stop: () => Promise.resolve(), key: (key) => pressed.push(key) } : { stop: () => Promise.resolve() };
      },
    };
    return { agent, pressed, handle };
  }

  it("presses a key only while the agent waits on a person, says what came of each, and logs each", async () => {
    const { agent, pressed, handle } = keyedAgent();
    const lines: string[] = [];
    const slots = new SlotPool({ count: 1, agent, workspaces: workspaces(), taskTimeoutMs: TIMEOUT_MS, log: (line) => lines.push(line) });
    const outcomes = () => slots.pendingPromptOutcomes().map((outcome) => outcome.outcome);

    slots.handle(ceoKey("enter"));
    slots.handle(START);
    await settle();
    handle.reporter?.progress("Bash: pnpm test");
    slots.handle(ceoKey("enter"));
    handle.reporter?.needsInput("Wants permission: Bash: git push");
    slots.handle(ceoKey("down"));
    slots.handle(ceoKey("enter"));
    expect(pressed).toEqual(["down", "enter"]);
    expect(outcomes()).toEqual(["unavailable", "not-waiting", "delivered", "delivered"]);
    expect(lines).toContain("key Enter for slot-1 from Dana not pressed: unavailable");
    expect(lines).toContain("key Enter for slot-1 from Dana not pressed: not-waiting");
    expect(lines).toContain("slot-1 on #39: Dana pressed Down");
    expect(lines).toContain("slot-1 on #39: Dana pressed Enter");

    // A turn that ended with nothing handed in leaves it at its prompt, where a prompt is the answer, not a key.
    handle.reporter?.turnDone();
    await settle();
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: NO_PULL_REQUEST });
    slots.handle(ceoKey("escape"));
    expect(pressed).toHaveLength(2);
    expect(outcomes().at(-1)).toBe("not-waiting");
  });

  it("refuses a key for an agent with no screen to press it on", async () => {
    const { agent, handle } = keyedAgent(false);
    const slots = pool("failed", agent);
    slots.handle(START);
    await settle();
    handle.reporter?.needsInput("Waiting on a person");
    slots.handle(ceoKey("enter"));
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["unavailable"]);
  });

  it("answers the mock's permission menu with keys: moving to yes and confirming has it carry on and hand in", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: MOCK_PERMISSION });
    slots.handle(ceoKey("down"));
    slots.handle(ceoKey("up"));
    slots.handle(ceoKey("enter"));
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["delivered", "delivered", "delivered"]);
    await vi.advanceTimersByTimeAsync(FROM_ANSWER_MS);
    expect(slot(slots)).toMatchObject({ status: "idle", issueNumber: 39, activity: TURN_DONE, pr: { simulated: true } });
  });

  it("has the mock told no with Esc end its turn and wait at its prompt for what to do instead", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
    slots.handle(ceoKey("escape"));
    await settle();
    expect(slot(slots)).toMatchObject({ status: "needs-input", issueNumber: 39, activity: NO_PULL_REQUEST, pr: undefined });
    slots.handle(ceoKey("enter"));
    expect(slots.pendingPromptOutcomes().map((outcome) => outcome.outcome)).toEqual(["delivered", "not-waiting"]);
    // Told what to do instead, it does it, and hands in.
    slots.handle({ id: "command-told", slotId: "slot-1", kind: "prompt", text: "Skip the tests.", requestedBy: "Dana", fromCeo: true });
    await vi.advanceTimersByTimeAsync(STEP_MS * 6);
    expect(slot(slots)).toMatchObject({ status: "idle", activity: TURN_DONE, pr: { simulated: true } });
  });

  it("has the mock take a number as the choice it names", async () => {
    const slots = pool("pr-opened");
    slots.handle(START);
    await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
    // Past its choices: nothing happens.
    slots.handle(ceoKey("9"));
    await vi.advanceTimersByTimeAsync(FROM_ANSWER_MS);
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: MOCK_PERMISSION });
    slots.handle(ceoKey("2"));
    await settle();
    expect(slot(slots)).toMatchObject({ status: "needs-input", activity: NO_PULL_REQUEST });
  });
});
