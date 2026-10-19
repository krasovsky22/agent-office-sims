/**
 * The standup's shared rules: only the CEO runs one, the places the agents
 * take in the conference room, the direction parser, and the standup's
 * state as a browser decodes it.
 */

import { Encoder, Reflection } from "@colyseus/schema";
import { describe, expect, it } from "vitest";

import { isBlocked } from "./collision.js";
import { OCCUPANT_RADIUS } from "./constants.js";
import { interactableById } from "./interaction.js";
import { INTERACTION_KIND, OFFICE_LAYOUT, interactables, roomAt } from "./layout.js";
import { parseStandupDirectMessage } from "./messages.js";
import { MAX_LIVE_AGENTS } from "./liveAgents.js";
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

const CONFERENCE_ROOM_ID = "meeting-room";

describe("standupSpots", () => {
  const spots = standupSpots(OFFICE_LAYOUT);
  const chairs = spots.filter((spot) => spot.seatId !== "");
  const standing = spots.filter((spot) => spot.seatId === "");
  const table = OFFICE_LAYOUT.desks.find((desk) => desk.meeting === true);

  it("has a place for every agent the floor can hold: an orchestrator's live agents and the runners' slots", () => {
    expect(spots.length).toBeGreaterThanOrEqual(MAX_LIVE_AGENTS + MAX_RUNNER_SLOTS);
  });

  it("hands out every conference chair first, each at the chair's own pose", () => {
    const tableSeats = interactables(OFFICE_LAYOUT).filter((spec) => spec.kind === INTERACTION_KIND.seat && spec.deskId === table?.id);
    expect(tableSeats.length).toBeGreaterThan(0);
    expect(chairs.map((spot) => spot.seatId)).toEqual(tableSeats.map((seat) => seat.id));
    expect(spots.slice(0, chairs.length)).toEqual(chairs);
    for (const spot of chairs) {
      const seat = interactableById(OFFICE_LAYOUT, spot.seatId);
      expect(spot).toMatchObject({ x: seat?.anchor.x, z: seat?.anchor.z });
      expect(Math.cos(spot.yaw - (seat?.anchor.yaw ?? Number.NaN))).toBeCloseTo(1);
    }
  });

  it("puts every place in the conference room, a standing one clear of everything, with room between them", () => {
    for (const spot of spots) {
      expect(roomAt(OFFICE_LAYOUT, spot)?.id).toBe(CONFERENCE_ROOM_ID);
      for (const other of spots) {
        if (other !== spot) {
          expect(Math.hypot(other.x - spot.x, other.z - spot.z)).toBeGreaterThanOrEqual(OCCUPANT_RADIUS * 2);
        }
      }
    }
    expect(standing.length).toBeGreaterThan(0);
    for (const spot of standing) {
      expect(isBlocked(spot, OCCUPANT_RADIUS, OFFICE_LAYOUT)).toBe(false);
    }
  });

  it("can be walked to from the open floor: a chair from behind it, a standing place itself", () => {
    for (const spot of spots) {
      const target = spot.seatId === "" ? spot : interactableById(OFFICE_LAYOUT, spot.seatId)?.exit;
      expect(target).toBeDefined();
      expect(findPath({ x: -0.6, z: -0.2 }, target ?? spot, OFFICE_LAYOUT).length).toBeGreaterThan(0);
    }
  });

  it("turns everyone standing to face the table", () => {
    for (const spot of standing) {
      const facing = { x: -Math.sin(spot.yaw), z: -Math.cos(spot.yaw) };
      const towards = { x: (table?.x ?? 0) - spot.x, z: (table?.z ?? 0) - spot.z };
      const length = Math.hypot(towards.x, towards.z);
      expect(facing.x * (towards.x / length) + facing.z * (towards.z / length)).toBeGreaterThan(0.99);
    }
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
