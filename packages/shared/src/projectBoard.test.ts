/**
 * The lobby board is placed by hand, so these pin the two things a hand can get
 * wrong: that it hangs where a player can walk up to it and faces the right
 * way, and that the proximity prompt offers its close-up in front of it and
 * nowhere else.
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

const LOBBY_CENTRE = { x: 9, z: -8 };

describe("the lobby's project board", () => {
  it("hangs in the lobby, on a wall, facing into the room", () => {
    const board = projectBoard();
    expect(board.roomId).toBe("lobby");
    expect(describeLayoutProblems(OFFICE_LAYOUT)).toEqual([]);
  });

  it("faces the lobby centre, so it can be read from the middle of the room", () => {
    const board = projectBoard();
    expect(roomAt(OFFICE_LAYOUT, LOBBY_CENTRE)?.id).toBe("lobby");
    // Yaw 0 faces -Z, so a board facing +Z is read from the south of it.
    expect(Math.cos(board.yaw)).toBeCloseTo(-1);
    expect(LOBBY_CENTRE.z).toBeGreaterThan(board.z);
    expect(Math.abs(LOBBY_CENTRE.x - board.x)).toBeLessThanOrEqual(board.width / 2);
  });

  it("fits under the ceiling the walls give it", () => {
    const board = projectBoard();
    const wallHeight = Math.min(...OFFICE_LAYOUT.walls.map((spec) => spec.height));
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
    expect(nearestInteractable(OFFICE_LAYOUT, spec.anchor, INTERACT_RANGE)?.id).toBe(PROJECT_BOARD_ID);
  });

  it("is not offered from the lobby centre, so reading it up close is a decision", () => {
    expect(nearestInteractable(OFFICE_LAYOUT, LOBBY_CENTRE, INTERACT_RANGE)).toBeUndefined();
  });

  it("holds nobody, so any number of players can read it at once", () => {
    const spec = boardInteractable();
    const reader = (id: string) => ({ id, x: spec.anchor.x, z: spec.anchor.z, interactableId: "" });
    const decision = authorizeInteract(OFFICE_LAYOUT, reader("milo"), PROJECT_BOARD_ID, INTERACT_RANGE, () => "dana");
    expect(decision.allowed).toBe(true);
  });

  it("follows the board's yaw rather than assuming a north wall", () => {
    // The same board hung on the lobby's east wall, facing west.
    const east: WallBoardSpec = { ...projectBoard(), x: 11.7, z: -8, yaw: Math.PI / 2 };
    const spec = boardInteractable({ ...OFFICE_LAYOUT, boards: [east] });
    expect(spec.anchor.x).toBeCloseTo(10.7);
    expect(spec.anchor.z).toBeCloseTo(-8);
  });
});

describe("board placement checks", () => {
  it("report a board turned to face the wall it hangs on", () => {
    const board = projectBoard();
    expect(describeLayoutProblems(withBoard({ ...board, yaw: 0 }))).toEqual([
      `board ${board.id} is not hung on a wall`,
      `board ${board.id} does not face into room lobby`,
    ]);
  });

  it("report a board left hanging in the middle of a room", () => {
    const board = projectBoard();
    expect(describeLayoutProblems(withBoard({ ...board, z: -8 }))).toEqual([
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
