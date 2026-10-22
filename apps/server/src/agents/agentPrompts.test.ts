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

import { AgentPrompts, type DirectionOutcome } from "./agentPrompts.js";
import { RunnerLink, runnerSlotAgentId } from "./runnerLink.js";

const REPO = "krasovsky22/agent-office-sims";
const CEO = "session-ceo";
const SLOT_1 = liveAgentKey(runnerSlotAgentId("box", "slot-1"));
const REPORTED = liveAgentKey("crewmate");

function setup(options: { runner?: boolean; deskOwnerOf?: (agentId: string) => string | undefined } = {}) {
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
  const directed: Array<{ commandId: string; outcome: DirectionOutcome }> = [];
  const prompts = new AgentPrompts({
    state,
    runner: options.runner === false ? undefined : link,
    now: () => now,
    refuse: (sessionId, event) => refused.push({ sessionId, event }),
    publish: (entry) => published.push(entry),
    answerTimeoutMs: 30_000,
    ...(options.deskOwnerOf === undefined ? {} : { deskOwnerOf: options.deskOwnerOf }),
    directed: (commandId, outcome) => directed.push({ commandId, outcome }),
  });
  /** One sync from the runner `box`, with one working slot, carrying prompt outcomes and acks. */
  const sync = (outcomes: RunnerPromptOutcome[] = [], acked: string[] = [], runnerId = "box") => {
    const outcome = link.sync({
      runnerId,
      repo: REPO,
      acked,
      slots: [{ id: "slot-1", name: "Claude 1", title: "Software Developer", description: "", status: "working", issueNumber: 39, activity: "", pr: undefined }],
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
    directed,
    state,
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

  it("takes back a prompt it gave up on before its runner picked it up, so it is never typed", () => {
    const { prompts, link, sync, tick, refused } = setup();
    sync();
    prompts.submit(CEO, { agentId: SLOT_1, text: "go on" });
    expect(link.pending("box")).toHaveLength(1);
    tick(30_000);
    prompts.expire();
    expect(refused).toEqual([{ sessionId: CEO, event: { agentId: SLOT_1, rejection: AGENT_PROMPT_REJECTION.unanswered } }]);
    expect(sync()).toEqual([]);
  });

  it("queues the CEO's keys for the slot's runner in the order pressed", () => {
    const { prompts, sync } = setup();
    sync();
    expect(prompts.submitKey(CEO, { agentId: SLOT_1, key: "down" })).toBeUndefined();
    expect(prompts.submitKey(CEO, { agentId: SLOT_1, key: "enter" })).toBeUndefined();
    expect(sync()).toEqual([
      { id: "command-1", slotId: "slot-1", kind: "key", key: "down", requestedBy: "Dana" },
      { id: "command-2", slotId: "slot-1", kind: "key", key: "enter", requestedBy: "Dana" },
    ]);
  });

  it("announces no key pressed, and adds none to the prompts' history", () => {
    const { prompts, sync, report, published, refused } = setup();
    sync();
    prompts.submitKey(CEO, { agentId: SLOT_1, key: "1" });
    sync([report("command-1", RUNNER_PROMPT_OUTCOME.delivered)]);
    expect(published).toEqual([]);
    expect(prompts.history()).toEqual([]);
    expect(refused).toEqual([]);
  });

  it.each([
    [RUNNER_PROMPT_OUTCOME.notWaiting, AGENT_PROMPT_REJECTION.notWaiting],
    [RUNNER_PROMPT_OUTCOME.unavailable, AGENT_PROMPT_REJECTION.unavailable],
  ] as const)("tells only the sender a key refused as %s was not pressed, and which", (outcome, rejection) => {
    const { prompts, sync, report, refused } = setup();
    sync();
    prompts.submitKey(CEO, { agentId: SLOT_1, key: "escape" });
    sync([report("command-1", outcome)]);
    expect(refused).toEqual([{ sessionId: CEO, event: { agentId: SLOT_1, rejection, key: "escape" } }]);
  });

  it("refuses a key for anyone but a runner's agent, and gives up on one its runner never answers", () => {
    const { prompts, sync, tick, refused, link } = setup();
    sync();
    expect(prompts.submitKey(CEO, { agentId: REPORTED, key: "enter" })).toBe(AGENT_PROMPT_REJECTION.noAgent);
    expect(link.pending("box")).toEqual([]);
    prompts.submitKey(CEO, { agentId: SLOT_1, key: "enter" });
    tick(30_000);
    prompts.expire();
    expect(refused).toEqual([
      { sessionId: CEO, event: { agentId: SLOT_1, rejection: AGENT_PROMPT_REJECTION.unanswered, key: "enter" } },
    ]);
    expect(sync()).toEqual([]);
  });

  it("refuses an agent lent to another player's desk to the CEO's prompts, keys and directions alike, and takes them from that player", () => {
    const { prompts, sync, state } = setup({ deskOwnerOf: (agentId) => (agentId === SLOT_1 ? "session-milo" : undefined) });
    const milo = new HumanPlayer();
    milo.id = "session-milo";
    milo.name = "Milo";
    state.occupants.set(milo.id, milo);
    sync();
    expect(prompts.submit(CEO, { agentId: SLOT_1, text: "push to main" })).toBe(AGENT_PROMPT_REJECTION.forbidden);
    expect(prompts.submitKey(CEO, { agentId: SLOT_1, key: "enter" })).toBe(AGENT_PROMPT_REJECTION.forbidden);
    expect(prompts.submitDirection(CEO, SLOT_1, "push to main")).toBe(AGENT_PROMPT_REJECTION.forbidden);
    expect(sync()).toEqual([]);
    expect(prompts.submit(milo.id, { agentId: SLOT_1, text: "Run the tests." })).toBeUndefined();
    expect(sync()).toEqual([expect.objectContaining({ kind: "prompt", text: "Run the tests.", requestedBy: "Milo" })]);
  });

  describe("a standup's direction", () => {
    it("goes to the runner as the CEO's prompt to keep for later, and its fate goes to the standup, not the CEO's panel", () => {
      const { prompts, sync, report, published, refused, directed } = setup();
      sync();
      expect(prompts.submitDirection(CEO, SLOT_1, "Open the PR.")).toEqual({ commandId: "command-1" });
      expect(sync()).toEqual([
        { id: "command-1", slotId: "slot-1", kind: "prompt", text: "Open the PR.", requestedBy: "Dana", fromCeo: true, queue: true },
      ]);

      sync([report("command-1", RUNNER_PROMPT_OUTCOME.queued)], ["command-1"]);
      sync([report("command-1", RUNNER_PROMPT_OUTCOME.queued)]);
      expect(directed).toEqual([{ commandId: "command-1", outcome: { kind: "queued" } }]);

      sync([report("command-1", RUNNER_PROMPT_OUTCOME.delivered)]);
      expect(directed.at(-1)).toEqual({ commandId: "command-1", outcome: { kind: "typed" } });
      // Typed, it is in the agent's terminal record like any prompt.
      expect(published.map((entry) => entry.text)).toEqual(["Open the PR."]);
      expect(refused).toEqual([]);
    });

    it("carries its agent's status, and is answered by an agent with no session, waited on while it answers", () => {
      const { prompts, sync, report, tick, directed, refused } = setup();
      sync();
      prompts.submitDirection(CEO, SLOT_1, "What's the status?", "Your update at this standup: free.");
      expect(sync()).toEqual([expect.objectContaining({ id: "command-1", queue: true, context: "Your update at this standup: free." })]);

      sync([report("command-1", RUNNER_PROMPT_OUTCOME.answering)], ["command-1"]);
      tick(60_000);
      prompts.expire();
      expect(directed).toEqual([{ commandId: "command-1", outcome: { kind: "answering" } }]);

      sync([{ ...report("command-1", RUNNER_PROMPT_OUTCOME.answered), text: "I'm free for an issue." }]);
      expect(directed.at(-1)).toEqual({ commandId: "command-1", outcome: { kind: "answered", reply: "I'm free for an issue." } });

      prompts.submitDirection(CEO, SLOT_1, "And next?");
      sync([{ ...report("command-2", RUNNER_PROMPT_OUTCOME.notAnswered), text: "it ran past its 1 minute" }], ["command-2"]);
      expect(directed.at(-1)).toEqual({ commandId: "command-2", outcome: { kind: "unanswered", why: "it ran past its 1 minute" } });
      expect(refused).toEqual([]);
    });

    it("says why one was not typed to the standup alone", () => {
      const { prompts, sync, report, refused, directed } = setup();
      sync();
      prompts.submitDirection(CEO, SLOT_1, "Open the PR.");
      sync([report("command-1", RUNNER_PROMPT_OUTCOME.unavailable)]);
      expect(directed).toEqual([
        { commandId: "command-1", outcome: { kind: "failed", rejection: AGENT_PROMPT_REJECTION.unavailable } },
      ]);
      expect(refused).toEqual([]);
      expect(prompts.submitDirection(CEO, REPORTED, "Go.")).toBe(AGENT_PROMPT_REJECTION.noAgent);
    });

    it("is waited on for as long as its agent is here once kept, and given up on when it leaves", () => {
      const { prompts, sync, report, tick, directed, state } = setup();
      sync();
      prompts.submitDirection(CEO, SLOT_1, "Open the PR.");
      sync([report("command-1", RUNNER_PROMPT_OUTCOME.queued)], ["command-1"]);
      tick(10 * 60_000);
      prompts.expire();
      expect(directed.map((entry) => entry.outcome.kind)).toEqual(["queued"]);

      state.occupants.delete(SLOT_1);
      prompts.expire();
      expect(directed.at(-1)).toEqual({
        commandId: "command-1",
        outcome: { kind: "failed", rejection: AGENT_PROMPT_REJECTION.unanswered },
      });
    });

    it("is given up on like a prompt when its runner never answers at all", () => {
      const { prompts, sync, tick, directed, refused } = setup();
      sync();
      prompts.submitDirection(CEO, SLOT_1, "Open the PR.");
      tick(30_000);
      prompts.expire();
      expect(directed).toEqual([
        { commandId: "command-1", outcome: { kind: "failed", rejection: AGENT_PROMPT_REJECTION.unanswered } },
      ]);
      expect(refused).toEqual([]);
      expect(sync()).toEqual([]);
    });

    it("never keeps a prompt from the terminal panel waiting on a later answer", () => {
      const { prompts, sync, report, tick, refused } = setup();
      sync();
      prompts.submit(CEO, { agentId: SLOT_1, text: "go on" });
      sync([report("command-1", RUNNER_PROMPT_OUTCOME.queued)]);
      tick(30_000);
      prompts.expire();
      expect(refused).toEqual([{ sessionId: CEO, event: { agentId: SLOT_1, rejection: AGENT_PROMPT_REJECTION.unanswered } }]);
    });
  });
});
