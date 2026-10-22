/**
 * The terminal panel's composer is offered exactly when the server would take
 * the prompt, everyone else is told why, and a prompt that was not typed reads
 * as a reason rather than a lost message.
 */

import { AGENT_KEYS, AGENT_PROMPT_REJECTION, OCCUPANT_KIND, type OfficeActor } from "@sim/shared";
import { describe, expect, it } from "vitest";

import {
  DESK_HELD_ACCESS,
  DESK_PROMPT_ACCESS,
  agentKeyOfKeyboard,
  agentKeyRejectionText,
  agentPromptAccessFor,
  agentPromptRejectionText,
  watchedPromptAccess,
} from "./agentPromptAccess.js";

const PLAYER: OfficeActor = { id: "a", kind: OCCUPANT_KIND.human, isCeo: false };

describe("agentPromptAccessFor", () => {
  it("lets the CEO prompt", () => {
    expect(agentPromptAccessFor({ ...PLAYER, isCeo: true }, "Dana")).toMatchObject({ mayPrompt: true });
  });

  it("tells anyone else who can, and that they can still watch", () => {
    expect(agentPromptAccessFor(PLAYER, "Dana")).toEqual({
      mayPrompt: false,
      summary: "Only the CEO, Dana, can prompt this agent. You can watch its terminal.",
    });
    expect(agentPromptAccessFor(PLAYER, undefined)).toEqual({
      mayPrompt: false,
      summary: "Only the CEO can prompt this agent. You can watch its terminal.",
    });
  });
});

describe("watchedPromptAccess", () => {
  const ceo = agentPromptAccessFor({ ...PLAYER, isCeo: true }, "Dana");

  it("keeps the player's access for an agent lent to no desk", () => {
    expect(watchedPromptAccess(ceo, undefined, "a")).toBe(ceo);
  });

  it("is read-only, the CEO's included, for an agent lent to another player's desk, and the player's own for theirs", () => {
    expect(watchedPromptAccess(ceo, "milo", "a")).toBe(DESK_HELD_ACCESS);
    expect(DESK_HELD_ACCESS.mayPrompt).toBe(false);
    expect(watchedPromptAccess(agentPromptAccessFor(PLAYER, "Dana"), "a", "a")).toBe(DESK_PROMPT_ACCESS);
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
      "Claude 1 is waiting on a choice on its screen, so the prompt was not typed. Answer it with the keys.",
    );
  });
});

describe("agentKeyRejectionText", () => {
  it("has words for every refusal of every key", () => {
    for (const rejection of Object.values(AGENT_PROMPT_REJECTION)) {
      for (const key of AGENT_KEYS) {
        expect(agentKeyRejectionText(rejection, "Claude 1", key)).not.toBe("");
      }
    }
    expect(agentKeyRejectionText(AGENT_PROMPT_REJECTION.notWaiting, "Claude 1", "escape")).toBe(
      "Claude 1 is not waiting on a choice, so Esc was not pressed. Send it a prompt instead.",
    );
  });
});

describe("agentKeyOfKeyboard", () => {
  it("reads the arrows, Enter and the digits as the agent's keys", () => {
    expect(agentKeyOfKeyboard("ArrowUp")).toBe("up");
    expect(agentKeyOfKeyboard("ArrowDown")).toBe("down");
    expect(agentKeyOfKeyboard("Enter")).toBe("enter");
    expect(agentKeyOfKeyboard("3")).toBe("3");
  });

  it("leaves Esc, letters and anything else to the panel", () => {
    for (const key of ["Escape", "0", "y", "ArrowLeft", "Tab", " "]) {
      expect(agentKeyOfKeyboard(key)).toBeUndefined();
    }
  });
});
