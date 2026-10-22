/**
 * The gate on prompting a coding agent: only the CEO. The server asks it of
 * every prompt and the client of its composer, so the two cannot disagree.
 */

import { describe, expect, it } from "vitest";

import { AGENT_KEYS, AGENT_KEY_LABEL, AGENT_PROMPT_REJECTION, agentPromptRefusal, isAgentKey } from "./agentPrompt.js";
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

  it("lets only a desk's player prompt the agent lent to it, the CEO refused", () => {
    expect(agentPromptRefusal(actor({}), "session-1")).toBeUndefined();
    expect(agentPromptRefusal(actor({ isCeo: true }), "session-2")).toBe(AGENT_PROMPT_REJECTION.forbidden);
    expect(agentPromptRefusal(actor({}), "")).toBe(AGENT_PROMPT_REJECTION.forbidden);
  });
});

describe("agent keys", () => {
  it("names every key, and knows only those", () => {
    for (const key of AGENT_KEYS) {
      expect(isAgentKey(key)).toBe(true);
      expect(AGENT_KEY_LABEL[key]).not.toBe("");
    }
    expect(isAgentKey("tab")).toBe(false);
    expect(isAgentKey("0")).toBe(false);
    expect(isAgentKey(undefined)).toBe(false);
  });
});
