/**
 * The standup: who may call one, where the agents sit for it, and the words
 * both sides use about it.
 *
 * The CEO calls a standup and ends it, from the HUD or by telling the AI
 * Manager; every agent on the floor walks to the conference room and sits on a
 * chair of its own at the table, each gives an update in turn, the CEO answers
 * blockers and gives directions, and when the CEO ends it everyone goes back
 * to work. What the standup is doing is replicated state (`Standup` in
 * `./state.ts`), run by the server (`apps/server/src/sim/standup.ts`); this
 * module is the part both sides need, so the client can say why a button
 * would be refused before the server refuses it, and the server puts the
 * agents where the client expects to see them.
 *
 * The rule is the work's: the CEO runs the office, so only the CEO calls,
 * ends or speaks at a standup. Everyone else sees it, the same as the CEO.
 */

import { isBlocked } from "./collision.js";
import { OCCUPANT_RADIUS } from "./constants.js";
import { INTERACTION_KIND, type OfficeLayout, type Vec2, interactables, localToWorld, roomAt } from "./layout.js";
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
 * next at its prompt with the standup over. One with no session at all, free
 * between tasks, answers it in a short run of its own, and its answer is on
 * the record. An orchestrator's agent takes no prompts from the office, so its
 * direction is only on the record.
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
  /** For an agent with no session: it is working out an answer. */
  answering: "answering",
  /** It answered; `reply` is what it said. */
  answered: "answered",
  /** It could not answer; `reason` says why. */
  unanswered: "unanswered",
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

/**
 * Where one agent is at a standup: sat on a conference chair, or, with every
 * chair taken, stood at an end of the table facing it.
 */
export interface StandupSpot extends Vec2 {
  readonly yaw: number;
  /** The chair it sits on, by interactable id; `""` for a place to stand. */
  readonly seatId: string;
}

/**
 * How far past each end of a meeting table the standing places are, and the
 * places across that end, in metres.
 */
const STAND_BEYOND = 0.9;
const STAND_ACROSS = [0, -0.75, 0.75] as const;

const spotCache = new WeakMap<OfficeLayout, readonly StandupSpot[]>();

/**
 * The places the agents take at a standup, in the conference room: every
 * chair at its meeting table first, in seat order, each the chair's own pose,
 * then places to stand past either end of the table, facing it, for agents
 * that find every chair taken. Derived from the layout like the seats are, so
 * a change to the conference room re-places them; a standing place a body
 * would not fit, or outside the room, is left out. The order is the one they
 * are handed out in.
 *
 * Empty for a layout without a meeting table.
 */
export function standupSpots(layout: OfficeLayout): readonly StandupSpot[] {
  const cached = spotCache.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  const spots: StandupSpot[] = [];
  const standing: StandupSpot[] = [];
  for (const table of layout.desks) {
    const room = table.meeting === true ? roomAt(layout, table) : undefined;
    if (room === undefined) {
      continue;
    }
    for (const seat of interactables(layout)) {
      if (seat.kind === INTERACTION_KIND.seat && seat.deskId === table.id) {
        spots.push({ x: seat.anchor.x, z: seat.anchor.z, yaw: normalizeYaw(seat.anchor.yaw), seatId: seat.id });
      }
    }
    for (const end of [-1, 1]) {
      for (const across of STAND_ACROSS) {
        const point = localToWorld(table, table.yaw, end * (table.width / 2 + STAND_BEYOND), across);
        if (isBlocked(point, OCCUPANT_RADIUS, layout) || roomAt(layout, point)?.id !== room.id) {
          continue;
        }
        const yaw = normalizeYaw(Math.atan2(-(table.x - point.x), -(table.z - point.z)));
        standing.push({ x: point.x, z: point.z, yaw, seatId: "" });
      }
    }
  }
  spots.push(...standing);
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
  readonly reply: string;
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
