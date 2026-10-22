/**
 * The desk terminal's shared rules: which seats have a computer to use, and
 * that every player may use one.
 */

import { describe, expect, it } from "vitest";

import { deskTerminalRefusal, deskTerminalSeat } from "./deskTerminal.js";
import { INTERACTION_KIND, OFFICE_LAYOUT, interactables } from "./layout.js";
import { managerSeat } from "./manager.js";
import { OCCUPANT_KIND, OfficeState } from "./state.js";

describe("deskTerminalSeat", () => {
  it("finds a computer at an open-floor desk, and at the CEO's", () => {
    expect(deskTerminalSeat(OFFICE_LAYOUT, "seat-desk-north-1-1")?.id).toBe("seat-desk-north-1-1");
    expect(deskTerminalSeat(OFFICE_LAYOUT, "seat-desk-ceo-1")?.id).toBe("seat-desk-ceo-1");
  });

  it("finds none at the AI Manager's desk, at anything that is not a seat, or at nothing", () => {
    const manager = managerSeat(OFFICE_LAYOUT);
    expect(manager).toBeDefined();
    expect(deskTerminalSeat(OFFICE_LAYOUT, manager?.id ?? "")).toBeUndefined();
    const notSeat = interactables(OFFICE_LAYOUT).find((spec) => spec.kind !== INTERACTION_KIND.seat);
    expect(deskTerminalSeat(OFFICE_LAYOUT, notSeat?.id ?? "")).toBeUndefined();
    expect(deskTerminalSeat(OFFICE_LAYOUT, "")).toBeUndefined();
    expect(deskTerminalSeat(OFFICE_LAYOUT, "seat-nowhere-1")).toBeUndefined();
  });
});

describe("deskTerminalRefusal", () => {
  it("lets every player use a desk's computer, and nothing else", () => {
    const actor = { id: "a", kind: OCCUPANT_KIND.human };
    expect(deskTerminalRefusal({ ...actor, isCeo: true })).toBeUndefined();
    expect(deskTerminalRefusal({ ...actor, isCeo: false })).toBeUndefined();
    expect(deskTerminalRefusal({ id: "b", kind: OCCUPANT_KIND.liveAgent, isCeo: false })).toBe("forbidden");
  });
});

describe("the desk terminal's state", () => {
  it("starts with every desk's computer off", () => {
    expect(new OfficeState().desks.size).toBe(0);
  });
});
