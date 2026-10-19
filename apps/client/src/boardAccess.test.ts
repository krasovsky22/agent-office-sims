/**
 * The board's read-only presentation has to agree with the server's rule, or
 * an executive is offered a control that is then refused. These pin that
 * agreement, and that the wording explains the refusal.
 */

import {
  OCCUPANT_KIND,
  type OfficeActor,
  WORK_ACTION,
  WORK_REJECTION,
  WORK_STATUS,
  mayActOnWork,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { boardAccessFor, mayAct, rejectionText } from "./boardAccess.js";

const DANA: OfficeActor = { id: "dana", kind: OCCUPANT_KIND.human, isCeo: true };
const MILO: OfficeActor = { id: "milo", kind: OCCUPANT_KIND.human, isCeo: false };
const ADA = { id: "agent-1" };

describe("boardAccessFor", () => {
  it("opens the board to the CEO", () => {
    expect(boardAccessFor(DANA, "Dana").readOnly).toBe(false);
  });

  it("makes it read-only for an executive, and names who is in charge", () => {
    const access = boardAccessFor(MILO, "Dana");
    expect(access.readOnly).toBe(true);
    expect(access.summary).toContain("read-only");
    expect(access.summary).toContain("Dana");
  });

  it("still explains itself before the CEO's name is known", () => {
    expect(boardAccessFor(MILO, undefined).summary).toContain("only the CEO can");
  });
});

describe("board panel offers", () => {
  const inProgress = {
    issueNumber: 12,
    title: "Issue 12",
    status: WORK_STATUS.in_progress,
    assigneeId: ADA.id,
    outputArtifact: "",
    note: "",
    assignedAt: 1,
    updatedAt: 1,
  };

  it("offers the CEO assignment and the shared planner's moves", () => {
    const access = boardAccessFor(DANA, "Dana");
    expect(access.mayAssign).toBe(true);
    expect(access.movesFor(inProgress, [DANA, ADA])).toEqual([
      { action: WORK_ACTION.moveStatus, to: WORK_STATUS.assigned },
      { action: WORK_ACTION.moveStatus, to: WORK_STATUS.review },
      { action: WORK_ACTION.release },
    ]);
  });

  it("offers a release instead of rework for a review whose agent has left", () => {
    const access = boardAccessFor(DANA, "Dana");
    const inReview = { ...inProgress, status: WORK_STATUS.review };
    expect(access.movesFor(inReview, [DANA])).toEqual([
      { action: WORK_ACTION.moveStatus, to: WORK_STATUS.done },
      { action: WORK_ACTION.release },
    ]);
  });

  it("offers an executive neither assignment nor moves", () => {
    const access = boardAccessFor(MILO, "Dana");
    expect(access.mayAssign).toBe(false);
    expect(access.movesFor(inProgress, [DANA, ADA])).toEqual([]);
  });
});

describe("mayAct", () => {
  it("answers exactly as the server's rule does", () => {
    for (const actor of [DANA, MILO]) {
      for (const action of Object.values(WORK_ACTION)) {
        expect(mayAct(actor, action), `${actor.id} ${action}`).toBe(mayActOnWork({ actor, action }));
      }
    }
    expect(mayAct(DANA, WORK_ACTION.assign)).toBe(true);
    expect(mayAct(MILO, WORK_ACTION.assign)).toBe(false);
  });
});

describe("rejectionText", () => {
  it("has a sentence for every rejection", () => {
    for (const rejection of Object.values(WORK_REJECTION)) {
      expect(rejectionText(rejection)).not.toBe("");
    }
    expect(rejectionText(WORK_REJECTION.forbidden)).toContain("CEO");
  });

  it("names the label that kept a refused issue from the agents", () => {
    expect(rejectionText(WORK_REJECTION.restricted, "agent-restricted")).toBe(
      "That issue is restricted from the coding agents: a maintainer has to remove its agent-restricted label first.",
    );
    expect(rejectionText(WORK_REJECTION.restricted)).toBe("That issue is restricted from the coding agents.");
  });
});
