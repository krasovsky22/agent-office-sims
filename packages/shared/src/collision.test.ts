/**
 * The collision resolver is the one piece of this milestone both sides run, so
 * it is the one piece with tests. Everything here is expressed against the real
 * {@link OFFICE_LAYOUT} rather than a fixture: a resolver that is correct about
 * an invented wall and wrong about the shipped floor plan is not useful.
 */

import { describe, expect, it } from "vitest";

import { isBlocked, resolveMove } from "./collision.js";
import { OCCUPANT_RADIUS, WALK_SPEED } from "./constants.js";
import { OFFICE_LAYOUT, describeLayoutProblems } from "./layout.js";

const R = OCCUPANT_RADIUS;

/** Contact faces of the walls, desks and props the cases below aim at. */
const SOUTH_WALL_FACE = 11.7;
const EAST_WALL_FACE = 11.7;
const NORTH_WALL_FACE = -11.7;
const PARTITION_NORTH_FACE = -2.7;
const PARTITION_SOUTH_FACE = -2.4;
const MEETING_EAST_WALL_FACE = 0;
const DESK_ROW_SOUTH_FACE = 0.9;
const CEO_DESK_SOUTH_FACE = -8.05;
const COFFEE_MACHINE_SOUTH_FACE = -10.75;

/** Start and travel of the diagonal that wedges into the meeting room corner. */
const CORNER_START = { x: -1, z: -10 };
const CORNER_DELTA = { x: 5, z: -5 };

function move(from: { x: number; z: number }, delta: { x: number; z: number }) {
  return resolveMove(from, delta, R, OFFICE_LAYOUT);
}

interface Case {
  readonly name: string;
  readonly from: { x: number; z: number };
  readonly delta: { x: number; z: number };
  readonly expect: { x: number; z: number };
}

/**
 * Decimal places the expected positions are checked to, i.e. half a millimetre.
 * A blocked axis comes to rest a contact epsilon short of the surface, which is
 * two orders of magnitude finer than this.
 */
const PLACES = 3;

const cases: readonly Case[] = [
  {
    name: "head-on into the south wall stops a radius short",
    from: { x: 0, z: 9 },
    delta: { x: 0, z: 4 },
    expect: { x: 0, z: SOUTH_WALL_FACE - R },
  },
  {
    name: "head-on into a desk stops a radius short",
    from: { x: 1.8, z: 2.5 },
    delta: { x: 0, z: -3 },
    expect: { x: 1.8, z: DESK_ROW_SOUTH_FACE + R },
  },
  {
    name: "oblique approach to the east wall keeps the along-wall component",
    from: { x: 10, z: 2.5 },
    delta: { x: 3, z: 2 },
    expect: { x: EAST_WALL_FACE - R, z: 4.5 },
  },
  {
    name: "oblique approach to the partition slides east along it",
    from: { x: 0, z: -4 },
    delta: { x: 2, z: 1 },
    expect: { x: 2, z: PARTITION_NORTH_FACE - R },
  },
  {
    name: "diagonal into the meeting room's inside corner stops on both faces",
    from: CORNER_START,
    delta: CORNER_DELTA,
    expect: { x: MEETING_EAST_WALL_FACE - R, z: NORTH_WALL_FACE + R },
  },
  {
    name: "a step long enough to cross a wall is still stopped by it",
    from: { x: -10.7, z: 0 },
    delta: { x: 0, z: -20 },
    expect: { x: -10.7, z: PARTITION_SOUTH_FACE + R },
  },
  {
    name: "an absurd step is stopped by the same wall",
    from: { x: -10.7, z: 0 },
    delta: { x: 0, z: -1000 },
    expect: { x: -10.7, z: PARTITION_SOUTH_FACE + R },
  },
  {
    name: "a doorway is passable",
    from: { x: -8.7, z: -3.7 },
    delta: { x: 0, z: -6 },
    expect: { x: -8.7, z: CEO_DESK_SOUTH_FACE + R },
  },
  {
    name: "head-on into a prop stops a radius short",
    from: { x: 3.15, z: -10 },
    delta: { x: 0, z: -2 },
    expect: { x: 3.15, z: COFFEE_MACHINE_SOUTH_FACE + R },
  },
  {
    name: "unobstructed movement is untouched",
    from: { x: 0, z: 6.5 },
    delta: { x: 1, z: -1 },
    expect: { x: 1, z: 5.5 },
  },
];

describe("resolveMove", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = move(testCase.from, testCase.delta);
      expect(result.x).toBeCloseTo(testCase.expect.x, PLACES);
      expect(result.z).toBeCloseTo(testCase.expect.z, PLACES);
      expect(isBlocked(result, R, OFFICE_LAYOUT)).toBe(false);
    });
  }

  it("leaves a zero movement exactly where it was", () => {
    const result = move({ x: 1.25, z: -3.7 }, { x: 0, z: 0 });
    expect(result).toEqual({ x: 1.25, z: -3.7 });
  });

  it("treats a non-finite component as no movement on that axis", () => {
    const result = move({ x: 0, z: 9 }, { x: Number.NaN, z: -1 });
    expect(result.x).toBeCloseTo(0, 6);
    expect(result.z).toBeCloseTo(8, 6);
  });

  it("is deterministic", () => {
    const first = move(CORNER_START, CORNER_DELTA);
    const second = move(CORNER_START, CORNER_DELTA);
    expect(second).toEqual(first);
  });

  it("holds position when pressed into a corner it already rests in", () => {
    const corner = move(CORNER_START, CORNER_DELTA);
    const pressed = move(corner, { x: 1, z: -1 });
    expect(pressed.x).toBeCloseTo(corner.x, 6);
    expect(pressed.z).toBeCloseTo(corner.z, 6);
  });

  /**
   * The client resolves once per rendered frame and the server once per pose it
   * receives, so the same travel reaches the resolver chopped up differently on
   * the two sides. They have to land in the same place or the server's
   * correction shows up as rubber-banding.
   */
  it("lands in the same place however the travel is divided", () => {
    const from = { x: 10, z: 2.5 };
    const total = { x: WALK_SPEED, z: WALK_SPEED };

    const once = move(from, total);
    const divided = (chunks: number) => {
      let position = { x: from.x, z: from.z };
      for (let i = 0; i < chunks; i += 1) {
        position = move(position, { x: total.x / chunks, z: total.z / chunks });
      }
      return position;
    };

    for (const chunks of [3, 20, 60]) {
      const result = divided(chunks);
      expect(result.x).toBeCloseTo(once.x, 2);
      expect(result.z).toBeCloseTo(once.z, 2);
    }
  });

  /**
   * Sweeps every direction from a handful of starts at speeds well beyond what
   * a frame can produce. No input may ever leave an occupant inside geometry;
   * that is the invariant the server's validation rests on.
   */
  it("never leaves an occupant inside geometry", () => {
    const starts = [
      { x: 0, z: 9 },
      CORNER_START,
      { x: 0, z: -4 },
      { x: 10, z: 2.5 },
      { x: -10.7, z: 0 },
      { x: 3.15, z: -10 },
      { x: -8.7, z: -6.8 },
      { x: 9, z: -8 },
    ];
    const distances = [0.05, 0.5, 4, 40];

    for (const start of starts) {
      expect(isBlocked(start, R, OFFICE_LAYOUT)).toBe(false);
      for (let step = 0; step < 72; step += 1) {
        const angle = (step / 72) * Math.PI * 2;
        for (const distance of distances) {
          const delta = { x: Math.cos(angle) * distance, z: Math.sin(angle) * distance };
          const result = move(start, delta);
          expect(
            isBlocked(result, R, OFFICE_LAYOUT),
            `(${start.x}, ${start.z}) + ${distance}m at ${angle.toFixed(3)}rad -> (${result.x}, ${result.z})`,
          ).toBe(false);
        }
      }
    }
  });

  /** Walking a long way in one direction must stay inside the shell. */
  it("keeps an occupant inside the building", () => {
    for (let step = 0; step < 36; step += 1) {
      const angle = (step / 36) * Math.PI * 2;
      const result = move({ x: 0, z: 2.5 }, { x: Math.cos(angle) * 200, z: Math.sin(angle) * 200 });
      expect(result.x).toBeGreaterThan(OFFICE_LAYOUT.floor.minX);
      expect(result.x).toBeLessThan(OFFICE_LAYOUT.floor.maxX);
      expect(result.z).toBeGreaterThan(OFFICE_LAYOUT.floor.minZ);
      expect(result.z).toBeLessThan(OFFICE_LAYOUT.floor.maxZ);
    }
  });
});

describe("OFFICE_LAYOUT", () => {
  it("satisfies the invariants the resolver depends on", () => {
    expect(describeLayoutProblems(OFFICE_LAYOUT)).toEqual([]);
  });
});
