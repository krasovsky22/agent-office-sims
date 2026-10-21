/**
 * The props are data, and these are the claims the client is allowed to make
 * about that data: that it is derived from the floor plan rather than typed out,
 * that nothing is placed inside a wall, and — the one the renderer's cost rests
 * on — that the number of batches a populated office draws does not grow with the
 * number of props in it.
 *
 * Expressed against the real {@link OFFICE_LAYOUT} wherever possible, for the
 * same reason the collision tests are: furniture that is correct about an
 * invented room and wrong about the shipped one is not useful.
 */

import { describe, expect, it } from "vitest";

import {
  INTERACTION_KIND,
  OFFICE_LAYOUT,
  OPEN_FLOOR_ROOM_ID,
  type DeskSpec,
  type OfficeLayout,
  interactables,
  localToWorld,
} from "./layout.js";
import {
  OFFICE_PROPS,
  type AssetPropKind,
  derivedProps,
  describePropProblems,
  groupPropsByKind,
  doorwayGaps,
  monitorOfSeat,
  onWalkway,
} from "./props.js";

function kinds(props: readonly { kind: AssetPropKind }[]): Set<AssetPropKind> {
  return new Set(props.map((prop) => prop.kind));
}

function countOf(kind: AssetPropKind, props: readonly { kind: AssetPropKind }[]): number {
  return props.filter((prop) => prop.kind === kind).length;
}

/** The shipped layout with its desk list swapped, to prove derivation. */
function withDesks(desks: readonly DeskSpec[]): OfficeLayout {
  return { ...OFFICE_LAYOUT, desks };
}

describe("the shipped office's props", () => {
  it("places nothing inside an obstacle or off the floor", () => {
    expect(describePropProblems(OFFICE_LAYOUT, OFFICE_PROPS)).toEqual([]);
  });

  it("covers every kind the asset kit has to supply", () => {
    expect([...kinds(OFFICE_PROPS)].sort()).toEqual([
      "armchair",
      "cabinet",
      "chair",
      "coffee",
      "coffeeTable",
      "desk",
      "diningChair",
      "door",
      "microwave",
      "monitor",
      "plant",
      "radio",
      "reception",
      "sideboard",
      "sofa",
      "table",
    ]);
  });

  it("stands each piece of tabletop dressing on top of the prop it names", () => {
    expect(OFFICE_LAYOUT.tabletop.length).toBeGreaterThan(0);
    for (const item of OFFICE_LAYOUT.tabletop) {
      const base = OFFICE_LAYOUT.props.find((spec) => spec.id === item.on);
      const prop = OFFICE_PROPS.find((candidate) => candidate.id === `prop-${item.id}`);
      expect(base, item.id).toBeDefined();
      expect(prop?.kind).toBe(item.kind);
      expect(prop?.y).toBe(base?.height);
    }
  });

  it("gives every desk in the layout a desk prop, or a table for a meeting table, fitted to its collision box", () => {
    const meetingTables = OFFICE_LAYOUT.desks.filter((spec) => spec.meeting === true);
    expect(meetingTables.length).toBeGreaterThan(0);
    expect(countOf("desk", OFFICE_PROPS)).toBe(OFFICE_LAYOUT.desks.length - meetingTables.length);

    for (const spec of OFFICE_LAYOUT.desks) {
      const prop = OFFICE_PROPS.find((candidate) => candidate.id === `prop-${spec.id}`);
      expect(prop, spec.id).toBeDefined();
      expect(prop?.kind, spec.id).toBe(spec.meeting === true ? "table" : "desk");
      expect(prop?.fit).toEqual({ width: spec.width, depth: spec.depth, height: spec.height });
      expect(prop?.x).toBe(spec.x);
      expect(prop?.z).toBe(spec.z);
      expect(prop?.yaw).toBe(spec.yaw);
    }
  });

  it("seats a workstation desk once and the meeting table down both sides", () => {
    const seats = (deskId: string) =>
      OFFICE_PROPS.filter((prop) => prop.kind === "chair" && prop.id.startsWith(`prop-${deskId}-`));

    expect(seats("desk-north-1")).toHaveLength(1);
    expect(seats("desk-ceo")).toHaveLength(1);
    expect(seats("table-meeting")).toHaveLength(8);
  });

  it("stands every monitor on a desktop, facing its seat, and none on the meeting table", () => {
    const monitors = OFFICE_PROPS.filter((prop) => prop.kind === "monitor");
    const meetingChairs = OFFICE_PROPS.filter(
      (prop) => prop.kind === "chair" && prop.id.startsWith("prop-table-meeting-"),
    );
    expect(monitors.length).toBe(countOf("chair", OFFICE_PROPS) - meetingChairs.length);
    expect(monitors.some((prop) => prop.id.startsWith("prop-table-meeting-"))).toBe(false);

    const deskHeights = new Set(OFFICE_LAYOUT.desks.map((spec) => spec.height));
    for (const monitor of monitors) {
      expect(deskHeights.has(monitor.y), monitor.id).toBe(true);
    }

    // desk-north-1 faces -Z, so its screen sits on the far side from the seat.
    const desk = OFFICE_LAYOUT.desks.find((spec) => spec.id === "desk-north-1");
    const screen = OFFICE_PROPS.find((prop) => prop.id === "prop-desk-north-1-monitor-1");
    const chair = OFFICE_PROPS.find((prop) => prop.id === "prop-desk-north-1-chair-1");
    expect(screen?.z).toBeLessThan(desk?.z ?? 0);
    expect(chair?.z).toBeGreaterThan(desk?.z ?? 0);
    expect(screen?.yaw).toBeCloseTo(Math.PI);
    expect(chair?.yaw).toBeCloseTo(0);
  });

  it("finds a door frame in each doorway gap and none in the open thoroughfare", () => {
    const doors = OFFICE_PROPS.filter((prop) => prop.kind === "door");
    // Every doorway in the plan is a gap between two walls, so each gets one,
    // and the lounge, open to the floor along its whole side, gets none.
    expect(doors).toHaveLength(OFFICE_LAYOUT.doorways.length);

    // The CEO office's doorway onto the open floor, which is also where the
    // navigation waypoints put their door node.
    const ceoDoor = doors.find((prop) => prop.id === "prop-door-wall-ceo-south-west");
    expect(ceoDoor?.x).toBeCloseTo(-5.4);
    expect(ceoDoor?.z).toBeCloseTo(-4.85);
    expect(ceoDoor?.fit?.width).toBeCloseTo(1.4);

    // The wall it spans runs east-west, so the frame is not turned, and it is
    // as thick as that wall.
    expect(ceoDoor?.yaw).toBeCloseTo(0);
    expect(ceoDoor?.fit?.depth).toBeCloseTo(0.3);
  });

  it("fits each door frame to the gap it fills, not to a written-down size", () => {
    const SHRINK = 0.8;
    const narrowed = {
      ...OFFICE_LAYOUT,
      walls: OFFICE_LAYOUT.walls.map((spec) =>
        spec.id === "wall-ceo-south-east"
          ? { ...spec, footprint: { ...spec.footprint, minX: spec.footprint.minX - SHRINK } }
          : spec,
      ),
    };

    const original = OFFICE_PROPS.find((prop) => prop.id === "prop-door-wall-ceo-south-west");
    const door = derivedProps(narrowed).find((prop) => prop.id === "prop-door-wall-ceo-south-west");
    expect(door?.fit?.width).toBeCloseTo((original?.fit?.width ?? 0) - SHRINK);
    expect(door?.z).toBeCloseTo(-4.85);
  });

  it("stands one plant in each room, never two in the same corner of the floor", () => {
    const plants = OFFICE_PROPS.filter((prop) => prop.kind === "plant");
    // All but the open floor, whose every corner is on one of its walkways.
    expect(plants.map((plant) => plant.id).sort()).toEqual(
      OFFICE_LAYOUT.rooms
        .filter((room) => room.id !== OPEN_FLOOR_ROOM_ID)
        .map((room) => `prop-plant-${room.id}`)
        .sort(),
    );

    const corners = new Set(plants.map((plant) => `${plant.x},${plant.z}`));
    expect(corners.size).toBe(plants.length);
  });
});

describe("prop derivation", () => {
  it("follows the layout rather than a hardcoded desk list", () => {
    const one = derivedProps(withDesks([OFFICE_LAYOUT.desks[0]!]));
    const many = derivedProps(OFFICE_LAYOUT);

    expect(countOf("desk", one)).toBe(1);
    expect(countOf("desk", many)).toBe(OFFICE_LAYOUT.desks.filter((spec) => spec.meeting !== true).length);
  });

  it("furnishes a desk the shipped layout has never seen", () => {
    const invented: DeskSpec = {
      id: "desk-invented",
      x: 0,
      z: 2.5,
      yaw: 0,
      width: 1.6,
      depth: 0.8,
      height: 0.75,
    };
    const props = derivedProps(withDesks([invented]));

    expect(props.filter((prop) => prop.kind === "desk")).toHaveLength(1);
    expect(props.filter((prop) => prop.kind === "chair")).toHaveLength(1);
    expect(props.filter((prop) => prop.kind === "monitor")).toHaveLength(1);
    expect(describePropProblems(withDesks([invented]), props)).toEqual([]);
  });

  it("reports a prop that a layout change has walled in", () => {
    // Swallow whichever room corner a plant stands in.
    const plant = OFFICE_PROPS.find((prop) => prop.kind === "plant");
    expect(plant).toBeDefined();
    const swallowed = {
      ...OFFICE_LAYOUT,
      walls: [
        ...OFFICE_LAYOUT.walls,
        {
          id: "wall-invented",
          footprint: { minX: plant!.x - 1, minZ: plant!.z - 1, maxX: plant!.x + 1, maxZ: plant!.z + 1 },
          height: 3,
        },
      ],
    };

    expect(describePropProblems(swallowed, [plant!])).toEqual([
      `prop ${plant!.id} stands inside an obstacle at (${plant!.x}, ${plant!.z})`,
    ]);
  });
});

describe("walkways", () => {
  it("counts every doorway, either side of its wall, as walkway", () => {
    for (const door of OFFICE_LAYOUT.doorways) {
      const across = door.axis === "x" ? { x: 0, z: 0.8 } : { x: 0.8, z: 0 };
      expect(onWalkway(OFFICE_LAYOUT, door.centre), door.id).toBe(true);
      expect(onWalkway(OFFICE_LAYOUT, { x: door.centre.x + across.x, z: door.centre.z + across.z }), door.id).toBe(true);
      expect(onWalkway(OFFICE_LAYOUT, { x: door.centre.x - across.x, z: door.centre.z - across.z }), door.id).toBe(true);
    }
  });

  it("counts every carpet runner and every link of the nav graph as walkway", () => {
    for (const carpet of OFFICE_LAYOUT.carpets) {
      const { footprint } = carpet;
      expect(onWalkway(OFFICE_LAYOUT, { x: (footprint.minX + footprint.maxX) / 2, z: (footprint.minZ + footprint.maxZ) / 2 })).toBe(true);
    }
    const byId = new Map(OFFICE_LAYOUT.waypoints.map((waypoint) => [waypoint.id, waypoint]));
    for (const waypoint of OFFICE_LAYOUT.waypoints) {
      for (const link of waypoint.links) {
        const other = byId.get(link)!;
        const middle = { x: (waypoint.x + other.x) / 2, z: (waypoint.z + other.z) / 2 };
        expect(onWalkway(OFFICE_LAYOUT, middle), `${waypoint.id} to ${link}`).toBe(true);
      }
    }
  });

  it("never stands a plant in a doorway or on a walkway, the kitchen's included", () => {
    const plants = OFFICE_PROPS.filter((prop) => prop.kind === "plant");
    for (const plant of plants) {
      expect(onWalkway(OFFICE_LAYOUT, plant), plant.id).toBe(false);
    }
    const kitchenDoor = OFFICE_LAYOUT.doorways.find((door) => door.id === "door-kitchen")!;
    const kitchenPlant = plants.find((plant) => plant.id === "prop-plant-kitchen")!;
    expect(Math.hypot(kitchenPlant.x - kitchenDoor.centre.x, kitchenPlant.z - kitchenDoor.centre.z)).toBeGreaterThan(2);
  });

  it("reports a free-standing prop left in a doorway", () => {
    const door = OFFICE_LAYOUT.doorways.find((spec) => spec.id === "door-kitchen")!;
    const plant = { id: "prop-plant-stray", kind: "plant" as const, x: door.centre.x + 0.9, y: 0, z: door.centre.z, yaw: 0 };
    expect(describePropProblems(OFFICE_LAYOUT, [plant])).toContain(
      `prop ${plant.id} stands in a doorway or walkway at (${plant.x}, ${plant.z})`,
    );
  });
});

describe("doorwayGaps", () => {
  it("finds one gap per doorway the layout names, centred on it and as wide", () => {
    const gaps = doorwayGaps(OFFICE_LAYOUT);
    expect(gaps).toHaveLength(OFFICE_LAYOUT.doorways.length);
    for (const door of OFFICE_LAYOUT.doorways) {
      const gap = gaps.find((candidate) => Math.hypot(candidate.x - door.centre.x, candidate.z - door.centre.z) < 1e-6);
      expect(gap, door.id).toBeDefined();
      expect(gap!.width).toBeCloseTo(door.width);
      expect(gap!.frameHeight).toBeLessThan(gap!.wallHeight);
    }
  });
});

describe("monitorOfSeat", () => {
  const seats = interactables(OFFICE_LAYOUT).filter((spec) => spec.kind === INTERACTION_KIND.seat);

  it("pairs seat-<desk>-<n> with prop-<desk>-monitor-<n>", () => {
    const seat = seats[0]!;
    const monitor = monitorOfSeat(OFFICE_LAYOUT, seat.id);

    expect(monitor?.id).toBe(seat.id.replace(/^seat-(.+)-(\d+)$/, "prop-$1-monitor-$2"));
    expect(monitor?.kind).toBe("monitor");
  });

  it("gives every workstation seat in the office its own monitor, on its own desk, in front of it", () => {
    const monitors = new Set<string>();
    const meeting = (deskId: string | undefined) =>
      OFFICE_LAYOUT.desks.find((spec) => spec.id === deskId)?.meeting === true;
    const workSeats = seats.filter((seat) => !meeting(seat.deskId));
    for (const seat of seats.filter((candidate) => meeting(candidate.deskId))) {
      expect(monitorOfSeat(OFFICE_LAYOUT, seat.id), seat.id).toBeUndefined();
    }
    for (const seat of workSeats) {
      const monitor = monitorOfSeat(OFFICE_LAYOUT, seat.id);
      expect(monitor, seat.id).toBeDefined();
      monitors.add(monitor!.id);

      const desk = OFFICE_LAYOUT.desks.find((spec) => spec.id === seat.deskId)!;
      // Seat and monitor share a column across the desk, on opposite sides of it.
      const seatLocal = localToWorld({ x: 0, z: 0 }, -desk.yaw, seat.anchor.x - desk.x, seat.anchor.z - desk.z);
      const monitorLocal = localToWorld({ x: 0, z: 0 }, -desk.yaw, monitor!.x - desk.x, monitor!.z - desk.z);
      expect(monitorLocal.x, seat.id).toBeCloseTo(seatLocal.x);
      expect(Math.sign(monitorLocal.z), seat.id).toBe(-Math.sign(seatLocal.z));
    }
    expect(monitors.size).toBe(workSeats.length);
  });

  it("follows the layout, not the shipped desks", () => {
    const invented: DeskSpec = { id: "desk-invented", x: 0, z: 6.5, yaw: 0, width: 1.6, depth: 0.8, height: 0.75 };
    const layout = withDesks([invented]);

    expect(monitorOfSeat(layout, "seat-desk-invented-1")).toMatchObject({
      id: "prop-desk-invented-monitor-1",
      y: invented.height,
    });
    expect(monitorOfSeat(OFFICE_LAYOUT, "seat-desk-invented-1")).toBeUndefined();
  });

  it("has nothing for an id that is not a desk's seat", () => {
    const coffee = interactables(OFFICE_LAYOUT).find((spec) => spec.kind === INTERACTION_KIND.coffee)!;

    expect(monitorOfSeat(OFFICE_LAYOUT, coffee.id)).toBeUndefined();
    expect(monitorOfSeat(OFFICE_LAYOUT, "")).toBeUndefined();
    expect(monitorOfSeat(OFFICE_LAYOUT, `${seats[0]!.id}9`)).toBeUndefined();
  });
});

describe("the renderer's batching plan", () => {
  it("groups every prop under its own kind, losing none", () => {
    const batches = groupPropsByKind(OFFICE_PROPS);
    const total = [...batches.values()].reduce((sum, batch) => sum + batch.length, 0);

    expect(total).toBe(OFFICE_PROPS.length);
    expect(new Set(batches.keys())).toEqual(kinds(OFFICE_PROPS));
  });

  /**
   * This is the acceptance criterion the issue states as a draw-call count: the
   * client draws one instanced batch per kind per material, so if the batch count
   * is flat across desk counts the draw-call count is too.
   */
  it("does not grow a batch when the office grows desks", () => {
    const rows = (count: number): DeskSpec[] =>
      Array.from({ length: count }, (_unused, index) => ({
        id: `desk-row-${index}`,
        // Spread along the bullpen aisle; exact spacing does not matter here.
        x: -7.5 + index * 0.9,
        z: 6.5,
        yaw: 0,
        width: 0.8,
        depth: 0.8,
        height: 0.75,
      }));

    const few = groupPropsByKind(derivedProps(withDesks(rows(2))));
    const lots = groupPropsByKind(derivedProps(withDesks(rows(60))));

    expect(lots.size).toBe(few.size);
    expect(lots.get("desk")).toHaveLength(60);
    expect(few.get("desk")).toHaveLength(2);
  });
});
