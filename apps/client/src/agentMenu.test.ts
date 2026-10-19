/**
 * The long-press `E` menu: the agent faced is the nearest in front within
 * reach, its options are offered exactly when the server would act on them,
 * and everyone else is told why.
 */

import { AGENT_ACTION_REJECTION, OCCUPANT_KIND, type OfficeActor, WORK_STATUS, type WorkData, type WorkStatus } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { AGENT_MENU_RANGE, agentActionRejectionText, agentMenuFor, facedAgent } from "./agentMenu.js";

const CEO: OfficeActor = { id: "dana", kind: OCCUPANT_KIND.human, isCeo: true };
const MAYA = { id: "maya", name: "Maya", profileEditable: true, fired: false };

function work(assigneeId: string, status: WorkStatus = WORK_STATUS.in_progress): WorkData {
  return { issueNumber: 39, title: "Night shift", status, assigneeId, outputArtifact: "", note: "", assignedAt: 1, updatedAt: 1 };
}

describe("facedAgent", () => {
  // Facing -Z, as a yaw of 0 does.
  const pose = { x: 0, z: 0, yaw: 0 };

  it("is the nearest agent in front, within reach", () => {
    expect(facedAgent(pose, [{ id: "far", x: 0, z: -2 }, { id: "near", x: 0.3, z: -1 }])).toBe("near");
    expect(facedAgent({ ...pose, yaw: Math.PI / 2 }, [{ id: "west", x: -1, z: 0 }])).toBe("west");
  });

  it("is nobody behind, beside, or out of reach", () => {
    expect(facedAgent(pose, [{ id: "behind", x: 0, z: 1 }])).toBeUndefined();
    expect(facedAgent(pose, [{ id: "beside", x: 1, z: -0.2 }])).toBeUndefined();
    expect(facedAgent(pose, [{ id: "far", x: 0, z: -(AGENT_MENU_RANGE + 0.1) }])).toBeUndefined();
  });
});

describe("agentMenuFor", () => {
  it("offers the CEO both on a runner's agent with an issue in hand", () => {
    expect(agentMenuFor(CEO, MAYA, [work("maya")], "Dana")).toEqual({
      agentId: "maya",
      agentName: "Maya",
      task: "#39",
      options: [
        { action: "cancel", label: "Cancel task", refusal: undefined },
        { action: "fire", label: "Fire agent", refusal: undefined },
      ],
    });
  });

  it("says why not: nothing to cancel, or anyone but the CEO", () => {
    const idle = agentMenuFor(CEO, MAYA, [work("maya", WORK_STATUS.done)], "Dana");
    expect(idle.task).toBe("");
    expect(idle.options.map((option) => option.refusal)).toEqual(["Maya has no task to cancel.", undefined]);
    const exec = agentMenuFor({ ...CEO, isCeo: false }, MAYA, [work("maya")], "Dana");
    expect(exec.options.map((option) => option.refusal)).toEqual([
      "Only the CEO, Dana, can cancel an agent's task or fire it.",
      "Only the CEO, Dana, can cancel an agent's task or fire it.",
    ]);
  });
});

describe("agentActionRejectionText", () => {
  it("has words for every refusal", () => {
    for (const rejection of Object.values(AGENT_ACTION_REJECTION)) {
      expect(agentActionRejectionText(rejection, "Maya")).not.toBe("");
    }
  });
});
