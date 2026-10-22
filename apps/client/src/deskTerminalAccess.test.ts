/**
 * What the local player's desk shows them: each of their own desks opens on its
 * own lent agent's terminal, or says why there is none, and nobody else's does.
 */

import { type AgentPromptEntry, DESK_TERMINAL_PHASE } from "@sim/shared";
import { describe, expect, it } from "vitest";

import {
  type DeskReading,
  deskPanelFor,
  deskPhaseText,
  deskPrompts,
  deskScreenKey,
  deskTakenText,
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

/** The replicated desks map, holding these desks. */
function on(...desks: DeskReading[]): Map<string, DeskReading> {
  return new Map(desks.map((desk) => [desk.seatId, desk]));
}

describe("deskPanelFor", () => {
  it("opens the player's own desk on its agent's terminal", () => {
    expect(deskPanelFor(on(OPEN), "me", SEAT, 0)).toEqual({ seatId: SEAT, agentId: AGENT, message: "", needsInput: false, activity: "Bash: ls", promptsAfter: 0 });
    expect(deskPanelFor(on({ ...OPEN, needsInput: true }), "me", SEAT, 0)?.needsInput).toBe(true);
  });

  it("says why there is no terminal yet, with nothing to type to", () => {
    for (const phase of [DESK_TERMINAL_PHASE.starting, DESK_TERMINAL_PHASE.waiting, DESK_TERMINAL_PHASE.noRunner, DESK_TERMINAL_PHASE.ended]) {
      const panel = deskPanelFor(on({ ...OPEN, agentId: "", phase, needsInput: true }), "me", SEAT, 0);
      expect(panel).toMatchObject({ agentId: "", needsInput: false, activity: "" });
      expect(panel?.message).toBe(deskPhaseText(phase, ""));
    }
  });

  it("shows nothing to anyone else, at another seat, standing, or before the state", () => {
    expect(deskPanelFor(on(OPEN), "someone-else", SEAT, 0)).toBeUndefined();
    expect(deskPanelFor(on(OPEN), "me", "seat-desk-north-2-1", 0)).toBeUndefined();
    expect(deskPanelFor(on(OPEN), "me", "", 0)).toBeUndefined();
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
    const sitting = deskPanelFor(on(OPEN), "me", SEAT, 2);
    expect(sitting === undefined ? [] : deskPrompts(log, sitting).map((e) => e.id)).toEqual([3]);
    const earlier = deskPanelFor(on(OPEN), "me", SEAT, 0);
    expect(earlier === undefined ? [] : deskPrompts(log, earlier).map((e) => e.id)).toEqual([1, 3]);
  });

  it("lists nothing while no agent is lent", () => {
    const starting = deskPanelFor(on({ ...OPEN, agentId: "", phase: DESK_TERMINAL_PHASE.starting }), "me", SEAT, 0);
    expect(starting === undefined ? [] : deskPrompts(log, starting)).toEqual([]);
  });
});

describe("deskPhaseText", () => {
  it("says what the player can do about each", () => {
    expect(deskPhaseText(DESK_TERMINAL_PHASE.noRunner, "")).toMatch(/No agent runner is connected/);
    expect(deskPhaseText(DESK_TERMINAL_PHASE.waiting, "")).toMatch(/Every coding agent is busy/);
    expect(deskPhaseText(DESK_TERMINAL_PHASE.ended, "Claude exited with code 1.")).toBe(
      "The session ended: Claude exited with code 1. Stand up and sit down again for a fresh one.",
    );
    expect(deskPhaseText(DESK_TERMINAL_PHASE.ended, "")).toBe("The session ended. Stand up and sit down again for a fresh one.");
  });
});

describe("deskPanelFor with several desks on", () => {
  const OTHER = "seat-desk-north-2-1";
  const OTHER_AGENT = "agent:runner:box:slot-2";

  it("opens each desk on its own session", () => {
    const desks = on(OPEN, { ...OPEN, seatId: OTHER, agentId: OTHER_AGENT, activity: "" });
    expect(deskPanelFor(desks, "me", SEAT, 0)).toMatchObject({ seatId: SEAT, agentId: AGENT });
    expect(deskPanelFor(desks, "me", OTHER, 0)).toMatchObject({ seatId: OTHER, agentId: OTHER_AGENT });
  });

  it("says turning another desk off frees an agent when the player's other desks hold every one", () => {
    const waiting: DeskReading = { ...OPEN, seatId: OTHER, agentId: "", phase: DESK_TERMINAL_PHASE.waiting };
    expect(deskPanelFor(on(OPEN, waiting), "me", OTHER, 0)?.message).toBe(deskPhaseText(DESK_TERMINAL_PHASE.waiting, "", true));
    expect(deskPhaseText(DESK_TERMINAL_PHASE.waiting, "", true)).toMatch(/turn another desk's computer off/);
    expect(deskPanelFor(on(waiting), "me", OTHER, 0)?.message).toBe(deskPhaseText(DESK_TERMINAL_PHASE.waiting, ""));
  });
});

describe("deskTakenText", () => {
  it("names whose the computer is when the roster shows it", () => {
    expect(deskTakenText("Dana")).toMatch(/^Dana has this desk's computer on: only they/);
    expect(deskTakenText(undefined)).toMatch(/^Someone else has this desk's computer on/);
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
    const panel = deskPanelFor(on(OPEN), "me", SEAT, 0);
    expect(sameDeskPanel(panel, deskPanelFor(on(OPEN), "me", SEAT, 0))).toBe(true);
    expect(sameDeskPanel(panel, deskPanelFor(on({ ...OPEN, activity: "Bash: pwd" }), "me", SEAT, 0))).toBe(false);
    expect(sameDeskPanel(panel, undefined)).toBe(false);
    expect(sameDeskPanel(undefined, undefined)).toBe(true);
  });
});
