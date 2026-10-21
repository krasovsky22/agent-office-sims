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
 * here because nothing in this milestone can be stepped over or crawled under,
 * and the ceiling is out of everyone's reach.
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
  /**
   * Set on a meeting table: seated down both long sides rather than one, with
   * no screen in front of anybody, and drawn as a table rather than a desk.
   */
  readonly meeting?: true;
}

/**
 * What a prop is, for the asset registry that will replace the grey boxes.
 *
 * Desks have their own spec because the rows of them are the floor plan's main
 * structure; everything else solid that is not a wall or a desk is a prop.
 */
export type PropKind =
  | "coffee"
  | "cabinet"
  | "table"
  | "diningChair"
  | "reception"
  | "sofa"
  | "armchair"
  | "coffeeTable"
  | "sideboard";

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
export type TabletopKind = "microwave" | "radio";

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

/**
 * A lift door set into a wall, for the building's lift lobby.
 *
 * Nothing collides with it, the wall it is set into already does. It is
 * positioned like a {@link WallBoardSpec}, by the centre of its face on the
 * wall's surface, with `yaw` the way the face looks. It is only called, and
 * ridden, on a floor of a building with more than one: {@link withLiftCalls}
 * puts a call in front of each door, and a building of one floor leaves the
 * doors as scenery.
 */
export interface LiftSpec {
  readonly id: string;
  /** The room the doors open into. */
  readonly roomId: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  /** Width of the door opening, frame excluded. */
  readonly width: number;
  /** Height of the door opening. */
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
 * A carpet runner laid on the floor along a walkway.
 *
 * Decor, so it never collides: it is here, with the walkways it marks, so the
 * runner the client draws and the route the agents walk are written down in
 * one place.
 */
export interface CarpetSpec {
  readonly id: string;
  readonly footprint: Aabb2;
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
  radio: "radio",
  lift: "lift",
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
  readonly lifts: readonly LiftSpec[];
  readonly rooms: readonly RoomSpec[];
  readonly doorways: readonly DoorwaySpec[];
  readonly carpets: readonly CarpetSpec[];
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
  /**
   * Height of the ceiling over the whole floor slab, or `undefined` for a
   * floor open to the sky. Nothing on the floor reaches it, so it never
   * collides; it is here so the client draws it and keeps the camera under it
   * from the same number the walls are built to.
   */
  readonly ceiling: number | undefined;
}

const WALL_HEIGHT = 3;

/** Height of the railing along the kerb: waist high, so the street is seen over it. */
const RAILING_HEIGHT = 1.05;
const DESK_HEIGHT = 0.75;

/** The lounge's soft seating, in its own frame: the seat faces -Z. */
const SOFA = { width: 2, depth: 0.85, height: 0.9 } as const;
const ARMCHAIR = { width: 0.9, depth: 0.85, height: 0.9 } as const;

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

/** The corner of the open floor with the soft seating and the sticker boards. */
export const LOUNGE_ROOM_ID = "lounge";

/** The AI manager's private office, where the standup gathers. */
export const MANAGER_OFFICE_ROOM_ID = "manager-office";

/** The building's entrance hall, with reception and the lifts. */
export const LOBBY_ROOM_ID = "lobby";

/** The open floor's wall board that shows this repository's own GitHub issues and pull requests. */
export const PROJECT_BOARD_ID = "project-board";

/**
 * The open floor's sticker board of issues an agent can pick up, one sticky
 * note each; an agent starting one walks here and takes its note.
 */
export const ISSUES_STICKER_BOARD_ID = "issues-sticker-board";

/** The sticker board an agent pins an issue's note on once it has handed in its pull request. */
export const PULL_REQUESTS_STICKER_BOARD_ID = "pull-requests-sticker-board";

/** The open floor's wall board of recurring tasks: each standing task, its schedule, last run and status. */
export const RECURRING_TASKS_BOARD_ID = "recurring-tasks-board";

/** The AI manager's desk in its office, where it sits for good. */
export const MANAGER_DESK_ID = "desk-manager";

/** The spot across the manager's desk where the CEO stands to talk to it. */
export const MANAGER_INTERACTABLE_ID = "manager-desk";

/** The office radio's interactable, stood at in front of the lounge's coffee table. */
export const RADIO_INTERACTABLE_ID = "radio";

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

/** A shell wall glazed onto the outside. */
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
 * One row of identical desks, one at each of `xs`.
 *
 * The rows are the open floor's structure, so they are generated rather than
 * written out: a row written by hand is a row where one desk ends up a
 * centimetre out of line.
 */
function deskRow(prefix: string, z: number, yaw: number, xs: readonly number[]): DeskSpec[] {
  return xs.map((x, index) => desk(`${prefix}-${index + 1}`, x, z, yaw));
}

/**
 * Where the desks in every open-floor row sit along X.
 *
 * Three to a row with a 2.4 m gap between neighbours, so the floor can be
 * walked across between the desks as well as round them, and the westernmost
 * desk stands well east of the office door: whoever comes in from the lobby
 * walks up a clear carpeted walkway rather than straight into a chair.
 */
const DESK_ROW_XS = [-6.6, -2.6, 1.4] as const;

/**
 * The prototype office: the first floor of a building on a New York street,
 * laid out after a reference floor plan, with the building's lobby across its
 * south side and the pavement outside its front door.
 *
 * Reading it from the street, which is to the east:
 *
 * - The main entrance opens from the pavement into the lobby, a hall along the
 *   building's south wall. Reception stands just inside, facing the door, in
 *   front of a feature wall with the office's name on it. Down the hall the
 *   lifts are set into a core on the north wall — ridden only in a building
 *   of more than one floor — and to the left of the lifts a door leads north
 *   into the office.
 * - That door comes in at the south-west corner of the open floor, the office's
 *   main room, which holds three rows of desks facing north. Across its north
 *   side stand two private offices side by side, the CEO's and the AI
 *   manager's, and the project board hangs on their front wall between their
 *   doors, so every desk looks at it.
 * - West of the private offices the open floor opens into the lounge: a sofa
 *   against the west wall, two armchairs round a coffee table, and the two
 *   sticker boards facing each other across it.
 * - The east side, on the street, is the conference room, a long table seated
 *   down both sides and a sideboard along its south wall, with the kitchen
 *   south of it; each opens west onto the open floor.
 * - The shell's east wall is glass from end to end bar the main entrance, and
 *   its west wall all but behind the issues sticker board; north and south it
 *   backs onto the neighbouring buildings. The pavement runs the length of
 *   the building between the street glass and a railing along the kerb; past
 *   the kerb is the {@link StreetSpec | street}, which is scenery. A ceiling
 *   covers the whole floor at the walls' height.
 *
 * Every interior doorway is 1.4m clear, which is twice an occupant's diameter: wide
 * enough that two people pass, narrow enough to read as a door. Walls are
 * {@link MIN_OBSTACLE_THICKNESS} thick, the thinnest the collision substep can
 * guarantee a fast mover cannot cross.
 */
export const OFFICE_LAYOUT: OfficeLayout = {
  name: "First Floor",
  floor: rect(-12, -12, 12, 12),
  walls: [
    // Shell.
    wall("wall-north", -12, -12, 12, -11.7),
    wall("wall-south", -12, 11.7, 12, 12),
    // The back: solid, since nothing stands outside it to look out on.
    wall("wall-west-north", -12, -12, -11.7, -7.9),
    wall("wall-west-south", -12, -7.9, -11.7, 12),
    // The street front, glazed either side of the main entrance into the lobby.
    windowWall("wall-east-north", 11.7, -12, 12, 8.35),
    windowWall("wall-east-south", 11.7, 10.15, 12, 12),

    // The pavement outside: a railing along the kerb and across each end,
    // where the neighbouring buildings' fronts begin.
    railing("railing-kerb", 15.5, -12.3, 15.8, 12.3),
    railing("railing-north", 12, -12.3, 15.5, -12),
    railing("railing-south", 12, 12, 15.5, 12.3),

    // The private offices' side walls: the lounge's east wall, and the wall
    // between the two offices. Each runs to the offices' front wall.
    wall("wall-ceo-west", -6.7, -11.7, -6.4, -4.7),
    wall("wall-ceo-east", -1.85, -11.7, -1.55, -4.7),

    // The private offices' front wall onto the open floor, a doorway into each
    // at its outer end, leaving the middle clear for the project board.
    wall("wall-ceo-south-west", -6.4, -5, -6.1, -4.7),
    wall("wall-ceo-south-east", -4.7, -5, -1.85, -4.7),
    wall("wall-manager-south-west", -1.55, -5, 2.1, -4.7),
    wall("wall-manager-south-east", 3.5, -5, 4, -4.7),

    // The open floor's east wall, with a doorway into the conference room and
    // one into the kitchen; the last stretch is the jamb of the kitchen's.
    wall("wall-meeting-west-north", 4, -11.7, 4.3, -4.4),
    wall("wall-meeting-west-south", 4, -3, 4.3, 5),
    wall("wall-kitchen-west-south", 4, 6.4, 4.3, 6.8),
    // Between the conference room and the kitchen.
    wall("wall-meeting-south", 4.3, -0.6, 11.7, -0.3),

    // The office's south wall, which is the lobby's north wall, broken by the
    // office door at its west end, clear of the end desk's chair.
    wall("wall-lobby-west", -11.7, 6.5, -11.3, 6.8),
    wall("wall-lobby-east", -9.9, 6.5, 11.7, 6.8),
    // The lift core, against it east of the office door, and the feature wall
    // behind reception, free-standing so the hall runs round it either side.
    wall("wall-lifts", -8.4, 6.8, -4, 8),
    wall("wall-reception", 7.4, 8.05, 7.7, 10.45),
  ],
  desks: [
    // Open floor. Every desk here faces north, so everyone sitting at one looks
    // at the project board on the private offices' front wall. Each chair backs
    // onto the aisle south of its row, which is also where its occupant stands up.
    ...deskRow("desk-north", -2.2, 0, DESK_ROW_XS),
    ...deskRow("desk-middle", 0.9, 0, DESK_ROW_XS),
    ...deskRow("desk-south", 4, 0, DESK_ROW_XS),

    // Private rooms.
    // The CEO's, turned to face its door, with the back wall behind the chair.
    desk("desk-ceo", -5.1, -9, Math.PI, 2.2, 0.9),
    // Down the middle of the conference room, its length north-south, so it is
    // sat at from the west and from the east; the standups are held at it.
    { ...desk("table-meeting", 8, -6.2, -QUARTER_TURN, 6.4, 1.4), meeting: true },

    // The AI manager's, in its own office: turned to face the door, so whoever
    // comes in walks straight up to it.
    desk(MANAGER_DESK_ID, 1.225, -9.2, Math.PI),
  ],
  props: [
    // Against the kitchen's north wall, facing south into the room and straight
    // up the walk from the door, with room to stand in front of it.
    {
      id: "coffee-machine",
      kind: "coffee",
      x: 5.3,
      z: 0.05,
      yaw: Math.PI,
      width: 0.9,
      depth: 0.7,
      height: 1.5,
    },

    // The kitchen counter: a run of base cabinets backed onto the north wall
    // east of the coffee machine, facing into the room.
    ...counterRun("kitchen-cabinet-north", { x: 8.45, z: 0 }, Math.PI, 4),

    // A table for four in the kitchen's east half, by the window.
    prop("kitchen-table", "table", 9.2, 3.4, 0, { width: 1.2, depth: 0.8, height: 0.75 }),
    prop("kitchen-chair-1", "diningChair", 8.9, 2.75, Math.PI, DINING_CHAIR),
    prop("kitchen-chair-2", "diningChair", 9.5, 2.75, Math.PI, DINING_CHAIR),
    prop("kitchen-chair-3", "diningChair", 8.9, 4.05, 0, DINING_CHAIR),
    prop("kitchen-chair-4", "diningChair", 9.5, 4.05, 0, DINING_CHAIR),

    // The sideboard along the conference room's south wall, facing the table.
    prop("meeting-sideboard", "sideboard", 8, -0.85, 0, { width: 2.4, depth: 0.5, height: 0.8 }),

    // The lounge: a sofa against the west wall, a coffee table in front of it
    // and two armchairs across the table, all facing in round it.
    prop("lounge-sofa", "sofa", -11.275, -6.3, -QUARTER_TURN, SOFA),
    prop("lounge-table", "coffeeTable", -9.7, -6.3, QUARTER_TURN, { width: 1.1, depth: 0.6, height: 0.45 }),
    prop("lounge-armchair-1", "armchair", -8.3, -6.9, QUARTER_TURN, ARMCHAIR),
    prop("lounge-armchair-2", "armchair", -8.3, -5.7, QUARTER_TURN, ARMCHAIR),

    // Reception, just inside the main entrance and turned to face it: the
    // first thing anyone coming in off the street sees, backed by the feature
    // wall. The hall to the lifts runs round it on the north side.
    prop("reception-desk", "reception", 8.6, 9.25, -QUARTER_TURN, { width: 1.8, depth: 0.6, height: 1.05 }),
  ],
  tabletop: [
    // On the counter's second cabinet, pushed back against the wall.
    {
      id: "kitchen-microwave",
      kind: "microwave",
      on: "kitchen-cabinet-north-2",
      x: 7.7,
      z: -0.05,
      yaw: Math.PI,
      width: 0.55,
      depth: 0.4,
      height: 0.33,
    },
    // The office radio, on the lounge's coffee table and turned to face the open floor.
    {
      id: "lounge-radio",
      kind: "radio",
      on: "lounge-table",
      x: -9.7,
      z: -6.3,
      yaw: Math.PI,
      width: 0.44,
      depth: 0.14,
      height: 0.32,
    },
  ],
  boards: [
    // The private offices' front wall, between their two doorways and facing
    // south down the desk rows: every open-floor seat looks north at it, and a
    // player coming in off the lobby walks towards it. As wide as the wall allows with a
    // clear half metre either side to the door frames, so it reads from the
    // back row.
    {
      id: PROJECT_BOARD_ID,
      roomId: OPEN_FLOOR_ROOM_ID,
      x: -1.2,
      z: -4.7,
      yaw: Math.PI,
      width: 6,
      height: 2.6,
      elevation: 0.3,
    },
    // The two sticker boards face each other across the lounge, issues on the
    // shell's west wall and pull requests on the CEO office's, so an agent
    // takes a note from one and later pins it on the other a few steps away,
    // with the sofa clear to the south of both.
    {
      id: ISSUES_STICKER_BOARD_ID,
      roomId: LOUNGE_ROOM_ID,
      x: -11.7,
      z: -9.4,
      yaw: -QUARTER_TURN,
      width: 3,
      height: 2.1,
      elevation: 0.45,
    },
    {
      id: PULL_REQUESTS_STICKER_BOARD_ID,
      roomId: LOUNGE_ROOM_ID,
      x: -6.7,
      z: -9.4,
      yaw: QUARTER_TURN,
      width: 3,
      height: 2.1,
      elevation: 0.45,
    },
    // The recurring tasks, on the open floor's bare west wall between its two
    // aisles, facing east over the walkway in from the office door, so it is
    // read standing on the walkway and seen from the desks.
    {
      id: RECURRING_TASKS_BOARD_ID,
      roomId: OPEN_FLOOR_ROOM_ID,
      x: -11.7,
      z: 1.35,
      yaw: -QUARTER_TURN,
      width: 2.8,
      height: 1.7,
      elevation: 0.7,
    },
  ],
  // Two lift doors in the face of the core, opening south into the lobby.
  lifts: [
    { id: "lift-west", roomId: LOBBY_ROOM_ID, x: -7.3, z: 8, yaw: Math.PI, width: 1.1, height: 2.2 },
    { id: "lift-east", roomId: LOBBY_ROOM_ID, x: -5.1, z: 8, yaw: Math.PI, width: 1.1, height: 2.2 },
  ],
  rooms: [
    { id: "ceo-office", name: "CEO Office", bounds: rect(-6.4, -11.7, -1.85, -5) },
    { id: MANAGER_OFFICE_ROOM_ID, name: "AI Manager's Office", bounds: rect(-1.55, -11.7, 4, -5) },
    { id: "meeting-room", name: "Conference Room", bounds: rect(4.3, -11.7, 11.7, -0.6) },
    { id: "kitchen", name: "Kitchen", bounds: rect(4.3, -0.3, 11.7, 6.5) },
    // Open to the open floor along its whole south side: no wall between them.
    { id: LOUNGE_ROOM_ID, name: "Lounge", bounds: rect(-11.7, -11.7, -6.7, -4.7) },
    { id: OPEN_FLOOR_ROOM_ID, name: "Open Floor", bounds: rect(-11.7, -4.7, 4, 6.5) },
    { id: LOBBY_ROOM_ID, name: "Lobby", bounds: rect(-11.7, 6.8, 11.7, 11.7) },
    { id: SIDEWALK_ROOM_ID, name: "Sidewalk", bounds: rect(12, -12, 15.5, 12) },
  ],
  doorways: [
    { id: "door-ceo", centre: { x: -5.4, z: -4.85 }, width: 1.4, axis: "x", connects: ["ceo-office", OPEN_FLOOR_ROOM_ID] },
    {
      id: "door-manager",
      centre: { x: 2.8, z: -4.85 },
      width: 1.4,
      axis: "x",
      connects: [MANAGER_OFFICE_ROOM_ID, OPEN_FLOOR_ROOM_ID],
    },
    { id: "door-meeting", centre: { x: 4.15, z: -3.7 }, width: 1.4, axis: "z", connects: ["meeting-room", OPEN_FLOOR_ROOM_ID] },
    { id: "door-kitchen", centre: { x: 4.15, z: 5.7 }, width: 1.4, axis: "z", connects: ["kitchen", OPEN_FLOOR_ROOM_ID] },
    { id: "door-office", centre: { x: -10.6, z: 6.65 }, width: 1.4, axis: "x", connects: [OPEN_FLOOR_ROOM_ID, LOBBY_ROOM_ID] },
    { id: "door-entrance", centre: { x: 11.85, z: 9.25 }, width: 1.8, axis: "z", connects: [LOBBY_ROOM_ID, SIDEWALK_ROOM_ID] },
  ],
  // Runners down the open floor's main walkways: up the west side from the
  // office door, along the front past the project board and every door off
  // it, and along the back to the kitchen. Laid edge to edge, never
  // overlapping, so no two fight for the same pixel.
  carpets: [
    { id: "carpet-west", footprint: rect(-11.15, -3.15, -10.05, 5.2) },
    { id: "carpet-front", footprint: rect(-11.15, -4.25, 4, -3.15) },
    { id: "carpet-back", footprint: rect(-11.15, 5.2, 4, 6.5) },
  ],
  // Every link is axis-aligned and clear of the geometry, so a body can follow
  // one by walking straight at the next node.
  waypoints: [
    // Lounge: between the two sticker boards, and down its east side, past
    // the armchairs, to the open floor.
    { id: "wp-lounge-boards", x: -9.2, z: -9.4, links: ["wp-lounge-east"] },
    { id: "wp-lounge-east", x: -7.25, z: -9.4, links: ["wp-lounge-boards", "wp-floor-front-lounge"] },

    // CEO office: in at the door, and round the east end of the desk to its chair.
    { id: "wp-ceo-desk", x: -5.4, z: -6.8, links: ["wp-ceo-door", "wp-ceo-east"] },
    { id: "wp-ceo-door", x: -5.4, z: -4.85, links: ["wp-ceo-desk", "wp-floor-front-ceo"] },
    { id: "wp-ceo-east", x: -2.8, z: -6.8, links: ["wp-ceo-desk", "wp-ceo-desk-back"] },
    { id: "wp-ceo-desk-back", x: -2.8, z: -10.7, links: ["wp-ceo-east"] },

    // The AI manager's office, and round the east end of its desk to its chair.
    { id: "wp-manager-door", x: 2.8, z: -4.85, links: ["wp-manager-centre", "wp-floor-front-manager"] },
    { id: "wp-manager-centre", x: 2.8, z: -8.2, links: ["wp-manager-door", "wp-manager-desk-back"] },
    { id: "wp-manager-desk-back", x: 2.8, z: -10.9, links: ["wp-manager-centre"] },

    // Conference room: in at the door, and a loop round the table, which
    // hides each side's chairs from the other.
    { id: "wp-meeting-door", x: 4.15, z: -3.7, links: ["wp-floor-front-east", "wp-meeting-west"] },
    {
      id: "wp-meeting-west",
      x: 5.6,
      z: -3.7,
      links: ["wp-meeting-door", "wp-meeting-north-west", "wp-meeting-south-west"],
    },
    { id: "wp-meeting-north-west", x: 5.6, z: -10.6, links: ["wp-meeting-west", "wp-meeting-north-east"] },
    { id: "wp-meeting-north-east", x: 10.6, z: -10.6, links: ["wp-meeting-north-west", "wp-meeting-east"] },
    { id: "wp-meeting-east", x: 10.6, z: -6.2, links: ["wp-meeting-north-east", "wp-meeting-south-east"] },
    { id: "wp-meeting-south-east", x: 10.6, z: -2, links: ["wp-meeting-east", "wp-meeting-south-west"] },
    { id: "wp-meeting-south-west", x: 5.6, z: -2, links: ["wp-meeting-south-east", "wp-meeting-west"] },

    // Kitchen.
    { id: "wp-kitchen-door", x: 4.15, z: 5.7, links: ["wp-floor-back-east", "wp-kitchen-centre"] },
    { id: "wp-kitchen-centre", x: 5.3, z: 5.7, links: ["wp-kitchen-door", "wp-kitchen-coffee"] },
    { id: "wp-kitchen-coffee", x: 5.3, z: 1.6, links: ["wp-kitchen-centre"] },

    // Open floor: a walk along the front, under the project board and past
    // every door off it; an aisle behind each desk row; and an aisle down each
    // side joining them. Two nodes along the middle of each aisle as well, each
    // between two desks, so every chair has one within a few steps along its
    // own aisle.
    {
      id: "wp-floor-front-west",
      x: -10.6,
      z: -3.7,
      links: ["wp-floor-front-lounge", "wp-floor-aisle-north-west"],
    },
    {
      id: "wp-floor-front-lounge",
      x: -7.25,
      z: -3.7,
      links: ["wp-floor-front-west", "wp-lounge-east", "wp-floor-front-ceo"],
    },
    { id: "wp-floor-front-ceo", x: -5.4, z: -3.7, links: ["wp-floor-front-lounge", "wp-ceo-door", "wp-floor-front"] },
    { id: "wp-floor-front", x: -1.2, z: -3.7, links: ["wp-floor-front-ceo", "wp-floor-front-manager"] },
    {
      id: "wp-floor-front-manager",
      x: 2.8,
      z: -3.7,
      links: ["wp-floor-front", "wp-manager-door", "wp-floor-front-east"],
    },
    {
      id: "wp-floor-front-east",
      x: 3.5,
      z: -3.7,
      links: ["wp-floor-front-manager", "wp-meeting-door", "wp-floor-aisle-north-east"],
    },

    {
      id: "wp-floor-aisle-north-west",
      x: -10.6,
      z: -0.2,
      links: ["wp-floor-front-west", "wp-floor-aisle-north-mid", "wp-floor-aisle-south-west"],
    },
    { id: "wp-floor-aisle-north-mid", x: -4.6, z: -0.2, links: ["wp-floor-aisle-north-west", "wp-floor-aisle-north"] },
    { id: "wp-floor-aisle-north", x: -0.6, z: -0.2, links: ["wp-floor-aisle-north-mid", "wp-floor-aisle-north-east"] },
    {
      id: "wp-floor-aisle-north-east",
      x: 3.5,
      z: -0.2,
      links: ["wp-floor-aisle-north", "wp-floor-front-east", "wp-floor-aisle-south-east"],
    },

    {
      id: "wp-floor-aisle-south-west",
      x: -10.6,
      z: 2.88,
      links: ["wp-floor-aisle-north-west", "wp-floor-aisle-south-mid", "wp-floor-back-door"],
    },
    { id: "wp-floor-aisle-south-mid", x: -4.6, z: 2.88, links: ["wp-floor-aisle-south-west", "wp-floor-aisle-south"] },
    { id: "wp-floor-aisle-south", x: -0.6, z: 2.88, links: ["wp-floor-aisle-south-mid", "wp-floor-aisle-south-east"] },
    {
      id: "wp-floor-aisle-south-east",
      x: 3.5,
      z: 2.88,
      links: ["wp-floor-aisle-south", "wp-floor-aisle-north-east", "wp-floor-back-east"],
    },

    {
      id: "wp-floor-back-door",
      x: -10.6,
      z: 5.7,
      links: ["wp-floor-aisle-south-west", "wp-office-door", "wp-floor-back-mid"],
    },
    { id: "wp-floor-back-mid", x: -4.6, z: 5.7, links: ["wp-floor-back-door", "wp-floor-back"] },
    { id: "wp-floor-back", x: -0.6, z: 5.7, links: ["wp-floor-back-mid", "wp-floor-back-east"] },
    {
      id: "wp-floor-back-east",
      x: 3.5,
      z: 5.7,
      links: ["wp-floor-back", "wp-floor-aisle-south-east", "wp-kitchen-door"],
    },

    // Out through the office door into the lobby, along the hall past the
    // lifts, round the north side of reception, and out of the main entrance.
    { id: "wp-office-door", x: -10.6, z: 6.65, links: ["wp-floor-back-door", "wp-lobby-west"] },
    { id: "wp-lobby-west", x: -10.6, z: 9.4, links: ["wp-office-door", "wp-lobby-lifts"] },
    { id: "wp-lobby-lifts", x: -6.2, z: 9.4, links: ["wp-lobby-west", "wp-lobby-centre"] },
    { id: "wp-lobby-centre", x: 6.6, z: 9.4, links: ["wp-lobby-lifts", "wp-lobby-north"] },
    { id: "wp-lobby-north", x: 6.6, z: 7.4, links: ["wp-lobby-centre", "wp-lobby-east"] },
    { id: "wp-lobby-east", x: 10.8, z: 7.4, links: ["wp-lobby-north", "wp-lobby-entrance"] },

    // In through the main entrance from the pavement, and up and down it.
    { id: "wp-lobby-entrance", x: 10.8, z: 9.25, links: ["wp-lobby-east", "wp-entrance-door"] },
    { id: "wp-entrance-door", x: 11.85, z: 9.25, links: ["wp-lobby-entrance", "wp-sidewalk-door"] },
    {
      id: "wp-sidewalk-door",
      x: 13.7,
      z: 9.25,
      links: ["wp-entrance-door", "wp-sidewalk-north", "wp-sidewalk-south"],
    },
    { id: "wp-sidewalk-north", x: 13.7, z: -10.8, links: ["wp-sidewalk-door"] },
    { id: "wp-sidewalk-south", x: 13.7, z: 10.8, links: ["wp-sidewalk-door"] },
  ],
  // Out on the pavement in front of the main entrance, facing it, so everyone
  // arrives off the street and walks in through the lobby. Spread up and down
  // the door and out towards the kerb so arrivals never stand in one another.
  spawnPoints: [
    { x: 14, z: 9.25, yaw: Math.PI / 2 },
    { x: 14, z: 8.25, yaw: Math.PI / 2 },
    { x: 14, z: 10.25, yaw: Math.PI / 2 },
    { x: 14.9, z: 9.25, yaw: Math.PI / 2 },
    { x: 14.9, z: 8.25, yaw: Math.PI / 2 },
    { x: 14.9, z: 10.25, yaw: Math.PI / 2 },
  ],
  fixtures: [
    // Across the manager's desk from its chair, facing it. The desk and the
    // manager sitting at it are what show it, so it needs no volume.
    {
      id: MANAGER_INTERACTABLE_ID,
      kind: INTERACTION_KIND.manager,
      anchor: { x: 1.225, z: -8.2, yaw: 0 },
      volume: undefined,
      exit: undefined,
      deskId: undefined,
      seatId: undefined,
    },
    // South of the lounge's coffee table, facing the radio on it, clear of the
    // sofa and the armchairs. The radio's own model shows it.
    {
      id: RADIO_INTERACTABLE_ID,
      kind: INTERACTION_KIND.radio,
      anchor: { x: -9.7, z: -5.1, yaw: 0 },
      volume: undefined,
      exit: undefined,
      deskId: undefined,
      seatId: undefined,
    },
  ],
  // A two-way avenue, two lanes each way, driving on the right: the near lanes
  // run south past the windows and the far ones north. It runs on well past
  // where the client's fog has swallowed it, so nobody on the pavement sees
  // where it ends or where the cars wrap round. The crossing is outside the
  // main entrance.
  street: {
    road: rect(15.8, -280, 26.2, 280),
    lanes: [
      { x: 17.1, direction: 1 },
      { x: 19.7, direction: 1 },
      { x: 22.3, direction: -1 },
      { x: 24.9, direction: -1 },
    ],
    crossingZ: 9.25,
    farFrontX: 30,
  },
  ceiling: WALL_HEIGHT,
};

/** How far in front of a lift's doors whoever calls it stands. */
const LIFT_CALL_DISTANCE = 0.7;

/** How far in front of a lift's doors its riders step out, the nearer of two rows. */
const LIFT_ARRIVAL_DISTANCE = 1.2;

/** Between the two rows of arrivals in front of a lift, so two riders never land in one another. */
const LIFT_ARRIVAL_SPACING = 1;

/** The interactable that calls a lift, by the lift's id. */
export function liftCallId(liftId: string): string {
  return `${liftId}-call`;
}

/** A point `distance` out from a lift's doors, the way they face. */
function inFrontOfLift(lift: LiftSpec, distance: number): Vec2 {
  return { x: lift.x - Math.sin(lift.yaw) * distance, z: lift.z - Math.cos(lift.yaw) * distance };
}

/**
 * The layout with a call in front of each of its lifts, where `E` opens the
 * list of floors.
 *
 * Derived from the lifts rather than placed by hand, so a lift cannot move and
 * leave its call behind. Only a building with somewhere else to go has them:
 * a building of one floor uses its layout as it is.
 */
export function withLiftCalls(layout: OfficeLayout): OfficeLayout {
  const calls = layout.lifts.map(
    (lift): InteractableSpec => ({
      id: liftCallId(lift.id),
      kind: INTERACTION_KIND.lift,
      // Facing the doors, which face the other way.
      anchor: { ...inFrontOfLift(lift, LIFT_CALL_DISTANCE), yaw: lift.yaw >= 0 ? lift.yaw - Math.PI : lift.yaw + Math.PI },
      volume: undefined,
      exit: undefined,
      deskId: undefined,
      seatId: undefined,
    }),
  );
  return { ...layout, fixtures: [...layout.fixtures, ...calls] };
}

/**
 * The office on a floor above the street, derived from the ground floor's.
 *
 * The same office in the same place, so the floors cannot drift apart and the
 * tests that walk the ground floor's plan cover most of this one too. What
 * goes is what only the ground floor has: reception, the main entrance and
 * the pavement outside it with its railings, and the waypoints out to them.
 * The street front is glass from end to end instead, the street seen from up
 * high, and everyone arrives by lift, stepping out of its doors into the lift
 * lobby facing the office door, so the lifts are called here whatever the
 * building.
 */
export function upperFloorLayout(ground: OfficeLayout): OfficeLayout {
  const outdoors = new Set(ground.rooms.filter((room) => room.id === SIDEWALK_ROOM_ID).map((room) => room.id));
  const entrances = ground.doorways.filter((door) => door.connects.some((id) => outdoors.has(id)));
  const isOut = (point: Vec2): boolean => {
    const room = roomAt(ground, point);
    return (room !== undefined && outdoors.has(room.id)) || entrances.some((door) => door.centre.x === point.x && door.centre.z === point.z);
  };
  const dropped = new Set(ground.waypoints.filter(isOut).map((node) => node.id));
  const office = ground.doorways.find((door) => door.connects.includes(LOBBY_ROOM_ID) && !entrances.includes(door));

  // The street front's glazing, broken on the ground floor by the main entrance, as one run.
  const glazed = ground.walls.filter((spec) => spec.style === "window");
  const glass: WallSpec = {
    id: "wall-street",
    footprint: {
      minX: Math.min(...glazed.map((spec) => spec.footprint.minX)),
      minZ: Math.min(...glazed.map((spec) => spec.footprint.minZ)),
      maxX: Math.max(...glazed.map((spec) => spec.footprint.maxX)),
      maxZ: Math.max(...glazed.map((spec) => spec.footprint.maxZ)),
    },
    height: WALL_HEIGHT,
    style: "window",
  };

  return withLiftCalls({
    ...ground,
    name: "Upper Floor",
    walls: [...ground.walls.filter((spec) => spec.style === undefined), glass],
    props: ground.props.filter((spec) => spec.kind !== "reception"),
    rooms: ground.rooms.filter((room) => !outdoors.has(room.id)),
    doorways: ground.doorways.filter((door) => !entrances.includes(door)),
    waypoints: ground.waypoints
      .filter((node) => !dropped.has(node.id))
      .map((node) => ({ ...node, links: node.links.filter((id) => !dropped.has(id)) })),
    // Out of the doors, two rows deep in front of each, turned down the hall
    // towards the door into the office, which is the way anyone arriving is
    // going; square to the hall, so the camera behind them looks along it.
    spawnPoints: ground.lifts.flatMap((lift) =>
      [0, 1].map((row) => {
        const at = inFrontOfLift(lift, LIFT_ARRIVAL_DISTANCE + row * LIFT_ARRIVAL_SPACING);
        return { ...at, yaw: office === undefined ? lift.yaw : office.centre.x < at.x ? QUARTER_TURN : -QUARTER_TURN };
      }),
    ),
  });
}

/** The ground floor of a building with more than one floor: the office as it is, with its lifts called. */
export const GROUND_FLOOR_LAYOUT: OfficeLayout = withLiftCalls(OFFICE_LAYOUT);

/** Every floor above the ground floor. */
export const UPPER_FLOOR_LAYOUT: OfficeLayout = upperFloorLayout(OFFICE_LAYOUT);

/**
 * The floor plan of one floor of a building of `floors`, numbered from 1 at
 * the street.
 *
 * The one place the choice is made, so the server's room and the client's
 * scene pick the same plan from the same two numbers. A building of one floor
 * is the office as it always was.
 */
export function floorLayout(floor: number, floors: number): OfficeLayout {
  if (floor > 1) {
    return UPPER_FLOOR_LAYOUT;
  }
  return floors > 1 ? GROUND_FLOOR_LAYOUT : OFFICE_LAYOUT;
}

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
 * A yaw turned half round, kept within (-PI, PI] so a facing derived from
 * the layout is never a full turn off the range everyone else's yaw is in.
 */
function turnedRound(yaw: number): number {
  const turned = yaw - Math.PI;
  return turned <= -Math.PI ? turned + 2 * Math.PI : turned;
}

/**
 * The places to sit at a desk.
 *
 * Seat count comes from the desk's width, so a 1.6 m desk gets one and a 3.2 m
 * table gets two without either number being written down. The occupant sits
 * on the desk's +Z side and faces it, which is -Z local — so a desk's yaw is
 * also the yaw of everyone sitting at it. A meeting table is sat at from its
 * -Z side as well, by a second row turned half round to face back across it;
 * that row comes after the first.
 *
 * Both the chair props and the seat interactables come from here, which is
 * what keeps the chair you see and the chair you sit in at one position.
 */
export function workstations(spec: DeskSpec): readonly Workstation[] {
  const seats = Math.max(1, Math.round(spec.width / SEAT_PITCH));
  const pitch = spec.width / seats;
  const sides = spec.meeting === true ? [1, -1] : [1];
  const result: Workstation[] = [];
  for (const side of sides) {
    const yaw = side > 0 ? spec.yaw : turnedRound(spec.yaw);
    for (let seat = 0; seat < seats; seat += 1) {
      const localX = (seat - (seats - 1) / 2) * pitch;
      const position = localToWorld(spec, spec.yaw, localX, side * (spec.depth / 2 + CHAIR_GAP));
      // Straight back from the desk, so getting up never stands anyone inside the
      // desk or the neighbouring chair.
      const exit = localToWorld(
        spec,
        spec.yaw,
        localX,
        side * (spec.depth / 2 + CHAIR_GAP + DESK_CHAIR.depth / 2 + OCCUPANT_RADIUS + STAND_UP_GAP),
      );
      result.push({
        localX,
        seat: { x: position.x, z: position.z, yaw },
        chair: footprintAabb(position, yaw, DESK_CHAIR.width, DESK_CHAIR.depth),
        exit,
      });
    }
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
  sofa: undefined,
  armchair: undefined,
  coffeeTable: undefined,
  sideboard: undefined,
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
      anchor: { x: position.x, z: position.z, yaw: turnedRound(spec.yaw) },
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
      anchor: { x: position.x, z: position.z, yaw: turnedRound(board.yaw) },
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

  // A runner under a wall or another runner fights it for the same pixels.
  layout.carpets.forEach((carpet, index) => {
    if (!groundsOf(layout).some((ground) => containsBox(ground, carpet.footprint))) {
      problems.push(`carpet ${carpet.id} runs off the floor`);
    }
    if (layout.walls.some((spec) => boxesOverlap(carpet.footprint, spec.footprint))) {
      problems.push(`carpet ${carpet.id} runs under a wall`);
    }
    if (layout.carpets.some((other, otherIndex) => otherIndex > index && boxesOverlap(carpet.footprint, other.footprint))) {
      problems.push(`carpet ${carpet.id} overlaps another carpet`);
    }
  });

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

/** Something mounted flat on a wall and facing into a room: a board or a lift's doors. */
interface WallMount {
  readonly id: string;
  readonly roomId: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

/**
 * Whether a wall mount is on a wall and faces into the room it names, as
 * problem strings in `words`' terms.
 */
function describeMountProblems(
  layout: OfficeLayout,
  mount: WallMount,
  words: { readonly noun: string; readonly faces: string; readonly face: string; readonly hung: string },
): string[] {
  const problems: string[] = [];
  if (!layout.rooms.some((room) => room.id === mount.roomId)) {
    problems.push(`${words.noun} ${mount.id} ${words.faces} unknown room ${mount.roomId}`);
  }
  const forwardX = -Math.sin(mount.yaw);
  const forwardZ = -Math.cos(mount.yaw);
  const behind = { x: mount.x - forwardX * BOARD_PROBE, z: mount.z - forwardZ * BOARD_PROBE };
  const inFront = {
    x: mount.x + forwardX * (BOARD_PROBE + OCCUPANT_RADIUS),
    z: mount.z + forwardZ * (BOARD_PROBE + OCCUPANT_RADIUS),
  };
  if (!layout.walls.some((spec) => containsPoint(spec.footprint, behind))) {
    problems.push(`${words.noun} ${mount.id} is not ${words.hung} a wall`);
  }
  if (roomAt(layout, inFront)?.id !== mount.roomId) {
    problems.push(`${words.noun} ${mount.id} does not ${words.face} into room ${mount.roomId}`);
  }
  return problems;
}

/**
 * Checks that every board hangs on a wall and faces into the room it names,
 * and every lift is set into a wall and opens into its room.
 *
 * Both are placed by hand, so the mistake to catch is one turned the wrong way
 * round — facing into the wall it is mounted on — or left hanging in the
 * middle of a room.
 */
function describeBoardProblems(layout: OfficeLayout): string[] {
  const problems: string[] = [];
  for (const board of layout.boards) {
    if (board.width <= 0 || board.height <= 0 || board.elevation < 0) {
      problems.push(`board ${board.id} has a non-positive size or a negative elevation`);
    }
    problems.push(...describeMountProblems(layout, board, { noun: "board", faces: "faces", face: "face", hung: "hung on" }));
  }
  for (const lift of layout.lifts) {
    if (lift.width <= 0 || lift.height <= 0) {
      problems.push(`lift ${lift.id} has a non-positive size`);
    }
    problems.push(...describeMountProblems(layout, lift, { noun: "lift", faces: "opens", face: "open", hung: "set into" }));
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
