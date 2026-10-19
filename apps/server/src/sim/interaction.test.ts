/**
 * The server half of interaction: what the room does with an interact request
 * once the shared rule has been consulted.
 *
 * Range re-checking, desk occupancy and seat release are acceptance criteria
 * that only mean anything on the server — a modified client skips the client's
 * copy of every one of them — so they are tested here against real schema
 * occupants and the shipped floor plan, with time passed in rather than read
 * from a clock.
 */

import {
  ANIMATION_STATE,
  COFFEE_BREAK_MS,
  COFFEE_SIPS,
  COFFEE_SIP_INTERVAL_MS,
  HumanPlayer,
  INTERACT_RANGE,
  INTERACT_REFUSAL,
  OCCUPANT_RADIUS,
  OFFICE_LAYOUT,
  type InteractableSpec,
  type Occupant,
  interactableById,
  isBlocked,
  liveAgentKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { CoffeeCups } from "./coffee.js";
import {
  HoldRegistry,
  type InteractionHost,
  SERVER_INTERACT_RANGE,
  USE_COOLDOWN_MS,
  holdTick,
  releaseHold,
  requestInteract,
} from "./interaction.js";
import { type OccupantMotion, applyPose, createMotion, recordPose } from "./movement.js";

const SEAT = "seat-desk-north-3-1";
const FAR_SEAT = "seat-desk-ceo-1";
const COFFEE = "coffee-machine";
const BOARD = "project-board";
/** The screen at {@link SEAT}'s workstation. */
const SCREEN = "screen-desk-north-3-1";

function specOf(id: string): InteractableSpec {
  const spec = interactableById(OFFICE_LAYOUT, id);
  if (spec === undefined) {
    throw new Error(`the layout has no interactable ${id}`);
  }
  return spec;
}

interface Room extends InteractionHost {
  readonly occupants: Map<string, Occupant>;
  readonly motions: Map<string, OccupantMotion>;
}

function createRoom(): Room {
  return {
    layout: OFFICE_LAYOUT,
    occupants: new Map(),
    motions: new Map(),
    holds: new HoldRegistry(),
    lastUsedAt: new Map(),
    cups: new CoffeeCups(),
  };
}

/** Puts an occupant in the room, standing a given distance due south of an anchor. */
function join(room: Room, id: string, near: string, distance = 0, now = 0): HumanPlayer {
  const { anchor } = specOf(near);
  const player = new HumanPlayer();
  player.id = id;
  player.name = id;
  player.x = anchor.x;
  player.z = anchor.z + distance;
  player.yaw = 0;
  room.occupants.set(id, player);
  room.motions.set(id, createMotion(player.x, player.z, player.yaw, now));
  return player;
}

/** The replicated fields an interaction is allowed to change. */
function snapshot(player: HumanPlayer) {
  return {
    x: player.x,
    z: player.z,
    yaw: player.yaw,
    animation: player.animation,
    interactableId: player.interactableId,
  };
}

describe("requestInteract", () => {
  it("seats an occupant standing at a free desk", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT, 0.5);

    const outcome = requestInteract(room, "alice", SEAT, 1000);

    const { anchor } = specOf(SEAT);
    expect(outcome.result).toBe("held");
    expect(alice.interactableId).toBe(SEAT);
    expect(alice.animation).toBe(ANIMATION_STATE.sitting);
    expect(alice.x).toBeCloseTo(anchor.x);
    expect(alice.z).toBeCloseTo(anchor.z);
    expect(room.holds.holderOf(SEAT)).toBe("alice");
  });

  /**
   * The acceptance criterion: a client that skips its own range check and
   * asks for a desk on the far side of the office is refused, and nothing
   * about the room changes.
   */
  it("refuses an out-of-range interact with no state change", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT);
    const before = snapshot(alice);

    const outcome = requestInteract(room, "alice", FAR_SEAT, 1000);

    expect(outcome).toEqual({
      result: "refused",
      decision: { allowed: false, refusal: INTERACT_REFUSAL.outOfRange },
    });
    expect(snapshot(alice)).toEqual(before);
    expect(room.holds.holderOf(FAR_SEAT)).toBeUndefined();
    expect(room.holds.heldBy("alice")).toBeUndefined();
  });

  it("re-checks range against the pose it accepted, not one still pending", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT, SERVER_INTERACT_RANGE * 2);
    // A pose claiming to be at the anchor has arrived but not been simulated:
    // it is a claim, not a position the room has agreed to.
    const motion = room.motions.get("alice");
    const { anchor } = specOf(SEAT);
    if (motion !== undefined) {
      recordPose(motion, { x: anchor.x, z: anchor.z, yaw: 0, animation: "walking" }, 50);
    }
    const before = snapshot(alice);

    const outcome = requestInteract(room, "alice", SEAT, 50);

    expect(outcome.result).toBe("refused");
    expect(snapshot(alice)).toEqual(before);
  });

  it("allows a client that pressed the key at the edge of its prompt", () => {
    const room = createRoom();
    join(room, "alice", SEAT, INTERACT_RANGE);
    expect(requestInteract(room, "alice", SEAT, 0).result).toBe("held");
  });

  it("refuses an id the layout does not have", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT);
    const before = snapshot(alice);
    const outcome = requestInteract(room, "alice", "seat-desk-nowhere-1", 0);
    expect(outcome.result).toBe("refused");
    expect(snapshot(alice)).toEqual(before);
  });

  it("refuses a session that is not in the room", () => {
    const room = createRoom();
    expect(requestInteract(room, "ghost", SEAT, 0).result).toBe("refused");
    expect(room.holds.holderOf(SEAT)).toBeUndefined();
  });

  it("does not let two players occupy one desk", () => {
    const room = createRoom();
    join(room, "alice", SEAT);
    const bob = join(room, "bob", SEAT, 0.3);
    requestInteract(room, "alice", SEAT, 0);
    const before = snapshot(bob);

    const outcome = requestInteract(room, "bob", SEAT, 10);

    expect(outcome).toEqual({
      result: "refused",
      decision: { allowed: false, refusal: INTERACT_REFUSAL.occupied },
    });
    expect(snapshot(bob)).toEqual(before);
    expect(room.holds.holderOf(SEAT)).toBe("alice");
  });

  it("refuses a second interaction while the first is held", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT);
    requestInteract(room, "alice", SEAT, 0);
    const neighbour = "seat-desk-north-4-1";

    const outcome = requestInteract(room, "alice", neighbour, 10);

    expect(outcome.result).toBe("refused");
    expect(alice.interactableId).toBe(SEAT);
    expect(room.holds.holderOf(neighbour)).toBeUndefined();
  });

  it("uses the project board without holding anyone or changing any state", () => {
    const room = createRoom();
    const alice = join(room, "alice", BOARD);
    const before = snapshot(alice);

    const outcome = requestInteract(room, "alice", BOARD, 0);

    expect(outcome.result).toBe("used");
    expect(snapshot(alice)).toEqual(before);
    expect(room.holds.heldBy("alice")).toBeUndefined();
  });

  it("drops repeat project board uses inside the cooldown, per session, with no state change", () => {
    const room = createRoom();
    const alice = join(room, "alice", BOARD);
    const bob = join(room, "bob", BOARD, 0.5);
    expect(requestInteract(room, "alice", BOARD, 0).result).toBe("used");
    const before = snapshot(alice);

    for (let at = 1; at < USE_COOLDOWN_MS; at += 100) {
      expect(requestInteract(room, "alice", BOARD, at).result).toBe("cooling");
    }
    expect(snapshot(alice)).toEqual(before);
    expect(room.holds.heldBy("alice")).toBeUndefined();

    expect(requestInteract(room, "bob", BOARD, 10).result).toBe("used");
    expect(bob.interactableId).toBe("");
    expect(requestInteract(room, "alice", BOARD, USE_COOLDOWN_MS).result).toBe("used");
  });

  it("lets anyone watch a seated live agent's screen without holding them or the agent", () => {
    const room = createRoom();
    const agent = liveAgentKey("runner-1");
    join(room, agent, SEAT);
    expect(requestInteract(room, agent, SEAT, 0).result).toBe("held");
    const alice = join(room, "alice", SCREEN);
    const bob = join(room, "bob", SCREEN, 0.3);
    const before = snapshot(alice);

    expect(requestInteract(room, "alice", SCREEN, 0).result).toBe("used");
    expect(requestInteract(room, "bob", SCREEN, 0).result).toBe("used");
    expect(snapshot(alice)).toEqual(before);
    expect(bob.interactableId).toBe("");
    expect(room.holds.holderOf(SEAT)).toBe(agent);
  });

  it("refuses a screen nobody is working at, or only a player is sitting at, with no state change", () => {
    const room = createRoom();
    const alice = join(room, "alice", SCREEN);
    const before = snapshot(alice);
    const refused = { result: "refused", decision: { allowed: false, refusal: INTERACT_REFUSAL.notOffered } };

    expect(requestInteract(room, "alice", SCREEN, 0)).toEqual(refused);
    join(room, "bob", SEAT);
    expect(requestInteract(room, "bob", SEAT, 0).result).toBe("held");
    expect(requestInteract(room, "alice", SCREEN, USE_COOLDOWN_MS)).toEqual(refused);
    expect(snapshot(alice)).toEqual(before);
  });

  it("does not put desks or the coffee machine behind the project board cooldown", () => {
    const room = createRoom();
    join(room, "alice", SEAT);

    expect(requestInteract(room, "alice", SEAT, 0).result).toBe("held");
    releaseHold(room, "alice", 10);
    expect(requestInteract(room, "alice", SEAT, 20).result).toBe("held");
  });
});

describe("releaseHold", () => {
  it("stands the occupant up behind the chair and frees the desk", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT);
    requestInteract(room, "alice", SEAT, 0);

    expect(releaseHold(room, "alice", 500)).toBe(true);

    const { exit } = specOf(SEAT);
    expect(exit).toBeDefined();
    expect(alice.interactableId).toBe("");
    expect(alice.animation).toBe(ANIMATION_STATE.idle);
    expect(alice.x).toBeCloseTo(exit?.x ?? Number.NaN);
    expect(alice.z).toBeCloseTo(exit?.z ?? Number.NaN);
    // The chair is solid, and the occupant is let go outside it.
    expect(isBlocked(alice, OCCUPANT_RADIUS, OFFICE_LAYOUT)).toBe(false);
    expect(room.holds.holderOf(SEAT)).toBeUndefined();
  });

  it("lets somebody else sit once the desk is free", () => {
    const room = createRoom();
    join(room, "alice", SEAT);
    join(room, "bob", SEAT, 0.3);
    requestInteract(room, "alice", SEAT, 0);
    releaseHold(room, "alice", 100);

    expect(requestInteract(room, "bob", SEAT, 200).result).toBe("held");
    expect(room.holds.holderOf(SEAT)).toBe("bob");
  });

  it("is a no-op for an occupant holding nothing", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT);
    const before = snapshot(alice);
    expect(releaseHold(room, "alice", 0)).toBe(false);
    expect(snapshot(alice)).toEqual(before);
  });

  /**
   * Leaving a seat has to restore normal movement: the tick stops discarding
   * the occupant's poses, and the travel budget starts from the release rather
   * than covering however long they sat there.
   */
  it("restores normal movement after standing up", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT);
    const motion = room.motions.get("alice");
    if (motion === undefined) {
      throw new Error("alice has no motion");
    }
    requestInteract(room, "alice", SEAT, 0);
    releaseHold(room, "alice", 60_000);

    // One honest step south, sent 100ms after standing up.
    const target = { x: alice.x, z: alice.z + 0.3 };
    recordPose(motion, { ...target, yaw: Math.PI, animation: "walking" }, 60_100);
    expect(holdTick(room, "alice", 60_100)).toBe(false);
    applyPose(alice, motion, 60_100, OFFICE_LAYOUT);

    expect(alice.z).toBeCloseTo(target.z);
    expect(alice.animation).toBe(ANIMATION_STATE.walking);
  });

  /**
   * A closed tab or a dropped connection ends the session, and the room
   * releases its hold as it goes. The player who comes back is a new session
   * standing in the office, and the desk is theirs to take again.
   */
  it("frees the desk when the sitter leaves, so a rejoin can sit again", () => {
    const room = createRoom();
    join(room, "alice", SEAT);
    requestInteract(room, "alice", SEAT, 0);

    // What `onLeave` does.
    room.holds.release("alice");
    room.occupants.delete("alice");
    room.motions.delete("alice");

    const rejoined = join(room, "alice-again", SEAT, 0.2, 5000);
    expect(rejoined.interactableId).toBe("");
    expect(holdTick(room, "alice-again", 5000)).toBe(false);
    expect(requestInteract(room, "alice-again", SEAT, 5000).result).toBe("held");
  });
});

describe("holdTick", () => {
  it("keeps a sitter seated however long they stay", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT);
    requestInteract(room, "alice", SEAT, 0);
    expect(holdTick(room, "alice", 3_600_000)).toBe(true);
    expect(alice.interactableId).toBe(SEAT);
  });

  it("throws away a pose that would drag a sitter out of the chair", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT);
    const motion = room.motions.get("alice");
    if (motion === undefined) {
      throw new Error("alice has no motion");
    }
    requestInteract(room, "alice", SEAT, 0);
    recordPose(motion, { x: alice.x + 1, z: alice.z, yaw: 0, animation: "walking" }, 50);

    expect(holdTick(room, "alice", 50)).toBe(true);
    expect(motion.hasPending).toBe(false);
    expect(alice.animation).toBe(ANIMATION_STATE.sitting);
  });

  it("ends a coffee break on its own after the shared duration", () => {
    const room = createRoom();
    const alice = join(room, "alice", COFFEE);
    expect(requestInteract(room, "alice", COFFEE, 1000).result).toBe("held");
    expect(alice.interactableId).toBe(COFFEE);

    expect(holdTick(room, "alice", 1000 + COFFEE_BREAK_MS - 1)).toBe(true);
    expect(holdTick(room, "alice", 1000 + COFFEE_BREAK_MS)).toBe(false);
    expect(alice.interactableId).toBe("");
    expect(room.holds.holderOf(COFFEE)).toBeUndefined();
    // The machine has no exit, so the drinker is left standing where they poured.
    const { anchor } = specOf(COFFEE);
    expect(alice.x).toBeCloseTo(anchor.x);
    expect(alice.z).toBeCloseTo(anchor.z);
  });

  it("pours a full cup that is first sipped once the break is over", () => {
    const room = createRoom();
    const alice = join(room, "alice", COFFEE);
    requestInteract(room, "alice", COFFEE, 1000);
    expect(alice.coffeeSips).toBe(COFFEE_SIPS);

    room.cups.step(1000 + COFFEE_BREAK_MS + COFFEE_SIP_INTERVAL_MS - 1, room.occupants);
    expect(alice.coffeeSips).toBe(COFFEE_SIPS);
    room.cups.step(1000 + COFFEE_BREAK_MS + COFFEE_SIP_INTERVAL_MS, room.occupants);
    expect(alice.coffeeSips).toBe(COFFEE_SIPS - 1);
  });

  it("pours nothing at a desk", () => {
    const room = createRoom();
    const alice = join(room, "alice", SEAT, 0.5);
    requestInteract(room, "alice", SEAT, 1000);
    expect(alice.coffeeSips).toBe(0);
    expect(room.cups.isHolding("alice")).toBe(false);
  });
});

describe("HoldRegistry", () => {
  it("does not let a stale release evict whoever took the anchor next", () => {
    const holds = new HoldRegistry();
    const seat = specOf(SEAT);
    holds.take("alice", seat, 0);
    // Bob takes it without Alice's release being recorded first; the registry
    // trusts its caller, which is why authorisation happens before it.
    holds.take("bob", seat, 10);
    holds.release("alice");
    expect(holds.holderOf(SEAT)).toBe("bob");
  });

  it("drops a session's previous hold when it takes another", () => {
    const holds = new HoldRegistry();
    holds.take("alice", specOf(SEAT), 0);
    holds.take("alice", specOf(COFFEE), 10);
    expect(holds.holderOf(SEAT)).toBeUndefined();
    expect(holds.heldBy("alice")?.interactableId).toBe(COFFEE);
  });
});
