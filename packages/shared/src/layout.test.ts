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
  OFFICE_LAYOUT,
  type OfficeLayout,
  type PropSpec,
  type Vec2,
  type WaypointSpec,
  containsPoint,
  describeLayoutProblems,
  interactables,
  propAabb,
  roomAt,
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

describe("OFFICE_LAYOUT rooms", () => {
  /** A node inside each room, which is what "reaching the room" means here. */
  const destinations: readonly (readonly [string, string])[] = [
    ["ceo-office", "wp-ceo-desk"],
    ["meeting-room", "wp-meeting-table"],
    ["kitchen", "wp-kitchen-coffee"],
    ["lobby", "wp-lobby-centre"],
    ["corridor", "wp-corridor-ceo"],
    ["open-floor", "wp-floor-back"],
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

    const start = "wp-floor-aisle-north";
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
    const start = "wp-floor-aisle-north";
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
    const start = "wp-floor-aisle-north";
    const atStart = walkTo(spawn, waypoint(start));

    const others = interactables(OFFICE_LAYOUT).filter((spec) => spec.exit === undefined);
    expect(others.map((spec) => spec.kind).sort()).toEqual(
      [
        INTERACTION_KIND.board,
        INTERACTION_KIND.coffee,
        INTERACTION_KIND.manager,
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
    // Just past the front face is kitchen floor; just past the back is wall.
    const reach = machine.depth / 2 + R;
    const inFront = { x: machine.x + forward.x * reach, z: machine.z + forward.z * reach };
    const behind = { x: machine.x - forward.x * reach, z: machine.z - forward.z * reach };
    expect(roomAt(OFFICE_LAYOUT, inFront)?.id).toBe("kitchen");
    expect(roomAt(OFFICE_LAYOUT, behind)).toBeUndefined();

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

  it("leaves the straight walk from the door to the coffee machine clear", () => {
    const coffee = interactables(OFFICE_LAYOUT).find((spec) => spec.id === "coffee-machine");
    expect(coffee).toBeDefined();
    if (coffee === undefined) {
      return;
    }
    const door = waypoint("wp-kitchen-door");
    const arrived = walkTo(door, coffee.anchor);
    expect(distanceBetween(arrived, coffee.anchor)).toBeLessThanOrEqual(ARRIVAL_TOLERANCE);
    // Not one of the new furnishings sits on that line, so it is clear by a body's width.
    const walk = { minX: door.x - R, minZ: coffee.anchor.z, maxX: door.x + R, maxZ: door.z };
    for (const spec of inKitchen.filter((candidate) => candidate.id !== "coffee-machine")) {
      const box = propAabb(spec);
      const overlaps =
        box.minX < walk.maxX && walk.minX < box.maxX && box.minZ < walk.maxZ && walk.minZ < box.maxZ;
      expect(overlaps, spec.id).toBe(false);
    }
  });

  it("would refuse a cabinet pushed into the wall, into a neighbour, or into the doorway", () => {
    const cabinet = kitchenProp("kitchen-cabinet-north-1");
    expect(describeLayoutProblems(withProp({ ...cabinet, z: cabinet.z - 0.1 }))).toContain(
      "prop kitchen-cabinet-north-1 overlaps wall wall-north",
    );
    expect(describeLayoutProblems(withProp({ ...cabinet, x: cabinet.x - 0.1 }))).toContain(
      "prop kitchen-cabinet-north-1 overlaps prop kitchen-cabinet-north-2",
    );
    expect(describeLayoutProblems(withProp({ ...cabinet, x: 3.15, z: -5.5 }))).toContain(
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
