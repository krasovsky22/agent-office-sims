/**
 * The standup: who may call one, where the agents stand for it, and the words
 * both sides use about it.
 *
 * The CEO calls a standup and ends it, from the HUD or by telling the AI
 * Manager; every agent on the floor walks to the manager's room and stands in
 * front of its desk, each gives an update in turn, the CEO answers blockers and
 * gives directions, and when the CEO ends it everyone goes back to work. What
 * the standup is doing is replicated state (`Standup` in `./state.ts`), run by
 * the server (`apps/server/src/sim/standup.ts`); this module is the part both
 * sides need, so the client can say why a button would be refused before the
 * server refuses it, and the server puts the agents where the client expects
 * to see them.
 *
 * The rule is the work's: the CEO runs the office, so only the CEO calls,
 * ends or speaks at a standup. Everyone else sees it, the same as the CEO.
 */

import { isBlocked } from "./collision.js";
import { OCCUPANT_RADIUS } from "./constants.js";
import { INTERACTION_KIND, type OfficeLayout, type Vec2, interactables, localToWorld, roomAt } from "./layout.js";
import { managerSeat } from "./manager.js";
import { normalizeYaw } from "./state.js";
import type { OfficeActor } from "./work.js";

/** Why the office did not take a standup command. Refusal changes nothing. */
export const STANDUP_REJECTION = {
  /** Only the CEO calls, ends or speaks at a standup. */
  forbidden: "forbidden",
  /** A standup is already on. */
  running: "running",
  /** No standup is on to end or speak at. */
  notRunning: "not-running",
  /** There are no agents on the floor to gather. */
  noAgents: "no-agents",
  /** The direction names no agent at the standup. */
  noAgent: "no-agent",
} as const;

export type StandupRejection = (typeof STANDUP_REJECTION)[keyof typeof STANDUP_REJECTION];

/**
 * What came of a direction the CEO gave an agent at a standup.
 *
 * A runner's coding agent at its prompt has the direction typed at once; one
 * in the middle of a turn, or waiting on a choice screen, keeps it until it is
 * next at its prompt with the standup over. An orchestrator's agent takes no
 * prompts from the office, so its direction is only on the record.
 */
export const STANDUP_DIRECTION_STATUS = {
  /** On its way to the agent's runner. */
  sending: "sending",
  /** Typed into its terminal as a prompt. */
  typed: "typed",
  /** Kept for when it is next at its prompt, after the standup. */
  queued: "queued",
  /** Kept, and since typed. */
  delivered: "delivered",
  /** An agent the office cannot type to: the direction is on the record only. */
  noted: "noted",
  /** Not typed, and will not be; `reason` says why. */
  failed: "failed",
} as const;

export type StandupDirectionStatus = (typeof STANDUP_DIRECTION_STATUS)[keyof typeof STANDUP_DIRECTION_STATUS];

/** The `agentId` a direction for every agent at the standup names. */
export const STANDUP_EVERYONE = "";

/** Directions a standup keeps on its record; the oldest go first. */
export const MAX_STANDUP_DIRECTIONS = 40;

/**
 * Whether an actor may call, end or speak at a standup. **The one gate.**
 *
 * The server checks it on every command; the client asks it only to disable a
 * control and say why.
 */
export function mayRunStandup(actor: OfficeActor): boolean {
  return actor.isCeo;
}

/** Where one agent stands at a standup, facing the manager. */
export interface StandupSpot extends Vec2 {
  readonly yaw: number;
}

/** Rows behind the CEO's place at the manager's desk, and the places along each, in metres. */
const SPOT_ROWS = [0.9, 1.8, 2.7] as const;
const SPOT_OFFSETS = [-0.75, 0.75, -1.5, 1.5, -2.25, 2.25] as const;

const spotCache = new WeakMap<OfficeLayout, readonly StandupSpot[]>();

/**
 * The places the agents stand at a standup: rows behind the spot where the
 * CEO talks to the manager, each facing the manager in its chair, with an
 * aisle left clear up the middle to the desk. Derived from the layout like
 * the seats are, so a change to the manager's room re-places them; a place a
 * body would not fit, or outside the manager's room, is left out. Nearest the
 * desk first, which is the order they are handed out in.
 *
 * Empty for a layout without the manager's desk.
 */
export function standupSpots(layout: OfficeLayout): readonly StandupSpot[] {
  const cached = spotCache.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  const seat = managerSeat(layout);
  const desk = interactables(layout).find((spec) => spec.kind === INTERACTION_KIND.manager);
  const room = desk === undefined ? undefined : roomAt(layout, desk.anchor);
  const spots: StandupSpot[] = [];
  if (seat !== undefined && desk !== undefined && room !== undefined) {
    for (const row of SPOT_ROWS) {
      for (const offset of SPOT_OFFSETS) {
        const point = localToWorld(desk.anchor, desk.anchor.yaw, offset, row);
        if (isBlocked(point, OCCUPANT_RADIUS, layout) || roomAt(layout, point)?.id !== room.id) {
          continue;
        }
        const yaw = normalizeYaw(Math.atan2(-(seat.anchor.x - point.x), -(seat.anchor.z - point.z)));
        spots.push({ x: point.x, z: point.z, yaw });
      }
    }
  }
  spotCache.set(layout, spots);
  return spots;
}

/** One update as a client holds it: a plain copy of the replicated `StandupUpdate`. */
export interface StandupUpdateData {
  readonly agentId: string;
  readonly agentName: string;
  readonly workedOn: string;
  readonly blockers: string;
  readonly needsYou: boolean;
  readonly resolved: boolean;
  readonly at: number;
}

/** One direction as a client holds it: a plain copy of the replicated `StandupDirection`. */
export interface StandupDirectionData {
  readonly id: number;
  readonly agentId: string;
  readonly agentName: string;
  readonly authorName: string;
  readonly text: string;
  readonly everyone: boolean;
  readonly status: string;
  readonly reason: string;
  readonly at: number;
}

/** The standup as a client holds it: a plain copy of the replicated `Standup`. */
export interface StandupData {
  readonly active: boolean;
  readonly calledBy: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly order: readonly string[];
  readonly speakerId: string;
  readonly updates: readonly StandupUpdateData[];
  readonly directions: readonly StandupDirectionData[];
}

/** The standup of an office that has never held one. */
export const NO_STANDUP: StandupData = {
  active: false,
  calledBy: "",
  startedAt: 0,
  endedAt: 0,
  order: [],
  speakerId: "",
  updates: [],
  directions: [],
};
