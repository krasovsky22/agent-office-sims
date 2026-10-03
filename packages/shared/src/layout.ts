/**
 * The office floor plan, as plain data.
 *
 * This module is the single source of truth for where the world is. The client
 * builds Three.js meshes from it and the server collides against it; neither
 * side keeps a wall position of its own, so the two can never disagree about
 * the shape of the room.
 *
 * The plan is described on the ground plane: X runs east, Z runs south, and Y
 * (height) only ever comes from a `height` field. Collision is a 2D problem
 * here because nothing in this milestone can be stepped over or crawled under.
 */

import {
  COLLISION_SUBSTEP,
  MIN_OBSTACLE_THICKNESS,
  OCCUPANT_RADIUS,
} from "./constants.js";

/** A 2D axis-aligned box on the ground plane. */
export interface Aabb2 {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** A point on the ground plane. */
export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

/** A wall segment. Its footprint is already axis-aligned. */
export interface WallSpec {
  readonly id: string;
  readonly footprint: Aabb2;
  readonly height: number;
}

/**
 * A desk, positioned by its centre and a yaw.
 *
 * `width` runs along the desk's local X and `depth` along its local Z, before
 * yaw is applied. Layout yaws are quarter turns, which keeps the collision box
 * derived in {@link deskAabb} exact rather than conservative.
 */
export interface DeskSpec {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

/** A named region of the floor. Nothing collides with a room. */
export interface RoomSpec {
  readonly id: string;
  readonly name: string;
  readonly bounds: Aabb2;
}

/**
 * A navigation node.
 *
 * Unread in this milestone: it exists so that agent employees can path through
 * the office later without the layout having to be reshaped first.
 */
export interface WaypointSpec {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Ids of directly reachable neighbours. Links are listed on both nodes. */
  readonly links: readonly string[];
}

/** A pose an arriving occupant can be placed at. */
export interface SpawnSpec {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

export interface OfficeLayout {
  readonly name: string;
  /** Outer extent of the floor slab, walls included. */
  readonly floor: Aabb2;
  readonly walls: readonly WallSpec[];
  readonly desks: readonly DeskSpec[];
  readonly rooms: readonly RoomSpec[];
  readonly waypoints: readonly WaypointSpec[];
  /** Cycled through in arrival order so occupants do not stack up. */
  readonly spawnPoints: readonly SpawnSpec[];
}

const WALL_HEIGHT = 3;
const DESK_HEIGHT = 0.75;

/** Quarter turn, the only yaw granularity the shipped layout uses. */
const QUARTER_TURN = Math.PI / 2;

function rect(minX: number, minZ: number, maxX: number, maxZ: number): Aabb2 {
  return { minX, minZ, maxX, maxZ };
}

function wall(id: string, minX: number, minZ: number, maxX: number, maxZ: number): WallSpec {
  return { id, footprint: rect(minX, minZ, maxX, maxZ), height: WALL_HEIGHT };
}

function desk(id: string, x: number, z: number, yaw: number, width = 1.6, depth = 0.8): DeskSpec {
  return { id, x, z, yaw, width, depth, height: DESK_HEIGHT };
}

/**
 * The prototype office: three rooms along the north wall opening onto an open
 * bullpen that fills the southern two thirds of the floor.
 *
 * Interior walls sit on x = -5, x = 4 and z = -3, each broken by a doorway, so
 * walking between the bullpen and the private rooms exercises both flat-wall
 * sliding and inside corners.
 */
export const OFFICE_LAYOUT: OfficeLayout = {
  name: "Ground Floor",
  floor: rect(-12, -9, 12, 9),
  walls: [
    // Shell.
    wall("wall-north", -12, -9, 12, -8.7),
    wall("wall-south", -12, 8.7, 12, 9),
    wall("wall-west", -12, -9, -11.7, 9),
    wall("wall-east", 11.7, -9, 12, 9),

    // CEO office east wall, with a doorway onto the lobby.
    wall("wall-ceo-east-north", -5.15, -8.7, -4.85, -6.6),
    wall("wall-ceo-east-south", -5.15, -5.2, -4.85, -3.15),

    // Meeting room west wall, with a doorway onto the lobby.
    wall("wall-meeting-west-north", 3.85, -8.7, 4.15, -6.6),
    wall("wall-meeting-west-south", 3.85, -5.2, 4.15, -3.15),

    // Divider between the north rooms and the bullpen. The lobby's whole south
    // side is left open: that gap is the main thoroughfare.
    wall("wall-divider-west", -12, -3.15, -4.85, -2.85),
    wall("wall-divider-east", 3.85, -3.15, 12, -2.85),
  ],
  desks: [
    // Bullpen, north row, facing the divider.
    desk("desk-01", -7.5, 0, 0),
    desk("desk-02", -4.5, 0, 0),
    desk("desk-03", -1.5, 0, 0),
    desk("desk-04", 1.5, 0, 0),
    desk("desk-05", 4.5, 0, 0),
    desk("desk-06", 7.5, 0, 0),

    // Bullpen, south row, facing back up the floor.
    desk("desk-07", -7.5, 4, Math.PI),
    desk("desk-08", -4.5, 4, Math.PI),
    desk("desk-09", -1.5, 4, Math.PI),
    desk("desk-10", 1.5, 4, Math.PI),
    desk("desk-11", 4.5, 4, Math.PI),
    desk("desk-12", 7.5, 4, Math.PI),

    // Turned desks against the side walls.
    desk("desk-13", -10.2, 7, QUARTER_TURN),
    desk("desk-14", 10.2, 7, -QUARTER_TURN),

    // Private rooms.
    desk("desk-ceo", -8.4, -6, 0, 2.2, 0.9),
    desk("table-meeting", 7.9, -6, 0, 3.2, 1.4),
  ],
  rooms: [
    { id: "ceo-office", name: "CEO Office", bounds: rect(-11.7, -8.7, -5.15, -3.15) },
    { id: "lobby", name: "Lobby", bounds: rect(-4.85, -8.7, 3.85, -3.15) },
    { id: "meeting-room", name: "Meeting Room", bounds: rect(4.15, -8.7, 11.7, -3.15) },
    { id: "bullpen", name: "Bullpen", bounds: rect(-11.7, -2.85, 11.7, 8.7) },
  ],
  waypoints: [
    { id: "wp-ceo-desk", x: -8.4, z: -4.6, links: ["wp-ceo-door"] },
    { id: "wp-ceo-door", x: -5, z: -5.9, links: ["wp-ceo-desk", "wp-lobby-north"] },
    { id: "wp-lobby-north", x: 0, z: -5.9, links: ["wp-ceo-door", "wp-meeting-door", "wp-lobby-south"] },
    { id: "wp-meeting-door", x: 4, z: -5.9, links: ["wp-lobby-north", "wp-meeting-table"] },
    { id: "wp-meeting-table", x: 7.9, z: -4.2, links: ["wp-meeting-door"] },
    { id: "wp-lobby-south", x: 0, z: -1.5, links: ["wp-lobby-north", "wp-bullpen-centre"] },
    { id: "wp-bullpen-centre", x: 0, z: 2, links: ["wp-lobby-south", "wp-bullpen-west", "wp-bullpen-east", "wp-bullpen-south"] },
    { id: "wp-bullpen-west", x: -7.5, z: 2, links: ["wp-bullpen-centre"] },
    { id: "wp-bullpen-east", x: 7.5, z: 2, links: ["wp-bullpen-centre"] },
    { id: "wp-bullpen-south", x: 0, z: 6.5, links: ["wp-bullpen-centre"] },
  ],
  // The aisle between the two desk rows, facing north up the floor. Far enough
  // from the south wall that the third-person camera gets its full boom, so an
  // arriving player sees the office rather than the inside of a partition.
  spawnPoints: [
    { x: 0, z: 2, yaw: 0 },
    { x: -3, z: 2, yaw: 0 },
    { x: 3, z: 2, yaw: 0 },
    { x: -6, z: 2, yaw: 0 },
    { x: 6, z: 2, yaw: 0 },
    { x: 0, z: 2.8, yaw: 0 },
  ],
};

/**
 * The ground footprint a desk blocks once its yaw is applied.
 *
 * For the quarter-turn yaws the layout uses this is the desk exactly. For any
 * other yaw it is the enclosing axis-aligned box, which blocks slightly more
 * floor than the rendered desk covers.
 */
export function deskAabb(spec: DeskSpec): Aabb2 {
  const halfWidth = spec.width / 2;
  const halfDepth = spec.depth / 2;
  const cos = Math.abs(Math.cos(spec.yaw));
  const sin = Math.abs(Math.sin(spec.yaw));
  const extentX = halfWidth * cos + halfDepth * sin;
  const extentZ = halfWidth * sin + halfDepth * cos;
  return rect(spec.x - extentX, spec.z - extentZ, spec.x + extentX, spec.z + extentZ);
}

const boxCache = new WeakMap<OfficeLayout, readonly Aabb2[]>();

/**
 * Every solid box in a layout, flattened for the collision resolver.
 *
 * Cached per layout: the server calls this on every pose it validates, and the
 * layout never changes at runtime.
 */
export function collisionBoxes(layout: OfficeLayout): readonly Aabb2[] {
  const cached = boxCache.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  const boxes: Aabb2[] = [];
  for (const spec of layout.walls) {
    boxes.push(spec.footprint);
  }
  for (const spec of layout.desks) {
    boxes.push(deskAabb(spec));
  }
  boxCache.set(layout, boxes);
  return boxes;
}

/** Whether a point lies inside a box. Used for room lookups, not collision. */
export function containsPoint(box: Aabb2, point: Vec2): boolean {
  return point.x >= box.minX && point.x <= box.maxX && point.z >= box.minZ && point.z <= box.maxZ;
}

/** The named room a point falls in, or `undefined` for a doorway or a wall. */
export function roomAt(layout: OfficeLayout, point: Vec2): RoomSpec | undefined {
  return layout.rooms.find((room) => containsPoint(room.bounds, point));
}

/**
 * Checks the invariants the collision resolver relies on.
 *
 * Exported for the test suite rather than run at import time: a layout that
 * breaks one of these produces a wall players can walk through, which is far
 * cheaper to catch here than in a browser.
 */
export function describeLayoutProblems(layout: OfficeLayout): string[] {
  const problems: string[] = [];
  // A box written as -3.15..-2.85 measures a hair under 0.3 in binary floating
  // point, so compare against a value that forgives the representation.
  const minThickness = MIN_OBSTACLE_THICKNESS - 1e-9;
  if (COLLISION_SUBSTEP >= MIN_OBSTACLE_THICKNESS) {
    problems.push(
      `collision substep ${COLLISION_SUBSTEP} is not smaller than the minimum obstacle thickness ${MIN_OBSTACLE_THICKNESS}`,
    );
  }
  for (const spec of layout.walls) {
    const { footprint } = spec;
    const thickness = Math.min(footprint.maxX - footprint.minX, footprint.maxZ - footprint.minZ);
    if (thickness < minThickness) {
      problems.push(`wall ${spec.id} is ${thickness} thick, below the ${MIN_OBSTACLE_THICKNESS} minimum`);
    }
  }
  for (const spec of layout.desks) {
    const box = deskAabb(spec);
    const thickness = Math.min(box.maxX - box.minX, box.maxZ - box.minZ);
    if (thickness < minThickness) {
      problems.push(`desk ${spec.id} is ${thickness} thick, below the ${MIN_OBSTACLE_THICKNESS} minimum`);
    }
  }
  const ids = new Set<string>();
  for (const node of layout.waypoints) {
    ids.add(node.id);
  }
  for (const node of layout.waypoints) {
    for (const link of node.links) {
      if (!ids.has(link)) {
        problems.push(`waypoint ${node.id} links to unknown node ${link}`);
      } else if (!layout.waypoints.find((other) => other.id === link)?.links.includes(node.id)) {
        problems.push(`waypoint link ${node.id} -> ${link} is not mirrored`);
      }
    }
  }
  for (const point of layout.spawnPoints) {
    for (const box of collisionBoxes(layout)) {
      if (
        point.x > box.minX - OCCUPANT_RADIUS &&
        point.x < box.maxX + OCCUPANT_RADIUS &&
        point.z > box.minZ - OCCUPANT_RADIUS &&
        point.z < box.maxZ + OCCUPANT_RADIUS
      ) {
        problems.push(`spawn point (${point.x}, ${point.z}) overlaps an obstacle`);
      }
    }
  }
  return problems;
}
