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
  INTERACT_RANGE,
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

/**
 * An axis-aligned box in the world, for the few things that are not simply
 * standing on the floor. A fixture hung on a wall at chest height needs one,
 * since a footprint alone would not say where to draw it.
 */
export interface Aabb3 {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** A point on the ground plane. */
export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

/**
 * How a wall is drawn. Every style blocks exactly its footprint; the style only
 * changes what you see of it.
 *
 * - `window`: a sill, a run of glass and a header, so the street outside shows
 *   through it.
 * - `railing`: a waist-high rail on posts, for the kerb edge of the pavement,
 *   which you can see over but not cross.
 */
export type WallStyle = "window" | "railing";

/** A wall segment. Its footprint is already axis-aligned. */
export interface WallSpec {
  readonly id: string;
  readonly footprint: Aabb2;
  readonly height: number;
  /** Absent for a plain solid wall. */
  readonly style?: WallStyle;
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
export type PropKind = "coffee" | "cabinet" | "table" | "diningChair" | "reception";

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

/** What a piece of tabletop set dressing is. */
export type TabletopKind = "microwave";

/**
 * Set dressing stood on top of a prop rather than on the floor.
 *
 * Nothing collides with it, because the prop it stands on already does; that
 * is why it is not a {@link PropSpec}. It is positioned like one, by the centre
 * of its footprint and a yaw, and `on` names the prop whose top it sits on, so
 * the renderer lifts it to that prop's height instead of trusting a number of
 * its own.
 */
export interface TabletopSpec {
  readonly id: string;
  readonly kind: TabletopKind;
  /** Id of the {@link PropSpec} it stands on. */
  readonly on: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
}

/**
 * A display hung flat against a wall: something to read, not to walk around.
 *
 * Nothing collides with a board, because the wall it hangs on already does. It
 * is positioned by the centre of its face, on the wall's surface, and `yaw` is
 * the direction that face looks, in the same convention as everything else: 0
 * faces -Z. What it shows is not part of the floor plan; `id` is what the
 * client matches a feed to.
 */
export interface WallBoardSpec {
  readonly id: string;
  /** The room the board faces into, which is where it is read from. */
  readonly roomId: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly width: number;
  readonly height: number;
  /** Height of the board's bottom edge above the floor. */
  readonly elevation: number;
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
 * What live agents path through: `nav.ts` routes over these nodes and the
 * server's agent steering walks each link. Every room and every doorway holds
 * at least one node, and the graph is connected, so a path exists between any
 * two nodes.
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

/** What sort of thing an interactable is. */
export const INTERACTION_KIND = {
  seat: "seat",
  coffee: "coffee",
  board: "board",
  manager: "manager",
  screen: "screen",
} as const;

export type InteractionKind = (typeof INTERACTION_KIND)[keyof typeof INTERACTION_KIND];

/**
 * Something in the office an occupant can walk up to and use.
 *
 * This is world data and nothing more: what the interaction *does* — how long it
 * holds you, which animation it puts you in, what the prompt reads — is a rule,
 * and rules live in `interaction.ts`. Keeping the two apart is what lets the
 * client show a prompt and the server authorise the same interaction from one
 * description.
 */
export interface InteractableSpec {
  readonly id: string;
  readonly kind: InteractionKind;
  /** The pose an occupant takes while using it: where to stand, and facing. */
  readonly anchor: SpawnSpec;
  /**
   * Box the client draws, or `undefined` when something else already shows it
   * — a desk's chair or the coffee machine's prop.
   */
  readonly volume: Aabb3 | undefined;
  /**
   * Where an occupant is let go when the hold ends, or `undefined` to leave
   * them standing at the anchor.
   *
   * A seat needs one because its anchor is inside the chair, which is solid:
   * someone getting up has to be put down outside the chair's footprint, not
   * left inside it for the resolver to argue with.
   */
  readonly exit: Vec2 | undefined;
  /**
   * The desk a seat belongs to, or `undefined` for anything that is not a
   * seat. It is how the manager's chair is found from its desk.
   */
  readonly deskId: string | undefined;
  /**
   * The seat whose workstation a screen belongs to, or `undefined` for anything
   * that is not a screen. It is how a screen knows who is working at it.
   */
  readonly seatId: string | undefined;
}

/**
 * The office chair every workstation is furnished with, in metres.
 *
 * Measured in the chair's own frame, which faces -Z like everything else in the
 * layout, so its backrest is on the +Z side. The renderer stretches the chair
 * model to exactly `width` x `depth` x `height`, the collision world blocks
 * exactly `width` x `depth`, and a seated body is lifted to `seatHeight` and
 * set back against `backrestOffset`. Those four agree because they all read this
 * one record; `propKit.test.ts` measures the vendored model against it.
 */
export interface ChairSpec {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** Height of the top of the seat cushion above the floor. */
  readonly seatHeight: number;
  /** Distance from the chair's centre back to the front face of its backrest. */
  readonly backrestOffset: number;
}

export const DESK_CHAIR: ChairSpec = {
  width: 0.67,
  depth: 0.63,
  height: 1.215,
  seatHeight: 0.467,
  backrestOffset: 0.19,
};

/**
 * One place to sit at a desk: where along the desk it is, and the pose of the
 * occupant sitting there.
 */
export interface Workstation {
  /** Offset along the desk's own width, so a screen can be put in front of it. */
  readonly localX: number;
  /** The pose of the occupant sitting there, which is also where the chair stands. */
  readonly seat: SpawnSpec;
  /** The ground the chair blocks. */
  readonly chair: Aabb2;
  /** Where someone getting up from the chair is stood, just behind it. */
  readonly exit: Vec2;
}

/** One lane of the street, and which way its traffic drives. */
export interface StreetLaneSpec {
  /** Centre line of the lane. The street runs north-south, so a lane is a line of constant X. */
  readonly x: number;
  /** `1` for traffic driving south (+Z), `-1` for north. */
  readonly direction: 1 | -1;
}

/**
 * The street the office's front faces: everything past the pavement's kerb.
 *
 * It is scenery. Nobody walks on the road, so none of it collides and the
 * server never reads it; it is here, rather than in the client, so the road is
 * drawn against the same kerb the pavement's railing stands on. The pavement
 * itself is floor, a room with walls like any other.
 */
export interface StreetSpec {
  /** The carriageway, kerb to kerb; its Z extent is how far up and down the street is drawn. */
  readonly road: Aabb2;
  readonly lanes: readonly StreetLaneSpec[];
  /** Centre of the pedestrian crossing, and the traffic lights, across the road. */
  readonly crossingZ: number;
  /** Where the fronts of the buildings across the street stand, a pavement's width back from the far kerb. */
  readonly farFrontX: number;
}

export interface OfficeLayout {
  readonly name: string;
  /** Outer extent of the floor slab, walls included. */
  readonly floor: Aabb2;
  readonly walls: readonly WallSpec[];
  readonly desks: readonly DeskSpec[];
  readonly props: readonly PropSpec[];
  readonly tabletop: readonly TabletopSpec[];
  readonly boards: readonly WallBoardSpec[];
  readonly rooms: readonly RoomSpec[];
  readonly doorways: readonly DoorwaySpec[];
  readonly waypoints: readonly WaypointSpec[];
  /** Cycled through in arrival order so occupants do not stack up. */
  readonly spawnPoints: readonly SpawnSpec[];
  /**
   * Interactables placed by hand. Desk seats and screens and the coffee
   * machine are not listed here: they are derived from the desk and the prop
   * they belong to, so neither can be moved and leave its interactable behind.
   * {@link interactables} returns all of them.
   */
  readonly fixtures: readonly InteractableSpec[];
  /** The street outside, or `undefined` for a floor with no outside. */
  readonly street: StreetSpec | undefined;
}

const WALL_HEIGHT = 3;

/** Height of the railing along the kerb: waist high, so the street is seen over it. */
const RAILING_HEIGHT = 1.05;
const DESK_HEIGHT = 0.75;

/** Quarter turn, the only yaw granularity the shipped layout uses. */
const QUARTER_TURN = Math.PI / 2;

/** One base cabinet of a kitchen counter, in its own frame: its front faces -Z. */
const KITCHEN_CABINET = { width: 0.75, depth: 0.6, height: 0.9 } as const;

/** The chairs round the kitchen table: lighter than a desk chair, and solid all the same. */
const DINING_CHAIR = { width: 0.45, depth: 0.45, height: 0.9 } as const;

/** Floor space allowed per seat along a desk's width. */
const SEAT_PITCH = 1.6;

/**
 * Gap between the edge of a desk and the centre of the occupant sitting at it.
 *
 * Comfortably more than {@link OCCUPANT_RADIUS}, so a seat is never a position
 * the collision resolver would have refused to put someone in. The layout
 * invariant check enforces that rather than trusting this number.
 */
const CHAIR_GAP = 0.55;

/** Gap between the front of a prop and the occupant standing at it. */
const STANDING_GAP = 0.5;

/** Gap between a wall board and the occupant standing to read it. */
const READING_GAP = 1;

/** The pavement outside the main entrance, the one room that is outdoors. */
export const SIDEWALK_ROOM_ID = "sidewalk";

/** The room the desk rows stand in, where the live agents work. */
export const OPEN_FLOOR_ROOM_ID = "open-floor";

/** The open floor's wall board that shows this repository's own GitHub issues and pull requests. */
export const PROJECT_BOARD_ID = "project-board";

/**
 * The open floor's sticker board of issues an agent can pick up, one sticky
 * note each; an agent starting one walks here and takes its note.
 */
export const ISSUES_STICKER_BOARD_ID = "issues-sticker-board";

/** The sticker board an agent pins an issue's note on once it has handed in its pull request. */
export const PULL_REQUESTS_STICKER_BOARD_ID = "pull-requests-sticker-board";

/** The AI manager's desk in the lobby, where it sits for good. */
export const MANAGER_DESK_ID = "desk-manager";

/** The spot across the manager's desk where the CEO stands to talk to it. */
export const MANAGER_INTERACTABLE_ID = "manager-desk";

/**
 * Gap between the back of a chair and the occupant who just got up from it.
 *
 * A margin on top of {@link OCCUPANT_RADIUS}, so the stand-up spot is clear of
 * the chair by more than the resolver's own contact tolerance.
 */
const STAND_UP_GAP = 0.05;

function rect(minX: number, minZ: number, maxX: number, maxZ: number): Aabb2 {
  return { minX, minZ, maxX, maxZ };
}

function wall(id: string, minX: number, minZ: number, maxX: number, maxZ: number): WallSpec {
  return { id, footprint: rect(minX, minZ, maxX, maxZ), height: WALL_HEIGHT };
}

/** A shell wall glazed onto the street. */
function windowWall(id: string, minX: number, minZ: number, maxX: number, maxZ: number): WallSpec {
  return { ...wall(id, minX, minZ, maxX, maxZ), style: "window" };
}

/** A waist-high railing, the pavement's edge. */
function railing(id: string, minX: number, minZ: number, maxX: number, maxZ: number): WallSpec {
  return { id, footprint: rect(minX, minZ, maxX, maxZ), height: RAILING_HEIGHT, style: "railing" };
}

function desk(id: string, x: number, z: number, yaw: number, width = 1.6, depth = 0.8): DeskSpec {
  return { id, x, z, yaw, width, depth, height: DESK_HEIGHT };
}

function prop(
  id: string,
  kind: PropKind,
  x: number,
  z: number,
  yaw: number,
  size: { readonly width: number; readonly depth: number; readonly height: number },
): PropSpec {
  return { id, kind, x, z, yaw, width: size.width, depth: size.depth, height: size.height };
}

/**
 * A straight run of base cabinets, side by side along their own width.
 *
 * Generated for the same reason a desk row is: cabinets placed one by one are
 * cabinets that end up with a gap or an overlap between two of them. `first` is
 * the centre of the first cabinet and the run continues along the cabinets' own
 * width, so the whole run faces one way and its fronts stay flush.
 */
function counterRun(prefix: string, first: Vec2, yaw: number, count: number): PropSpec[] {
  return Array.from({ length: count }, (_, index) => {
    const centre = localToWorld(first, yaw, index * KITCHEN_CABINET.width, 0);
    return prop(`${prefix}-${index + 1}`, "cabinet", centre.x, centre.z, yaw, KITCHEN_CABINET);
  });
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
 * The prototype office floor: one storey, six named rooms, and the pavement
 * outside its front door.
 *
 * Reading from the north wall south:
 *
 * - A band of enclosed rooms, `z` from -11.7 to -5: the CEO's corner office in
 *   the north-west, then the meeting room, then the kitchen, then the entrance
 *   lobby in the north-east. Each is divided from the next by a solid wall and
 *   opens south onto the corridor through a doorway; the lobby's opening is the
 *   full width of the room, since that is the way in, and the AI manager's
 *   desk faces it.
 * - An east-west corridor, `z` from -4.7 to -2.7, running the whole width of
 *   the building and serving every door in that band.
 * - The open floor, `z` from -2.4 south, holding three rows of desks that all
 *   face the project board on its north partition. That partition separates
 *   it from the corridor, broken by two doorways so the walk from a desk to a
 *   meeting is short from either end of the room.
 *
 * - The street front, on the east: the shell's east wall is glass from end to
 *   end bar the main entrance, which opens from the pavement into the lobby
 *   with the reception counter facing it from across the room. The pavement
 *   runs the length of the building between the glass and a railing along the
 *   kerb; past the kerb is the {@link StreetSpec | street}, which is scenery.
 *
 * Every interior doorway is 1.4m clear, which is twice an occupant's diameter: wide
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
    // The street front, glazed either side of the main entrance into the lobby.
    windowWall("wall-east-north", 11.7, -12, 12, -7.5),
    windowWall("wall-east-south", 11.7, -5.7, 12, 12),

    // The pavement outside: a railing along the kerb and across each end,
    // where the neighbouring buildings' fronts begin.
    railing("railing-kerb", 15.5, -12.3, 15.8, 12.3),
    railing("railing-north", 12, -12.3, 15.5, -12),
    railing("railing-south", 12, 12, 15.5, 12.3),

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
    // Open floor. Every desk here faces north, so everyone sitting at one looks
    // at the project board on the partition. Each chair backs onto the aisle
    // south of its row, which is also where its occupant stands up.
    ...deskRow("desk-north", 0.5, 0, DESK_ROW_XS),
    ...deskRow("desk-middle", 4.5, 0, DESK_ROW_XS),
    ...deskRow("desk-south", 8.5, 0, DESK_ROW_XS),

    // One more desk at each end of the aisle between the middle and south rows,
    // outboard of the rows and facing the board like them. The chair stays
    // clear of the south row's end desk, so its occupant can still walk out.
    desk("desk-west-wall", -10.4, 6.5, 0),
    desk("desk-east-wall", 10.4, 6.5, 0),

    // Private rooms.
    desk("desk-ceo", -9, -8.5, 0, 2.2, 0.9),
    desk("table-meeting", -2.85, -8.5, 0, 3.2, 1.4),

    // The AI manager's, in the lobby: turned to face the way in, so whoever
    // arrives from the corridor walks straight up to it.
    desk(MANAGER_DESK_ID, 9, -9.2, Math.PI),
  ],
  props: [
    // Against the kitchen's north wall, facing south into the room and straight
    // down the walk from the door, with room to stand in front of it.
    {
      id: "coffee-machine",
      kind: "coffee",
      x: 3.15,
      z: -11.1,
      yaw: Math.PI,
      width: 0.9,
      depth: 0.7,
      height: 1.5,
    },

    // The kitchen counter: an L of base cabinets in the north-west corner,
    // backed onto the north wall west of the coffee machine and then down the
    // west wall, both legs facing into the room. The door-to-machine walk runs
    // east of all of it.
    ...counterRun("kitchen-cabinet-north", { x: 2.175, z: -11.4 }, Math.PI, 3),
    ...counterRun("kitchen-cabinet-west", { x: 0.6, z: -10.725 }, -QUARTER_TURN, 3),

    // A table for four in the kitchen's east half, a clear body's width east
    // of the walk from the door to the coffee machine.
    prop("kitchen-table", "table", 4.9, -8, 0, { width: 1.2, depth: 0.8, height: 0.75 }),
    prop("kitchen-chair-1", "diningChair", 4.6, -8.65, Math.PI, DINING_CHAIR),
    prop("kitchen-chair-2", "diningChair", 5.2, -8.65, Math.PI, DINING_CHAIR),
    prop("kitchen-chair-3", "diningChair", 4.6, -7.35, 0, DINING_CHAIR),
    prop("kitchen-chair-4", "diningChair", 5.2, -7.35, 0, DINING_CHAIR),

    // Reception, against the lobby's west wall and turned to face the main
    // entrance across the room: the first thing anyone coming in off the
    // street sees. Clear of the lobby's opening onto the corridor, so the walk
    // from the door to the rest of the office passes in front of it.
    prop("reception-desk", "reception", 7, -6.75, -QUARTER_TURN, { width: 1.8, depth: 0.6, height: 1.05 }),
  ],
  tabletop: [
    // On the middle of the counter's north leg, pushed back against the wall.
    {
      id: "kitchen-microwave",
      kind: "microwave",
      on: "kitchen-cabinet-north-2",
      x: 1.425,
      z: -11.45,
      yaw: Math.PI,
      width: 0.55,
      depth: 0.4,
      height: 0.33,
    },
  ],
  boards: [
    // The open floor's partition, between its two doorways and facing south
    // down the desk rows: every open-floor seat looks north at it, and an
    // arriving player spawns facing it. As wide as the partition allows with a
    // clear metre either side to the door frames, so it reads from the back row.
    {
      id: PROJECT_BOARD_ID,
      roomId: "open-floor",
      x: 0,
      z: -2.4,
      yaw: Math.PI,
      width: 8.4,
      height: 2.6,
      elevation: 0.3,
    },
    // The two sticker boards, one on each partition stretch outside the
    // doorways, so issues are picked up at the west end of the floor and the
    // pull requests pinned at the east. Kept clear of the door frames and of the
    // open floor's plant in its north-east corner, with the reading spot in
    // front of each a clear walk from the doorway's waypoint.
    {
      id: ISSUES_STICKER_BOARD_ID,
      roomId: "open-floor",
      x: -8.9,
      z: -2.4,
      yaw: Math.PI,
      width: 3.6,
      height: 2.1,
      elevation: 0.45,
    },
    {
      id: PULL_REQUESTS_STICKER_BOARD_ID,
      roomId: "open-floor",
      x: 8.9,
      z: -2.4,
      yaw: Math.PI,
      width: 3.6,
      height: 2.1,
      elevation: 0.45,
    },
  ],
  rooms: [
    { id: "ceo-office", name: "CEO Office", bounds: rect(-11.7, -11.7, -6, -5) },
    { id: "meeting-room", name: "Meeting Room", bounds: rect(-5.7, -11.7, 0, -5) },
    { id: "kitchen", name: "Kitchen", bounds: rect(0.3, -11.7, 6, -5) },
    { id: "lobby", name: "Lobby", bounds: rect(6.3, -11.7, 11.7, -5) },
    { id: "corridor", name: "Corridor", bounds: rect(-11.7, -4.7, 11.7, -2.7) },
    { id: "open-floor", name: "Open Floor", bounds: rect(-11.7, -2.4, 11.7, 11.7) },
    { id: SIDEWALK_ROOM_ID, name: "Sidewalk", bounds: rect(12, -12, 15.5, 12) },
  ],
  doorways: [
    { id: "door-ceo", centre: { x: -8.7, z: -4.85 }, width: 1.4, axis: "x", connects: ["ceo-office", "corridor"] },
    { id: "door-meeting", centre: { x: -2.85, z: -4.85 }, width: 1.4, axis: "x", connects: ["meeting-room", "corridor"] },
    { id: "door-kitchen", centre: { x: 3.15, z: -4.85 }, width: 1.4, axis: "x", connects: ["kitchen", "corridor"] },
    { id: "door-lobby", centre: { x: 9, z: -4.85 }, width: 5.4, axis: "x", connects: ["lobby", "corridor"] },
    { id: "door-floor-west", centre: { x: -6, z: -2.55 }, width: 1.4, axis: "x", connects: ["corridor", "open-floor"] },
    { id: "door-floor-east", centre: { x: 6, z: -2.55 }, width: 1.4, axis: "x", connects: ["corridor", "open-floor"] },
    { id: "door-entrance", centre: { x: 11.85, z: -6.6 }, width: 1.8, axis: "z", connects: ["lobby", SIDEWALK_ROOM_ID] },
  ],
  // Every link is axis-aligned and clear of the geometry, so a body can follow
  // one by walking straight at the next node.
  waypoints: [
    // CEO office.
    { id: "wp-ceo-desk", x: -8.7, z: -6.8, links: ["wp-ceo-door"] },
    { id: "wp-ceo-door", x: -8.7, z: -4.85, links: ["wp-ceo-desk", "wp-corridor-ceo"] },

    // Meeting room.
    { id: "wp-meeting-table", x: -2.85, z: -6.4, links: ["wp-meeting-door", "wp-meeting-east"] },
    { id: "wp-meeting-door", x: -2.85, z: -4.85, links: ["wp-meeting-table", "wp-corridor-meeting"] },
    // Round the table's east end to the far wall, which the table hides from
    // the door.
    { id: "wp-meeting-east", x: -0.6, z: -6.4, links: ["wp-meeting-table", "wp-meeting-north"] },
    { id: "wp-meeting-north", x: -0.6, z: -10.7, links: ["wp-meeting-east"] },

    // Kitchen.
    { id: "wp-kitchen-coffee", x: 3.15, z: -10, links: ["wp-kitchen-door"] },
    { id: "wp-kitchen-door", x: 3.15, z: -4.85, links: ["wp-kitchen-coffee", "wp-corridor-kitchen"] },

    // Lobby, and round the east end of the manager's desk to its chair.
    { id: "wp-lobby-centre", x: 9, z: -8, links: ["wp-lobby-door", "wp-lobby-east"] },
    { id: "wp-lobby-door", x: 9, z: -4.85, links: ["wp-lobby-centre", "wp-corridor-lobby"] },
    {
      id: "wp-lobby-east",
      x: 10.8,
      z: -8,
      links: ["wp-lobby-centre", "wp-lobby-desk-back", "wp-lobby-entrance"],
    },
    { id: "wp-lobby-desk-back", x: 10.8, z: -10.9, links: ["wp-lobby-east"] },

    // In through the main entrance from the pavement, and up and down it.
    { id: "wp-lobby-entrance", x: 10.8, z: -6.6, links: ["wp-lobby-east", "wp-entrance-door"] },
    { id: "wp-entrance-door", x: 11.85, z: -6.6, links: ["wp-lobby-entrance", "wp-sidewalk-door"] },
    {
      id: "wp-sidewalk-door",
      x: 13.7,
      z: -6.6,
      links: ["wp-entrance-door", "wp-sidewalk-north", "wp-sidewalk-south"],
    },
    { id: "wp-sidewalk-north", x: 13.7, z: -10.8, links: ["wp-sidewalk-door"] },
    { id: "wp-sidewalk-south", x: 13.7, z: 10.8, links: ["wp-sidewalk-door"] },

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
    {
      id: "wp-floor-west-door",
      x: -6,
      z: -1.6,
      links: ["wp-corridor-west-door", "wp-floor-north", "wp-floor-north-west"],
    },
    {
      id: "wp-floor-north",
      x: 0,
      z: -1.6,
      links: ["wp-floor-west-door", "wp-floor-east-door", "wp-floor-aisle-north"],
    },
    { id: "wp-floor-east-door", x: 6, z: -1.6, links: ["wp-corridor-east-door", "wp-floor-north", "wp-floor-north-east"] },

    // In front of each sticker board, and down the aisle end beside it to the
    // desk rows, so an agent fetching or pinning a note walks straight between
    // the board and its desk rather than round through the middle of the floor.
    { id: "wp-floor-north-west", x: -7.2, z: -1.6, links: ["wp-floor-west-door", "wp-floor-aisle-north-west"] },
    { id: "wp-floor-north-east", x: 7.2, z: -1.6, links: ["wp-floor-east-door", "wp-floor-aisle-north-east"] },

    { id: "wp-floor-aisle-north-west", x: -7.2, z: 2.5, links: ["wp-floor-aisle-north", "wp-floor-north-west"] },
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
    { id: "wp-floor-aisle-north-east", x: 7.2, z: 2.5, links: ["wp-floor-aisle-north", "wp-floor-north-east"] },

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

    { id: "wp-floor-back-west", x: -7.2, z: 10.5, links: ["wp-floor-back", "wp-floor-back-west-wall"] },
    {
      id: "wp-floor-back",
      x: 0,
      z: 10.5,
      links: ["wp-floor-aisle-south", "wp-floor-back-west", "wp-floor-back-east"],
    },
    { id: "wp-floor-back-east", x: 7.2, z: 10.5, links: ["wp-floor-back", "wp-floor-back-east-wall"] },

    // Behind the side-wall desks, round the end of the south row: the end desk
    // hides each of their chairs from the aisle nodes.
    { id: "wp-floor-back-west-wall", x: -10.4, z: 10.5, links: ["wp-floor-back-west"] },
    { id: "wp-floor-back-east-wall", x: 10.4, z: 10.5, links: ["wp-floor-back-east"] },
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
  fixtures: [
    // Across the manager's desk from its chair, facing it. The desk and the
    // manager sitting at it are what show it, so it needs no volume.
    {
      id: MANAGER_INTERACTABLE_ID,
      kind: INTERACTION_KIND.manager,
      anchor: { x: 9, z: -8.2, yaw: 0 },
      volume: undefined,
      exit: undefined,
      deskId: undefined,
      seatId: undefined,
    },
  ],
  // A two-way avenue, two lanes each way, driving on the right: the near lanes
  // run south past the windows and the far ones north.
  street: {
    road: rect(15.8, -70, 26.2, 70),
    lanes: [
      { x: 17.1, direction: 1 },
      { x: 19.7, direction: 1 },
      { x: 22.3, direction: -1 },
      { x: 24.9, direction: -1 },
    ],
    crossingZ: -6.6,
    farFrontX: 30,
  },
};

/**
 * Rotates a point in a furnishing's local frame into world space.
 *
 * Local X runs along a desk's width and local Z along its depth, before the yaw
 * is applied; yaw 0 faces -Z, as it does everywhere in the layout.
 */
export function localToWorld(origin: Vec2, yaw: number, localX: number, localZ: number): Vec2 {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: origin.x + localX * cos + localZ * sin,
    z: origin.z - localX * sin + localZ * cos,
  };
}

/**
 * The places to sit at a desk.
 *
 * Seat count comes from the desk's width, so a 1.6 m desk gets one and a 3.2 m
 * meeting table gets two without either number being written down. The
 * occupant sits on the desk's +Z side and faces it, which is -Z local — so a
 * desk's yaw is also the yaw of everyone sitting at it.
 *
 * Both the chair props and the seat interactables come from here, which is
 * what keeps the chair you see and the chair you sit in at one position.
 */
export function workstations(spec: DeskSpec): readonly Workstation[] {
  const seats = Math.max(1, Math.round(spec.width / SEAT_PITCH));
  const pitch = spec.width / seats;
  const result: Workstation[] = [];
  for (let seat = 0; seat < seats; seat += 1) {
    const localX = (seat - (seats - 1) / 2) * pitch;
    const position = localToWorld(spec, spec.yaw, localX, spec.depth / 2 + CHAIR_GAP);
    // Straight back from the desk, so getting up never stands anyone inside the
    // desk or the neighbouring chair.
    const exit = localToWorld(
      spec,
      spec.yaw,
      localX,
      spec.depth / 2 + CHAIR_GAP + DESK_CHAIR.depth / 2 + OCCUPANT_RADIUS + STAND_UP_GAP,
    );
    result.push({
      localX,
      seat: { x: position.x, z: position.z, yaw: spec.yaw },
      chair: footprintAabb(position, spec.yaw, DESK_CHAIR.width, DESK_CHAIR.depth),
      exit,
    });
  }
  return result;
}

/**
 * The id of a desk's `number`th seat interactable, counting from 1 in
 * {@link workstations} order. One template, so the seat and the props of its
 * workstation can be paired by id.
 */
export function seatInteractableId(deskId: string, number: number): string {
  return `seat-${deskId}-${number}`;
}

/**
 * The id of the screen at a desk's `number`th workstation, paired with its
 * seat's {@link seatInteractableId}.
 */
export function screenInteractableId(deskId: string, number: number): string {
  return `screen-${deskId}-${number}`;
}

/**
 * The interactable each prop kind turns into, or `undefined` for one that is
 * only furniture. Keyed by record, so a new prop kind is a type error here until
 * somebody decides whether it can be used.
 */
const PROP_INTERACTION: Record<PropKind, InteractionKind | undefined> = {
  coffee: INTERACTION_KIND.coffee,
  cabinet: undefined,
  table: undefined,
  diningChair: undefined,
  reception: undefined,
};

const interactableCache = new WeakMap<OfficeLayout, readonly InteractableSpec[]>();

/**
 * Every interactable in a layout: a seat per workstation and a screen per
 * open-floor one, one per usable prop, one per wall board, then the
 * hand-placed fixtures.
 *
 * Cached per layout, like {@link collisionBoxes}, because both sides query it
 * often — the client once a frame for its prompt — and the layout never changes
 * at runtime.
 */
export function interactables(layout: OfficeLayout): readonly InteractableSpec[] {
  const cached = interactableCache.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  const all: InteractableSpec[] = [];
  for (const spec of layout.desks) {
    workstations(spec).forEach((workstation, index) => {
      all.push({
        id: seatInteractableId(spec.id, index + 1),
        kind: INTERACTION_KIND.seat,
        anchor: workstation.seat,
        volume: undefined,
        exit: workstation.exit,
        deskId: spec.id,
        seatId: undefined,
      });
    });
    // A screen per open-floor workstation, read from just behind the chair,
    // which is where whoever gets up from it is stood, so it is clear floor
    // within reach of the seat by the layout's own check. Only the open floor's,
    // because that is where the live agents work.
    workstations(spec).forEach((workstation, index) => {
      if (roomAt(layout, workstation.seat)?.id !== OPEN_FLOOR_ROOM_ID) {
        return;
      }
      all.push({
        id: screenInteractableId(spec.id, index + 1),
        kind: INTERACTION_KIND.screen,
        anchor: { x: workstation.exit.x, z: workstation.exit.z, yaw: spec.yaw },
        volume: undefined,
        exit: undefined,
        deskId: undefined,
        seatId: seatInteractableId(spec.id, index + 1),
      });
    });
  }
  for (const spec of layout.props) {
    const kind = PROP_INTERACTION[spec.kind];
    if (kind === undefined) {
      continue;
    }
    // Stood in front of the prop and turned to face it. A prop's front is its
    // -Z side, so a prop backed onto a wall is used from the room.
    const position = localToWorld(spec, spec.yaw, 0, -(spec.depth / 2 + STANDING_GAP));
    all.push({
      id: spec.id,
      kind,
      anchor: { x: position.x, z: position.z, yaw: spec.yaw - Math.PI },
      volume: undefined,
      exit: undefined,
      deskId: undefined,
      seatId: undefined,
    });
  }
  for (const board of layout.boards) {
    // Stood in front of the face and turned to look at it; a board draws itself.
    const position = localToWorld(board, board.yaw, 0, -READING_GAP);
    all.push({
      id: board.id,
      kind: INTERACTION_KIND.board,
      anchor: { x: position.x, z: position.z, yaw: board.yaw - Math.PI },
      volume: undefined,
      exit: undefined,
      deskId: undefined,
      seatId: undefined,
    });
  }
  all.push(...layout.fixtures);
  interactableCache.set(layout, all);
  return all;
}

/**
 * The ground footprint a desk blocks once its yaw is applied.
 *
 * For the quarter-turn yaws the layout uses this is the desk exactly. For any
 * other yaw it is the enclosing axis-aligned box, which blocks slightly more
 * floor than the rendered desk covers.
 */
export function deskAabb(spec: DeskSpec): Aabb2 {
  return footprintAabb(spec, spec.yaw, spec.width, spec.depth);
}

/** The axis-aligned box a `width` x `depth` footprint covers once turned by `yaw`. */
function footprintAabb(centre: Vec2, yaw: number, width: number, depth: number): Aabb2 {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  const extentX = halfWidth * cos + halfDepth * sin;
  const extentZ = halfWidth * sin + halfDepth * cos;
  return rect(centre.x - extentX, centre.z - extentZ, centre.x + extentX, centre.z + extentZ);
}

/** The ground footprint a prop blocks. Derived exactly as a desk's is. */
export function propAabb(spec: PropSpec): Aabb2 {
  return deskAabb(spec);
}

/**
 * The ground every chair in a layout blocks, one box per workstation.
 *
 * Chairs come out of the desks rather than out of {@link OfficeLayout.props},
 * so a desk added to the plan brings a solid chair with it.
 */
export function chairBoxes(layout: OfficeLayout): readonly Aabb2[] {
  return layout.desks.flatMap((spec) => workstations(spec).map((workstation) => workstation.chair));
}

/** Walls, desks and props: everything solid except the chairs. */
function structureBoxes(layout: OfficeLayout): Aabb2[] {
  return [
    ...layout.walls.map((spec) => spec.footprint),
    ...layout.desks.map(deskAabb),
    ...layout.props.map(propAabb),
  ];
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
  const boxes = [...structureBoxes(layout), ...chairBoxes(layout)];
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
    if (overlapsObstacle(door.centre, collisionBoxes(layout))) {
      problems.push(`doorway ${door.id} is blocked by an obstacle`);
    }
  }

  problems.push(...describeBoardProblems(layout));
  problems.push(...describeFurnishingProblems(layout));

  // A chair inside a desk or a wall is a seat nobody can get into, and one
  // that blocks a neighbour's is a seat nobody can get out of.
  const structure = structureBoxes(layout);
  const chairs = chairBoxes(layout);
  chairs.forEach((chair, index) => {
    if (structure.some((box) => boxesOverlap(chair, box))) {
      problems.push(`chair ${index + 1} overlaps a wall, desk or prop`);
    }
    if (chairs.some((other, otherIndex) => otherIndex !== index && boxesOverlap(chair, other))) {
      problems.push(`chair ${index + 1} overlaps another chair`);
    }
  });

  problems.push(...describeWaypointProblems(layout));

  const interactableIds = new Set<string>();
  for (const spec of interactables(layout)) {
    if (interactableIds.has(spec.id)) {
      problems.push(`interactable id ${spec.id} is used twice`);
    }
    interactableIds.add(spec.id);
    // An anchor inside geometry is a prompt that appears and then strands the
    // occupant, so it is checked here rather than discovered by sitting down.
    // A seat's anchor is inside its own chair by design, which is why chairs
    // are left out of its test and its exit is held to the full one instead.
    const anchorBlockers = spec.exit === undefined ? collisionBoxes(layout) : structure;
    if (overlapsObstacle(spec.anchor, anchorBlockers)) {
      problems.push(`interactable ${spec.id} anchors inside an obstacle`);
    }
    if (spec.exit !== undefined) {
      if (overlapsObstacle(spec.exit, collisionBoxes(layout))) {
        problems.push(`interactable ${spec.id} lets go inside an obstacle`);
      }
      // Within reach of its own anchor, so whoever just stood up can sit
      // straight back down without walking anywhere.
      if (Math.hypot(spec.exit.x - spec.anchor.x, spec.exit.z - spec.anchor.z) > INTERACT_RANGE) {
        problems.push(`interactable ${spec.id} lets go out of reach of its anchor`);
      }
    }
  }

  for (const point of layout.spawnPoints) {
    if (overlapsObstacle(point, collisionBoxes(layout))) {
      problems.push(`spawn point (${point.x}, ${point.z}) overlaps an obstacle`);
    }
  }

  return problems;
}

/**
 * Whether an occupant standing at a point would be inside any of `boxes`.
 *
 * Deliberately not `isBlocked` from the collision module: that module imports
 * this one, and the floor plan must not depend on the resolver that consumes
 * it. The two agree because both grow every box by the occupant radius.
 */
function overlapsObstacle(point: Vec2, boxes: readonly Aabb2[]): boolean {
  for (const box of boxes) {
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

/** How far either side of a board's face it is sampled for a wall and a room. */
const BOARD_PROBE = MIN_OBSTACLE_THICKNESS / 2;

/**
 * Checks that every board hangs on a wall and faces into the room it names.
 *
 * A board is placed by hand, so the mistake to catch is one turned the wrong
 * way round — facing into the wall it is mounted on — or left hanging in the
 * middle of a room.
 */
function describeBoardProblems(layout: OfficeLayout): string[] {
  const problems: string[] = [];
  const roomIds = new Set(layout.rooms.map((room) => room.id));

  for (const board of layout.boards) {
    if (!roomIds.has(board.roomId)) {
      problems.push(`board ${board.id} faces unknown room ${board.roomId}`);
    }
    if (board.width <= 0 || board.height <= 0 || board.elevation < 0) {
      problems.push(`board ${board.id} has a non-positive size or a negative elevation`);
    }
    const forwardX = -Math.sin(board.yaw);
    const forwardZ = -Math.cos(board.yaw);
    const behind = { x: board.x - forwardX * BOARD_PROBE, z: board.z - forwardZ * BOARD_PROBE };
    const inFront = {
      x: board.x + forwardX * (BOARD_PROBE + OCCUPANT_RADIUS),
      z: board.z + forwardZ * (BOARD_PROBE + OCCUPANT_RADIUS),
    };
    if (!layout.walls.some((spec) => containsPoint(spec.footprint, behind))) {
      problems.push(`board ${board.id} is not hung on a wall`);
    }
    if (roomAt(layout, inFront)?.id !== board.roomId) {
      problems.push(`board ${board.id} does not face into room ${board.roomId}`);
    }
  }
  return problems;
}

/**
 * How far two boxes may share an edge before it counts as an overlap.
 *
 * A cabinet backed onto a wall is meant to touch it, and a footprint derived
 * through a yaw lands a rounding error either side of the face it was placed
 * against.
 */
const CONTACT_TOLERANCE = 1e-9;

/** A box shrunk by `margin` on every side. */
function inset(box: Aabb2, margin: number): Aabb2 {
  return rect(box.minX + margin, box.minZ + margin, box.maxX - margin, box.maxZ - margin);
}

/**
 * The floor a doorway needs kept clear: its gap, plus a body's width of
 * approach on either side of the wall line, so nobody has to squeeze past a
 * cabinet to get through.
 */
function doorwayApron(door: DoorwaySpec): Aabb2 {
  const halfWidth = door.width / 2;
  const halfDepth = MIN_OBSTACLE_THICKNESS / 2 + OCCUPANT_RADIUS * 2;
  const [halfX, halfZ] = door.axis === "x" ? [halfWidth, halfDepth] : [halfDepth, halfWidth];
  return rect(door.centre.x - halfX, door.centre.z - halfZ, door.centre.x + halfX, door.centre.z + halfZ);
}

/**
 * Checks that every prop stands clear of everything else solid and of every
 * doorway, and that every piece of tabletop dressing stands on the prop it
 * names.
 *
 * A prop is placed by hand, so the mistakes to catch are one pushed into a wall
 * or a neighbour, one left standing in a doorway, and a microwave left floating
 * where a cabinet used to be.
 */
function describeFurnishingProblems(layout: OfficeLayout): string[] {
  const problems: string[] = [];
  const solid = [
    ...layout.walls.map((spec) => ({ id: `wall ${spec.id}`, box: spec.footprint })),
    ...layout.desks.map((spec) => ({ id: `desk ${spec.id}`, box: deskAabb(spec) })),
    ...chairBoxes(layout).map((box, index) => ({ id: `chair ${index + 1}`, box })),
    ...layout.props.map((spec) => ({ id: `prop ${spec.id}`, box: propAabb(spec) })),
  ];

  for (const spec of layout.props) {
    const box = inset(propAabb(spec), CONTACT_TOLERANCE);
    for (const other of solid) {
      if (other.id !== `prop ${spec.id}` && boxesOverlap(box, other.box)) {
        problems.push(`prop ${spec.id} overlaps ${other.id}`);
      }
    }
    for (const door of layout.doorways) {
      if (boxesOverlap(box, doorwayApron(door))) {
        problems.push(`prop ${spec.id} stands in doorway ${door.id}`);
      }
    }
    if (!groundsOf(layout).some((ground) => containsBox(ground, box))) {
      problems.push(`prop ${spec.id} stands off the floor`);
    }
  }

  const propsById = new Map(layout.props.map((spec) => [spec.id, spec]));
  const tabletopIds = new Set<string>();
  for (const item of layout.tabletop) {
    if (tabletopIds.has(item.id)) {
      problems.push(`tabletop item id ${item.id} is used twice`);
    }
    tabletopIds.add(item.id);
    const base = propsById.get(item.on);
    if (base === undefined) {
      problems.push(`tabletop item ${item.id} stands on unknown prop ${item.on}`);
      continue;
    }
    const footprint = inset(footprintAabb(item, item.yaw, item.width, item.depth), CONTACT_TOLERANCE);
    if (!containsBox(propAabb(base), footprint)) {
      problems.push(`tabletop item ${item.id} overhangs prop ${base.id}`);
    }
  }
  return problems;
}

/**
 * Where something can stand: the floor slab, and any room outside it — the
 * pavement — which is ground of its own.
 */
export function groundsOf(layout: OfficeLayout): readonly Aabb2[] {
  return [
    layout.floor,
    ...layout.rooms.map((room) => room.bounds).filter((bounds) => !containsBox(layout.floor, bounds)),
  ];
}

const groundExtentCache = new WeakMap<OfficeLayout, Aabb2>();

/**
 * The box round all of {@link groundsOf}: the furthest anyone can stand.
 *
 * Cached, since the resolver clamps to it on every move it makes.
 */
export function groundExtent(layout: OfficeLayout): Aabb2 {
  const cached = groundExtentCache.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  const grounds = groundsOf(layout);
  const extent = rect(
    Math.min(...grounds.map((box) => box.minX)),
    Math.min(...grounds.map((box) => box.minZ)),
    Math.max(...grounds.map((box) => box.maxX)),
    Math.max(...grounds.map((box) => box.maxZ)),
  );
  groundExtentCache.set(layout, extent);
  return extent;
}

/** Whether `inner` lies wholly within `outer`. */
function containsBox(outer: Aabb2, inner: Aabb2): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minZ >= outer.minZ &&
    inner.maxZ <= outer.maxZ
  );
}

/** Whether two boxes share any area. Touching edges do not count. */
function boxesOverlap(a: Aabb2, b: Aabb2): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
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
    if (overlapsObstacle(node, collisionBoxes(layout))) {
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
