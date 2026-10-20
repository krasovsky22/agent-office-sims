/**
 * Test support for the slot pool's tests, one file a concern so Vitest runs
 * them in parallel: the commands and names they share, and a pool with the
 * `mock` agent whose every task works in a plain git checkout.
 */

import {
  DEFAULT_AGENT_DESCRIPTION,
  DEFAULT_AGENT_TITLE,
  type RunnerPromptCommand,
  type RunnerStartCommand,
  defaultAgentName,
  isRunnerWorkEvent,
} from "@sim/shared";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";

import { type MockOutcome, createMockAgent } from "./agents/mock.js";
import type { Agent } from "./agents/types.js";
import { type GitFixture, gitFixture } from "./gitFixture.js";
import type { TaskGithub } from "./github.js";
import { type SlotWorkspaces, SlotPool } from "./slots.js";

export const REPO = "krasovsky22/agent-office-sims";
export const STEP_MS = 100;
export const TIMEOUT_MS = 60_000;
/** The mock's script from the start command to its wait on a person. */
export const TO_WAIT_MS = STEP_MS * 4;
/** The rest of its script, from the answer to its outcome. */
export const FROM_ANSWER_MS = STEP_MS * 2;

export const START: RunnerStartCommand = {
  id: "command-1",
  slotId: "slot-1",
  kind: "start",
  issueNumber: 39,
  title: "Night shift",
  url: `https://github.com/${REPO}/issues/39`,
  note: "",
  requestedBy: "Dana",
};

/** The pool's agents' default names, its runner id left at its default. */
export const FIRST = defaultAgentName("runner", 0);
export const SECOND = defaultAgentName("runner", 1);

/** What every slot reports of its agent's profile until the CEO edits it, but its name. */
export const DEFAULT_PROFILE = { title: DEFAULT_AGENT_TITLE, description: DEFAULT_AGENT_DESCRIPTION };

/** The CEO's answer to what the mock waits on. */
export const ANSWER: RunnerPromptCommand = { id: "command-answer", slotId: "slot-1", kind: "prompt", text: "Go ahead.", requestedBy: "Dana" };

/** The events about issue work the pool holds, oldest first. */
export function workEvents(slots: SlotPool) {
  return slots.pendingEvents().filter(isRunnerWorkEvent);
}

export let fixture: GitFixture;
/** What the pool asked of its workspaces, in order. */
export let asked: string[];

/** Every task works in the fixture's checkout; `fail` refuses to open one. */
export function workspaces(fail?: string): SlotWorkspaces {
  return {
    open: async (slotId, issueNumber) => {
      asked.push(`open ${slotId} #${issueNumber}`);
      if (fail !== undefined) {
        throw new Error(fail);
      }
      return fixture.developer;
    },
    close: async (slotId, issueNumber, discard) => {
      if (discard !== undefined) {
        await discard(`sims/issue-${issueNumber}-${slotId}`, fixture.developer);
      }
      asked.push(`close ${slotId} #${issueNumber}${discard === undefined ? "" : " discarding"}`);
    },
  };
}

export function pool(outcome: MockOutcome = "failed", agent?: Agent, spaces = workspaces(), github?: TaskGithub) {
  let nextId = 1;
  return new SlotPool({
    count: 2,
    agent: agent ?? createMockAgent({ outcome, stepMs: STEP_MS }),
    workspaces: spaces,
    taskTimeoutMs: TIMEOUT_MS,
    eventId: () => `event-${nextId++}`,
    ...(github === undefined ? {} : { github }),
  });
}

/** Lets an opened workspace reach the agent waiting on it. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

export function slot(slots: SlotPool, id = "slot-1") {
  return slots.report().find((candidate) => candidate.id === id);
}

/** Runs the mock's whole script to its outcome, answering its wait on a person. */
export async function runScript(slots: SlotPool): Promise<void> {
  await vi.advanceTimersByTimeAsync(TO_WAIT_MS);
  slots.handle(ANSWER);
  await vi.advanceTimersByTimeAsync(FROM_ANSWER_MS);
}

/**
 * Gives each test of the calling suite a fresh copy of one git fixture made
 * for the file, an empty `asked`, and fake timers unless told otherwise.
 */
export function useSlotFixture({ fakeTimers = true }: { fakeTimers?: boolean } = {}): void {
  let template: GitFixture;
  beforeAll(() => {
    template = gitFixture();
  });
  afterAll(() => {
    template.cleanup();
  });
  beforeEach(() => {
    fixture = template.copy();
    asked = [];
    if (fakeTimers) {
      vi.useFakeTimers();
    }
  });
  afterEach(() => {
    vi.useRealTimers();
    fixture.cleanup();
  });
}
