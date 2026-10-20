/**
 * The floor plan's own tests: the plan is data, so what can go wrong with it is
 * that the data describes an office nobody can walk around.
 *
 * {@link describeLayoutProblems} already covers what can be checked by reading
 * the data — thicknesses, mirrored links, a connected graph. These cases are
 * the ones that need the resolver: they put a body at one position, walk it at
 * walking speed, and check where it ends up. That is the only way to find a
 * doorway that is a centimetre too narrow for the capsule that has to fit
 * through it.
 */

import { describe, expect, it } from "vitest";

import { resolveMove } from "./collision.js";
import {
  INTERACT_RANGE,
  MIN_OBSTACLE_THICKNESS,
  OCCUPANT_RADIUS,
  TICK_RATE_HZ,
  WALK_SPEED,
} from "./constants.js";
import {
  INTERACTION_KIND,
  ISSUES_STICKER_BOARD_ID,
  LOBBY_ROOM_ID,
  LOUNGE_ROOM_ID,
  MANAGER_OFFICE_ROOM_ID,
  OFFICE_LAYOUT,
  OPEN_FLOOR_ROOM_ID,
  PULL_REQUESTS_STICKER_BOARD_ID,
  type OfficeLayout,
  type PropSpec,
  type Vec2,
  type WaypointSpec,
  containsPoint,
  describeLayoutProblems,
  interactables,
  groundExtent,
  propAabb,
  roomAt,
  SIDEWALK_ROOM_ID,
} from "./layout.js";
import { nearestWaypoint } from "./nav.js";

const R = OCCUPANT_RADIUS;

/** One frame of travel at walking speed, the largest step a player produces. */
const FRAME_STEP = WALK_SPEED / TICK_RATE_HZ;

/** How close to a target counts as having arrived. */
const ARRIVAL_TOLERANCE = 0.05;

/**
 * Walks a body straight at a target, a frame at a time, and reports where it
 * stopped.
 *
 * Steering is deliberately naive — head at the target, let the resolver sort
 * out the contact — because that is what the agent movement work will do
 * between two waypoints. A link a naive walk cannot follow is a link the
 * floor plan should not be claiming.
 */
function walkTo(from: Vec2, target: Vec2): Vec2 {
  let position: Vec2 = { x: from.x, z: from.z };
  // Generous enough for the longest link in the office, and bounded so a body
  // that has stopped against geometry fails the assertion rather than hangs.
  const budget = Math.ceil(Math.hypot(target.x - from.x, target.z - from.z) / FRAME_STEP) + 20;

  for (let step = 0; step < budget; step += 1) {
    const toTargetX = target.x - position.x;
    const toTargetZ = target.z - position.z;
    const distance = Math.hypot(toTargetX, toTargetZ);
    if (distance <= ARRIVAL_TOLERANCE) {
      break;
    }
    const travel = Math.min(FRAME_STEP, distance);
    position = resolveMove(
      position,
      { x: (toTargetX / distance) * travel, z: (toTargetZ / distance) * travel },
      R,
      OFFICE_LAYOUT,
    );
  }

  return position;
}

function distanceBetween(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function waypoint(id: string): WaypointSpec {
  const node = OFFICE_LAYOUT.waypoints.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`no waypoint ${id}`);
  }
  return node;
}

/**
 * Walks a whole route node by node and returns the final position.
 *
 * Every hop is asserted on arrival, so a route that fails names the hop that
 * failed rather than only the destination.
 */
function walkRoute(from: Vec2, ids: readonly string[]): Vec2 {
  let position = from;
  for (const id of ids) {
    const node = waypoint(id);
    position = walkTo(position, node);
    expect(distanceBetween(position, node), `walking to ${id}`).toBeLessThanOrEqual(ARRIVAL_TOLERANCE);
  }
  return position;
}

/** Breadth-first route between two nodes. The real search is a later issue. */
function routeBetween(fromId: string, toId: string): readonly string[] {
  const previous = new Map<string, string>([[fromId, fromId]]);
  const queue = [fromId];

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) {
      continue;
    }
    if (id === toId) {
      const route = [id];
      for (let step = id; step !== fromId; ) {
        step = previous.get(step) ?? fromId;
        route.unshift(step);
      }
      return route.slice(1);
    }
    for (const link of waypoint(id).links) {
      if (!previous.has(link)) {
        previous.set(link, id);
        queue.push(link);
      }
    }
  }

  throw new Error(`no route from ${fromId} to ${toId}`);
}

describe("OFFICE_LAYOUT waypoints", () => {
  it("can be walked along every link, in both directions", () => {
    for (const node of OFFICE_LAYOUT.waypoints) {
      for (const id of node.links) {
        const other = waypoint(id);
        const arrived = walkTo(node, other);
        expect(distanceBetween(arrived, other), `${node.id} -> ${id}`).toBeLessThanOrEqual(
          ARRIVAL_TOLERANCE,
        );
      }
    }
  });
});

describe("OFFICE_LAYOUT spawn points", () => {
  const entrance = OFFICE_LAYOUT.doorways.find((door) => door.id === "door-entrance");

  /** Players arrive off the street: on the pavement, looking at the main entrance. */
  it("stand on the pavement in front of the main entrance, facing it", () => {
    expect(entrance).toBeDefined();
    if (entrance === undefined) {
      return;
    }
    for (const spawn of OFFICE_LAYOUT.spawnPoints) {
      const label = `spawn (${spawn.x}, ${spawn.z})`;
      expect(roomAt(OFFICE_LAYOUT, spawn)?.id, label).toBe(SIDEWALK_ROOM_ID);
      expect(Math.abs(spawn.z - entrance.centre.z), label).toBeLessThanOrEqual(entrance.width);
      const toDoor = { x: entrance.centre.x - spawn.x, z: entrance.centre.z - spawn.z };
      const facing = { x: -Math.sin(spawn.yaw), z: -Math.cos(spawn.yaw) };
      const cos = (toDoor.x * facing.x + toDoor.z * facing.z) / Math.hypot(toDoor.x, toDoor.z);
      expect(cos, label).toBeGreaterThan(0.8);
    }
  });

  it("are far enough apart that arrivals do not overlap", () => {
    const points = OFFICE_LAYOUT.spawnPoints;
    for (const [i, a] of points.entries()) {
      for (const b of points.slice(i + 1)) {
        expect(distanceBetween(a, b), `(${a.x}, ${a.z}) to (${b.x}, ${b.z})`).toBeGreaterThanOrEqual(
          2 * OCCUPANT_RADIUS,
        );
      }
    }
  });
});

describe("OFFICE_LAYOUT rooms", () => {
  /** A node inside each room, which is what "reaching the room" means here. */
  const destinations: readonly (readonly [string, string])[] = [
    ["ceo-office", "wp-ceo-desk"],
    ["manager-office", "wp-manager-centre"],
    ["meeting-room", "wp-meeting-east"],
    ["kitchen", "wp-kitchen-coffee"],
    ["lounge", "wp-lounge-boards"],
    ["open-floor", "wp-floor-back"],
    ["lobby", "wp-lobby-lifts"],
    ["sidewalk", "wp-sidewalk-door"],
  ];

  it("names one destination per room", () => {
    expect(destinations.map(([room]) => room).sort()).toEqual(
      OFFICE_LAYOUT.rooms.map((room) => room.id).sort(),
    );
    for (const [room, id] of destinations) {
      expect(roomAt(OFFICE_LAYOUT, waypoint(id))?.id, id).toBe(room);
    }
  });

  /**
   * The acceptance criterion for this floor plan, as a test: an arriving player
   * can walk from where they spawn into every room, through the doorways, with
   * nothing blocking the way.
   */
  it("are all reachable on foot from the first spawn point", () => {
    const spawn = OFFICE_LAYOUT.spawnPoints[0];
    expect(spawn).toBeDefined();
    if (spawn === undefined) {
      return;
    }

    const start = "wp-sidewalk-door";
    const atStart = walkTo(spawn, waypoint(start));
    expect(distanceBetween(atStart, waypoint(start))).toBeLessThanOrEqual(ARRIVAL_TOLERANCE);

    for (const [room, id] of destinations) {
      const arrived = walkRoute(atStart, routeBetween(start, id));
      expect(roomAt(OFFICE_LAYOUT, arrived)?.id, `reaching ${room}`).toBe(room);
    }
  });
});

describe("OFFICE_LAYOUT seats", () => {
  /**
   * Chairs are solid, so a seat is only usable if the spot behind its chair —
   * where you are stood when you get up — is somewhere you can walk to, close
   * enough to the seat to sit down from, and somewhere you can walk away from.
   */
  it("can each be walked up to from the first spawn point, sat at, and left", () => {
    const spawn = OFFICE_LAYOUT.spawnPoints[0];
    expect(spawn).toBeDefined();
    if (spawn === undefined) {
      return;
    }
    const start = "wp-sidewalk-door";
    const atStart = walkTo(spawn, waypoint(start));

    const seats = interactables(OFFICE_LAYOUT).filter((spec) => spec.kind === INTERACTION_KIND.seat);
    expect(seats.length).toBeGreaterThan(0);
    for (const seat of seats) {
      const { exit } = seat;
      expect(exit, seat.id).toBeDefined();
      if (exit === undefined) {
        continue;
      }
      const node = nearestWaypoint(exit, OFFICE_LAYOUT);
      expect(node, seat.id).toBeDefined();
      if (node === undefined) {
        continue;
      }

      const atNode = walkRoute(atStart, routeBetween(start, node.id));
      const arrived = walkTo(atNode, exit);
      expect(distanceBetween(arrived, exit), `walking up to ${seat.id}`).toBeLessThanOrEqual(
        ARRIVAL_TOLERANCE,
      );
      expect(distanceBetween(arrived, seat.anchor), `reaching ${seat.id}`).toBeLessThanOrEqual(
        INTERACT_RANGE,
      );

      const left = walkTo(exit, node);
      expect(distanceBetween(left, node), `walking away from ${seat.id}`).toBeLessThanOrEqual(
        ARRIVAL_TOLERANCE,
      );
    }
  });

  it("leave every other interactable reachable on foot from the first spawn point", () => {
    const spawn = OFFICE_LAYOUT.spawnPoints[0];
    expect(spawn).toBeDefined();
    if (spawn === undefined) {
      return;
    }
    const start = "wp-sidewalk-door";
    const atStart = walkTo(spawn, waypoint(start));

    const others = interactables(OFFICE_LAYOUT).filter((spec) => spec.exit === undefined);
    expect([...new Set(others.map((spec) => spec.kind))].sort()).toEqual(
      [
        INTERACTION_KIND.board,
        INTERACTION_KIND.coffee,
        INTERACTION_KIND.manager,
        INTERACTION_KIND.radio,
        INTERACTION_KIND.screen,
      ].sort(),
    );
    for (const spec of others) {
      const node = nearestWaypoint(spec.anchor, OFFICE_LAYOUT);
      expect(node, spec.id).toBeDefined();
      if (node === undefined) {
        continue;
      }

      const atNode = walkRoute(atStart, routeBetween(start, node.id));
      const arrived = walkTo(atNode, spec.anchor);
      expect(distanceBetween(arrived, spec.anchor), `walking up to ${spec.id}`).toBeLessThanOrEqual(
        ARRIVAL_TOLERANCE,
      );
      expect(distanceBetween(arrived, spec.anchor), `reaching ${spec.id}`).toBeLessThanOrEqual(
        INTERACT_RANGE,
      );
    }
  });
});

describe("OFFICE_LAYOUT doorways", () => {
  /**
   * Walks each doorway from one room into the other and back. A gap narrower
   * than the capsule stops the walk in the opening, so the arrival check is
   * what proves the doorway is a doorway rather than a seam in the wall.
   */
  it("can each be walked through in both directions", () => {
    // Far enough back that the approach starts clear of the wall line.
    const APPROACH = MIN_OBSTACLE_THICKNESS / 2 + R + 0.6;

    for (const door of OFFICE_LAYOUT.doorways) {
      const offset =
        door.axis === "x" ? { x: 0, z: APPROACH } : { x: APPROACH, z: 0 };
      const near = { x: door.centre.x - offset.x, z: door.centre.z - offset.z };
      const far = { x: door.centre.x + offset.x, z: door.centre.z + offset.z };
      const nearRoom = roomAt(OFFICE_LAYOUT, near)?.id;
      const farRoom = roomAt(OFFICE_LAYOUT, far)?.id;
      expect([nearRoom, farRoom].sort(), door.id).toEqual([...door.connects].sort());

      const through = walkTo(near, far);
      expect(distanceBetween(through, far), `${door.id} inbound`).toBeLessThanOrEqual(
        ARRIVAL_TOLERANCE,
      );
      const back = walkTo(far, near);
      expect(distanceBetween(back, near), `${door.id} outbound`).toBeLessThanOrEqual(
        ARRIVAL_TOLERANCE,
      );
    }
  });
});

describe("OFFICE_LAYOUT kitchen", () => {
  const kitchen = OFFICE_LAYOUT.rooms.find((room) => room.id === "kitchen");
  if (kitchen === undefined) {
    throw new Error("the shipped layout has no kitchen");
  }
  const inKitchen = OFFICE_LAYOUT.props.filter((spec) => containsPoint(kitchen.bounds, spec));

  function kitchenProp(id: string): PropSpec {
    const spec = OFFICE_LAYOUT.props.find((candidate) => candidate.id === id);
    if (spec === undefined) {
      throw new Error(`no prop ${id}`);
    }
    return spec;
  }

  /** The shipped layout with one prop swapped for `replacement`. */
  function withProp(replacement: PropSpec): OfficeLayout {
    return {
      ...OFFICE_LAYOUT,
      props: OFFICE_LAYOUT.props.map((spec) => (spec.id === replacement.id ? replacement : spec)),
    };
  }

  it("is furnished with a counter, a microwave on it, and a table with chairs", () => {
    const kinds = inKitchen.map((spec) => spec.kind);
    expect(kinds.filter((kind) => kind === "cabinet").length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((kind) => kind === "table")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "diningChair").length).toBeGreaterThanOrEqual(2);

    const microwave = OFFICE_LAYOUT.tabletop.find((item) => item.kind === "microwave");
    expect(microwave).toBeDefined();
    expect(inKitchen.find((spec) => spec.id === microwave?.on)?.kind).toBe("cabinet");
  });

  it("turns the coffee machine to face into the room and serves it from the front", () => {
    const machine = kitchenProp("coffee-machine");
    const forward = { x: -Math.sin(machine.yaw), z: -Math.cos(machine.yaw) };
    // A body's width past the front face is kitchen floor; just past the back is wall.
    const reach = machine.depth / 2 + R;
    const inFront = { x: machine.x + forward.x * reach, z: machine.z + forward.z * reach };
    const backReach = machine.depth / 2 + 0.05;
    const behind = { x: machine.x - forward.x * backReach, z: machine.z - forward.z * backReach };
    expect(roomAt(OFFICE_LAYOUT, inFront)?.id).toBe("kitchen");
    expect(roomAt(OFFICE_LAYOUT, behind)).toBeUndefined();
    expect(OFFICE_LAYOUT.walls.some((spec) => containsPoint(spec.footprint, behind))).toBe(true);

    const coffee = interactables(OFFICE_LAYOUT).find((spec) => spec.id === "coffee-machine");
    expect(coffee).toBeDefined();
    if (coffee === undefined) {
      return;
    }
    // Stood on the machine's front side, facing back into it.
    const ahead = forward.x * (coffee.anchor.x - machine.x) + forward.z * (coffee.anchor.z - machine.z);
    expect(ahead).toBeGreaterThan(machine.depth / 2);
    expect(Math.abs(Math.sin(coffee.anchor.yaw - machine.yaw - Math.PI))).toBeLessThan(1e-9);
    expect(Math.cos(coffee.anchor.yaw - machine.yaw - Math.PI)).toBeCloseTo(1);
  });

  it("would refuse a coffee machine turned back to face its wall", () => {
    const machine = kitchenProp("coffee-machine");
    expect(describeLayoutProblems(withProp({ ...machine, yaw: 0 }))).toContain(
      "interactable coffee-machine anchors inside an obstacle",
    );
  });

  it("leaves the walk from the door to the coffee machine clear", () => {
    const coffee = interactables(OFFICE_LAYOUT).find((spec) => spec.id === "coffee-machine");
    expect(coffee).toBeDefined();
    if (coffee === undefined) {
      return;
    }
    // In at the door, a step into the room, then straight up to the machine.
    const door = waypoint("wp-kitchen-door");
    const turn = waypoint("wp-kitchen-centre");
    const arrived = walkTo(walkRoute(door, ["wp-kitchen-centre"]), coffee.anchor);
    expect(distanceBetween(arrived, coffee.anchor)).toBeLessThanOrEqual(ARRIVAL_TOLERANCE);
    // Not one of the other furnishings sits on either leg, so both are clear by a body's width.
    const legs = [
      { minX: door.x - R, minZ: door.z - R, maxX: turn.x + R, maxZ: door.z + R },
      { minX: turn.x - R, minZ: coffee.anchor.z, maxX: turn.x + R, maxZ: turn.z },
    ];
    for (const spec of inKitchen.filter((candidate) => candidate.id !== "coffee-machine")) {
      const box = propAabb(spec);
      for (const walk of legs) {
        const overlaps =
          box.minX < walk.maxX && walk.minX < box.maxX && box.minZ < walk.maxZ && walk.minZ < box.maxZ;
        expect(overlaps, spec.id).toBe(false);
      }
    }
  });

  it("would refuse a cabinet pushed into the wall, into a neighbour, or into the doorway", () => {
    const cabinet = kitchenProp("kitchen-cabinet-north-1");
    expect(describeLayoutProblems(withProp({ ...cabinet, z: cabinet.z - 0.1 }))).toContain(
      "prop kitchen-cabinet-north-1 overlaps wall wall-meeting-south",
    );
    expect(describeLayoutProblems(withProp({ ...cabinet, x: cabinet.x - 0.1 }))).toContain(
      "prop kitchen-cabinet-north-1 overlaps prop kitchen-cabinet-north-2",
    );
    expect(describeLayoutProblems(withProp({ ...cabinet, x: 4.6, z: 5.8 }))).toContain(
      "prop kitchen-cabinet-north-1 stands in doorway door-kitchen",
    );
  });

  it("would refuse a microwave left off the counter it names", () => {
    const [microwave] = OFFICE_LAYOUT.tabletop;
    if (microwave === undefined) {
      throw new Error("the shipped layout has no tabletop items");
    }
    const offEdge = { ...microwave, x: microwave.x + 0.5 };
    expect(describeLayoutProblems({ ...OFFICE_LAYOUT, tabletop: [offEdge] })).toEqual([
      `tabletop item ${microwave.id} overhangs prop ${microwave.on}`,
    ]);
    const onNothing = { ...microwave, on: "kitchen-shelf" };
    expect(describeLayoutProblems({ ...OFFICE_LAYOUT, tabletop: [onNothing] })).toEqual([
      `tabletop item ${microwave.id} stands on unknown prop kitchen-shelf`,
    ]);
  });
});

describe("OFFICE_LAYOUT street front", () => {
  const street = OFFICE_LAYOUT.street;
  if (street === undefined) {
    throw new Error("the shipped layout has no street");
  }
  const entrance = OFFICE_LAYOUT.doorways.find((door) => door.id === "door-entrance");
  if (entrance === undefined) {
    throw new Error("the shipped layout has no main entrance");
  }
  const sidewalk = OFFICE_LAYOUT.rooms.find((room) => room.id === SIDEWALK_ROOM_ID);
  if (sidewalk === undefined) {
    throw new Error("the shipped layout has no sidewalk");
  }

  it("opens the main entrance from the pavement into the lobby, through the street wall", () => {
    expect([...entrance.connects].sort()).toEqual(["lobby", SIDEWALK_ROOM_ID]);
    expect(entrance.centre.x).toBeGreaterThan(OFFICE_LAYOUT.floor.maxX - MIN_OBSTACLE_THICKNESS);
    expect(entrance.centre.x).toBeLessThan(OFFICE_LAYOUT.floor.maxX);

    // Off the street, in at the door, and on to the open floor's desks.
    const outside = { x: (sidewalk.bounds.minX + sidewalk.bounds.maxX) / 2, z: entrance.centre.z };
    const inside = walkTo(outside, { x: 10.8, z: entrance.centre.z });
    expect(roomAt(OFFICE_LAYOUT, inside)?.id).toBe("lobby");
    walkRoute(inside, routeBetween("wp-lobby-entrance", "wp-floor-aisle-north"));
  });

  it("stands the reception desk just inside, facing the entrance", () => {
    const reception = OFFICE_LAYOUT.props.find((spec) => spec.kind === "reception");
    if (reception === undefined) {
      throw new Error("the shipped layout has no reception desk");
    }
    expect(roomAt(OFFICE_LAYOUT, reception)?.id).toBe("lobby");
    // Its front, the local -Z side every prop faces, looks at the door, and
    // the door is square in front of it.
    const forward = { x: -Math.sin(reception.yaw), z: -Math.cos(reception.yaw) };
    const toDoor = { x: entrance.centre.x - reception.x, z: entrance.centre.z - reception.z };
    const along = (forward.x * toDoor.x + forward.z * toDoor.z) / Math.hypot(toDoor.x, toDoor.z);
    expect(along).toBeGreaterThan(0.95);
    const box = propAabb(reception);
    expect(box.minZ).toBeLessThan(entrance.centre.z);
    expect(box.maxZ).toBeGreaterThan(entrance.centre.z);
  });

  it("glazes the whole street wall either side of the entrance", () => {
    const streetWall = OFFICE_LAYOUT.walls.filter(
      (spec) => spec.footprint.minX >= OFFICE_LAYOUT.floor.maxX - MIN_OBSTACLE_THICKNESS - 1e-9 &&
        spec.footprint.maxX <= OFFICE_LAYOUT.floor.maxX,
    );
    expect(streetWall.length).toBe(2);
    for (const spec of streetWall) {
      expect(spec.style, spec.id).toBe("window");
    }
    const glazed = streetWall.reduce((sum, spec) => sum + spec.footprint.maxZ - spec.footprint.minZ, 0);
    expect(glazed + entrance.width).toBeCloseTo(OFFICE_LAYOUT.floor.maxZ - OFFICE_LAYOUT.floor.minZ);
  });

  it("glazes nothing but the street front, since no other wall has anything outside it to look at", () => {
    const glazed = OFFICE_LAYOUT.walls.filter((spec) => spec.style === "window");
    expect(glazed.length).toBeGreaterThan(0);
    for (const spec of glazed) {
      expect(spec.footprint.maxX, spec.id).toBe(OFFICE_LAYOUT.floor.maxX);
    }
  });

  it("keeps everyone on the pavement, off the road", () => {
    const starts = [
      { x: 13.7, z: -6.6 },
      { x: 13.7, z: -10.8 },
      { x: 13.7, z: 10.8 },
    ];
    for (const start of starts) {
      for (let step = 0; step < 36; step += 1) {
        const angle = (step / 36) * Math.PI * 2;
        const end = resolveMove(start, { x: Math.cos(angle) * 40, z: Math.sin(angle) * 40 }, R, OFFICE_LAYOUT);
        expect(end.x + R, `${start.x}, ${start.z} at ${angle}`).toBeLessThanOrEqual(street.road.minX);
        expect(containsPoint(groundExtent(OFFICE_LAYOUT), end)).toBe(true);
      }
    }
  });

  it("runs traffic both ways in lanes on the road, and puts the far buildings past it", () => {
    expect(new Set(street.lanes.map((lane) => lane.direction))).toEqual(new Set([1, -1]));
    for (const lane of street.lanes) {
      expect(lane.x).toBeGreaterThan(street.road.minX);
      expect(lane.x).toBeLessThan(street.road.maxX);
    }
    expect(street.road.minX).toBeGreaterThanOrEqual(sidewalk.bounds.maxX);
    expect(street.farFrontX).toBeGreaterThan(street.road.maxX);
    expect(street.crossingZ).toBeGreaterThan(street.road.minZ);
    expect(street.crossingZ).toBeLessThan(street.road.maxZ);
  });
});

describe("OFFICE_LAYOUT building", () => {
  const room = (id: string) => {
    const found = OFFICE_LAYOUT.rooms.find((candidate) => candidate.id === id);
    if (found === undefined) {
      throw new Error(`the shipped layout has no ${id}`);
    }
    return found;
  };
  const doorway = (id: string) => {
    const found = OFFICE_LAYOUT.doorways.find((candidate) => candidate.id === id);
    if (found === undefined) {
      throw new Error(`the shipped layout has no ${id}`);
    }
    return found;
  };

  it("puts a ceiling over the whole floor at the height of its walls, out of everyone's reach", () => {
    const walls = OFFICE_LAYOUT.walls.filter((spec) => spec.style !== "railing");
    expect(OFFICE_LAYOUT.ceiling).toBe(Math.max(...walls.map((spec) => spec.height)));
    for (const board of OFFICE_LAYOUT.boards) {
      expect(board.elevation + board.height, board.id).toBeLessThan(OFFICE_LAYOUT.ceiling ?? 0);
    }
    for (const lift of OFFICE_LAYOUT.lifts) {
      expect(lift.height, lift.id).toBeLessThan(OFFICE_LAYOUT.ceiling ?? 0);
    }
  });

  /**
   * The way in, in the order a visitor meets it: off the street through the
   * main entrance, past reception, down the hall to the lifts, and through
   * the door to the left of them into the office.
   */
  it("leads in from the street past reception to the lifts, with the office door to their left", () => {
    const lobby = room(LOBBY_ROOM_ID);
    const entrance = doorway("door-entrance");
    const office = doorway("door-office");
    expect([...entrance.connects].sort()).toEqual([LOBBY_ROOM_ID, SIDEWALK_ROOM_ID].sort());
    expect([...office.connects].sort()).toEqual([LOBBY_ROOM_ID, OPEN_FLOOR_ROOM_ID].sort());

    const reception = OFFICE_LAYOUT.props.find((spec) => spec.kind === "reception");
    expect(reception && roomAt(OFFICE_LAYOUT, reception)?.id).toBe(LOBBY_ROOM_ID);
    expect(OFFICE_LAYOUT.lifts.length).toBeGreaterThan(0);
    for (const lift of OFFICE_LAYOUT.lifts) {
      expect(lift.roomId).toBe(LOBBY_ROOM_ID);
      // Further in from the street than reception.
      expect(Math.abs(lift.x - entrance.centre.x)).toBeGreaterThan(Math.abs((reception?.x ?? 0) - entrance.centre.x));
      // Facing the lifts, left is a quarter turn anticlockwise from the way they face back.
      const facing = { x: Math.sin(lift.yaw), z: Math.cos(lift.yaw) };
      const left = { x: facing.z, z: -facing.x };
      const toDoor = { x: office.centre.x - lift.x, z: office.centre.z - lift.z };
      expect(left.x * toDoor.x + left.z * toDoor.z, lift.id).toBeGreaterThan(lift.width);
    }
    expect(containsPoint(lobby.bounds, { x: entrance.centre.x - 1, z: entrance.centre.z })).toBe(true);

    // And the whole way can be walked, from the pavement to the desks.
    const pavement = waypoint("wp-sidewalk-door");
    walkRoute(pavement, routeBetween("wp-sidewalk-door", "wp-lobby-lifts"));
    walkRoute(waypoint("wp-lobby-lifts"), routeBetween("wp-lobby-lifts", "wp-floor-aisle-north"));
  });

  it("furnishes the lounge with a sofa, armchairs and a coffee table, and hangs both sticker boards there", () => {
    const inLounge = OFFICE_LAYOUT.props.filter((spec) => roomAt(OFFICE_LAYOUT, spec)?.id === LOUNGE_ROOM_ID);
    const kinds = inLounge.map((spec) => spec.kind);
    expect(kinds.filter((kind) => kind === "sofa")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "armchair")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "coffeeTable")).toHaveLength(1);
    expect(
      OFFICE_LAYOUT.boards.filter((board) => board.roomId === LOUNGE_ROOM_ID).map((board) => board.id).sort(),
    ).toEqual([ISSUES_STICKER_BOARD_ID, PULL_REQUESTS_STICKER_BOARD_ID].sort());
  });

  it("seats the conference room's table down both sides, with a sideboard along a wall", () => {
    const table = OFFICE_LAYOUT.desks.find((spec) => spec.meeting === true);
    expect(table && roomAt(OFFICE_LAYOUT, table)?.id).toBe("meeting-room");
    const sideboard = OFFICE_LAYOUT.props.find((spec) => spec.kind === "sideboard");
    expect(sideboard && roomAt(OFFICE_LAYOUT, sideboard)?.id).toBe("meeting-room");
  });

  it("gives the CEO and the AI manager an office each, side by side, off the open floor", () => {
    const ceo = room("ceo-office");
    const manager = room(MANAGER_OFFICE_ROOM_ID);
    expect(ceo.bounds.minZ).toBe(manager.bounds.minZ);
    expect(ceo.bounds.maxZ).toBe(manager.bounds.maxZ);
    expect(manager.bounds.minX - ceo.bounds.maxX).toBeCloseTo(MIN_OBSTACLE_THICKNESS);
    expect(doorway("door-ceo").connects).toContain(OPEN_FLOOR_ROOM_ID);
    expect(doorway("door-manager").connects).toContain(OPEN_FLOOR_ROOM_ID);
  });
});
