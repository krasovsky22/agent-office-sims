/**
 * The buildings round the office, as plain boxes: where each stands, how tall
 * it is, and whether it is brick or glass.
 *
 * Generated rather than placed, from a fixed seed, so the city is the same city
 * every load without anyone writing down sixty buildings. It is kept apart
 * from the meshes in `street.ts` so a test can check the one thing that would
 * break the illusion: a building standing in the road, on a pavement, or in
 * the office.
 *
 * Three runs of them, all fronting the street the layout describes: the block
 * across the road, a skyline of towers further back over its roofs, and the
 * office's own neighbours either side of it, their fronts flush with its glass.
 * And one more, the office's own building above the floor the game is on, so
 * from the street the office reads as its first floor.
 */

import type { OfficeLayout } from "@sim/shared";

export type BuildingStyle = "brick" | "glass";

export interface BuildingSpec {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly height: number;
  /** Height its walls start at, when that is not the ground. */
  readonly base?: number;
  readonly style: BuildingStyle;
  /** sRGB hex the facade texture is tinted with. */
  readonly colour: number;
  /** Whether a timber water tank stands on its roof, as on so many New York walk-ups. */
  readonly waterTank: boolean;
}

/** Red and brown brick, and the odd limestone front. */
const BRICK_COLOURS = [0x8a4b3a, 0x9c5b45, 0x7a3f33, 0xb08a6a, 0xa89f91, 0x6e4a3e, 0x8f6a55] as const;
/** Blue-grey curtain wall. */
const GLASS_COLOURS = [0x5d7a92, 0x4a6378, 0x7f98aa, 0x3d4f5f, 0x6b8597] as const;

/** Width of the alley left between two neighbours, when there is one. */
const ALLEY = 0.6;

/** How far past the far block's fronts the skyline's towers begin. */
const SKYLINE_SETBACK = 32;

/** Reach of the skyline row along the street, beyond the drawn road. */
const SKYLINE_OVERHANG = 30;

/** How tall the office's building stands above the office's ceiling. */
const UPPER_STOREYS_HEIGHT = 34;

/** The office building's curtain wall: the blue-grey of the glass towers round it. */
const UPPER_STOREYS_COLOUR = 0x6b8597;

/** A small seeded generator, so the city is the same city every load. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RowSpec {
  /** The street-facing side of the row, as an X. */
  readonly frontX: number;
  /** `1` when the row's buildings extend east of their front, `-1` west. */
  readonly backwards: 1 | -1;
  readonly fromZ: number;
  readonly toZ: number;
  readonly width: readonly [number, number];
  readonly depth: readonly [number, number];
  readonly brickHeight: readonly [number, number];
  readonly glassHeight: readonly [number, number];
  readonly glassShare: number;
}

function between(random: () => number, [low, high]: readonly [number, number]): number {
  return low + random() * (high - low);
}

function pick<T>(random: () => number, options: readonly [T, ...T[]]): T {
  return options[Math.floor(random() * options.length)] ?? options[0];
}

/** One run of buildings side by side along Z, with the odd alley between them. */
function row(random: () => number, spec: RowSpec): BuildingSpec[] {
  const buildings: BuildingSpec[] = [];
  let z = spec.fromZ;
  while (z < spec.toZ - 2) {
    const width = Math.min(between(random, spec.width), spec.toZ - z);
    const depth = between(random, spec.depth);
    const glass = random() < spec.glassShare;
    const near = spec.frontX;
    const far = spec.frontX + spec.backwards * depth;
    buildings.push({
      minX: Math.min(near, far),
      maxX: Math.max(near, far),
      minZ: z,
      maxZ: z + width,
      height: between(random, glass ? spec.glassHeight : spec.brickHeight),
      style: glass ? "glass" : "brick",
      colour: glass ? pick(random, GLASS_COLOURS) : pick(random, BRICK_COLOURS),
      waterTank: !glass && random() < 0.6,
    });
    z += width + (random() < 0.3 ? ALLEY : 0);
  }
  return buildings;
}

/** Every building round the office's street, or none for a layout with no street. */
export function skylineOf(layout: OfficeLayout, seed = 1115): readonly BuildingSpec[] {
  const { street } = layout;
  if (street === undefined) {
    return [];
  }
  const random = seededRandom(seed);
  const { road } = street;
  const shell = layout.floor;
  // The office's pavement ends in a railing either side of the building; its
  // neighbours start just past it.
  const neighbourGap = 0.3;

  return [
    // Across the road.
    ...row(random, {
      frontX: street.farFrontX,
      backwards: 1,
      fromZ: road.minZ,
      toZ: road.maxZ,
      width: [9, 20],
      depth: [14, 24],
      brickHeight: [12, 30],
      glassHeight: [30, 70],
      glassShare: 0.3,
    }),
    // The towers behind it.
    ...row(random, {
      frontX: street.farFrontX + SKYLINE_SETBACK,
      backwards: 1,
      fromZ: road.minZ - SKYLINE_OVERHANG,
      toZ: road.maxZ + SKYLINE_OVERHANG,
      width: [14, 26],
      depth: [16, 26],
      brickHeight: [35, 60],
      glassHeight: [55, 120],
      glassShare: 0.7,
    }),
    // The office's neighbours, north of it and south of it.
    ...row(random, {
      frontX: shell.maxX,
      backwards: -1,
      fromZ: road.minZ,
      toZ: shell.minZ - neighbourGap,
      width: [9, 18],
      depth: [24, 26],
      brickHeight: [14, 34],
      glassHeight: [30, 60],
      glassShare: 0.25,
    }),
    ...row(random, {
      frontX: shell.maxX,
      backwards: -1,
      fromZ: shell.maxZ + neighbourGap,
      toZ: road.maxZ,
      width: [9, 18],
      depth: [24, 26],
      brickHeight: [14, 34],
      glassHeight: [30, 60],
      glassShare: 0.25,
    }),
  ];
}

/**
 * The storeys of the office's own building above the office: its footprint,
 * from the ceiling up. None for a floor with no street to see it from, or no
 * ceiling to stand it on.
 */
export function upperStoreysOf(layout: OfficeLayout): BuildingSpec | undefined {
  if (layout.street === undefined || layout.ceiling === undefined) {
    return undefined;
  }
  const { floor } = layout;
  return {
    minX: floor.minX,
    minZ: floor.minZ,
    maxX: floor.maxX,
    maxZ: floor.maxZ,
    height: UPPER_STOREYS_HEIGHT,
    base: layout.ceiling,
    style: "glass",
    colour: UPPER_STOREYS_COLOUR,
    waterTank: false,
  };
}
