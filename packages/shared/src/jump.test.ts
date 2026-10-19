import { describe, expect, it } from "vitest";

import { JUMP_HEIGHT, JUMP_SECONDS, jumpHeight } from "./jump.js";

describe("jumpHeight", () => {
  it("leaves and lands on the floor", () => {
    expect(jumpHeight(0)).toBe(0);
    expect(jumpHeight(JUMP_SECONDS)).toBe(0);
    expect(jumpHeight(JUMP_SECONDS * 2)).toBe(0);
    expect(jumpHeight(-1)).toBe(0);
    expect(jumpHeight(Number.NaN)).toBe(0);
  });

  it("peaks halfway through", () => {
    expect(jumpHeight(JUMP_SECONDS / 2)).toBeCloseTo(JUMP_HEIGHT);
    expect(jumpHeight(JUMP_SECONDS / 4)).toBeLessThan(JUMP_HEIGHT);
    expect(jumpHeight(JUMP_SECONDS / 4)).toBeGreaterThan(0);
  });
});
