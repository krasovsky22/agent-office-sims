/**
 * What hangs on the office's walls: framed pictures, posters, clocks, a
 * whiteboard or two and the conference room's TV.
 *
 * Kept apart from the floor plan because none of it is structure: nothing here
 * collides, nothing is interactive and the server never reads it. It is still
 * shared data rather than client code, so the checks that keep a picture off a
 * window or a board run in the same test suite as the floor plan's own.
 *
 * Every piece names the wall it hangs on and where along it, rather than a
 * world position: the face it hangs on, and which way it looks, are worked out
 * from that wall's footprint, so a wall that moves takes its pictures with it.
 */

import { OCCUPANT_RADIUS } from "./constants.js";
import {
  type Aabb3,
  type OfficeLayout,
  type WallSpec,
  LOBBY_ROOM_ID,
  LOUNGE_ROOM_ID,
  MANAGER_OFFICE_ROOM_ID,
  OPEN_FLOOR_ROOM_ID,
  containsPoint,
  roomAt,
} from "./layout.js";

/**
 * What a piece of decor is, which is how the client draws its frame.
 *
 * - `picture`: a framed print; `art` says which.
 * - `poster`: an unframed print pinned flat; `art` says which.
 * - `clock`: a round wall clock showing the office's own time of day.
 * - `whiteboard`: a whiteboard with the last meeting still on it.
 * - `tv`: a flat screen showing a slide.
 * - `shelf`: a floating shelf with books and a trophy stood on it; `height`
 *   is how tall its load stands.
 */
export type WallDecorKind = "picture" | "poster" | "clock" | "whiteboard" | "tv" | "shelf";

/** The artwork a picture or a poster shows. The client paints each one. */
export type WallArt =
  | "simPortrait"
  | "simsTeam"
  | "employeeOfMonth"
  | "plumbob"
  | "cityscape"
  | "landscape"
  | "abstract"
  | "posterShipIt"
  | "posterTeamwork"
  | "posterCoffee"
  | "certificate"
  | "officeSign";

/** One piece of wall decor, placed by the wall it hangs on. */
export interface WallDecorSpec {
  readonly id: string;
  readonly kind: WallDecorKind;
  /** Set on a picture or a poster, and only on those. */
  readonly art?: WallArt;
  /** Id of the {@link WallSpec} it hangs on. */
  readonly wall: string;
  /** The room it faces into, which picks which face of the wall it is on. */
  readonly roomId: string;
  /**
   * Centre of the piece along the wall: an X for a wall that runs east-west, a
   * Z for one that runs north-south.
   */
  readonly along: number;
  readonly width: number;
  readonly height: number;
  /** Height of the bottom edge above the floor. */
  readonly elevation: number;
}

/** Where a piece of decor ends up: the centre of the wall face behind it, and the way it looks. */
export interface WallDecorPlacement {
  readonly x: number;
  readonly z: number;
  /** The way the piece faces, in the layout's convention: 0 faces -Z. */
  readonly yaw: number;
}

/**
 * How far in front of a wall face the room is looked for. Past the thickest
 * piece of decor, short of anything but a wall.
 */
const FACE_PROBE = OCCUPANT_RADIUS;

/** Spacing of the points along a piece's width that are checked for a clear wall in front. */
const SPAN_PROBE_STEP = 0.2;

/** How far proud of its wall any piece of decor may stand, for the overlap checks. */
export const WALL_DECOR_DEPTH = 0.08;

function runsAlongX(spec: WallSpec): boolean {
  return spec.footprint.maxX - spec.footprint.minX >= spec.footprint.maxZ - spec.footprint.minZ;
}

/** The two faces of a wall at `along`, each with the way it looks. */
function facesOf(spec: WallSpec, along: number): readonly WallDecorPlacement[] {
  const { footprint } = spec;
  return runsAlongX(spec)
    ? [
        { x: along, z: footprint.minZ, yaw: 0 },
        { x: along, z: footprint.maxZ, yaw: Math.PI },
      ]
    : [
        { x: footprint.minX, z: along, yaw: Math.PI / 2 },
        { x: footprint.maxX, z: along, yaw: -Math.PI / 2 },
      ];
}

/** A point `distance` in front of a placement, and `offset` along it to its right. */
function inFrontOf(face: WallDecorPlacement, distance: number, offset = 0): { x: number; z: number } {
  const forwardX = -Math.sin(face.yaw);
  const forwardZ = -Math.cos(face.yaw);
  // Right of a face looking along (fx, fz) is (-fz, fx).
  return { x: face.x + forwardX * distance - forwardZ * offset, z: face.z + forwardZ * distance + forwardX * offset };
}

/**
 * Where a piece of decor hangs: on whichever face of its wall looks into its
 * room.
 *
 * @returns undefined for a wall that does not exist, or one with neither face
 * on that room.
 */
export function wallDecorPlacement(layout: OfficeLayout, spec: WallDecorSpec): WallDecorPlacement | undefined {
  const wall = layout.walls.find((candidate) => candidate.id === spec.wall);
  if (wall === undefined) {
    return undefined;
  }
  return facesOf(wall, spec.along).find((face) => roomAt(layout, inFrontOf(face, FACE_PROBE))?.id === spec.roomId);
}

/** The thin box a wall-mounted face occupies, for checking two of them do not overlap. */
function faceVolume(
  face: WallDecorPlacement,
  size: { readonly width: number; readonly bottom: number; readonly top: number },
): Aabb3 {
  const left = inFrontOf(face, 0, -size.width / 2);
  const right = inFrontOf(face, WALL_DECOR_DEPTH, size.width / 2);
  return {
    minX: Math.min(left.x, right.x),
    minY: size.bottom,
    minZ: Math.min(left.z, right.z),
    maxX: Math.max(left.x, right.x),
    maxY: size.top,
    maxZ: Math.max(left.z, right.z),
  };
}

function volumesOverlap(a: Aabb3, b: Aabb3): boolean {
  return (
    a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY && a.minZ < b.maxZ && b.minZ < a.maxZ
  );
}

/** How far a lift's frame and indicator reach past its opening, on every side. */
const LIFT_SURROUND = 0.5;

/**
 * Checks that every piece of decor hangs whole on a plain wall, inside one
 * room, clear of the boards, the lifts and every other piece.
 *
 * Decor is placed by hand, so the mistakes to catch are one hung over a window
 * or a doorway, one that runs round a corner into the next room, one hung over
 * a board or another picture, and one taller than the wall.
 */
export function describeDecorProblems(layout: OfficeLayout, decor: readonly WallDecorSpec[]): string[] {
  const problems: string[] = [];
  const mounted: { readonly id: string; readonly volume: Aabb3 }[] = [
    ...layout.boards.map((board) => ({
      id: `board ${board.id}`,
      volume: faceVolume(board, { width: board.width, bottom: board.elevation, top: board.elevation + board.height }),
    })),
    ...layout.lifts.map((lift) => ({
      id: `lift ${lift.id}`,
      volume: faceVolume(lift, { width: lift.width + LIFT_SURROUND * 2, bottom: 0, top: lift.height + LIFT_SURROUND }),
    })),
  ];
  const ids = new Set<string>();

  for (const spec of decor) {
    const name = `decor ${spec.id}`;
    if (ids.has(spec.id)) {
      problems.push(`${name} uses an id twice`);
    }
    ids.add(spec.id);
    if (spec.width <= 0 || spec.height <= 0 || spec.elevation < 0) {
      problems.push(`${name} has a non-positive size or a negative elevation`);
    }
    if ((spec.kind === "picture" || spec.kind === "poster") !== (spec.art !== undefined)) {
      problems.push(`${name} is a ${spec.kind} ${spec.art === undefined ? "with no" : "with"} art`);
    }

    const wall = layout.walls.find((candidate) => candidate.id === spec.wall);
    if (wall === undefined) {
      problems.push(`${name} hangs on unknown wall ${spec.wall}`);
      continue;
    }
    if (wall.style !== undefined) {
      problems.push(`${name} hangs on ${wall.style} wall ${wall.id}`);
    }
    if (spec.elevation + spec.height > wall.height) {
      problems.push(`${name} reaches above the top of wall ${wall.id}`);
    }
    const [start, end] = runsAlongX(wall)
      ? [wall.footprint.minX, wall.footprint.maxX]
      : [wall.footprint.minZ, wall.footprint.maxZ];
    if (spec.along - spec.width / 2 < start || spec.along + spec.width / 2 > end) {
      problems.push(`${name} runs off the end of wall ${wall.id}`);
    }

    const face = wallDecorPlacement(layout, spec);
    if (face === undefined) {
      problems.push(`${name} has no face of wall ${wall.id} looking into room ${spec.roomId}`);
      continue;
    }
    // Across its whole width, so a piece cannot run round a corner, over the
    // end of a partition or into the next room.
    const steps = Math.max(1, Math.ceil(spec.width / SPAN_PROBE_STEP));
    for (let step = 0; step <= steps; step += 1) {
      const offset = -spec.width / 2 + (spec.width * step) / steps;
      const point = inFrontOf(face, FACE_PROBE, offset);
      if (roomAt(layout, point)?.id !== spec.roomId || layout.walls.some((other) => containsPoint(other.footprint, point))) {
        problems.push(`${name} does not hang wholly against wall ${wall.id} in room ${spec.roomId}`);
        break;
      }
    }

    const volume = faceVolume(face, { width: spec.width, bottom: spec.elevation, top: spec.elevation + spec.height });
    for (const other of mounted) {
      if (volumesOverlap(volume, other.volume)) {
        problems.push(`${name} overlaps ${other.id}`);
      }
    }
    mounted.push({ id: name, volume });
  }
  return problems;
}

const CONFERENCE_ROOM_ID = "meeting-room";
const KITCHEN_ROOM_ID = "kitchen";
const CEO_OFFICE_ROOM_ID = "ceo-office";

/** Eye height for the bottom of an ordinary framed picture. */
const PICTURE_ELEVATION = 1.3;
/** A clock hangs above everything else, where it can be read across a room. */
const CLOCK_ELEVATION = 2.05;
const CLOCK_SIZE = 0.45;

function picture(
  id: string,
  art: WallArt,
  wall: string,
  roomId: string,
  along: number,
  size: { readonly width: number; readonly height: number },
  elevation = PICTURE_ELEVATION,
): WallDecorSpec {
  return { id, kind: "picture", art, wall, roomId, along, ...size, elevation };
}

function poster(id: string, art: WallArt, wall: string, roomId: string, along: number): WallDecorSpec {
  return { id, kind: "poster", art, wall, roomId, along, width: 0.7, height: 1, elevation: 1.15 };
}

function clock(id: string, wall: string, roomId: string, along: number, elevation = CLOCK_ELEVATION): WallDecorSpec {
  return { id, kind: "clock", wall, roomId, along, width: CLOCK_SIZE, height: CLOCK_SIZE, elevation };
}

const WIDE = { width: 1.4, height: 0.9 } as const;
const TALL = { width: 0.9, height: 1.1 } as const;
const LARGE = { width: 1.6, height: 1 } as const;
const CERTIFICATE = { width: 0.55, height: 0.42 } as const;

/**
 * The shipped office's walls, room by room.
 *
 * Kept off the glass, the boards, the lifts and the doorways, and high enough
 * to clear the furniture backed onto the same wall: a picture is hung over the
 * kitchen counter, never behind the coffee machine.
 */
export const OFFICE_DECOR: readonly WallDecorSpec[] = [
  // Open floor: down its east wall and along its back wall, facing the desks.
  poster("decor-floor-ship-it", "posterShipIt", "wall-meeting-west-south", OPEN_FLOOR_ROOM_ID, -1.6),
  clock("decor-floor-clock", "wall-meeting-west-south", OPEN_FLOOR_ROOM_ID, 0.5),
  picture("decor-floor-team", "simsTeam", "wall-meeting-west-south", OPEN_FLOOR_ROOM_ID, 2.6, { width: 1.2, height: 0.8 }),
  picture("decor-floor-city", "cityscape", "wall-lobby-east", OPEN_FLOOR_ROOM_ID, -8.2, WIDE),
  picture("decor-floor-employee", "employeeOfMonth", "wall-lobby-east", OPEN_FLOOR_ROOM_ID, -4.9, TALL),
  poster("decor-floor-teamwork", "posterTeamwork", "wall-lobby-east", OPEN_FLOOR_ROOM_ID, -1.4),
  picture("decor-floor-portrait", "simPortrait", "wall-lobby-east", OPEN_FLOOR_ROOM_ID, 1.9, TALL),

  // Lounge: over the sofa end, and beside the pull requests board.
  picture("decor-lounge-abstract", "abstract", "wall-north", LOUNGE_ROOM_ID, -9.2, LARGE),
  picture("decor-lounge-landscape", "landscape", "wall-ceo-west", LOUNGE_ROOM_ID, -6.1, { width: 1, height: 0.7 }, 1.4),

  // The CEO's office: the plumbob on the back wall, behind the CEO's chair.
  picture("decor-ceo-plumbob", "plumbob", "wall-north", CEO_OFFICE_ROOM_ID, -5.1, { width: 1.2, height: 1.2 }, 1.2),
  picture("decor-ceo-city", "cityscape", "wall-ceo-west", CEO_OFFICE_ROOM_ID, -8.5, WIDE),
  clock("decor-ceo-clock", "wall-ceo-east", CEO_OFFICE_ROOM_ID, -8.5),

  // The AI manager's office. Behind its desk, the wall whoever comes in to
  // see it faces: a shelf of books and a trophy with a picture over it,
  // between two framed certificates, and a whiteboard on the side wall.
  {
    id: "decor-manager-shelf",
    kind: "shelf",
    wall: "wall-north",
    roomId: MANAGER_OFFICE_ROOM_ID,
    along: 1.225,
    width: 1.6,
    height: 0.4,
    elevation: 1.45,
  },
  picture("decor-manager-plumbob", "plumbob", "wall-north", MANAGER_OFFICE_ROOM_ID, 1.225, { width: 0.8, height: 0.7 }, 2.0),
  picture("decor-manager-certificate-west", "certificate", "wall-north", MANAGER_OFFICE_ROOM_ID, -0.15, CERTIFICATE, 1.4),
  picture("decor-manager-certificate-east", "certificate", "wall-north", MANAGER_OFFICE_ROOM_ID, 2.6, CERTIFICATE, 1.4),
  {
    id: "decor-manager-whiteboard",
    kind: "whiteboard",
    wall: "wall-ceo-east",
    roomId: MANAGER_OFFICE_ROOM_ID,
    along: -8.2,
    width: 2.2,
    height: 1.2,
    elevation: 0.9,
  },
  picture("decor-manager-portrait", "simPortrait", "wall-meeting-west-north", MANAGER_OFFICE_ROOM_ID, -8.5, TALL),

  // Conference room: the TV over the sideboard at the south end of the
  // table, a whiteboard at the north end, and the long west wall.
  {
    id: "decor-meeting-tv",
    kind: "tv",
    wall: "wall-meeting-south",
    roomId: CONFERENCE_ROOM_ID,
    along: 8,
    width: 2.2,
    height: 1.25,
    elevation: 1.15,
  },
  {
    id: "decor-meeting-whiteboard",
    kind: "whiteboard",
    wall: "wall-north",
    roomId: CONFERENCE_ROOM_ID,
    along: 8,
    width: 2.4,
    height: 1.2,
    elevation: 0.9,
  },
  picture("decor-meeting-team", "simsTeam", "wall-meeting-west-north", CONFERENCE_ROOM_ID, -6.2, LARGE),
  clock("decor-meeting-clock", "wall-meeting-west-north", CONFERENCE_ROOM_ID, -9.8),

  // Kitchen: a clock over the counter, a poster by the coffee and a picture
  // by the table.
  clock("decor-kitchen-clock", "wall-meeting-south", KITCHEN_ROOM_ID, 9.2, 1.9),
  poster("decor-kitchen-coffee", "posterCoffee", "wall-meeting-west-south", KITCHEN_ROOM_ID, 2.8),
  picture("decor-kitchen-landscape", "landscape", "wall-lobby-east", KITCHEN_ROOM_ID, 8.6, WIDE),

  // Lobby: the office's name over reception, and a gallery down the hall.
  picture("decor-lobby-sign", "officeSign", "wall-reception", LOBBY_ROOM_ID, 9.25, { width: 1.8, height: 0.5 }, 1.6),
  picture("decor-lobby-city", "cityscape", "wall-south", LOBBY_ROOM_ID, -9.5, WIDE),
  picture("decor-lobby-abstract", "abstract", "wall-south", LOBBY_ROOM_ID, -6.2, TALL),
  picture("decor-lobby-team", "simsTeam", "wall-south", LOBBY_ROOM_ID, -2.5, LARGE),
  picture("decor-lobby-landscape", "landscape", "wall-south", LOBBY_ROOM_ID, 1.5, WIDE),
  picture("decor-lobby-plumbob", "plumbob", "wall-south", LOBBY_ROOM_ID, 5, TALL),
  picture("decor-lobby-portrait", "simPortrait", "wall-lobby-east", LOBBY_ROOM_ID, -1.8, TALL),
  picture("decor-lobby-employee", "employeeOfMonth", "wall-lobby-east", LOBBY_ROOM_ID, 3, TALL),
];
