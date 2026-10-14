/**
 * The lobby board is placed by hand, so these pin the two things a hand can get
 * wrong: that it hangs where a player can walk up to it and faces the right
 * way, and that the close-up range check is the shape the issue describes — in
 * front of the board, close to it, and nowhere else.
 */

import { describe, expect, it } from "vitest";

import { isBlocked } from "./collision.js";
import { OCCUPANT_RADIUS } from "./constants.js";
import {
  OFFICE_LAYOUT,
  PROJECT_BOARD_ID,
  type OfficeLayout,
  type WallBoardSpec,
  describeLayoutProblems,
  roomAt,
} from "./layout.js";
import { BOARD_CLOSE_UP_RANGE, isWithinBoardRange } from "./projectBoard.js";

function projectBoard(layout: OfficeLayout = OFFICE_LAYOUT): WallBoardSpec {
  const board = layout.boards.find((candidate) => candidate.id === PROJECT_BOARD_ID);
  if (board === undefined) {
    throw new Error("the shipped layout has no project board");
  }
  return board;
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
    // In front of the face and inside its width, just further than close-up.
    expect(isWithinBoardRange(board, LOBBY_CENTRE, Number.POSITIVE_INFINITY)).toBe(true);
    expect(isWithinBoardRange(board, LOBBY_CENTRE)).toBe(false);
  });

  it("fits under the ceiling the walls give it", () => {
    const board = projectBoard();
    const wallHeight = Math.min(...OFFICE_LAYOUT.walls.map((spec) => spec.height));
    expect(board.elevation + board.height).toBeLessThanOrEqual(wallHeight);
  });

  it("leaves floor in front of it a body can stand on to read it close up", () => {
    const board = projectBoard();
    const standing = { x: board.x, z: board.z + BOARD_CLOSE_UP_RANGE / 2 };
    expect(isBlocked(standing, OCCUPANT_RADIUS, OFFICE_LAYOUT)).toBe(false);
    expect(isWithinBoardRange(board, standing)).toBe(true);
  });
});

describe("isWithinBoardRange", () => {
  // A board on a north wall facing south, so "in front" is +Z.
  const board = projectBoard();

  it("admits a player standing in front of the board, within range", () => {
    expect(isWithinBoardRange(board, { x: board.x, z: board.z + 1 })).toBe(true);
    expect(isWithinBoardRange(board, { x: board.x + board.width / 2, z: board.z + 1.5 })).toBe(true);
  });

  it("refuses a player too far back", () => {
    expect(isWithinBoardRange(board, { x: board.x, z: board.z + BOARD_CLOSE_UP_RANGE + 0.1 })).toBe(
      false,
    );
  });

  it("refuses a player well off to one side", () => {
    expect(isWithinBoardRange(board, { x: board.x + board.width, z: board.z + 1 })).toBe(false);
  });

  it("refuses a player behind the wall the board hangs on", () => {
    expect(isWithinBoardRange(board, { x: board.x, z: board.z - 1 })).toBe(false);
  });

  it("follows the board's yaw rather than assuming a north wall", () => {
    // The same board hung on an east wall, facing west.
    const east: WallBoardSpec = { ...board, x: 11.7, z: -8, yaw: Math.PI / 2 };
    expect(isWithinBoardRange(east, { x: 10.5, z: -8 })).toBe(true);
    expect(isWithinBoardRange(east, { x: 12.5, z: -8 })).toBe(false);
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
