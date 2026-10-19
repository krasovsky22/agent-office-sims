/**
 * The wall decor's tests: that every piece the office ships hangs whole on a
 * plain wall in the room it names, and that the checks catch the mistakes a
 * hand-placed picture makes.
 */

import { describe, expect, it } from "vitest";

import { OFFICE_DECOR, type WallDecorSpec, describeDecorProblems, wallDecorPlacement } from "./decor.js";
import { MANAGER_DESK_ID, MANAGER_OFFICE_ROOM_ID, OFFICE_LAYOUT, PROJECT_BOARD_ID } from "./layout.js";

function decor(id: string): WallDecorSpec {
  const found = OFFICE_DECOR.find((spec) => spec.id === id);
  if (found === undefined) {
    throw new Error(`the shipped decor has no ${id}`);
  }
  return found;
}

describe("OFFICE_DECOR", () => {
  it("hangs every piece whole on a plain wall, clear of the boards, the lifts and each other", () => {
    expect(describeDecorProblems(OFFICE_LAYOUT, OFFICE_DECOR)).toEqual([]);
  });

  it("decorates every indoor room", () => {
    const decorated = new Set(OFFICE_DECOR.map((spec) => spec.roomId));
    for (const room of OFFICE_LAYOUT.rooms.filter((candidate) => candidate.id !== "sidewalk")) {
      expect(decorated.has(room.id), room.id).toBe(true);
    }
  });

  it("hangs the conference room's TV over the sideboard, facing up the table", () => {
    const tv = decor("decor-meeting-tv");
    const placement = wallDecorPlacement(OFFICE_LAYOUT, tv);
    const sideboard = OFFICE_LAYOUT.props.find((spec) => spec.kind === "sideboard");
    const table = OFFICE_LAYOUT.desks.find((spec) => spec.meeting === true);
    expect(placement && sideboard && table).toBeTruthy();
    if (placement === undefined || sideboard === undefined || table === undefined) {
      return;
    }
    expect(tv.elevation).toBeGreaterThan(sideboard.height);
    expect(Math.abs(placement.x - sideboard.x)).toBeLessThan(sideboard.width / 2);
    // Facing the table: its forward vector points at the table's centre.
    const forward = { x: -Math.sin(placement.yaw), z: -Math.cos(placement.yaw) };
    expect(forward.x * (table.x - placement.x) + forward.z * (table.z - placement.z)).toBeGreaterThan(0);
  });

  it("dresses the wall behind the AI manager's desk with a shelf and certificates", () => {
    const desk = OFFICE_LAYOUT.desks.find((spec) => spec.id === MANAGER_DESK_ID);
    expect(desk).toBeDefined();
    const behind = OFFICE_DECOR.filter((spec) => spec.roomId === MANAGER_OFFICE_ROOM_ID && spec.wall === "wall-north");
    expect(behind.map((spec) => spec.kind)).toContain("shelf");
    expect(behind.filter((spec) => spec.art === "certificate").length).toBeGreaterThanOrEqual(2);
    // The desk faces away from that wall, so whoever sits at it has it at their back.
    const placement = wallDecorPlacement(OFFICE_LAYOUT, behind[0] ?? decor("decor-manager-shelf"));
    expect(placement?.yaw).toBeCloseTo(desk?.yaw ?? 0);
  });

  it("would refuse a picture over a window, off the end of its wall, over a board, or facing the wrong room", () => {
    const base = decor("decor-floor-portrait");
    expect(describeDecorProblems(OFFICE_LAYOUT, [{ ...base, wall: "wall-east-north", roomId: "meeting-room", along: -6 }])).toContain(
      "decor decor-floor-portrait hangs on window wall wall-east-north",
    );
    expect(describeDecorProblems(OFFICE_LAYOUT, [{ ...base, along: 11.5 }])).toContain(
      "decor decor-floor-portrait runs off the end of wall wall-lobby-east",
    );
    expect(describeDecorProblems(OFFICE_LAYOUT, [{ ...base, along: 3.9 }])).toContain(
      "decor decor-floor-portrait does not hang wholly against wall wall-lobby-east in room open-floor",
    );
    const board = OFFICE_LAYOUT.boards.find((spec) => spec.id === PROJECT_BOARD_ID);
    expect(
      describeDecorProblems(OFFICE_LAYOUT, [{ ...base, wall: "wall-ceo-south-east", along: -3, elevation: 1 }]),
    ).toContain(`decor decor-floor-portrait overlaps board ${board?.id}`);
    expect(describeDecorProblems(OFFICE_LAYOUT, [{ ...base, roomId: "ceo-office" }])).toContain(
      "decor decor-floor-portrait has no face of wall wall-lobby-east looking into room ceo-office",
    );
    expect(describeDecorProblems(OFFICE_LAYOUT, [base, { ...base, id: "decor-copy" }])).toContain(
      "decor decor-copy overlaps decor decor-floor-portrait",
    );
  });

  it("would refuse a picture with no art, or a clock with some", () => {
    const base = decor("decor-floor-portrait");
    const { art: _art, ...bare } = base;
    expect(describeDecorProblems(OFFICE_LAYOUT, [bare])).toContain("decor decor-floor-portrait is a picture with no art");
    expect(describeDecorProblems(OFFICE_LAYOUT, [{ ...decor("decor-floor-clock"), art: "plumbob" }])).toContain(
      "decor decor-floor-clock is a clock with art",
    );
  });
});
