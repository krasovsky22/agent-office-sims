/**
 * The project board is placed by hand, so these pin the things a hand can get
 * wrong: that it hangs on the open floor where the desk rows can read it,
 * faces the right way and clears the doorways beside it, and that the
 * proximity prompt offers its close-up in front of it and nowhere else.
 */

import { describe, expect, it } from "vitest";

import { isBlocked } from "./collision.js";
import { INTERACT_RANGE, OCCUPANT_RADIUS } from "./constants.js";
import { authorizeInteract, nearestInteractable, promptFor } from "./interaction.js";
import {
  INTERACTION_KIND,
  OFFICE_LAYOUT,
  PROJECT_BOARD_ID,
  type InteractableSpec,
  type OfficeLayout,
  type WallBoardSpec,
  describeLayoutProblems,
  interactables,
  roomAt,
} from "./layout.js";

function projectBoard(layout: OfficeLayout = OFFICE_LAYOUT): WallBoardSpec {
  const board = layout.boards.find((candidate) => candidate.id === PROJECT_BOARD_ID);
  if (board === undefined) {
    throw new Error("the shipped layout has no project board");
  }
  return board;
}

function boardInteractable(layout: OfficeLayout = OFFICE_LAYOUT): InteractableSpec {
  const spec = interactables(layout).find((candidate) => candidate.id === PROJECT_BOARD_ID);
  if (spec === undefined) {
    throw new Error("the project board is not an interactable");
  }
  return spec;
}

function withBoard(board: WallBoardSpec): OfficeLayout {
  return { ...OFFICE_LAYOUT, boards: [board] };
}

/** The aisle between the first two desk rows, where players spawn facing north. */
const FLOOR_AISLE = { x: 0, z: 2.5 };

/** Nobody is holding anything. */
const NOBODY = () => undefined;

describe("the open floor's project board", () => {
  it("hangs on the open floor, on a wall, facing into the room", () => {
    const board = projectBoard();
    expect(board.roomId).toBe("open-floor");
    expect(describeLayoutProblems(OFFICE_LAYOUT)).toEqual([]);
  });

  it("faces down the desk rows, so it can be read from the aisle between them", () => {
    const board = projectBoard();
    expect(roomAt(OFFICE_LAYOUT, FLOOR_AISLE)?.id).toBe("open-floor");
    // Yaw 0 faces -Z, so a board facing +Z is read from the south of it.
    expect(Math.cos(board.yaw)).toBeCloseTo(-1);
    expect(FLOOR_AISLE.z).toBeGreaterThan(board.z);
    expect(Math.abs(FLOOR_AISLE.x - board.x)).toBeLessThanOrEqual(board.width / 2);
  });

  it("is in sight of a seat in every north-facing desk row", () => {
    const board = projectBoard();
    const facingIt = interactables(OFFICE_LAYOUT).filter(
      (spec) =>
        spec.kind === INTERACTION_KIND.seat &&
        roomAt(OFFICE_LAYOUT, spec.anchor)?.id === "open-floor" &&
        Math.cos(spec.anchor.yaw) > 0.99 &&
        spec.anchor.z > board.z &&
        Math.abs(spec.anchor.x - board.x) <= board.width / 2,
    );
    const rows = new Set(facingIt.map((spec) => spec.anchor.z.toFixed(2)));
    expect(rows.size).toBeGreaterThanOrEqual(2);
  });

  it("is what every open-floor seat faces", () => {
    const board = projectBoard();
    const seats = interactables(OFFICE_LAYOUT).filter(
      (spec) =>
        spec.kind === INTERACTION_KIND.seat && roomAt(OFFICE_LAYOUT, spec.anchor)?.id === "open-floor",
    );
    expect(seats.length).toBeGreaterThan(0);
    for (const seat of seats) {
      // Yaw 0 faces -Z, toward the partition the board hangs on.
      expect(Math.cos(seat.anchor.yaw), seat.id).toBeCloseTo(1);
      expect(seat.anchor.z, seat.id).toBeGreaterThan(board.z);
    }
  });

  it("stays clear of the doorways in the wall it hangs on", () => {
    const board = projectBoard();
    const left = board.x - board.width / 2;
    const right = board.x + board.width / 2;
    for (const doorway of OFFICE_LAYOUT.doorways) {
      if (doorway.axis !== "x" || Math.abs(doorway.centre.z - board.z) > 0.5) {
        continue;
      }
      const doorLeft = doorway.centre.x - doorway.width / 2;
      const doorRight = doorway.centre.x + doorway.width / 2;
      expect(right <= doorLeft || left >= doorRight, `overlaps ${doorway.id}`).toBe(true);
    }
  });

  it("fits under the ceiling the walls give it", () => {
    const board = projectBoard();
    // The pavement's railings are waist high on purpose and roof nothing.
    const wallHeight = Math.min(
      ...OFFICE_LAYOUT.walls.filter((spec) => spec.style !== "railing").map((spec) => spec.height),
    );
    expect(board.elevation + board.height).toBeLessThanOrEqual(wallHeight);
  });

  it("is offered by the proximity prompt from floor a body can stand on in front of it", () => {
    const board = projectBoard();
    const spec = boardInteractable();
    expect(spec.kind).toBe(INTERACTION_KIND.board);
    expect(promptFor(spec)).toBe("Read the project board");
    expect(spec.anchor.z).toBeGreaterThan(board.z);
    expect(spec.anchor.x).toBeCloseTo(board.x);
    expect(isBlocked(spec.anchor, OCCUPANT_RADIUS, OFFICE_LAYOUT)).toBe(false);
    expect(nearestInteractable(OFFICE_LAYOUT, spec.anchor, INTERACT_RANGE, NOBODY)?.id).toBe(PROJECT_BOARD_ID);
  });

  it("is not offered from the aisle, so reading it up close is a decision", () => {
    expect(nearestInteractable(OFFICE_LAYOUT, FLOOR_AISLE, INTERACT_RANGE, NOBODY)).toBeUndefined();
  });

  it("holds nobody, so any number of players can read it at once", () => {
    const spec = boardInteractable();
    const reader = (id: string) => ({ id, x: spec.anchor.x, z: spec.anchor.z, interactableId: "" });
    const decision = authorizeInteract(OFFICE_LAYOUT, reader("milo"), PROJECT_BOARD_ID, INTERACT_RANGE, () => "dana");
    expect(decision.allowed).toBe(true);
  });

  it("follows the board's yaw rather than assuming a north wall", () => {
    // The same board hung on the open floor's east wall, facing west.
    const east: WallBoardSpec = { ...projectBoard(), x: 11.7, z: 3, yaw: Math.PI / 2 };
    const spec = boardInteractable({ ...OFFICE_LAYOUT, boards: [east] });
    expect(spec.anchor.x).toBeCloseTo(10.7);
    expect(spec.anchor.z).toBeCloseTo(3);
  });
});

describe("board placement checks", () => {
  it("report a board turned to face the wall it hangs on", () => {
    const board = projectBoard();
    expect(describeLayoutProblems(withBoard({ ...board, yaw: 0 }))).toEqual([
      `board ${board.id} is not hung on a wall`,
      `board ${board.id} does not face into room open-floor`,
    ]);
  });

  it("report a board left hanging in the middle of a room", () => {
    const board = projectBoard();
    expect(describeLayoutProblems(withBoard({ ...board, z: 3 }))).toEqual([
      `board ${board.id} is not hung on a wall`,
    ]);
  });

  it("report a board naming a room the plan does not have", () => {
    const board = projectBoard();
    expect(describeLayoutProblems(withBoard({ ...board, roomId: "atrium" }))).toEqual([
      `board ${board.id} faces unknown room atrium`,
      `board ${board.id} does not face into room atrium`,
    ]);
  });
});
