/**
 * What the local player's desk shows them: the CEO's own desk opens on its
 * lent agent's terminal, or says why there is none, and nobody else's does.
 */

import { type AgentPromptEntry, DESK_TERMINAL_PHASE } from "@sim/shared";
import { describe, expect, it } from "vitest";

import {
  type DeskReading,
  deskForbiddenText,
  deskPanelFor,
  deskPhaseText,
  deskPrompts,
  deskScreenKey,
  sameDeskPanel,
} from "./deskTerminalAccess.js";

const SEAT = "seat-desk-north-1-1";
const AGENT = "agent:runner:box:slot-1";

const OPEN: DeskReading = {
  seatId: SEAT,
  ownerId: "me",
  agentId: AGENT,
  phase: DESK_TERMINAL_PHASE.open,
  needsInput: false,
  activity: "Bash: ls",
  note: "",
};

describe("deskPanelFor", () => {
  it("opens the CEO's own desk on its agent's terminal", () => {
    expect(deskPanelFor(OPEN, "me", SEAT, 0)).toEqual({ agentId: AGENT, message: "", needsInput: false, activity: "Bash: ls", promptsAfter: 0 });
    expect(deskPanelFor({ ...OPEN, needsInput: true }, "me", SEAT, 0)?.needsInput).toBe(true);
  });

  it("says why there is no terminal yet, with nothing to type to", () => {
    for (const phase of [DESK_TERMINAL_PHASE.starting, DESK_TERMINAL_PHASE.waiting, DESK_TERMINAL_PHASE.noRunner, DESK_TERMINAL_PHASE.ended]) {
      const panel = deskPanelFor({ ...OPEN, agentId: "", phase, needsInput: true }, "me", SEAT, 0);
      expect(panel).toMatchObject({ agentId: "", needsInput: false, activity: "" });
      expect(panel?.message).toBe(deskPhaseText(phase, ""));
    }
  });

  it("shows nothing to anyone else, at another seat, standing, or before the state", () => {
    expect(deskPanelFor(OPEN, "someone-else", SEAT, 0)).toBeUndefined();
    expect(deskPanelFor(OPEN, "me", "seat-desk-north-2-1", 0)).toBeUndefined();
    expect(deskPanelFor(OPEN, "me", "", 0)).toBeUndefined();
    expect(deskPanelFor(undefined, "me", SEAT, 0)).toBeUndefined();
  });
});

describe("deskPrompts", () => {
  const entry = (id: number, agentId: string): AgentPromptEntry => ({
    id,
    agentId,
    agentName: "Mock 1",
    authorId: "me",
    authorName: "Dana",
    text: `prompt ${id}`,
    at: id,
  });
  const log = [entry(1, AGENT), entry(2, "agent:runner:box:slot-2"), entry(3, AGENT)];

  it("lists only this sitting's prompts to its agent, not a previous sitting's with the same slot", () => {
    const sitting = deskPanelFor(OPEN, "me", SEAT, 2);
    expect(sitting === undefined ? [] : deskPrompts(log, sitting).map((e) => e.id)).toEqual([3]);
    const earlier = deskPanelFor(OPEN, "me", SEAT, 0);
    expect(earlier === undefined ? [] : deskPrompts(log, earlier).map((e) => e.id)).toEqual([1, 3]);
  });

  it("lists nothing while no agent is lent", () => {
    const starting = deskPanelFor({ ...OPEN, agentId: "", phase: DESK_TERMINAL_PHASE.starting }, "me", SEAT, 0);
    expect(starting === undefined ? [] : deskPrompts(log, starting)).toEqual([]);
  });
});

describe("deskPhaseText", () => {
  it("says what the CEO can do about each", () => {
    expect(deskPhaseText(DESK_TERMINAL_PHASE.noRunner, "")).toMatch(/No agent runner is connected/);
    expect(deskPhaseText(DESK_TERMINAL_PHASE.waiting, "")).toMatch(/Every coding agent is busy/);
    expect(deskPhaseText(DESK_TERMINAL_PHASE.ended, "Claude exited with code 1.")).toBe(
      "The session ended: Claude exited with code 1. Stand up and sit down again for a fresh one.",
    );
    expect(deskPhaseText(DESK_TERMINAL_PHASE.ended, "")).toBe("The session ended. Stand up and sit down again for a fresh one.");
  });
});

describe("deskForbiddenText", () => {
  it("names the CEO when the roster shows who it is", () => {
    expect(deskForbiddenText("Dana")).toMatch(/^Only the CEO, Dana, can use a desk's computer/);
    expect(deskForbiddenText(undefined)).toMatch(/^Only the CEO can use a desk's computer/);
  });
});

describe("deskScreenKey", () => {
  it("shows the agent's terminal once open, a placeholder while one is coming, and nothing otherwise", () => {
    expect(deskScreenKey(OPEN)).toBe(AGENT);
    expect(deskScreenKey({ ...OPEN, agentId: "", phase: DESK_TERMINAL_PHASE.starting })).toBe(`desk:${SEAT}`);
    expect(deskScreenKey({ ...OPEN, agentId: "", phase: DESK_TERMINAL_PHASE.waiting })).toBe(`desk:${SEAT}`);
    expect(deskScreenKey({ ...OPEN, agentId: "", phase: DESK_TERMINAL_PHASE.noRunner })).toBeUndefined();
    expect(deskScreenKey({ ...OPEN, agentId: "", phase: DESK_TERMINAL_PHASE.ended })).toBeUndefined();
    expect(deskScreenKey({ ...OPEN, seatId: "" })).toBeUndefined();
    expect(deskScreenKey(undefined)).toBeUndefined();
  });
});

describe("sameDeskPanel", () => {
  it("tells a changed panel from the same one", () => {
    const panel = deskPanelFor(OPEN, "me", SEAT, 0);
    expect(sameDeskPanel(panel, deskPanelFor(OPEN, "me", SEAT, 0))).toBe(true);
    expect(sameDeskPanel(panel, deskPanelFor({ ...OPEN, activity: "Bash: pwd" }, "me", SEAT, 0))).toBe(false);
    expect(sameDeskPanel(panel, undefined)).toBe(false);
    expect(sameDeskPanel(undefined, undefined)).toBe(true);
  });
});
