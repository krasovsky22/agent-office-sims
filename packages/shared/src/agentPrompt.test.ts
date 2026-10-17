/**
 * The gate on prompting a coding agent: the CEO, and only a verified operator
 * where the server has a passphrase. The server asks it of every prompt and
 * the client of its composer, so the two cannot disagree.
 */

import { describe, expect, it } from "vitest";

import { AGENT_PROMPT_REJECTION, agentPromptRefusal } from "./agentPrompt.js";
import { OCCUPANT_KIND } from "./state.js";
import type { OfficeActor } from "./work.js";

function actor(overrides: Partial<OfficeActor>): OfficeActor {
  return { id: "session-1", kind: OCCUPANT_KIND.human, isCeo: false, isOperator: false, ...overrides };
}

describe("agentPromptRefusal", () => {
  it("lets the CEO prompt where the server has no operator passphrase", () => {
    expect(agentPromptRefusal(actor({ isCeo: true }), false)).toBeUndefined();
  });

  it("asks the CEO to verify where it has one, and then lets them", () => {
    expect(agentPromptRefusal(actor({ isCeo: true }), true)).toBe(AGENT_PROMPT_REJECTION.notOperator);
    expect(agentPromptRefusal(actor({ isCeo: true, isOperator: true }), true)).toBeUndefined();
  });

  it("refuses anyone who is not the CEO, verified or not", () => {
    expect(agentPromptRefusal(actor({}), false)).toBe(AGENT_PROMPT_REJECTION.forbidden);
    expect(agentPromptRefusal(actor({ isOperator: true }), true)).toBe(AGENT_PROMPT_REJECTION.forbidden);
    expect(agentPromptRefusal(actor({ kind: OCCUPANT_KIND.liveAgent, canTakeIssues: true }), false)).toBe(
      AGENT_PROMPT_REJECTION.forbidden,
    );
  });
});
