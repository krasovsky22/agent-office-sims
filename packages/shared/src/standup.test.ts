/**
 * The standup's shared rules: only the CEO runs one, the places the agents
 * stand at in the manager's room, the direction parser, and the standup's
 * state as a browser decodes it.
 */

import { Encoder, Reflection } from "@colyseus/schema";
import { describe, expect, it } from "vitest";

import { isBlocked } from "./collision.js";
import { OCCUPANT_RADIUS } from "./constants.js";
import { INTERACTION_KIND, OFFICE_LAYOUT, interactables, roomAt } from "./layout.js";
import { managerSeat } from "./manager.js";
import { parseStandupDirectMessage } from "./messages.js";
import { findPath } from "./nav.js";
import { MAX_RUNNER_SLOTS } from "./runner.js";
import { STANDUP_EVERYONE, mayRunStandup, standupSpots } from "./standup.js";
import { OCCUPANT_KIND, OfficeState, StandupDirection, StandupUpdate } from "./state.js";

describe("mayRunStandup", () => {
  it("lets the CEO alone call, end or speak at a standup", () => {
    expect(mayRunStandup({ id: "a", kind: OCCUPANT_KIND.human, isCeo: true, canTakeIssues: false })).toBe(true);
    expect(mayRunStandup({ id: "b", kind: OCCUPANT_KIND.human, isCeo: false, canTakeIssues: false })).toBe(false);
    expect(mayRunStandup({ id: "c", kind: OCCUPANT_KIND.liveAgent, isCeo: false, canTakeIssues: true })).toBe(false);
  });
});

describe("standupSpots", () => {
  const spots = standupSpots(OFFICE_LAYOUT);
  const seat = managerSeat(OFFICE_LAYOUT);
  const desk = interactables(OFFICE_LAYOUT).find((spec) => spec.kind === INTERACTION_KIND.manager);

  it("has a place for every agent the floor can hold: an orchestrator's dozen and the runners' slots", () => {
    expect(spots.length).toBeGreaterThanOrEqual(12 + MAX_RUNNER_SLOTS);
  });

  it("puts every place in the manager's room, clear of everything, with room between them", () => {
    for (const spot of spots) {
      expect(roomAt(OFFICE_LAYOUT, spot)?.id).toBe(roomAt(OFFICE_LAYOUT, desk?.anchor ?? spot)?.id);
      expect(isBlocked(spot, OCCUPANT_RADIUS, OFFICE_LAYOUT)).toBe(false);
      for (const other of spots) {
        if (other !== spot) {
          expect(Math.hypot(other.x - spot.x, other.z - spot.z)).toBeGreaterThanOrEqual(OCCUPANT_RADIUS * 2);
        }
      }
    }
  });

  it("leaves the CEO's place at the desk free, and can be walked to from the open floor", () => {
    for (const spot of spots) {
      expect(Math.hypot((desk?.anchor.x ?? 0) - spot.x, (desk?.anchor.z ?? 0) - spot.z)).toBeGreaterThan(0.7);
      expect(findPath({ x: -1.4, z: -0.2 }, spot, OFFICE_LAYOUT).length).toBeGreaterThan(0);
    }
  });

  it("turns everyone to face the manager in its chair, nearest the desk first", () => {
    const toSeat = (spot: { x: number; z: number }) => Math.hypot((seat?.anchor.x ?? 0) - spot.x, (seat?.anchor.z ?? 0) - spot.z);
    for (const spot of spots) {
      const facing = { x: -Math.sin(spot.yaw), z: -Math.cos(spot.yaw) };
      const towards = { x: (seat?.anchor.x ?? 0) - spot.x, z: (seat?.anchor.z ?? 0) - spot.z };
      const length = Math.hypot(towards.x, towards.z);
      expect(facing.x * (towards.x / length) + facing.z * (towards.z / length)).toBeGreaterThan(0.99);
    }
    expect(toSeat(spots[0] ?? { x: 0, z: 0 })).toBeLessThan(toSeat(spots.at(-1) ?? { x: 0, z: 0 }));
  });
});

describe("parseStandupDirectMessage", () => {
  it("takes a direction for one agent or for everyone, as a prompt's text", () => {
    expect(parseStandupDirectMessage({ agentId: "agent:runner:box:slot-1", text: "  Open the PR.\r\nThanks\u001b[2J " })).toEqual({
      agentId: "agent:runner:box:slot-1",
      text: "Open the PR.\nThanks[2J",
    });
    expect(parseStandupDirectMessage({ agentId: STANDUP_EVERYONE, text: "Wrap up." })).toEqual({ agentId: "", text: "Wrap up." });
  });

  it.each([
    ["no payload", undefined],
    ["no agent", { text: "Go." }],
    ["an agent id too long to be one", { agentId: "x".repeat(200), text: "Go." }],
    ["nothing legible", { agentId: "", text: "\u0007 \t" }],
    ["text past a prompt's length", { agentId: "", text: "x".repeat(2001) }],
  ])("refuses %s", (_case, raw) => {
    expect(parseStandupDirectMessage(raw)).toBeUndefined();
  });
});

describe("the standup's state", () => {
  it("reaches a client whole: who called it, the order, the updates and the directions", () => {
    const state = new OfficeState();
    const { standup } = state;
    standup.active = true;
    standup.calledBy = "Dana";
    standup.order.push("agent:one", "agent:two");
    standup.speakerId = "agent:one";
    const update = new StandupUpdate();
    update.agentId = "agent:one";
    update.agentName = "Claude 1";
    update.workedOn = "#39 “Night shift”, in progress";
    update.blockers = "waiting on you: Permission: Bash git push";
    update.needsYou = true;
    standup.updates.push(update);
    const direction = new StandupDirection();
    direction.id = 1;
    direction.agentName = "Claude 1";
    direction.text = "Open the PR.";
    direction.status = "queued";
    standup.directions.push(direction);
    const encoder = new Encoder(state);

    const decoder = Reflection.decode<OfficeState>(Reflection.encode(encoder));
    decoder.decode(encoder.encodeAll());

    expect(decoder.state.standup.toJSON()).toMatchObject({
      active: true,
      calledBy: "Dana",
      order: ["agent:one", "agent:two"],
      speakerId: "agent:one",
      updates: [{ agentName: "Claude 1", blockers: "waiting on you: Permission: Bash git push", needsYou: true, resolved: false }],
      directions: [{ id: 1, agentName: "Claude 1", text: "Open the PR.", status: "queued" }],
    });
  });

  it("starts with no standup ever held", () => {
    expect(new OfficeState().standup.toJSON()).toMatchObject({ active: false, calledBy: "", order: [], updates: [], directions: [] });
  });
});
