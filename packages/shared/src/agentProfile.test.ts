/**
 * An agent's profile: person-like default names that are stable and distinct,
 * the one gate on editing it, and sanitising that keeps every field within the
 * bytes a runner's sync spends on it.
 */

import { describe, expect, it } from "vitest";

import {
  AGENT_PROFILE_REJECTION,
  DEFAULT_AGENT_DESCRIPTION,
  DEFAULT_AGENT_NAMES,
  DEFAULT_AGENT_TITLE,
  MAX_AGENT_DESCRIPTION_BYTES,
  MAX_AGENT_TITLE_BYTES,
  agentLabel,
  agentProfileRefusal,
  defaultAgentName,
  defaultAgentProfile,
  fitJsonBytes,
  jsonTextBytes,
  parseAgentProfile,
  sanitizeAgentDescription,
  sanitizeAgentName,
  sanitizeAgentTitle,
} from "./agentProfile.js";
import { MAX_NAME_LENGTH } from "./messages.js";
import { MAX_RUNNER_SLOTS } from "./runner.js";
import { OCCUPANT_KIND } from "./state.js";

const CEO = { id: "dana", kind: OCCUPANT_KIND.human, isCeo: true };
const EXEC = { id: "milo", kind: OCCUPANT_KIND.human, isCeo: false };

describe("default profiles", () => {
  it("are software developers, with a description in the same spirit", () => {
    expect(DEFAULT_AGENT_TITLE).toBe("Software Developer");
    expect(defaultAgentProfile("runner-1", 0)).toEqual({
      name: defaultAgentName("runner-1", 0),
      title: DEFAULT_AGENT_TITLE,
      description: DEFAULT_AGENT_DESCRIPTION,
    });
    expect(sanitizeAgentTitle(DEFAULT_AGENT_TITLE)).toBe(DEFAULT_AGENT_TITLE);
    expect(sanitizeAgentDescription(DEFAULT_AGENT_DESCRIPTION)).toBe(DEFAULT_AGENT_DESCRIPTION);
  });

  it("names every agent like a person, short enough for a nameplate, no two alike", () => {
    expect(new Set(DEFAULT_AGENT_NAMES).size).toBe(DEFAULT_AGENT_NAMES.length);
    for (const name of DEFAULT_AGENT_NAMES) {
      expect(name).toMatch(/^[A-Z][a-z]+$/);
      expect(sanitizeAgentName(name)).toBe(name);
    }
  });

  it("gives a runner's slots distinct names, the same ones every time", () => {
    for (const runnerId of ["runner-1", "mac-studio", "box"]) {
      const names = Array.from({ length: MAX_RUNNER_SLOTS }, (_, index) => defaultAgentName(runnerId, index));
      expect(new Set(names).size).toBe(MAX_RUNNER_SLOTS);
      expect(names).toEqual(Array.from({ length: MAX_RUNNER_SLOTS }, (_, index) => defaultAgentName(runnerId, index)));
    }
  });

  it("starts runners whose ids differ by a character in blocks of their own", () => {
    const block = (runnerId: string) => new Set(Array.from({ length: MAX_RUNNER_SLOTS }, (_, index) => defaultAgentName(runnerId, index)));
    const first = block("runner-1");
    expect([...block("runner-2")].some((name) => first.has(name))).toBe(false);
  });
});

describe("agentProfileRefusal", () => {
  it("lets the CEO edit a profile, and nobody else", () => {
    expect(agentProfileRefusal(CEO)).toBeUndefined();
    expect(agentProfileRefusal(EXEC)).toBe(AGENT_PROFILE_REJECTION.forbidden);
    expect(agentProfileRefusal({ id: "agent:x", kind: OCCUPANT_KIND.liveAgent, isCeo: false, canTakeIssues: true })).toBe(
      AGENT_PROFILE_REJECTION.forbidden,
    );
  });
});

describe("sanitising a profile", () => {
  it("keeps a name to a nameplate's length, in bytes as well", () => {
    expect(sanitizeAgentName("  Grace \u0007 Hopper  ")).toBe("Grace Hopper");
    expect(sanitizeAgentName("é".repeat(MAX_NAME_LENGTH))).toBe("é".repeat(MAX_NAME_LENGTH / 2));
    expect(jsonTextBytes(sanitizeAgentName("😀".repeat(10)))).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it("keeps a title to one line within its bytes", () => {
    expect(sanitizeAgentTitle("Release\n\tEngineer ")).toBe("Release Engineer");
    expect(jsonTextBytes(sanitizeAgentTitle("t".repeat(100)))).toBe(MAX_AGENT_TITLE_BYTES);
    expect(sanitizeAgentTitle(7)).toBe("");
  });

  it("keeps a description's lines, and nothing that is not text", () => {
    expect(sanitizeAgentDescription("One.\r\n\r\n\r\n\r\nTwo.\tThree.\u001b[31m‮  \nFour.")).toBe("One.\n\nTwo. Three.[31m\nFour.");
    expect(jsonTextBytes(sanitizeAgentDescription("d".repeat(1000)))).toBe(MAX_AGENT_DESCRIPTION_BYTES);
    // A newline is two bytes in a sync body, so it counts as two.
    expect(jsonTextBytes(sanitizeAgentDescription("a\n".repeat(400)))).toBeLessThanOrEqual(MAX_AGENT_DESCRIPTION_BYTES);
  });

  it("refuses a profile with no name or no title, and takes one with no description", () => {
    expect(parseAgentProfile({ name: "Grace", title: "Release Engineer" })).toEqual({
      name: "Grace",
      title: "Release Engineer",
      description: "",
    });
    expect(parseAgentProfile({ name: "\u0007", title: "Release Engineer" })).toBeUndefined();
    expect(parseAgentProfile({ name: "Grace", title: "   " })).toBeUndefined();
    expect(parseAgentProfile("Grace")).toBeUndefined();
  });
});

describe("fitJsonBytes", () => {
  it("measures as a sync body does, escapes included, and cuts whole characters", () => {
    expect(fitJsonBytes("plain", 4)).toBe("plai");
    expect(fitJsonBytes('a"b', 2)).toBe("a");
    expect(fitJsonBytes("😀😀", 6)).toBe("😀");
  });
});

describe("agentLabel", () => {
  it("names an agent with its title where there is one line for it", () => {
    expect(agentLabel("Maya", "Software Developer")).toBe("Maya · Software Developer");
    expect(agentLabel("Maya", "")).toBe("Maya");
  });
});
