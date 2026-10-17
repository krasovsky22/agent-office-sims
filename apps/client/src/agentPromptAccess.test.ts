/**
 * The terminal panel's composer is offered exactly when the server would take
 * the prompt, everyone else is told why, and a prompt that was not typed reads
 * as a reason rather than a lost message.
 */

import { AGENT_PROMPT_REJECTION, OCCUPANT_KIND, type OfficeActor } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { agentPromptAccessFor, agentPromptRejectionText } from "./agentPromptAccess.js";

const PLAYER: OfficeActor = { id: "a", kind: OCCUPANT_KIND.human, isCeo: false, isOperator: false };

describe("agentPromptAccessFor", () => {
  it("lets the CEO prompt where the server has no operator passphrase", () => {
    expect(agentPromptAccessFor({ ...PLAYER, isCeo: true }, false, "Dana")).toMatchObject({ mayPrompt: true });
  });

  it("lets only the verified operator-CEO prompt where it has one, and tells the CEO how to verify", () => {
    expect(agentPromptAccessFor({ ...PLAYER, isCeo: true, isOperator: true }, true, "Dana")).toMatchObject({ mayPrompt: true });
    expect(agentPromptAccessFor({ ...PLAYER, isCeo: true }, true, "Dana")).toEqual({
      mayPrompt: false,
      summary: "Prompting a coding agent takes a verified operator. Verify with the passphrase at Firstmate's desk.",
    });
  });

  it("tells anyone else who can, and that they can still watch", () => {
    expect(agentPromptAccessFor(PLAYER, false, "Dana")).toEqual({
      mayPrompt: false,
      summary: "Only the CEO, Dana, can prompt this agent. You can watch its terminal.",
    });
    expect(agentPromptAccessFor({ ...PLAYER, isOperator: true }, true, undefined)).toEqual({
      mayPrompt: false,
      summary: "Only the CEO can prompt this agent, once verified as operator. You can watch its terminal.",
    });
  });
});

describe("agentPromptRejectionText", () => {
  it("has words for every refusal", () => {
    for (const rejection of Object.values(AGENT_PROMPT_REJECTION)) {
      expect(agentPromptRejectionText(rejection, "Claude 1")).not.toBe("");
    }
    expect(agentPromptRejectionText(AGENT_PROMPT_REJECTION.busy, "Claude 1")).toBe(
      "Claude 1 is busy, so the prompt was not typed. Send it again once its turn is done.",
    );
    expect(agentPromptRejectionText(AGENT_PROMPT_REJECTION.needsInput, "Claude 1")).toBe(
      "Claude 1 is waiting on a permission, so the prompt was not typed.",
    );
  });
});
