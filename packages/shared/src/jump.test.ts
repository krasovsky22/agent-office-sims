import { describe, expect, it } from "vitest";

import { HIGH_FIVE_REACH, JUMP_HEIGHT, JUMP_SECONDS, inHighFiveReach, jumpHeight } from "./jump.js";
import { parseHighFiveMessage } from "./messages.js";

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

describe("high five", () => {
  it("reaches as far as HIGH_FIVE_REACH and no further", () => {
    expect(inHighFiveReach({ x: 0, z: 0 }, { x: 0, z: HIGH_FIVE_REACH })).toBe(true);
    expect(inHighFiveReach({ x: 0, z: 0 }, { x: HIGH_FIVE_REACH, z: 0.1 })).toBe(false);
  });

  it("parses an agent key and nothing else", () => {
    expect(parseHighFiveMessage({ agentId: "agent:runner:box:slot-1" })).toEqual({ agentId: "agent:runner:box:slot-1" });
    for (const raw of [null, {}, { agentId: "" }, { agentId: 7 }, { agentId: "x".repeat(97) }]) {
      expect(parseHighFiveMessage(raw)).toBeUndefined();
    }
  });
});
