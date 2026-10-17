/**
 * The gate on prompting a coding agent: only the CEO. The server asks it of
 * every prompt and the client of its composer, so the two cannot disagree.
 */

import { describe, expect, it } from "vitest";

import { AGENT_PROMPT_REJECTION, agentPromptRefusal } from "./agentPrompt.js";
import { OCCUPANT_KIND } from "./state.js";
import type { OfficeActor } from "./work.js";

function actor(overrides: Partial<OfficeActor>): OfficeActor {
  return { id: "session-1", kind: OCCUPANT_KIND.human, isCeo: false, ...overrides };
}

describe("agentPromptRefusal", () => {
  it("lets the CEO prompt", () => {
    expect(agentPromptRefusal(actor({ isCeo: true }))).toBeUndefined();
  });

  it("refuses anyone who is not the CEO", () => {
    expect(agentPromptRefusal(actor({}))).toBe(AGENT_PROMPT_REJECTION.forbidden);
    expect(agentPromptRefusal(actor({ kind: OCCUPANT_KIND.liveAgent, canTakeIssues: true }))).toBe(
      AGENT_PROMPT_REJECTION.forbidden,
    );
  });
});
