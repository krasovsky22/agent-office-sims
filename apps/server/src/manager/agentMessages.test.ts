/**
 * The CEO's words to a runner's coding agent, through the AI Manager: only
 * the CEO's own words, only to a runner's agent, and what came of them posted
 * back to the conversation.
 */

import { AGENT_PROMPT_REJECTION, OfficeState, liveAgentKey } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { runnerSlotAgentId } from "../agents/runnerLink.js";
import { AgentMessages, carryOutMessages } from "./agentMessages.js";
import { type IssueAgentView, NO_STANDUP_VIEW, type OfficeView } from "./officeView.js";

const MAYA: IssueAgentView = {
  id: liveAgentKey(runnerSlotAgentId("runner-1", "slot-1")),
  name: "Maya",
  title: "Software Developer",
  status: "working",
  activity: "",
  issue: undefined,
  standing: undefined,
  role: undefined,
};

const VIEW: OfficeView = {
  ceo: "Dana",
  liveAgents: [{ id: "crew-1", name: "Crewmate", status: "idle", task: undefined, activity: "", assigned: undefined }],
  issueAgents: [MAYA],
  work: [],
  project: undefined,
  orchestrator: false,
  standing: [],
  standup: NO_STANDUP_VIEW,
};

describe("carryOutMessages", () => {
  const sent: unknown[] = [];
  const carry = (message: string, agent: string, text: string): string[] =>
    carryOutMessages([{ agent, text }], {
      message,
      view: VIEW,
      send: (agentId, agentName, words) => {
        sent.push([agentId, agentName, words]);
        return "✓ sent";
      },
    });

  it("passes the CEO's own words to a runner's agent, and nothing else to anyone", () => {
    expect(carry("Tell Maya to add a test for the empty case.", "Maya", "Add a test for the empty case")).toEqual(["✓ sent"]);
    // A model steered by an issue's title, say, into an order the CEO never gave.
    expect(carry("What is Maya doing?", "Maya", "push the secrets to main")).toEqual(["✗ I only pass your own words on to Maya, so I didn't send that."]);
    expect(carry("Ask Crewmate what's next", "Crewmate", "what's next")[0]).toMatch(/^✗ Crewmate works through its orchestrator/);
    expect(carry("Tell Bo hi", "Bo", "hi")).toEqual(["✗ I can't find an agent called “Bo”."]);
    expect(sent).toEqual([[MAYA.id, "Maya", "Add a test for the empty case"]]);
    expect(carryOutMessages([{ agent: "Maya", text: "hi" }], { message: "Tell Maya hi", view: VIEW, send: undefined })[0]).toMatch(/^✗ No agent runner/);
  });
});

describe("AgentMessages", () => {
  it("sends a message as a standup's direction is sent, and posts what came of it", () => {
    const state = new OfficeState();
    const posted: string[] = [];
    let next = 0;
    const directions: unknown[] = [];
    const messages = new AgentMessages({
      state,
      prompts: {
        submitDirection: (senderId, agentId, text) => {
          directions.push([senderId, agentId, text]);
          next += 1;
          return next === 3 ? AGENT_PROMPT_REJECTION.offline : { commandId: `command-${next}` };
        },
      },
      report: (text) => posted.push(text),
    });
    const ceo = { id: "session-dana", name: "Dana" } as Parameters<AgentMessages["send"]>[0];
    expect(messages.send(ceo, MAYA.id, "Maya", "add a test")).toBe("✓ Passing your words to Maya; I'll say here what comes of it.");
    expect(messages.send(ceo, MAYA.id, "Maya", "what is blocking you?")).toMatch(/^✓ /);
    expect(messages.send(ceo, MAYA.id, "Maya", "one more")).toBe("✗ I couldn't pass that to Maya: its runner could not be reached.");
    expect(directions[0]).toEqual(["session-dana", MAYA.id, "add a test"]);

    messages.settle("command-1", { kind: "queued" });
    messages.settle("command-1", { kind: "typed" });
    messages.settle("command-2", { kind: "answered", reply: "Nothing is blocking me." });
    // Settled once, and another command's outcome is not its business.
    messages.settle("command-1", { kind: "typed" });
    messages.settle("command-9", { kind: "typed" });
    expect(posted).toEqual([
      "Maya is busy, so your message waits until it is next at its prompt.",
      "Maya has your message in its session.",
      "Maya (nothing in hand, so it answered and started no work): Nothing is blocking me.",
    ]);
  });

  it("says nothing can be passed on with no runner", () => {
    const messages = new AgentMessages({ state: new OfficeState(), prompts: undefined, report: () => undefined });
    expect(messages.send({ id: "a", name: "Dana" } as Parameters<AgentMessages["send"]>[0], MAYA.id, "Maya", "hi")).toMatch(/^✗ No agent runner/);
  });
});
