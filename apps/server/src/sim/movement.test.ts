/**
 * Jump height as the server publishes it.
 *
 * The client simulates its own arc, so what is tested here is the server's
 * side of that bargain: an honest height passes untouched, a dishonest one is
 * cut down to the highest an honest jump reaches, and none of it lets anyone
 * through the furniture.
 */

import { HumanPlayer, MAX_JUMP_HEIGHT, OFFICE_LAYOUT, interactableById } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { applyPose, createMotion, recordPose } from "./movement.js";

/** A player standing behind a desk's chair, where its exit puts them, and their motion. */
function standing() {
  const exit = interactableById(OFFICE_LAYOUT, "seat-desk-north-3-1")?.exit;
  if (exit === undefined) {
    throw new Error("the layout's seat has no exit");
  }
  const player = new HumanPlayer();
  player.x = exit.x;
  player.z = exit.z;
  return { player, motion: createMotion(player.x, player.z, 0, 0) };
}

describe("applyPose height", () => {
  it("publishes an honest jump's height as reported", () => {
    const { player, motion } = standing();
    recordPose(motion, { x: player.x, y: MAX_JUMP_HEIGHT / 2, z: player.z, yaw: 0, animation: "idle" }, 50);
    applyPose(player, motion, 50, OFFICE_LAYOUT);
    expect(player.y).toBeCloseTo(MAX_JUMP_HEIGHT / 2);
  });

  it("cuts a height above the highest jump down to it", () => {
    const { player, motion } = standing();
    recordPose(motion, { x: player.x, y: 40, z: player.z, yaw: 0, animation: "idle" }, 50);
    applyPose(player, motion, 50, OFFICE_LAYOUT);
    expect(player.y).toBe(MAX_JUMP_HEIGHT);
  });

  it("keeps the feet out of the floor", () => {
    const { player, motion } = standing();
    recordPose(motion, { x: player.x, y: -3, z: player.z, yaw: 0, animation: "idle" }, 50);
    applyPose(player, motion, 50, OFFICE_LAYOUT);
    expect(player.y).toBe(0);
  });

  it("collides with the furniture in the air exactly as on the floor", () => {
    const seat = interactableById(OFFICE_LAYOUT, "seat-desk-north-3-1")?.anchor;
    if (seat === undefined) {
      throw new Error("the layout has no such seat");
    }
    const walkInto = (y: number) => {
      const { player, motion } = standing();
      recordPose(motion, { x: seat.x, y, z: seat.z, yaw: 0, animation: "walking" }, 400);
      applyPose(player, motion, 400, OFFICE_LAYOUT);
      return { x: player.x, z: player.z };
    };
    const grounded = walkInto(0);
    // The chair is solid, so walking at it stops short of its anchor.
    expect(Math.hypot(grounded.x - seat.x, grounded.z - seat.z)).toBeGreaterThan(0.1);
    expect(walkInto(MAX_JUMP_HEIGHT)).toEqual(grounded);
  });
});
