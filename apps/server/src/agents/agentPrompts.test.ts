/**
 * The CEO's prompts from sent to typed or turned down, against a real runner
 * link: each one reaches the runner once, as a prompt marked as the CEO's,
 * and what the runner says came of it is taken once, from that runner and
 * slot only.
 */

import {
  AGENT_PROMPT_REJECTION,
  type AgentPromptEntry,
  type AgentPromptRejectedEvent,
  HumanPlayer,
  LiveAgent,
  OCCUPANT_KIND,
  OfficeState,
  PLAYER_ROLE,
  RUNNER_PROMPT_OUTCOME,
  type RunnerPromptOutcome,
  type RunnerPromptOutcomeKind,
  liveAgentKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { AgentPrompts } from "./agentPrompts.js";
import { RunnerLink, runnerSlotAgentId } from "./runnerLink.js";

const REPO = "krasovsky22/agent-office-sims";
const CEO = "session-ceo";
const SLOT_1 = liveAgentKey(runnerSlotAgentId("box", "slot-1"));
const REPORTED = liveAgentKey("crewmate");

function setup(options: { runner?: boolean } = {}) {
  let nextId = 1;
  let now = 1_000;
  const link = new RunnerLink({ repository: REPO, timeoutMs: 30_000, commandId: () => `command-${nextId++}` });
  const inbox = link.openEventInbox();
  const state = new OfficeState();
  const ceo = new HumanPlayer();
  ceo.id = CEO;
  ceo.name = "Dana";
  ceo.role = PLAYER_ROLE.ceo;
  state.occupants.set(CEO, ceo);
  for (const [id, name] of [
    [SLOT_1, "Claude 1"],
    [REPORTED, "Crewmate"],
  ] as const) {
    const agent = new LiveAgent();
    agent.id = id;
    agent.name = name;
    agent.kind = OCCUPANT_KIND.liveAgent;
    state.occupants.set(id, agent);
  }
  const refused: Array<{ sessionId: string; event: AgentPromptRejectedEvent }> = [];
  const published: AgentPromptEntry[] = [];
  const prompts = new AgentPrompts({
    state,
    runner: options.runner === false ? undefined : link,
    now: () => now,
    refuse: (sessionId, event) => refused.push({ sessionId, event }),
    publish: (entry) => published.push(entry),
    answerTimeoutMs: 30_000,
  });
  /** One sync from the runner `box`, with one working slot, carrying prompt outcomes and acks. */
  const sync = (outcomes: RunnerPromptOutcome[] = [], acked: string[] = [], runnerId = "box") => {
    const outcome = link.sync({
      runnerId,
      repo: REPO,
      acked,
      slots: [{ id: "slot-1", name: "Claude 1", status: "working", issueNumber: 39, activity: "", pr: undefined }],
      events: [],
      prompts: outcomes,
    });
    prompts.receive(inbox.drainPrompts());
    return outcome.kind === "accepted" ? outcome.commands : [];
  };
  const report = (commandId: string, outcome: RunnerPromptOutcomeKind, slotId = "slot-1") => ({ commandId, slotId, outcome });
  return {
    link,
    prompts,
    refused,
    published,
    sync,
    report,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("AgentPrompts", () => {
  it("queues the CEO's prompt for the slot's runner, marked as the CEO's, and shows nothing yet", () => {
    const { prompts, sync, published, refused } = setup();
    sync();
    expect(prompts.submit(CEO, { agentId: SLOT_1, text: "Yes, cover the empty case." })).toBeUndefined();
    expect(sync()).toEqual([
      {
        id: "command-1",
        slotId: "slot-1",
        kind: "prompt",
        text: "Yes, cover the empty case.",
        requestedBy: "Dana",
        fromCeo: true,
      },
    ]);
    expect(published).toEqual([]);
    expect(refused).toEqual([]);
  });

  it("reaches the runner once: it stops coming once acked", () => {
    const { prompts, sync } = setup();
    sync();
    prompts.submit(CEO, { agentId: SLOT_1, text: "go on" });
    expect(sync()).toHaveLength(1);
    expect(sync()).toHaveLength(1);
    expect(sync([], ["command-1"])).toEqual([]);
    expect(sync()).toEqual([]);
  });

  it("tells everyone once it is typed, once however often the runner says so", () => {
    const { prompts, sync, report, published, refused } = setup();
    sync();
    prompts.submit(CEO, { agentId: SLOT_1, text: "Yes.\nThen push." });
    sync([report("command-1", RUNNER_PROMPT_OUTCOME.delivered)]);
    sync([report("command-1", RUNNER_PROMPT_OUTCOME.delivered)]);
    expect(published).toEqual([
      {
        id: 1,
        agentId: SLOT_1,
        agentName: "Claude 1",
        authorId: CEO,
        authorName: "Dana",
        text: "Yes.\nThen push.",
        at: 1_000,
      },
    ]);
    expect(prompts.history()).toEqual(published);
    expect(refused).toEqual([]);
  });

  it.each([
    [RUNNER_PROMPT_OUTCOME.busy, AGENT_PROMPT_REJECTION.busy],
    [RUNNER_PROMPT_OUTCOME.needsInput, AGENT_PROMPT_REJECTION.needsInput],
    [RUNNER_PROMPT_OUTCOME.unavailable, AGENT_PROMPT_REJECTION.unavailable],
  ] as const)("tells only the sender a prompt refused as %s was not typed", (outcome, rejection) => {
    const { prompts, sync, report, published, refused } = setup();
    sync();
    prompts.submit(CEO, { agentId: SLOT_1, text: "go on" });
    sync([report("command-1", outcome)]);
    expect(refused).toEqual([{ sessionId: CEO, event: { agentId: SLOT_1, rejection } }]);
    expect(published).toEqual([]);
  });

  it("takes what came of a prompt only from the runner and slot it was sent to", () => {
    const { prompts, sync, report, published } = setup();
    sync();
    prompts.submit(CEO, { agentId: SLOT_1, text: "go on" });
    sync([report("command-1", RUNNER_PROMPT_OUTCOME.delivered, "slot-2")]);
    sync([report("command-1", RUNNER_PROMPT_OUTCOME.delivered)], [], "other-box");
    expect(published).toEqual([]);
    sync([report("command-1", RUNNER_PROMPT_OUTCOME.delivered)]);
    expect(published).toHaveLength(1);
  });

  it("refuses a prompt for anyone but a runner's agent in the office", () => {
    const { prompts, sync, link } = setup();
    sync();
    expect(prompts.submit(CEO, { agentId: REPORTED, text: "go on" })).toBe(AGENT_PROMPT_REJECTION.noAgent);
    expect(prompts.submit(CEO, { agentId: CEO, text: "go on" })).toBe(AGENT_PROMPT_REJECTION.noAgent);
    expect(prompts.submit(CEO, { agentId: liveAgentKey(runnerSlotAgentId("box", "slot-9")), text: "go on" })).toBe(
      AGENT_PROMPT_REJECTION.noAgent,
    );
    expect(link.pending("box")).toEqual([]);
  });

  it("refuses a prompt with no runner to take it", () => {
    expect(setup({ runner: false }).prompts.submit(CEO, { agentId: SLOT_1, text: "go on" })).toBe(
      AGENT_PROMPT_REJECTION.noAgent,
    );
    // The slot is on the floor, but its runner has not synced with this link.
    expect(setup().prompts.submit(CEO, { agentId: SLOT_1, text: "go on" })).toBe(AGENT_PROMPT_REJECTION.offline);
  });

  it("gives up on a prompt its runner never answers, and tells the sender", () => {
    const { prompts, sync, report, tick, refused, published } = setup();
    sync();
    prompts.submit(CEO, { agentId: SLOT_1, text: "go on" });
    tick(29_000);
    prompts.expire();
    expect(refused).toEqual([]);
    tick(1_000);
    prompts.expire();
    expect(refused).toEqual([{ sessionId: CEO, event: { agentId: SLOT_1, rejection: AGENT_PROMPT_REJECTION.unanswered } }]);
    // An answer that comes after that changes nothing.
    sync([report("command-1", RUNNER_PROMPT_OUTCOME.delivered)]);
    expect(published).toEqual([]);
  });
});
