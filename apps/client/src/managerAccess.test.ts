/**
 * The manager's composer is offered exactly when the server will listen, and a
 * refusal reads as a reason rather than a lost message.
 */

import { MANAGER_REJECTION, OCCUPANT_KIND } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { managerAccessFor, managerRejectionText } from "./managerAccess.js";

describe("managerAccessFor", () => {
  it("lets the CEO instruct the manager", () => {
    expect(managerAccessFor({ id: "a", kind: OCCUPANT_KIND.human, isCeo: true, isOperator: false }, "Dana")).toMatchObject({
      mayInstruct: true,
    });
  });

  it("tells anyone else who can, and that they can still read along", () => {
    expect(managerAccessFor({ id: "b", kind: OCCUPANT_KIND.human, isCeo: false, isOperator: false }, "Dana")).toEqual({
      mayInstruct: false,
      summary: "Only the CEO, Dana, can instruct Firstmate. You can read the conversation.",
    });
    expect(managerAccessFor({ id: "b", kind: OCCUPANT_KIND.human, isCeo: false, isOperator: false }, undefined).summary).toBe(
      "Only the CEO can instruct Firstmate. You can read the conversation.",
    );
  });
});

describe("managerRejectionText", () => {
  it("has words for every refusal", () => {
    for (const rejection of Object.values(MANAGER_REJECTION)) {
      expect(managerRejectionText(rejection)).not.toBe("");
    }
    expect(managerRejectionText(MANAGER_REJECTION.forbidden)).toBe("Only the CEO can instruct Firstmate.");
  });
});
