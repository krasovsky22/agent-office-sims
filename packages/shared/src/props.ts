/**
 * Where the office furniture stands, as plain data.
 *
 * Same rule as `layout.ts`: a prop position is written down once, here, and the
 * client only reads it. Nothing in `apps/client` decides where a desk, chair, or
 * plant goes — it receives a list of {@link PropSpec} and draws it.
 *
 * Most of this file is derivation rather than a table of coordinates. Desks,
 * chairs, monitors, doors, and plants all come out of the floor plan's own
 * geometry, so a layout that grows a room or a desk row furnishes itself and the
 * two cannot drift apart. Only {@link HAND_PLACED} is authored by hand, and it is
 * authored against the shipped floor plan specifically.
 *
 * Coordinates and yaw mean exactly what they mean in the layout: X east, Z
 * south, yaw a rotation about +Y where 0 faces -Z. Sizes are metres.
 *
 * Props do not collide. The collision world is still walls and desks only, which
 * is what keeps `collision.ts` and the server's validation untouched by this
 * module. A chair you can walk through is the deliberate trade; giving the decor
 * footprints is a follow-up that has to change both sides at once.
 */

import {
  type Aabb2,
  type DeskSpec,
  type OfficeLayout,
  type WallSpec,
  OFFICE_LAYOUT,
  collisionBoxes,
} from "./layout.js";

/**
 * The kinds of prop a renderer has to know how to draw.
 *
 * This union is the contract with the asset kit: the client keeps one model per
 * kind and nothing else. Adding a kind here means adding a model there, so the
 * union stays deliberately short.
 */
export type PropKind = "desk" | "chair" | "monitor" | "plant" | "door" | "coffee";

/** An exact box a model should be stretched to fill. */
export interface PropFit {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

/**
 * One placed piece of furniture.
 *
 * A prop is positioned by the centre of its footprint, so a renderer does not
 * need to know how its model happens to be authored. `y` is the height its base
 * sits at — zero for anything standing on the floor, a desk's height for
 * anything standing on a desk.
 */
export interface PropSpec {
  readonly id: string;
  readonly kind: PropKind;
  readonly x: number;
  /** Height of the prop's base above the floor. */
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  /**
   * Stretch the model to exactly this box, in the prop's own unrotated frame:
   * `width` along local X, `depth` along local Z.
   *
   * Used where the floor plan already states a size the prop has to agree with —
   * a desk's collision box, a doorway's gap — so the thing you see and the thing
   * you bump into are the same shape.
   */
  readonly fit?: PropFit;
  /** Uniform multiplier on the model's natural size. Ignored when `fit` is set. */
  readonly scale?: number;
}

/**
 * Floor a free-standing prop is assumed to occupy, as a radius.
 *
 * Not a collision radius — nothing collides with a prop. It is the spacing used
 * when deriving placements, and the figure {@link describePropProblems} checks
 * them against, so a chair is never left standing inside a desk.
 */
export const PROP_CLEARANCE = 0.4;

/** Floor space allowed per seat along a desk's width. */
const SEAT_PITCH = 1.6;

/** Gap between the edge of a desk and the chair pulled up to it. */
const CHAIR_GAP = 0.55;

/** How far onto the desk a monitor sits, measured from the desk's far edge. */
const MONITOR_INSET = 0.25;

/** Distance a plant is set in from the room corner it stands in. */
const PLANT_INSET = 0.8;

/**
 * Widest wall gap still treated as a doorway.
 *
 * The shipped plan has 1.4 m doorways and one 8.7 m opening onto the bullpen
 * that is a thoroughfare, not a door. This is the line between them.
 */
const DOORWAY_MAX_SPAN = 2;

/** Height of a door frame, capped by the wall it sits in. */
const DOORWAY_HEIGHT = 2.1;

const QUARTER_TURN = Math.PI / 2;

/** Rotates a point in a prop's local frame into world space. */
function toWorld(origin: { x: number; z: number }, yaw: number, localX: number, localZ: number) {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: origin.x + localX * cos + localZ * sin,
    z: origin.z - localX * sin + localZ * cos,
  };
}

/** Whether a point is inside a box grown by `margin` on every side. */
function nearBox(box: Aabb2, point: { x: number; z: number }, margin: number): boolean {
  return (
    point.x > box.minX - margin &&
    point.x < box.maxX + margin &&
    point.z > box.minZ - margin &&
    point.z < box.maxZ + margin
  );
}

/**
 * The desk itself, plus a seat and a screen for every workstation along it.
 *
 * Seat count comes from the desk's width, so a 1.6 m desk gets one and a 3.2 m
 * meeting table gets two without either number being written down. The desk prop
 * is fitted to the layout's own `width`/`depth`/`height`, which is the same box
 * `layout.ts`'s `deskAabb` hands the collision resolver — so the desk you can
 * see and the desk that stops you are one shape.
 */
function deskProps(spec: DeskSpec): PropSpec[] {
  const props: PropSpec[] = [
    {
      id: `prop-${spec.id}`,
      kind: "desk",
      x: spec.x,
      y: 0,
      z: spec.z,
      yaw: spec.yaw,
      fit: { width: spec.width, depth: spec.depth, height: spec.height },
    },
  ];

  const seats = Math.max(1, Math.round(spec.width / SEAT_PITCH));
  const seatPitch = spec.width / seats;

  for (let seat = 0; seat < seats; seat += 1) {
    const localX = (seat - (seats - 1) / 2) * seatPitch;

    // The occupant sits on the desk's +Z side and faces it, which is -Z local.
    const chair = toWorld(spec, spec.yaw, localX, spec.depth / 2 + CHAIR_GAP);
    props.push({
      id: `prop-${spec.id}-chair-${seat + 1}`,
      kind: "chair",
      x: chair.x,
      y: 0,
      z: chair.z,
      yaw: spec.yaw,
    });

    // The screen stands on the desktop at the far edge, turned to face the seat.
    const monitor = toWorld(spec, spec.yaw, localX, MONITOR_INSET - spec.depth / 2);
    props.push({
      id: `prop-${spec.id}-monitor-${seat + 1}`,
      kind: "monitor",
      x: monitor.x,
      y: spec.height,
      z: monitor.z,
      yaw: spec.yaw + Math.PI,
    });
  }

  return props;
}

/** A wall's long axis, and the span it is thin across. */
interface WallAxis {
  readonly spec: WallSpec;
  /** `"x"` for an east-west wall, `"z"` for a north-south one. */
  readonly along: "x" | "z";
  readonly longMin: number;
  readonly longMax: number;
  readonly crossMin: number;
  readonly crossMax: number;
}

function wallAxis(spec: WallSpec): WallAxis {
  const { footprint } = spec;
  const width = footprint.maxX - footprint.minX;
  const depth = footprint.maxZ - footprint.minZ;
  return width >= depth
    ? {
        spec,
        along: "x",
        longMin: footprint.minX,
        longMax: footprint.maxX,
        crossMin: footprint.minZ,
        crossMax: footprint.maxZ,
      }
    : {
        spec,
        along: "z",
        longMin: footprint.minZ,
        longMax: footprint.maxZ,
        crossMin: footprint.minX,
        crossMax: footprint.maxX,
      };
}

/**
 * A door frame in every doorway the floor plan leaves.
 *
 * A doorway is not recorded anywhere — it is the gap between two wall segments
 * that are otherwise the same wall. So this looks for exactly that: two walls on
 * the same axis, sharing a thickness span, separated by no more than
 * {@link DOORWAY_MAX_SPAN}. The frame is then fitted to the gap it found, which
 * is why no door position or width appears in this file.
 */
function doorProps(layout: OfficeLayout): PropSpec[] {
  const axes = layout.walls.map(wallAxis);
  const props: PropSpec[] = [];

  for (let i = 0; i < axes.length; i += 1) {
    for (let j = i + 1; j < axes.length; j += 1) {
      const a = axes[i];
      const b = axes[j];
      if (a === undefined || b === undefined || a.along !== b.along) {
        continue;
      }
      if (a.crossMin !== b.crossMin || a.crossMax !== b.crossMax) {
        continue;
      }

      const [first, second] = a.longMin <= b.longMin ? [a, b] : [b, a];
      const span = second.longMin - first.longMax;
      if (span <= 0 || span > DOORWAY_MAX_SPAN) {
        continue;
      }

      const thickness = a.crossMax - a.crossMin;
      const alongCentre = first.longMax + span / 2;
      const crossCentre = (a.crossMin + a.crossMax) / 2;
      const height = Math.min(DOORWAY_HEIGHT, Math.min(a.spec.height, b.spec.height));

      props.push({
        id: `prop-door-${first.spec.id}`,
        kind: "door",
        // Local X runs along the gap, so a wall running north-south needs the
        // frame turned a quarter turn to span it.
        x: a.along === "x" ? alongCentre : crossCentre,
        y: 0,
        z: a.along === "x" ? crossCentre : alongCentre,
        yaw: a.along === "x" ? 0 : QUARTER_TURN,
        fit: { width: span, depth: thickness, height },
      });
    }
  }

  return props;
}

/** Room corners, tried in this order, rotated per room so the office varies. */
const CORNERS = [
  { x: -1, z: -1 },
  { x: 1, z: -1 },
  { x: 1, z: 1 },
  { x: -1, z: 1 },
] as const;

/**
 * One plant per room, in the first corner that is clear of the world.
 *
 * Corners are tried in a rotating order so the four rooms do not all grow a
 * plant in the same corner, and a corner already occupied by a desk is skipped —
 * which is what keeps this derivation safe when the floor plan changes under it.
 */
function plantProps(layout: OfficeLayout): PropSpec[] {
  const boxes = collisionBoxes(layout);
  const props: PropSpec[] = [];

  layout.rooms.forEach((room, index) => {
    for (let step = 0; step < CORNERS.length; step += 1) {
      const corner = CORNERS[(index + step) % CORNERS.length];
      if (corner === undefined) {
        continue;
      }
      const x = corner.x < 0 ? room.bounds.minX + PLANT_INSET : room.bounds.maxX - PLANT_INSET;
      const z = corner.z < 0 ? room.bounds.minZ + PLANT_INSET : room.bounds.maxZ - PLANT_INSET;
      if (boxes.some((box) => nearBox(box, { x, z }, PROP_CLEARANCE))) {
        continue;
      }
      props.push({
        id: `prop-plant-${room.id}`,
        kind: "plant",
        x,
        y: 0,
        z,
        // Turned to face the middle of the room it stands in.
        yaw: Math.atan2(-corner.x, -corner.z),
      });
      return;
    }
  });

  return props;
}

/**
 * The pieces with nowhere to be derived from.
 *
 * A coffee machine does not follow from a wall or a desk, so these two are
 * placed by hand against the shipped floor plan: one in the lobby, where
 * everyone walks past, and one against the bullpen's east wall. They are scaled
 * up to the floor-standing size an office has rather than the countertop model
 * the asset kit ships.
 *
 * {@link describePropProblems} checks them, so a layout change that walls one of
 * them in fails the test suite rather than being noticed in a screenshot.
 */
const HAND_PLACED: readonly PropSpec[] = [
  { id: "prop-coffee-lobby", kind: "coffee", x: 0, y: 0, z: -8.18, yaw: Math.PI, scale: 2 },
  { id: "prop-coffee-bullpen", kind: "coffee", x: 11.18, y: 0, z: 1, yaw: QUARTER_TURN, scale: 2 },
];

/**
 * Every prop a layout furnishes itself with.
 *
 * Pure derivation: give it a different floor plan and you get that floor plan's
 * furniture. The shipped office's full set is {@link OFFICE_PROPS}, which is this
 * plus the hand-placed pieces.
 */
export function derivedProps(layout: OfficeLayout): readonly PropSpec[] {
  return [
    ...layout.desks.flatMap(deskProps),
    ...doorProps(layout),
    ...plantProps(layout),
  ];
}

/** The furniture of the shipped office. This is what the client renders. */
export const OFFICE_PROPS: readonly PropSpec[] = [
  ...derivedProps(OFFICE_LAYOUT),
  ...HAND_PLACED,
];

/**
 * Props grouped by kind, which is also the renderer's batching plan.
 *
 * The client draws one batch per kind per material in that kind's model, so the
 * number of draw calls is a function of how many *kinds* are present, not how
 * many props. Ten more desks cost ten more matrices and no more draw calls. The
 * grouping lives here, with a test on it, so that property is an executable
 * contract rather than something you have to open a profiler to believe.
 */
export function groupPropsByKind(
  props: readonly PropSpec[],
): ReadonlyMap<PropKind, readonly PropSpec[]> {
  const batches = new Map<PropKind, PropSpec[]>();
  for (const prop of props) {
    const batch = batches.get(prop.kind);
    if (batch === undefined) {
      batches.set(prop.kind, [prop]);
    } else {
      batch.push(prop);
    }
  }
  return batches;
}

/**
 * Checks the placement invariants, for the test suite rather than at runtime.
 *
 * Desks, monitors, and doors are excluded on purpose: a desk prop *is* its own
 * collision box, a monitor stands on one, and a door frame fills a wall gap. The
 * props worth checking are the free-standing ones, which should never be found
 * inside a desk or buried in a wall.
 */
export function describePropProblems(
  layout: OfficeLayout,
  props: readonly PropSpec[],
): string[] {
  const problems: string[] = [];
  const boxes = collisionBoxes(layout);
  const freeStanding = new Set<PropKind>(["chair", "plant", "coffee"]);
  const seen = new Set<string>();

  for (const prop of props) {
    if (seen.has(prop.id)) {
      problems.push(`duplicate prop id ${prop.id}`);
    }
    seen.add(prop.id);

    if (prop.fit !== undefined && (prop.fit.width <= 0 || prop.fit.depth <= 0 || prop.fit.height <= 0)) {
      problems.push(`prop ${prop.id} has a non-positive fit`);
    }

    if (!freeStanding.has(prop.kind)) {
      continue;
    }

    const point = { x: prop.x, z: prop.z };
    for (const box of boxes) {
      if (nearBox(box, point, PROP_CLEARANCE)) {
        problems.push(`prop ${prop.id} stands inside an obstacle at (${prop.x}, ${prop.z})`);
      }
    }
    // A negative margin shrinks the floor slab, so a prop has to stand a clear
    // radius inside it rather than half-buried in the shell wall.
    if (!nearBox(layout.floor, point, -PROP_CLEARANCE)) {
      problems.push(`prop ${prop.id} stands off the floor at (${prop.x}, ${prop.z})`);
    }
  }

  // A monitor floating in mid-air means a desk height went missing.
  for (const prop of props) {
    if (prop.kind === "monitor" && prop.y <= 0) {
      problems.push(`monitor ${prop.id} does not stand on a desk`);
    }
  }

  return problems;
}
