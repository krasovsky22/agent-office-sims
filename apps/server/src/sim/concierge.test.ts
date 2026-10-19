/**
 * When the concierge welcomes someone: once each time a player steps into the
 * lobby, from wherever they came, turned to face them and then back to the door.
 */

import {
  HumanPlayer,
  OFFICE_LAYOUT,
  type Occupant,
  conciergePost,
  conciergeWelcome,
  employConcierge,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { ConciergeDesk, WELCOME_COOLDOWN_MS, WELCOME_GAZE_MS } from "./concierge.js";

/** On the pavement, just outside the main entrance. */
const PAVEMENT = { x: 13.7, z: 9.25 };
/** In the main entrance itself, a doorway. */
const ENTRANCE = { x: 11.85, z: 9.25 };
/** Just inside the lobby, in front of reception. */
const LOBBY = { x: 10.8, z: 9.25 };
/** On the open floor, at the office door. */
const OPEN_FLOOR = { x: -10.6, z: 5.7 };
/** Through the office door, in the lobby's west end. */
const LOBBY_WEST = { x: -10.6, z: 9.4 };

interface Said {
  readonly occupantId: string;
  readonly text: string;
}

function player(id: string, name: string, at: { x: number; z: number }): HumanPlayer {
  const occupant = new HumanPlayer();
  occupant.id = id;
  occupant.name = name;
  occupant.x = at.x;
  occupant.z = at.z;
  return occupant;
}

function moveTo(occupant: Occupant, at: { x: number; z: number }): void {
  occupant.x = at.x;
  occupant.z = at.z;
}

function reception() {
  const concierge = employConcierge(OFFICE_LAYOUT);
  const post = conciergePost(OFFICE_LAYOUT);
  if (concierge === undefined || post === undefined) {
    throw new Error("the office has no reception desk");
  }
  const occupants = new Map<string, Occupant>([[concierge.id, concierge]]);
  const said: Said[] = [];
  const waves: string[] = [];
  const desk = new ConciergeDesk(
    {
      layout: OFFICE_LAYOUT,
      occupants,
      say: (occupantId, text) => said.push({ occupantId, text }),
      wave: (occupantId) => waves.push(occupantId),
    },
    concierge,
    post,
  );
  return { concierge, post, occupants, said, waves, desk };
}

describe("the concierge's welcome", () => {
  it("greets a player who walks in off the street once, by name, with a wave", () => {
    const { concierge, occupants, said, waves, desk } = reception();
    const dana = player("dana", "Dana", PAVEMENT);
    occupants.set(dana.id, dana);

    desk.step(0);
    moveTo(dana, ENTRANCE);
    desk.step(50);
    expect(said).toEqual([]);

    moveTo(dana, LOBBY);
    desk.step(100);
    expect(said).toEqual([{ occupantId: concierge.id, text: conciergeWelcome("Dana") }]);
    expect(waves).toEqual([concierge.id]);

    // Standing about in the lobby, or walking round it, is not another entry.
    for (let now = 150; now < 10_000; now += 50) {
      moveTo(dana, now % 100 === 0 ? LOBBY : { x: 6.6, z: 9.4 });
      desk.step(now);
    }
    expect(said).toHaveLength(1);
  });

  it("greets a player who comes in through the office door, and one who joins in the lobby", () => {
    const { occupants, said, desk } = reception();
    const milo = player("milo", "Milo", OPEN_FLOOR);
    occupants.set(milo.id, milo);
    desk.step(0);
    moveTo(milo, LOBBY_WEST);
    desk.step(50);

    const ada = player("ada", "Ada", LOBBY);
    occupants.set(ada.id, ada);
    desk.step(100);

    expect(said.map((line) => line.text)).toEqual([conciergeWelcome("Milo"), conciergeWelcome("Ada")]);
  });

  it("never greets anyone who is not a player", () => {
    const { occupants, said, desk } = reception();
    const agent = player("agent:w1", "Maya", LOBBY);
    agent.kind = "live-agent";
    occupants.set(agent.id, agent);
    desk.step(0);
    expect(said).toEqual([]);
  });

  it("turns to face whoever it greets, then back to the door", () => {
    const { concierge, post, occupants, desk } = reception();
    const dana = player("dana", "Dana", PAVEMENT);
    occupants.set(dana.id, dana);
    desk.step(0);
    // Off to one side of the desk, so facing her is not facing the door.
    moveTo(dana, { x: 10.8, z: 11 });
    desk.step(100);

    const facing = { x: -Math.sin(concierge.yaw), z: -Math.cos(concierge.yaw) };
    const offset = { x: dana.x - concierge.x, z: dana.z - concierge.z };
    const distance = Math.hypot(offset.x, offset.z);
    expect((facing.x * offset.x + facing.z * offset.z) / distance).toBeCloseTo(1);
    expect(concierge.yaw).not.toBeCloseTo(post.yaw);

    desk.step(100 + WELCOME_GAZE_MS - 1);
    expect(concierge.yaw).not.toBeCloseTo(post.yaw);
    desk.step(100 + WELCOME_GAZE_MS);
    expect(concierge.yaw).toBe(post.yaw);
  });

  it("greets a player again once they have left and come back, but not on every step across the threshold", () => {
    const { said, occupants, desk } = reception();
    const dana = player("dana", "Dana", PAVEMENT);
    occupants.set(dana.id, dana);
    desk.step(0);

    moveTo(dana, LOBBY);
    desk.step(100);
    moveTo(dana, PAVEMENT);
    desk.step(200);
    moveTo(dana, LOBBY);
    desk.step(300);
    expect(said).toHaveLength(1);

    moveTo(dana, PAVEMENT);
    desk.step(400);
    moveTo(dana, LOBBY);
    desk.step(100 + WELCOME_COOLDOWN_MS);
    expect(said).toHaveLength(2);
  });

  it("forgets a player who left the office, so coming back is a fresh welcome", () => {
    const { said, occupants, desk } = reception();
    const dana = player("dana", "Dana", LOBBY);
    occupants.set(dana.id, dana);
    desk.step(0);
    occupants.delete(dana.id);
    desk.step(50);
    occupants.set(dana.id, dana);
    desk.step(100);
    expect(said).toHaveLength(2);
  });
});
