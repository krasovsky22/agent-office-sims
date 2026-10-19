import { JUMP_SECONDS, Occupant } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { createMotion, tryJump } from "./movement.js";

describe("tryJump", () => {
  it("refuses a jump that would start in mid-air", () => {
    const occupant = new Occupant();
    const motion = createMotion(0, 0, 0, 0);
    expect(tryJump(occupant, motion, 1000)).toBe(true);
    expect(tryJump(occupant, motion, 1000 + JUMP_SECONDS * 500)).toBe(false);
    expect(tryJump(occupant, motion, 1000 + JUMP_SECONDS * 1000)).toBe(true);
  });

  it("refuses a jump from a chair", () => {
    const occupant = new Occupant();
    occupant.interactableId = "desk-1-chair";
    expect(tryJump(occupant, createMotion(0, 0, 0, 0), 1000)).toBe(false);
  });
});
