/**
 * The interaction rules both sides run.
 *
 * `authorizeInteract` is the server's whole defence against a client that asks
 * for something it should not get — a desk across the room, a chair somebody
 * else is in — so it is tested here rather than only exercised in a browser.
 * Like the collision tests, every case is expressed against the real
 * {@link OFFICE_LAYOUT}: a rule that is correct about an invented chair and
 * wrong about the shipped floor plan is not useful.
 */

import { describe, expect, it } from "vitest";

import { isBlocked } from "./collision.js";
import {
  COFFEE_BREAK_MS,
  INTERACT_RANGE,
  INTERACT_RANGE_TOLERANCE,
  OCCUPANT_RADIUS,
} from "./constants.js";
import {
  INTERACT_REFUSAL,
  type InteractActor,
  authorizeInteract,
  heldAnimationFor,
  holdMsFor,
  holdsAnchor,
  interactableById,
  nearestInteractable,
  promptFor,
} from "./interaction.js";
import {
  INTERACTION_KIND,
  OFFICE_LAYOUT,
  describeLayoutProblems,
  interactables,
  workstations,
} from "./layout.js";
import { OFFICE_PROPS } from "./props.js";
import { ANIMATION_STATE } from "./state.js";

/** The range the server reaches with, as `OfficeRoom` computes it. */
const SERVER_RANGE = INTERACT_RANGE * INTERACT_RANGE_TOLERANCE;

/** Nobody is holding anything. */
const NOBODY = () => undefined;

function specOf(id: string) {
  const spec = interactableById(OFFICE_LAYOUT, id);
  if (spec === undefined) {
    throw new Error(`the layout has no interactable ${id}`);
  }
  return spec;
}

/** An actor standing a given distance due south of an interactable's anchor. */
function actorAt(id: string, distance: number, actorId = "alice"): InteractActor {
  const { anchor } = specOf(id);
  return { id: actorId, x: anchor.x, z: anchor.z + distance, interactableId: "" };
}

describe("the office's interactables", () => {
  it("satisfies the invariants a usable anchor depends on", () => {
    // Covers unique ids and every anchor being a position an occupant could
    // actually have walked to, for seats and fixtures alike.
    expect(describeLayoutProblems(OFFICE_LAYOUT)).toEqual([]);
  });

  it("rejects anything but a seat anchored inside a chair", () => {
    const seat = interactables(OFFICE_LAYOUT).find((spec) => spec.kind === INTERACTION_KIND.seat);
    const [fixture] = OFFICE_LAYOUT.fixtures;
    expect(seat).toBeDefined();
    expect(fixture).toBeDefined();
    if (seat === undefined || fixture === undefined) {
      return;
    }
    const onChair = { ...OFFICE_LAYOUT, fixtures: [{ ...fixture, anchor: seat.anchor }] };
    expect(describeLayoutProblems(onChair)).toContain(
      `interactable ${fixture.id} anchors inside an obstacle`,
    );
  });

  it("gives every chair a seat, standing exactly where the chair does", () => {
    const seats = interactables(OFFICE_LAYOUT).filter(
      (spec) => spec.kind === INTERACTION_KIND.seat,
    );
    const chairs = OFFICE_PROPS.filter((prop) => prop.kind === "chair");
    expect(seats).toHaveLength(chairs.length);
    for (const chair of chairs) {
      const seat = seats.find(
        (candidate) =>
          Math.abs(candidate.anchor.x - chair.x) < 1e-9 &&
          Math.abs(candidate.anchor.z - chair.z) < 1e-9,
      );
      expect(seat, `no seat at ${chair.id}`).toBeDefined();
      expect(seat?.anchor.yaw).toBe(chair.yaw);
    }
  });

  it("makes every chair solid, so nobody stands in a seat they are not sitting in", () => {
    for (const spec of interactables(OFFICE_LAYOUT)) {
      if (spec.kind === INTERACTION_KIND.seat) {
        expect(isBlocked(spec.anchor, OCCUPANT_RADIUS, OFFICE_LAYOUT), spec.id).toBe(true);
      }
    }
  });

  it("stands someone getting up behind the chair, clear of it and in reach of the seat", () => {
    for (const desk of OFFICE_LAYOUT.desks) {
      for (const { seat, exit } of workstations(desk)) {
        expect(isBlocked(exit, OCCUPANT_RADIUS, OFFICE_LAYOUT)).toBe(false);
        expect(Math.hypot(exit.x - seat.x, exit.z - seat.z)).toBeLessThanOrEqual(INTERACT_RANGE);
        // Behind: further from the desk than the seat is, along the way it faces.
        const forwardX = -Math.sin(seat.yaw);
        const forwardZ = -Math.cos(seat.yaw);
        expect(forwardX * (exit.x - seat.x) + forwardZ * (exit.z - seat.z)).toBeLessThan(0);
      }
    }
  });

  it("lets go where the anchor is for everything but a seat", () => {
    for (const spec of interactables(OFFICE_LAYOUT)) {
      expect(spec.exit === undefined, spec.id).toBe(spec.kind !== INTERACTION_KIND.seat);
    }
  });

  it("gives the meeting table one seat per chair rather than one in total", () => {
    const meeting = interactables(OFFICE_LAYOUT).filter((spec) =>
      spec.id.startsWith("seat-table-meeting-"),
    );
    expect(meeting.map((spec) => spec.id)).toEqual([
      "seat-table-meeting-1",
      "seat-table-meeting-2",
    ]);
  });

  it("seats the occupant clear of the desk and facing it", () => {
    for (const desk of OFFICE_LAYOUT.desks) {
      for (const { seat } of workstations(desk)) {
        // Far enough out that the chair is not inside the desk, close enough that
        // the sitter is plainly at it rather than loitering nearby.
        const reach = Math.abs(
          (seat.x - desk.x) * Math.sin(desk.yaw) + (seat.z - desk.z) * Math.cos(desk.yaw),
        );
        expect(reach).toBeGreaterThan(desk.depth / 2 + OCCUPANT_RADIUS);
        expect(reach).toBeLessThan(desk.depth / 2 + INTERACT_RANGE);
        // Facing the desk: the sitter's forward vector points back at its centre.
        const forwardX = -Math.sin(seat.yaw);
        const forwardZ = -Math.cos(seat.yaw);
        expect(forwardX * (desk.x - seat.x) + forwardZ * (desk.z - seat.z)).toBeGreaterThan(0);
      }
    }
  });

  it("stands the coffee drinker in the kitchen, facing the machine", () => {
    const coffee = specOf("coffee-machine");
    const machine = OFFICE_LAYOUT.props.find((prop) => prop.id === "coffee-machine");
    expect(coffee.kind).toBe(INTERACTION_KIND.coffee);
    expect(machine).toBeDefined();
    if (machine === undefined) {
      return;
    }
    const forwardX = -Math.sin(coffee.anchor.yaw);
    const forwardZ = -Math.cos(coffee.anchor.yaw);
    expect(
      forwardX * (machine.x - coffee.anchor.x) + forwardZ * (machine.z - coffee.anchor.z),
    ).toBeGreaterThan(0);
    expect(
      Math.hypot(machine.x - coffee.anchor.x, machine.z - coffee.anchor.z),
    ).toBeLessThan(INTERACT_RANGE);
  });
});

describe("what each interaction means", () => {
  it("holds an occupant at a desk until they get up", () => {
    const seat = specOf("seat-desk-north-3-1");
    expect(holdsAnchor(seat)).toBe(true);
    expect(holdMsFor(seat)).toBe(0);
    expect(heldAnimationFor(seat)).toBe(ANIMATION_STATE.sitting);
  });

  it("holds an occupant at the coffee machine for a fixed time", () => {
    const coffee = specOf("coffee-machine");
    expect(holdsAnchor(coffee)).toBe(true);
    expect(holdMsFor(coffee)).toBe(COFFEE_BREAK_MS);
    // No drinking clip on the rig: the cup is the visible effect, not a pose.
    expect(heldAnimationFor(coffee)).toBe(ANIMATION_STATE.idle);
  });

  it("does not hold an occupant at the project board", () => {
    const board = specOf("project-board");
    expect(holdsAnchor(board)).toBe(false);
  });

  it("names the action in every prompt", () => {
    for (const spec of interactables(OFFICE_LAYOUT)) {
      expect(promptFor(spec)).not.toBe("");
    }
  });
});

describe("nearestInteractable", () => {
  it("finds the thing you are standing at", () => {
    const seat = specOf("seat-desk-north-3-1");
    expect(nearestInteractable(OFFICE_LAYOUT, seat.anchor, INTERACT_RANGE)?.id).toBe(seat.id);
  });

  /**
   * The prompt appearing and disappearing at the documented distance is the
   * acceptance criterion, so it is pinned either side of the boundary rather
   * than approximately.
   *
   * Measured against the CEO's chair because it is a seat with nothing
   * else within range behind it. Backing away from a bullpen desk walks you
   * into the chair of the desk behind, which is the right answer to a different
   * question.
   */
  it("appears and disappears at the shared range", () => {
    const epsilon = 1e-6;
    expect(
      nearestInteractable(
        OFFICE_LAYOUT,
        actorAt("seat-desk-ceo-1", INTERACT_RANGE - epsilon),
        INTERACT_RANGE,
      )?.id,
    ).toBe("seat-desk-ceo-1");
    expect(
      nearestInteractable(
        OFFICE_LAYOUT,
        actorAt("seat-desk-ceo-1", INTERACT_RANGE + epsilon),
        INTERACT_RANGE,
      ),
    ).toBeUndefined();
  });

  it("finds nothing in the middle of the floor", () => {
    expect(nearestInteractable(OFFICE_LAYOUT, { x: 0, z: 2 }, INTERACT_RANGE)).toBeUndefined();
  });

  it("prefers the closer of two interactables", () => {
    const near = specOf("seat-desk-north-3-1");
    const far = specOf("seat-desk-north-4-1");
    const between = {
      x: near.anchor.x + (far.anchor.x - near.anchor.x) * 0.25,
      z: near.anchor.z,
    };
    const range = Math.hypot(far.anchor.x - between.x, far.anchor.z - between.z);
    // Both are inside the range used here, so the choice is about distance.
    expect(nearestInteractable(OFFICE_LAYOUT, between, range)?.id).toBe(near.id);
  });
});

describe("authorizeInteract", () => {
  it("allows an occupant standing at the anchor", () => {
    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      actorAt("seat-desk-north-3-1", 0),
      "seat-desk-north-3-1",
      SERVER_RANGE,
      NOBODY,
      NOBODY,
    );
    expect(decision).toEqual({ allowed: true, target: specOf("seat-desk-north-3-1") });
  });

  it("refuses an id the layout does not have", () => {
    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      actorAt("seat-desk-north-3-1", 0),
      "seat-desk-99",
      SERVER_RANGE,
      NOBODY,
      NOBODY,
    );
    expect(decision).toEqual({
      allowed: false,
      refusal: INTERACT_REFUSAL.unknownTarget,
    });
  });

  /**
   * The case that matters most: a client that skips its own range check and
   * asks to sit at a desk on the other side of the office. The server is
   * measuring from the pose it accepted, not from anything in the message.
   */
  it("refuses a target out of reach", () => {
    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      { id: "alice", x: 0, z: 6, interactableId: "" },
      "seat-desk-ceo-1",
      SERVER_RANGE,
      NOBODY,
      NOBODY,
    );
    expect(decision).toEqual({ allowed: false, refusal: INTERACT_REFUSAL.outOfRange });
  });

  it("reaches exactly as far as it is asked to and no further", () => {
    const epsilon = 1e-6;
    expect(
      authorizeInteract(
        OFFICE_LAYOUT,
        actorAt("seat-desk-north-3-1", SERVER_RANGE - epsilon),
        "seat-desk-north-3-1",
        SERVER_RANGE,
        NOBODY,
        NOBODY,
      ).allowed,
    ).toBe(true);
    expect(
      authorizeInteract(
        OFFICE_LAYOUT,
        actorAt("seat-desk-north-3-1", SERVER_RANGE + epsilon),
        "seat-desk-north-3-1",
        SERVER_RANGE,
        NOBODY,
        NOBODY,
      ),
    ).toEqual({ allowed: false, refusal: INTERACT_REFUSAL.outOfRange });
  });

  /**
   * The server's tolerance has to be wider than the range the client prompts
   * at, or a player who pressed the key the instant the prompt appeared would
   * be refused for a packet still in flight.
   */
  it("tolerates a client that prompted at the edge of its own range", () => {
    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      actorAt("seat-desk-north-3-1", INTERACT_RANGE),
      "seat-desk-north-3-1",
      SERVER_RANGE,
      NOBODY,
      NOBODY,
    );
    expect(decision.allowed).toBe(true);
  });

  it("refuses a desk somebody else is sitting at", () => {
    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      actorAt("seat-desk-north-3-1", 0, "bob"),
      "seat-desk-north-3-1",
      SERVER_RANGE,
      (id) => (id === "seat-desk-north-3-1" ? "alice" : undefined),
      NOBODY,
    );
    expect(decision).toEqual({ allowed: false, refusal: INTERACT_REFUSAL.occupied });
  });

  it("refuses an occupant already engaged elsewhere", () => {
    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      { ...actorAt("seat-desk-north-3-1", 0), interactableId: "seat-desk-north-4-1" },
      "seat-desk-north-3-1",
      SERVER_RANGE,
      NOBODY,
      NOBODY,
    );
    expect(decision).toEqual({ allowed: false, refusal: INTERACT_REFUSAL.alreadyEngaged });
  });

  it("refuses an out-of-range target whether or not it is taken", () => {
    const far = { id: "bob", x: 0, z: 6, interactableId: "" };
    const taken = authorizeInteract(OFFICE_LAYOUT, far, "seat-desk-ceo-1", SERVER_RANGE, () => "alice", NOBODY);
    const free = authorizeInteract(OFFICE_LAYOUT, far, "seat-desk-ceo-1", SERVER_RANGE, NOBODY, NOBODY);
    // Identical answers, so a refusal leaks nothing about who is where.
    expect(taken).toEqual(free);
    expect(taken).toEqual({ allowed: false, refusal: INTERACT_REFUSAL.outOfRange });
  });

  it("lets a second occupant read the project board while the first is reading it", () => {
    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      actorAt("project-board", 0, "bob"),
      "project-board",
      SERVER_RANGE,
      () => "alice",
      () => "agent-1",
    );
    expect(decision.allowed).toBe(true);
  });

  it("refuses a seat at a desk an agent has, though the agent is standing", () => {
    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      actorAt("seat-desk-north-3-1", 0, "bob"),
      "seat-desk-north-3-1",
      SERVER_RANGE,
      NOBODY,
      (deskId) => (deskId === "desk-north-3" ? "agent-1" : undefined),
    );
    expect(decision).toEqual({ allowed: false, refusal: INTERACT_REFUSAL.occupied });
  });

  it("leaves a desk no agent has free for players", () => {
    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      actorAt("seat-desk-north-4-1", 0, "bob"),
      "seat-desk-north-4-1",
      SERVER_RANGE,
      NOBODY,
      (deskId) => (deskId === "desk-north-3" ? "agent-1" : undefined),
    );
    expect(decision.allowed).toBe(true);
  });
});
