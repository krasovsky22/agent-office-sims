/**
 * The concierge's shared half: where it stands, what counts as the lobby, and
 * the words of its welcome.
 *
 * When it says them is the server's, and tested there.
 */

import { describe, expect, it } from "vitest";

import { MAX_CHAT_LENGTH } from "./constants.js";
import {
  CONCIERGE_NAME,
  CONCIERGE_OCCUPANT_ID,
  conciergePost,
  conciergeWelcome,
  employConcierge,
  isInLobby,
} from "./concierge.js";
import { LOBBY_ROOM_ID, OFFICE_LAYOUT, type OfficeLayout, containsPoint, propAabb, roomAt } from "./layout.js";
import { MAX_NAME_LENGTH } from "./messages.js";
import { ANIMATION_STATE, OCCUPANT_KIND, isHumanPlayer } from "./state.js";

const RECEPTION = OFFICE_LAYOUT.props.find((spec) => spec.kind === "reception");

describe("the concierge's post", () => {
  it("is behind the reception desk in the lobby, facing the main entrance", () => {
    const post = conciergePost(OFFICE_LAYOUT);
    expect(post).toBeDefined();
    expect(RECEPTION).toBeDefined();
    if (post === undefined || RECEPTION === undefined) {
      return;
    }
    expect(roomAt(OFFICE_LAYOUT, post)?.id).toBe(LOBBY_ROOM_ID);
    // Not inside the desk, and on the side away from the door.
    expect(containsPoint(propAabb(RECEPTION), post)).toBe(false);
    const entrance = OFFICE_LAYOUT.doorways.find((door) => door.id === "door-entrance");
    expect(entrance).toBeDefined();
    if (entrance === undefined) {
      return;
    }
    const toDoor = Math.hypot(entrance.centre.x - post.x, entrance.centre.z - post.z);
    const deskToDoor = Math.hypot(entrance.centre.x - RECEPTION.x, entrance.centre.z - RECEPTION.z);
    expect(toDoor).toBeGreaterThan(deskToDoor);
    // Yaw 0 faces -Z, so facing the door is facing along the reversed offset to it.
    const facing = { x: -Math.sin(post.yaw), z: -Math.cos(post.yaw) };
    const offset = { x: entrance.centre.x - post.x, z: entrance.centre.z - post.z };
    expect((facing.x * offset.x + facing.z * offset.z) / toDoor).toBeGreaterThan(0.99);
  });

  it("is absent from a floor without a reception desk", () => {
    const bare: OfficeLayout = { ...OFFICE_LAYOUT, props: OFFICE_LAYOUT.props.filter((spec) => spec.kind !== "reception") };
    expect(conciergePost(bare)).toBeUndefined();
    expect(employConcierge(bare)).toBeUndefined();
  });
});

describe("employing the concierge", () => {
  it("stands it at its post as a concierge, never a player or an agent", () => {
    const concierge = employConcierge(OFFICE_LAYOUT);
    const post = conciergePost(OFFICE_LAYOUT);
    expect(concierge).toBeDefined();
    if (concierge === undefined || post === undefined) {
      return;
    }
    expect(concierge.id).toBe(CONCIERGE_OCCUPANT_ID);
    expect(concierge.name).toBe(CONCIERGE_NAME);
    expect(concierge.kind).toBe(OCCUPANT_KIND.concierge);
    expect(isHumanPlayer(concierge)).toBe(false);
    expect({ x: concierge.x, z: concierge.z }).toEqual({ x: expect.closeTo(post.x, 5), z: expect.closeTo(post.z, 5) });
    expect(concierge.yaw).toBeCloseTo(post.yaw);
    expect(concierge.animation).toBe(ANIMATION_STATE.idle);
    expect(concierge.interactableId).toBe("");
  });
});

describe("the lobby", () => {
  it("tells the lobby from the rooms either side of it, and leaves a doorway undecided", () => {
    expect(isInLobby(OFFICE_LAYOUT, { x: 10.8, z: 9.25 })).toBe(true);
    expect(isInLobby(OFFICE_LAYOUT, { x: 13.7, z: 9.25 })).toBe(false);
    expect(isInLobby(OFFICE_LAYOUT, { x: -10.6, z: 5.7 })).toBe(false);
    // The main entrance and the office door are in neither.
    expect(isInLobby(OFFICE_LAYOUT, { x: 11.85, z: 9.25 })).toBeUndefined();
    expect(isInLobby(OFFICE_LAYOUT, { x: -10.6, z: 6.65 })).toBeUndefined();
  });
});

describe("the welcome", () => {
  it("names whoever came in", () => {
    expect(conciergeWelcome("Dana")).toBe("Welcome to the office, Dana! The door left of the lifts takes you in.");
  });

  it("still welcomes someone with no legible name", () => {
    expect(conciergeWelcome(" \u0000 ")).toBe("Welcome to the office! The door left of the lifts takes you in.");
  });

  it("is never more than a chat line, whatever the name", () => {
    const line = conciergeWelcome("N".repeat(MAX_NAME_LENGTH * 4));
    expect(Array.from(line).length).toBeLessThanOrEqual(MAX_CHAT_LENGTH);
    expect(line).not.toMatch(/\p{Cc}/u);
  });
});
