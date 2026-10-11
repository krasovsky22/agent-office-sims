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

/**
 * What a prop is, for the asset registry that will replace the grey boxes.
 *
 * Desks have their own spec because the rows of them are the floor plan's main
 * structure; everything else solid that is not a wall or a desk is a prop.
 */
export type PropKind = "coffee";

/**
 * A solid furnishing other than a desk, positioned the same way a desk is.
 *
 * Props collide, so a prop is a thing you walk around rather than a decal: the
 * client renders every one of them and the server blocks against every one of
 * them. `kind` is what a later asset registry keys a model off.
 */
export interface PropSpec {
  readonly id: string;
  readonly kind: PropKind;
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
 * A gap in the wall line between two rooms.
 *
 * The gap is already there in {@link OfficeLayout.walls} — a doorway is two
 * wall segments with space between them, not a wall with a hole. This spec
 * names that space so later work does not have to infer it from the segments:
 * it is where a door model hangs and where a path crosses between two rooms.
 */
export interface DoorwaySpec {
  readonly id: string;
  /** Centre of the gap, in the middle of the wall line it breaks. */
  readonly centre: Vec2;
  /** Clear width of the gap, measured along {@link DoorwaySpec.axis}. */
  readonly width: number;
  /** The axis the gap's width runs along; travel crosses the other one. */
  readonly axis: "x" | "z";
  /** Ids of the two rooms the gap joins, in no particular order. */
  readonly connects: readonly [string, string];
}

/**
 * A navigation node.
 *
 * Unread in this milestone: it exists so that agent employees can path through
 * the office later without the layout having to be reshaped first. Every room
 * and every doorway holds at least one node, and the graph is connected, so a
 * path exists between any two nodes.
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
  readonly props: readonly PropSpec[];
  readonly rooms: readonly RoomSpec[];
  readonly doorways: readonly DoorwaySpec[];
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
 * One row of identical desks, evenly spaced about x = 0.
 *
 * The rows are the open floor's structure, so they are generated rather than
 * written out: a row written by hand is a row where one desk ends up a
 * centimetre out of line.
 */
function deskRow(prefix: string, z: number, yaw: number, xs: readonly number[]): DeskSpec[] {
  return xs.map((x, index) => desk(`${prefix}-${index + 1}`, x, z, yaw));
}

/** Where the desks in every open-floor row sit along X. */
const DESK_ROW_XS = [-9, -5.4, -1.8, 1.8, 5.4, 9] as const;

/**
 * The prototype office floor: one storey, six named rooms.
 *
 * Reading from the north wall south:
 *
 * - A band of enclosed rooms, `z` from -11.7 to -5: the CEO's corner office in
 *   the north-west, then the meeting room, then the kitchen, then the entrance
 *   lobby in the north-east. Each is divided from the next by a solid wall and
 *   opens south onto the corridor through a doorway; the lobby's opening is the
 *   full width of the room, since that is the way in.
 * - An east-west corridor, `z` from -4.7 to -2.7, running the whole width of
 *   the building and serving every door in that band.
 * - The open floor, `z` from -2.4 south, holding three rows of desks. A
 *   partition separates it from the corridor, broken by two doorways so the
 *   walk from a desk to a meeting is short from either end of the room.
 *
 * Every doorway is 1.4m clear, which is twice an occupant's diameter: wide
 * enough that two people pass, narrow enough to read as a door. Walls are
 * {@link MIN_OBSTACLE_THICKNESS} thick, the thinnest the collision substep can
 * guarantee a fast mover cannot cross.
 */
export const OFFICE_LAYOUT: OfficeLayout = {
  name: "Ground Floor",
  floor: rect(-12, -12, 12, 12),
  walls: [
    // Shell.
    wall("wall-north", -12, -12, 12, -11.7),
    wall("wall-south", -12, 11.7, 12, 12),
    wall("wall-west", -12, -12, -11.7, 12),
    wall("wall-east", 11.7, -12, 12, 12),

    // Dividers between the rooms in the north band. Each runs south to the
    // corridor, so it doubles as the jamb of the doorway beside it.
    wall("wall-ceo-east", -6, -11.7, -5.7, -4.7),
    wall("wall-meeting-east", 0, -11.7, 0.3, -4.7),
    wall("wall-kitchen-east", 6, -11.7, 6.3, -4.7),

    // South wall of the CEO office, with a doorway onto the corridor.
    wall("wall-ceo-south-west", -11.7, -5, -9.4, -4.7),
    wall("wall-ceo-south-east", -8, -5, -6, -4.7),

    // South wall of the meeting room, with a doorway onto the corridor.
    wall("wall-meeting-south-west", -5.7, -5, -3.55, -4.7),
    wall("wall-meeting-south-east", -2.15, -5, 0, -4.7),

    // South wall of the kitchen, with a doorway onto the corridor.
    wall("wall-kitchen-south-west", 0.3, -5, 2.45, -4.7),
    wall("wall-kitchen-south-east", 3.85, -5, 6, -4.7),

    // The lobby has no south wall: its whole width opens onto the corridor.

    // Partition between the corridor and the open floor, broken by a doorway
    // at each end of the desk rows.
    wall("wall-partition-west", -11.7, -2.7, -6.7, -2.4),
    wall("wall-partition-centre", -5.3, -2.7, 5.3, -2.4),
    wall("wall-partition-east", 6.7, -2.7, 11.7, -2.4),
  ],
  desks: [
    // Open floor. The middle row faces back up the floor so that two rows look
    // at each other across an aisle rather than all three facing one way.
    ...deskRow("desk-north", 0.5, 0, DESK_ROW_XS),
    ...deskRow("desk-middle", 4.5, Math.PI, DESK_ROW_XS),
    ...deskRow("desk-south", 8.5, 0, DESK_ROW_XS),

    // Turned desks against the side walls, far enough off them to walk behind.
    desk("desk-west-wall", -10.4, 6.5, QUARTER_TURN),
    desk("desk-east-wall", 10.4, 6.5, -QUARTER_TURN),

    // Private rooms.
    desk("desk-ceo", -9, -8.5, 0, 2.2, 0.9),
    desk("table-meeting", -2.85, -8.5, 0, 3.2, 1.4),
  ],
  props: [
    // Against the kitchen's north wall, with room to stand in front of it.
    { id: "coffee-machine", kind: "coffee", x: 3.15, z: -11.1, yaw: 0, width: 0.9, depth: 0.7, height: 1.5 },
  ],
  rooms: [
    { id: "ceo-office", name: "CEO Office", bounds: rect(-11.7, -11.7, -6, -5) },
    { id: "meeting-room", name: "Meeting Room", bounds: rect(-5.7, -11.7, 0, -5) },
    { id: "kitchen", name: "Kitchen", bounds: rect(0.3, -11.7, 6, -5) },
    { id: "lobby", name: "Lobby", bounds: rect(6.3, -11.7, 11.7, -5) },
    { id: "corridor", name: "Corridor", bounds: rect(-11.7, -4.7, 11.7, -2.7) },
    { id: "open-floor", name: "Open Floor", bounds: rect(-11.7, -2.4, 11.7, 11.7) },
  ],
  doorways: [
    { id: "door-ceo", centre: { x: -8.7, z: -4.85 }, width: 1.4, axis: "x", connects: ["ceo-office", "corridor"] },
    { id: "door-meeting", centre: { x: -2.85, z: -4.85 }, width: 1.4, axis: "x", connects: ["meeting-room", "corridor"] },
    { id: "door-kitchen", centre: { x: 3.15, z: -4.85 }, width: 1.4, axis: "x", connects: ["kitchen", "corridor"] },
    { id: "door-lobby", centre: { x: 9, z: -4.85 }, width: 5.4, axis: "x", connects: ["lobby", "corridor"] },
    { id: "door-floor-west", centre: { x: -6, z: -2.55 }, width: 1.4, axis: "x", connects: ["corridor", "open-floor"] },
    { id: "door-floor-east", centre: { x: 6, z: -2.55 }, width: 1.4, axis: "x", connects: ["corridor", "open-floor"] },
  ],
  // Every link is axis-aligned and clear of the geometry, so a body can follow
  // one by walking straight at the next node.
  waypoints: [
    // CEO office.
    { id: "wp-ceo-desk", x: -8.7, z: -6.8, links: ["wp-ceo-door"] },
    { id: "wp-ceo-door", x: -8.7, z: -4.85, links: ["wp-ceo-desk", "wp-corridor-ceo"] },

    // Meeting room.
    { id: "wp-meeting-table", x: -2.85, z: -6.8, links: ["wp-meeting-door"] },
    { id: "wp-meeting-door", x: -2.85, z: -4.85, links: ["wp-meeting-table", "wp-corridor-meeting"] },

    // Kitchen.
    { id: "wp-kitchen-coffee", x: 3.15, z: -10, links: ["wp-kitchen-door"] },
    { id: "wp-kitchen-door", x: 3.15, z: -4.85, links: ["wp-kitchen-coffee", "wp-corridor-kitchen"] },

    // Lobby.
    { id: "wp-lobby-centre", x: 9, z: -8, links: ["wp-lobby-door"] },
    { id: "wp-lobby-door", x: 9, z: -4.85, links: ["wp-lobby-centre", "wp-corridor-lobby"] },

    // Corridor, one node off each doorway so a turn lands on a node.
    { id: "wp-corridor-ceo", x: -8.7, z: -3.7, links: ["wp-ceo-door", "wp-corridor-west-door"] },
    {
      id: "wp-corridor-west-door",
      x: -6,
      z: -3.7,
      links: ["wp-corridor-ceo", "wp-corridor-meeting", "wp-floor-west-door"],
    },
    {
      id: "wp-corridor-meeting",
      x: -2.85,
      z: -3.7,
      links: ["wp-corridor-west-door", "wp-meeting-door", "wp-corridor-kitchen"],
    },
    {
      id: "wp-corridor-kitchen",
      x: 3.15,
      z: -3.7,
      links: ["wp-corridor-meeting", "wp-kitchen-door", "wp-corridor-east-door"],
    },
    {
      id: "wp-corridor-east-door",
      x: 6,
      z: -3.7,
      links: ["wp-corridor-kitchen", "wp-floor-east-door", "wp-corridor-lobby"],
    },
    { id: "wp-corridor-lobby", x: 9, z: -3.7, links: ["wp-corridor-east-door", "wp-lobby-door"] },

    // Open floor: a spine along the north edge, then one node per aisle end.
    { id: "wp-floor-west-door", x: -6, z: -1.6, links: ["wp-corridor-west-door", "wp-floor-north"] },
    {
      id: "wp-floor-north",
      x: 0,
      z: -1.6,
      links: ["wp-floor-west-door", "wp-floor-east-door", "wp-floor-aisle-north"],
    },
    { id: "wp-floor-east-door", x: 6, z: -1.6, links: ["wp-corridor-east-door", "wp-floor-north"] },

    { id: "wp-floor-aisle-north-west", x: -7.2, z: 2.5, links: ["wp-floor-aisle-north"] },
    {
      id: "wp-floor-aisle-north",
      x: 0,
      z: 2.5,
      links: [
        "wp-floor-north",
        "wp-floor-aisle-north-west",
        "wp-floor-aisle-north-east",
        "wp-floor-aisle-south",
      ],
    },
    { id: "wp-floor-aisle-north-east", x: 7.2, z: 2.5, links: ["wp-floor-aisle-north"] },

    { id: "wp-floor-aisle-south-west", x: -7.2, z: 6.5, links: ["wp-floor-aisle-south"] },
    {
      id: "wp-floor-aisle-south",
      x: 0,
      z: 6.5,
      links: [
        "wp-floor-aisle-north",
        "wp-floor-aisle-south-west",
        "wp-floor-aisle-south-east",
        "wp-floor-back",
      ],
    },
    { id: "wp-floor-aisle-south-east", x: 7.2, z: 6.5, links: ["wp-floor-aisle-south"] },

    { id: "wp-floor-back-west", x: -7.2, z: 10.5, links: ["wp-floor-back"] },
    {
      id: "wp-floor-back",
      x: 0,
      z: 10.5,
      links: ["wp-floor-aisle-south", "wp-floor-back-west", "wp-floor-back-east"],
    },
    { id: "wp-floor-back-east", x: 7.2, z: 10.5, links: ["wp-floor-back"] },
  ],
  // The aisle between the first two desk rows, facing north up the floor. Far
  // enough from the partition that the third-person camera gets its full boom,
  // so an arriving player sees the office rather than the inside of a wall.
  spawnPoints: [
    { x: 0, z: 2.5, yaw: 0 },
    { x: -3.6, z: 2.5, yaw: 0 },
    { x: 3.6, z: 2.5, yaw: 0 },
    { x: -7.2, z: 2.5, yaw: 0 },
    { x: 7.2, z: 2.5, yaw: 0 },
    { x: 0, z: 3, yaw: 0 },
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

/** The ground footprint a prop blocks. Derived exactly as a desk's is. */
export function propAabb(spec: PropSpec): Aabb2 {
  return deskAabb(spec);
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
  for (const spec of layout.props) {
    boxes.push(propAabb(spec));
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
 * Narrowest doorway an occupant can walk through.
 *
 * Exactly one diameter leaves no clearance at all, and the resolver stops a
 * hair short of each jamb, so a passable doorway needs more than that.
 */
const MIN_DOORWAY_WIDTH = OCCUPANT_RADIUS * 2 + 0.1;

/**
 * How far either side of a doorway's centre its two rooms are sampled.
 *
 * Clears the half-thickness of the wall line the doorway breaks plus an
 * occupant's radius, so the sample lands on floor a body could stand on.
 */
const DOORWAY_PROBE = MIN_OBSTACLE_THICKNESS / 2 + OCCUPANT_RADIUS;

/**
 * Checks the invariants the collision resolver and the navigation graph rely
 * on.
 *
 * Exported for the test suite rather than run at import time: a layout that
 * breaks one of these produces a wall players can walk through or a room no
 * agent can path to, both far cheaper to catch here than in a browser.
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
  for (const spec of layout.props) {
    const box = propAabb(spec);
    const thickness = Math.min(box.maxX - box.minX, box.maxZ - box.minZ);
    if (thickness < minThickness) {
      problems.push(`prop ${spec.id} is ${thickness} thick, below the ${MIN_OBSTACLE_THICKNESS} minimum`);
    }
  }

  const roomIds = new Set(layout.rooms.map((room) => room.id));
  for (const door of layout.doorways) {
    if (door.width < MIN_DOORWAY_WIDTH) {
      problems.push(`doorway ${door.id} is ${door.width} wide, below the ${MIN_DOORWAY_WIDTH} minimum`);
    }
    for (const id of door.connects) {
      if (!roomIds.has(id)) {
        problems.push(`doorway ${door.id} connects unknown room ${id}`);
      }
    }
    // The rooms either side of the gap, sampled across the wall line. A
    // doorway whose own data disagrees with the room bounds would send a path
    // through a wall.
    const offset = door.axis === "x" ? { x: 0, z: DOORWAY_PROBE } : { x: DOORWAY_PROBE, z: 0 };
    const sides = [
      roomAt(layout, { x: door.centre.x - offset.x, z: door.centre.z - offset.z })?.id,
      roomAt(layout, { x: door.centre.x + offset.x, z: door.centre.z + offset.z })?.id,
    ];
    for (const id of door.connects) {
      if (!sides.includes(id)) {
        problems.push(`doorway ${door.id} does not have room ${id} on either side of it`);
      }
    }
    if (overlapsObstacle(layout, door.centre)) {
      problems.push(`doorway ${door.id} is blocked by an obstacle`);
    }
  }

  problems.push(...describeWaypointProblems(layout));

  for (const point of layout.spawnPoints) {
    if (overlapsObstacle(layout, point)) {
      problems.push(`spawn point (${point.x}, ${point.z}) overlaps an obstacle`);
    }
  }
  return problems;
}

/**
 * Whether an occupant standing at a point would be inside any obstacle.
 *
 * Deliberately not `isBlocked` from the collision module: that module imports
 * this one, and the floor plan must not depend on the resolver that consumes
 * it. The two agree because both grow every box by the occupant radius.
 */
function overlapsObstacle(layout: OfficeLayout, point: Vec2): boolean {
  for (const box of collisionBoxes(layout)) {
    if (
      point.x > box.minX - OCCUPANT_RADIUS &&
      point.x < box.maxX + OCCUPANT_RADIUS &&
      point.z > box.minZ - OCCUPANT_RADIUS &&
      point.z < box.maxZ + OCCUPANT_RADIUS
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks the navigation graph on its own: ids resolve, links are mirrored, no
 * node stands inside geometry, every room holds a node, and the whole graph is
 * one connected component.
 *
 * Connectivity is the one that matters most to a caller: a path search over a
 * graph in two pieces returns no route between them, which reads as an agent
 * refusing to walk to a room rather than as a broken floor plan.
 */
function describeWaypointProblems(layout: OfficeLayout): string[] {
  const problems: string[] = [];
  const byId = new Map(layout.waypoints.map((node) => [node.id, node]));

  for (const node of layout.waypoints) {
    for (const link of node.links) {
      const other = byId.get(link);
      if (other === undefined) {
        problems.push(`waypoint ${node.id} links to unknown node ${link}`);
      } else if (!other.links.includes(node.id)) {
        problems.push(`waypoint link ${node.id} -> ${link} is not mirrored`);
      }
    }
    if (overlapsObstacle(layout, node)) {
      problems.push(`waypoint ${node.id} stands inside an obstacle`);
    }
  }

  for (const room of layout.rooms) {
    if (!layout.waypoints.some((node) => containsPoint(room.bounds, node))) {
      problems.push(`room ${room.id} holds no waypoint`);
    }
  }

  const first = layout.waypoints[0];
  if (first !== undefined) {
    const seen = new Set([first.id]);
    const queue = [first];
    while (queue.length > 0) {
      // Breadth-first from one node: a graph where every edge is mirrored is
      // connected exactly when this reaches all of them.
      const node = queue.shift();
      if (node === undefined) {
        continue;
      }
      for (const link of node.links) {
        const other = byId.get(link);
        if (other !== undefined && !seen.has(other.id)) {
          seen.add(other.id);
          queue.push(other);
        }
      }
    }
    for (const node of layout.waypoints) {
      if (!seen.has(node.id)) {
        problems.push(`waypoint ${node.id} is not reachable from ${first.id} through the link graph`);
      }
    }
  }

  return problems;
}
