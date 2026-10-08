/**
 * Pathfinding tests.
 *
 * Two halves. The first works against {@link FIXTURE_LAYOUT}, a deliberately
 * small plan built here: two rooms joined by a doorway, one desk placed to
 * stand between a body and the waypoint nearest to it, and a sealed closet
 * whose waypoints no route can reach. A fixture is what makes the unreachable
 * and occluded cases statable at all, and it keeps these tests from moving
 * every time the shipped floor plan gains a room.
 *
 * The second half then confirms the same behaviours against the real
 * {@link OFFICE_LAYOUT}, because pathfinding that is right about an invented
 * plan and wrong about the shipped one is not useful.
 */

import { describe, expect, it } from "vitest";

import { OCCUPANT_RADIUS } from "./constants.js";
import {
  type OfficeLayout,
  OFFICE_LAYOUT,
  describeLayoutProblems,
  roomAt,
} from "./layout.js";
import { findPath, findWaypointPath, nearestWaypoint } from "./nav.js";

const WALL_HEIGHT = 3;

function wall(id: string, minX: number, minZ: number, maxX: number, maxZ: number) {
  return { id, footprint: { minX, minZ, maxX, maxZ }, height: WALL_HEIGHT };
}

/**
 * Two rooms and a sealed closet.
 *
 * ```
 *        x -12 ........ 0 ........ 12
 *   z -6  +-----------+#+-----------+
 *         |           |#|           |
 *         |  west     |#|   east    |
 *    0    | [desk]  o  o  o       o |   o = waypoint, # = divider wall
 *         |           |#| +-------+ |
 *         |           |#| | o   o | |   closet: no doorway
 *    6    +-----------+#+-+-------+-+
 * ```
 */
const FIXTURE_LAYOUT: OfficeLayout = {
  name: "Fixture",
  floor: { minX: -12, minZ: -6, maxX: 12, maxZ: 6 },
  walls: [
    wall("shell-north", -12, -6, 12, -5.7),
    wall("shell-south", -12, 5.7, 12, 6),
    wall("shell-west", -12, -6, -11.7, 6),
    wall("shell-east", 11.7, -6, 12, 6),

    // One divider on x = 0, broken by a doorway spanning z = -1.15 to 1.15.
    wall("divider-north", -0.15, -6, 0.15, -1.15),
    wall("divider-south", -0.15, 1.15, 0.15, 6),

    // A closet with no doorway, closed on its fourth side by the shell.
    wall("closet-west", 5, 1, 5.3, 5.7),
    wall("closet-north", 5, 1, 10, 1.3),
    wall("closet-east", 9.7, 1, 10, 5.7),
  ],
  desks: [{ id: "desk-west", x: -6, z: 0, yaw: 0, width: 1.6, depth: 0.8, height: 0.75 }],
  // Nav never reads rooms; they are here so the fixture is a complete layout
  // and so the "outside every room" case can be stated with `roomAt`.
  rooms: [
    { id: "closet", name: "Closet", bounds: { minX: 5.3, minZ: 1.3, maxX: 9.7, maxZ: 5.7 } },
    { id: "west", name: "West Room", bounds: { minX: -11.7, minZ: -5.7, maxX: -0.15, maxZ: 5.7 } },
    { id: "east", name: "East Room", bounds: { minX: 0.15, minZ: -5.7, maxX: 11.7, maxZ: 5.7 } },
  ],
  waypoints: [
    { id: "wp-west-desk", x: -6, z: 1.2, links: ["wp-west-mid"] },
    { id: "wp-west-mid", x: -3, z: 0, links: ["wp-west-desk", "wp-door"] },
    { id: "wp-door", x: 0, z: 0, links: ["wp-west-mid", "wp-east-mid"] },
    { id: "wp-east-mid", x: 3, z: 0, links: ["wp-door", "wp-east-far"] },
    { id: "wp-east-far", x: 9, z: -3, links: ["wp-east-mid"] },
    { id: "wp-closet-near", x: 6, z: 2.5, links: ["wp-closet-far"] },
    { id: "wp-closet-far", x: 9, z: 2.5, links: ["wp-closet-near"] },
  ],
  spawnPoints: [{ x: -3, z: 0, yaw: 0 }],
};

/** A position inside the sealed closet, clear of its walls by a body radius. */
const IN_CLOSET = { x: 7, z: 3 };

describe("the fixture layout", () => {
  it("is a layout the resolver would accept, so the cases below mean something", () => {
    expect(describeLayoutProblems(FIXTURE_LAYOUT)).toEqual([]);
  });
});

describe("findWaypointPath", () => {
  it("joins direct neighbours with both ends", () => {
    expect(findWaypointPath("wp-west-desk", "wp-west-mid", FIXTURE_LAYOUT)).toEqual([
      "wp-west-desk",
      "wp-west-mid",
    ]);
  });

  it("walks multiple hops across the doorway", () => {
    expect(findWaypointPath("wp-west-desk", "wp-east-far", FIXTURE_LAYOUT)).toEqual([
      "wp-west-desk",
      "wp-west-mid",
      "wp-door",
      "wp-east-mid",
      "wp-east-far",
    ]);
  });

  it("reverses symmetrically", () => {
    const forward = findWaypointPath("wp-west-desk", "wp-east-far", FIXTURE_LAYOUT);
    const back = findWaypointPath("wp-east-far", "wp-west-desk", FIXTURE_LAYOUT);
    expect(back).toEqual([...forward].reverse());
  });

  it("returns the single node when both ends are the same waypoint", () => {
    expect(findWaypointPath("wp-door", "wp-door", FIXTURE_LAYOUT)).toEqual(["wp-door"]);
  });

  it("returns an empty path for a goal in a disconnected part of the graph", () => {
    expect(findWaypointPath("wp-west-mid", "wp-closet-near", FIXTURE_LAYOUT)).toEqual([]);
  });

  it("returns an empty path for an unknown id rather than throwing", () => {
    expect(findWaypointPath("wp-west-mid", "wp-nowhere", FIXTURE_LAYOUT)).toEqual([]);
    expect(findWaypointPath("wp-nowhere", "wp-west-mid", FIXTURE_LAYOUT)).toEqual([]);
  });

  it("returns an empty path for a layout with no waypoints", () => {
    const empty: OfficeLayout = { ...FIXTURE_LAYOUT, waypoints: [] };
    expect(findWaypointPath("wp-door", "wp-east-mid", empty)).toEqual([]);
  });
});

describe("nearestWaypoint", () => {
  it("picks the closest node when the line to it is clear", () => {
    expect(nearestWaypoint({ x: -6, z: 1.6 }, FIXTURE_LAYOUT)?.id).toBe("wp-west-desk");
  });

  it("skips a closer node that is behind a desk", () => {
    // wp-west-desk is 2.7m away but straight through desk-west; wp-west-mid is
    // 3.35m away around it.
    expect(nearestWaypoint({ x: -6, z: -1.5 }, FIXTURE_LAYOUT)?.id).toBe("wp-west-mid");
  });

  it("anchors a position in a doorway, which is in no room at all", () => {
    expect(roomAt(FIXTURE_LAYOUT, { x: 0, z: 0 })).toBeUndefined();
    expect(nearestWaypoint({ x: 0, z: 0 }, FIXTURE_LAYOUT)?.id).toBe("wp-door");
  });

  it("returns undefined only when the layout has no waypoints", () => {
    const empty: OfficeLayout = { ...FIXTURE_LAYOUT, waypoints: [] };
    expect(nearestWaypoint({ x: 0, z: 0 }, empty)).toBeUndefined();
  });
});

describe("findPath", () => {
  it("routes between direct neighbours", () => {
    expect(findPath({ x: -6, z: 1.6 }, { x: -3.2, z: 0 }, FIXTURE_LAYOUT)).toEqual([
      "wp-west-desk",
      "wp-west-mid",
    ]);
  });

  it("routes multiple hops from one room to the other", () => {
    expect(findPath({ x: -6, z: 1.6 }, { x: 9, z: -3 }, FIXTURE_LAYOUT)).toEqual([
      "wp-west-desk",
      "wp-west-mid",
      "wp-door",
      "wp-east-mid",
      "wp-east-far",
    ]);
  });

  it("returns one node for two positions that share the nearest waypoint", () => {
    expect(findPath({ x: 2.5, z: 0 }, { x: 3.5, z: 0 }, FIXTURE_LAYOUT)).toEqual(["wp-east-mid"]);
  });

  it("routes within one room when the room holds more than one waypoint", () => {
    expect(findPath({ x: -3, z: 0 }, { x: -6, z: 1.6 }, FIXTURE_LAYOUT)).toEqual([
      "wp-west-mid",
      "wp-west-desk",
    ]);
  });

  it("starts from the reachable node, not the closest one", () => {
    expect(findPath({ x: -6, z: -1.5 }, { x: 9, z: -3 }, FIXTURE_LAYOUT)).toEqual([
      "wp-west-mid",
      "wp-door",
      "wp-east-mid",
      "wp-east-far",
    ]);
  });

  it("routes from a position that is in no room", () => {
    expect(roomAt(FIXTURE_LAYOUT, { x: 0, z: 0 })).toBeUndefined();
    expect(findPath({ x: 0, z: 0 }, { x: 9, z: -3 }, FIXTURE_LAYOUT)).toEqual([
      "wp-door",
      "wp-east-mid",
      "wp-east-far",
    ]);
  });

  it("returns an empty path for a goal nothing can walk to", () => {
    expect(nearestWaypoint(IN_CLOSET, FIXTURE_LAYOUT)?.id).toBe("wp-closet-near");
    expect(findPath({ x: -3, z: 0 }, IN_CLOSET, FIXTURE_LAYOUT)).toEqual([]);
    expect(findPath(IN_CLOSET, { x: -3, z: 0 }, FIXTURE_LAYOUT)).toEqual([]);
  });

  it("is a pure function of its arguments", () => {
    const from = { x: -6, z: 1.6 };
    const to = { x: 9, z: -3 };
    const first = findPath(from, to, FIXTURE_LAYOUT);
    findPath(to, from, FIXTURE_LAYOUT);
    findPath(IN_CLOSET, from, FIXTURE_LAYOUT);
    expect(findPath(from, to, FIXTURE_LAYOUT)).toEqual(first);
    expect(from).toEqual({ x: -6, z: 1.6 });
    expect(to).toEqual({ x: 9, z: -3 });
  });
});

/**
 * The shipped plan. These cases are the same five shapes as above, stated
 * against the real waypoint graph; the unreachable case has no counterpart
 * here because the shipped graph is connected, which is itself asserted.
 */
describe("OFFICE_LAYOUT", () => {
  const R = OCCUPANT_RADIUS;
  const AT_CEO_DESK = { x: -8.4, z: -4.8 };
  const AT_MEETING_TABLE = { x: 7.9, z: -4.5 };
  const CEO_DOORWAY = { x: -5, z: -5.9 };
  const BULLPEN_CENTRE = { x: 0, z: 2 };

  it("joins direct neighbours", () => {
    expect(findWaypointPath("wp-ceo-desk", "wp-ceo-door", OFFICE_LAYOUT)).toEqual([
      "wp-ceo-desk",
      "wp-ceo-door",
    ]);
  });

  it("routes from the CEO desk to the meeting table across three rooms", () => {
    expect(findPath(AT_CEO_DESK, AT_MEETING_TABLE, OFFICE_LAYOUT, R)).toEqual([
      "wp-ceo-desk",
      "wp-ceo-door",
      "wp-lobby-north",
      "wp-meeting-door",
      "wp-meeting-table",
    ]);
  });

  it("routes across the bullpen, start and goal in the same room", () => {
    expect(findPath({ x: -7.5, z: 2 }, { x: 7.5, z: 2 }, OFFICE_LAYOUT, R)).toEqual([
      "wp-bullpen-west",
      "wp-bullpen-centre",
      "wp-bullpen-east",
    ]);
  });

  it("routes from the CEO doorway, which belongs to no room", () => {
    expect(roomAt(OFFICE_LAYOUT, CEO_DOORWAY)).toBeUndefined();
    expect(findPath(CEO_DOORWAY, BULLPEN_CENTRE, OFFICE_LAYOUT, R)).toEqual([
      "wp-ceo-door",
      "wp-lobby-north",
      "wp-lobby-south",
      "wp-bullpen-centre",
    ]);
  });

  it("anchors every spawn point to a waypoint it can walk to", () => {
    for (const spawn of OFFICE_LAYOUT.spawnPoints) {
      const node = nearestWaypoint(spawn, OFFICE_LAYOUT, R);
      expect(node, `spawn (${spawn.x}, ${spawn.z})`).toBeDefined();
      expect(findPath(spawn, AT_MEETING_TABLE, OFFICE_LAYOUT, R).length).toBeGreaterThan(0);
    }
  });

  /**
   * An island in the shipped graph would strand an agent employee wherever it
   * happened to stand, so the plan is only allowed one connected component.
   */
  it("has no unreachable waypoint", () => {
    for (const from of OFFICE_LAYOUT.waypoints) {
      for (const to of OFFICE_LAYOUT.waypoints) {
        const path = findWaypointPath(from.id, to.id, OFFICE_LAYOUT);
        expect(path.at(0), `${from.id} -> ${to.id}`).toBe(from.id);
        expect(path.at(-1), `${from.id} -> ${to.id}`).toBe(to.id);
      }
    }
  });
});
