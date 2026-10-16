/**
 * The panel offers the passphrase only where it changes something, and says
 * why work for a live agent would be refused before the server refuses it.
 */

import { OCCUPANT_KIND, OPERATOR_REJECTION } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { operatorAccessFor, operatorRejectionText } from "./operatorAccess.js";

const CEO = { id: "a", kind: OCCUPANT_KIND.human, isCeo: true, isOperator: false } as const;
const EXEC = { id: "b", kind: OCCUPANT_KIND.human, isCeo: false, isOperator: false } as const;

describe("operatorAccessFor", () => {
  it("says nothing in an office with no passphrase", () => {
    expect(operatorAccessFor(CEO, false)).toBeUndefined();
    expect(operatorAccessFor(EXEC, false)).toBeUndefined();
  });

  it("lets a verified CEO command the live agents and offers no form", () => {
    expect(operatorAccessFor({ ...CEO, isOperator: true }, true)).toMatchObject({ mayCommand: true, mayVerify: false });
  });

  it("asks an unverified CEO, an executive and an operator who lost the role to verify", () => {
    expect(operatorAccessFor(CEO, true)).toMatchObject({ mayCommand: false, mayVerify: true });
    expect(operatorAccessFor(CEO, true)?.summary).toMatch(/takes a verified operator/);
    expect(operatorAccessFor(EXEC, true)?.summary).toMatch(/Verifying makes you the CEO/);
    expect(operatorAccessFor({ ...EXEC, isOperator: true }, true)).toMatchObject({ mayCommand: false, mayVerify: true });
  });
});

describe("operatorRejectionText", () => {
  it("gives every refusal a reason", () => {
    for (const rejection of Object.values(OPERATOR_REJECTION)) {
      expect(operatorRejectionText(rejection)).not.toBe("");
    }
  });
});
