/**
 * The staff panel has to agree with the server about who may hire and what the
 * payroll is, and every refusal and departure has to say why. These pin both.
 */

import {
  HIRING_CANDIDATES,
  OCCUPANT_KIND,
  OFFICE_LAYOUT,
  QUIT_REASON,
  STAFF_CHANGE,
  STAFF_REJECTION,
  type OfficeActor,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { formatCash } from "./companyReadout.js";
import { readStaff, sameStaff, staffChangeText, staffRejectionText } from "./staffing.js";

const DANA: OfficeActor = { id: "dana", kind: OCCUPANT_KIND.human, isCeo: true, isOperator: false };
const MILO: OfficeActor = { id: "milo", kind: OCCUPANT_KIND.human, isCeo: false, isOperator: false };

describe("readStaff", () => {
  it("lets the CEO manage staff and nobody else", () => {
    expect(readStaff(DANA, []).canManage).toBe(true);
    expect(readStaff(MILO, []).canManage).toBe(false);
    expect(readStaff(undefined, []).canManage).toBe(false);
  });

  it("adds up the salaries, the figure midnight draws", () => {
    expect(readStaff(DANA, [600, 550]).payroll).toBe(`${formatCash(1150)}/day`);
  });

  it("counts desks against the floor plan and says when it is full", () => {
    const capacity = OFFICE_LAYOUT.agentDesks.length;
    expect(readStaff(DANA, [1, 2]).desks).toBe(`2 of ${capacity} desks filled`);
    expect(readStaff(DANA, [1, 2]).full).toBe(false);
    expect(readStaff(DANA, Array.from({ length: capacity }, () => 1)).full).toBe(true);
  });

  it("lists every candidate with its salary", () => {
    const { candidates } = readStaff(DANA, []);
    expect(candidates.map((candidate) => candidate.id)).toEqual(
      HIRING_CANDIDATES.map((candidate) => candidate.id),
    );
    const first = HIRING_CANDIDATES[0];
    expect(candidates[0]?.salary).toBe(`${formatCash(first?.salary ?? 0)}/day`);
  });

  it("notices a hire, and nothing else", () => {
    const before = readStaff(DANA, [600]);
    expect(sameStaff(before, readStaff(DANA, [600]))).toBe(true);
    expect(sameStaff(before, readStaff(DANA, [600, 500]))).toBe(false);
    expect(sameStaff(undefined, before)).toBe(false);
  });
});

describe("staff wording", () => {
  it("gives every refusal a reason", () => {
    for (const rejection of Object.values(STAFF_REJECTION)) {
      expect(staffRejectionText(rejection)).not.toBe("");
    }
    expect(staffRejectionText(STAFF_REJECTION.noFreeDesk)).toContain("desk");
  });

  const ada = { agentId: "agent-1", name: "Ada Byrne", jobTitle: "Backend Engineer", salary: 600 };

  it("announces a hire with its salary", () => {
    expect(staffChangeText({ ...ada, change: STAFF_CHANGE.hired })).toBe(
      "Ada Byrne (Backend Engineer) was hired at $600/day.",
    );
  });

  it("announces a firing with the morale it cost and the work handed back", () => {
    expect(
      staffChangeText({ ...ada, change: STAFF_CHANGE.fired, moraleLost: 8, releasedIssues: 1 }),
    ).toBe(
      "Ada Byrne (Backend Engineer) was let go. Morale fell 8 points. " +
        "The issue they were on is free on the project board.",
    );
  });

  it("says why someone quit", () => {
    expect(
      staffChangeText({ ...ada, change: STAFF_CHANGE.quit, reason: QUIT_REASON, releasedIssues: 0 }),
    ).toBe(`Ada Byrne (Backend Engineer) quit: ${QUIT_REASON}.`);
  });
});
