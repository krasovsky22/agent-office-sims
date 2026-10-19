/**
 * The long-press `E` menu's gate and its message: only the CEO cancels or
 * fires, only a runner's agent, not one already leaving, and a cancel only
 * with an issue in hand; and the runner commands the two become.
 */

import { describe, expect, it } from "vitest";

import { AGENT_ACTION, AGENT_ACTION_REJECTION, agentActionRefusal, agentActionTarget, heldIssue } from "./agentActions.js";
import { parseAgentActionMessage } from "./messages.js";
import { toRunnerCommand } from "./runner.js";
import { OCCUPANT_KIND, WORK_STATUS } from "./state.js";
import type { OfficeActor } from "./work.js";

const CEO: OfficeActor = { id: "dana", kind: OCCUPANT_KIND.human, isCeo: true };
const EXEC: OfficeActor = { id: "milo", kind: OCCUPANT_KIND.human, isCeo: false };
const WORKING = { runnerAgent: true, fired: false, issueNumber: 39 };

describe("agentActionRefusal", () => {
  it("lets the CEO cancel a runner's agent's task and fire it", () => {
    expect(agentActionRefusal(CEO, AGENT_ACTION.cancel, WORKING)).toBeUndefined();
    expect(agentActionRefusal(CEO, AGENT_ACTION.fire, WORKING)).toBeUndefined();
    expect(agentActionRefusal(CEO, AGENT_ACTION.fire, { ...WORKING, issueNumber: undefined })).toBeUndefined();
  });

  it("says why not: anyone else, nobody there or an orchestrator's agent, one leaving, a cancel with nothing in hand", () => {
    expect(agentActionRefusal(EXEC, AGENT_ACTION.fire, WORKING)).toBe(AGENT_ACTION_REJECTION.forbidden);
    expect(agentActionRefusal(CEO, AGENT_ACTION.fire, undefined)).toBe(AGENT_ACTION_REJECTION.noAgent);
    expect(agentActionRefusal(CEO, AGENT_ACTION.cancel, { ...WORKING, runnerAgent: false })).toBe(AGENT_ACTION_REJECTION.noAgent);
    expect(agentActionRefusal(CEO, AGENT_ACTION.cancel, { ...WORKING, fired: true })).toBe(AGENT_ACTION_REJECTION.leaving);
    expect(agentActionRefusal(CEO, AGENT_ACTION.cancel, { ...WORKING, issueNumber: undefined })).toBe(AGENT_ACTION_REJECTION.noTask);
  });
});

describe("agentActionTarget", () => {
  it("reads the agent's unfinished issue off the work, and a runner's agent off its editable profile", () => {
    const work = [
      { issueNumber: 12, status: WORK_STATUS.done, assigneeId: "maya" },
      { issueNumber: 39, status: WORK_STATUS.review, assigneeId: "maya" },
      { issueNumber: 40, status: WORK_STATUS.in_progress, assigneeId: "leo" },
    ];
    expect(agentActionTarget({ id: "maya", profileEditable: true, fired: false }, work)).toEqual(WORKING);
    expect(heldIssue("nobody", work)).toBeUndefined();
    expect(agentActionTarget({ id: "crewmate", profileEditable: false, fired: false }, work).runnerAgent).toBe(false);
  });
});

describe("parseAgentActionMessage", () => {
  it("takes an agent and one of the two actions, and nothing else", () => {
    expect(parseAgentActionMessage({ agentId: "agent:runner:box:slot-1", action: "fire" })).toEqual({
      agentId: "agent:runner:box:slot-1",
      action: "fire",
    });
    for (const raw of [null, {}, { agentId: "", action: "cancel" }, { agentId: "x".repeat(97), action: "cancel" }, { agentId: "a", action: "promote" }]) {
      expect(parseAgentActionMessage(raw)).toBeUndefined();
    }
  });
});

describe("the runner commands", () => {
  it("marks a cancel's stop to discard, and builds a firing", () => {
    expect(toRunnerCommand("command-1", { kind: "stop", slotId: "slot-1", reason: "cancelled", issueNumber: 39, discard: true })).toEqual({
      id: "command-1",
      slotId: "slot-1",
      kind: "stop",
      reason: "cancelled",
      issueNumber: 39,
      discard: true,
    });
    expect(toRunnerCommand("command-2", { kind: "fire", slotId: "slot-1", requestedBy: "Dana\u0007" })).toEqual({
      id: "command-2",
      slotId: "slot-1",
      kind: "fire",
      requestedBy: "Dana",
    });
  });
});
