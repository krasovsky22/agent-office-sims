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

import { OFFICE_LAYOUT, type DeskSpec, type OfficeLayout } from "./layout.js";
import {
  OFFICE_PROPS,
  type PropKind,
  derivedProps,
  describePropProblems,
  groupPropsByKind,
} from "./props.js";

function kinds(props: readonly { kind: PropKind }[]): Set<PropKind> {
  return new Set(props.map((prop) => prop.kind));
}

function countOf(kind: PropKind, props: readonly { kind: PropKind }[]): number {
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
      "chair",
      "coffee",
      "desk",
      "door",
      "monitor",
      "plant",
    ]);
  });

  it("gives every desk in the layout a desk prop fitted to its collision box", () => {
    expect(countOf("desk", OFFICE_PROPS)).toBe(OFFICE_LAYOUT.desks.length);

    for (const spec of OFFICE_LAYOUT.desks) {
      const prop = OFFICE_PROPS.find((candidate) => candidate.id === `prop-${spec.id}`);
      expect(prop, spec.id).toBeDefined();
      expect(prop?.fit).toEqual({ width: spec.width, depth: spec.depth, height: spec.height });
      expect(prop?.x).toBe(spec.x);
      expect(prop?.z).toBe(spec.z);
      expect(prop?.yaw).toBe(spec.yaw);
    }
  });

  it("seats a workstation desk once and the meeting table twice", () => {
    const seats = (deskId: string) =>
      OFFICE_PROPS.filter((prop) => prop.kind === "chair" && prop.id.startsWith(`prop-${deskId}-`));

    expect(seats("desk-01")).toHaveLength(1);
    expect(seats("desk-ceo")).toHaveLength(1);
    expect(seats("table-meeting")).toHaveLength(2);
  });

  it("stands every monitor on a desktop, facing its seat", () => {
    const monitors = OFFICE_PROPS.filter((prop) => prop.kind === "monitor");
    expect(monitors.length).toBe(countOf("chair", OFFICE_PROPS));

    const deskHeights = new Set(OFFICE_LAYOUT.desks.map((spec) => spec.height));
    for (const monitor of monitors) {
      expect(deskHeights.has(monitor.y), monitor.id).toBe(true);
    }

    // desk-01 faces -Z, so its screen faces back down the floor at the seat.
    const screen = OFFICE_PROPS.find((prop) => prop.id === "prop-desk-01-monitor-1");
    const chair = OFFICE_PROPS.find((prop) => prop.id === "prop-desk-01-chair-1");
    expect(screen?.z).toBeLessThan(0);
    expect(chair?.z).toBeGreaterThan(0);
    expect(screen?.yaw).toBeCloseTo(Math.PI);
    expect(chair?.yaw).toBeCloseTo(0);
  });

  it("finds a door frame in each of the two doorways and none in the open thoroughfare", () => {
    const doors = OFFICE_PROPS.filter((prop) => prop.kind === "door");
    expect(doors).toHaveLength(2);

    const [west, east] = [...doors].sort((a, b) => a.x - b.x);

    // The two gaps the layout leaves in the CEO and meeting-room walls, which are
    // also where the navigation waypoints put their door nodes.
    expect(west?.x).toBeCloseTo(-5);
    expect(west?.z).toBeCloseTo(-5.9);
    expect(west?.fit?.width).toBeCloseTo(1.4);
    expect(east?.x).toBeCloseTo(4);
    expect(east?.z).toBeCloseTo(-5.9);
    expect(east?.fit?.width).toBeCloseTo(1.4);

    // Both frames are turned to span a wall that runs north-south, and both are
    // as thick as that wall.
    expect(west?.yaw).toBeCloseTo(Math.PI / 2);
    expect(west?.fit?.depth).toBeCloseTo(0.3);
  });

  it("fits each door frame to the gap it fills, not to a written-down size", () => {
    const narrowed = {
      ...OFFICE_LAYOUT,
      walls: OFFICE_LAYOUT.walls.map((spec) =>
        spec.id === "wall-ceo-east-south"
          ? { ...spec, footprint: { ...spec.footprint, minZ: -6 } }
          : spec,
      ),
    };

    const door = derivedProps(narrowed).find((prop) => prop.id === "prop-door-wall-ceo-east-north");
    expect(door?.fit?.width).toBeCloseTo(0.6);
    expect(door?.z).toBeCloseTo(-6.3);
  });

  it("stands one plant in each room, never two in the same corner of the floor", () => {
    const plants = OFFICE_PROPS.filter((prop) => prop.kind === "plant");
    expect(plants).toHaveLength(OFFICE_LAYOUT.rooms.length);

    const corners = new Set(plants.map((plant) => `${plant.x},${plant.z}`));
    expect(corners.size).toBe(plants.length);
  });
});

describe("prop derivation", () => {
  it("follows the layout rather than a hardcoded desk list", () => {
    const one = derivedProps(withDesks([OFFICE_LAYOUT.desks[0]!]));
    const many = derivedProps(OFFICE_LAYOUT);

    expect(countOf("desk", one)).toBe(1);
    expect(countOf("desk", many)).toBe(OFFICE_LAYOUT.desks.length);
  });

  it("furnishes a desk the shipped layout has never seen", () => {
    const invented: DeskSpec = {
      id: "desk-invented",
      x: 0,
      z: 6.5,
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
    // Swallow the bullpen's north-west corner, where its plant stands.
    const plant = OFFICE_PROPS.find((prop) => prop.id === "prop-plant-bullpen");
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
