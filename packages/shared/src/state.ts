/**
 * Replicated room state.
 *
 * {@link Occupant} is deliberately the base type for everyone who can stand in
 * the office, not just for players. This milestone only ever puts
 * {@link HumanPlayer} instances in the map, but the agent employees this
 * prototype exists to host will be a sibling class added alongside it, and the
 * occupants map will not have to be reshaped to hold them.
 *
 * Positions are `float32`: the wire stays small and the rounding is far below
 * the drift the client tolerates before it corrects itself.
 *
 * Fields are wired up with `defineTypes` rather than Colyseus' `@type()`
 * decorator, and declared with `declare` so no field initialiser is emitted.
 * Both choices avoid a compiler setting:
 *
 * - `@type()` is a legacy-style decorator, and the three toolchains that compile
 *   this package (tsx on the server, Vite in the browser, Vitest in the test
 *   run) do not all honour `experimentalDecorators` from the tsconfig. Compiled
 *   under standard decorator semantics it throws at module load.
 * - Colyseus installs its change-tracking accessors as own properties of each
 *   instance, so a class field initialiser compiled under
 *   `useDefineForClassFields` would overwrite them and silently stop replicating
 *   that field.
 *
 * Defaults therefore live in the constructors, which assign through those
 * accessors exactly as a tracked write should.
 */

import { MapSchema, Schema, defineTypes } from "@colyseus/schema";

/** What sort of thing an occupant is. */
export const OCCUPANT_KIND = {
  human: "human",
  agent: "agent",
} as const;

export type OccupantKind = (typeof OCCUPANT_KIND)[keyof typeof OCCUPANT_KIND];

/**
 * What an occupant is currently doing, for the renderer's benefit.
 *
 * A string rather than a boolean because sitting, typing and talking all land
 * here once there is anything in the office to do.
 */
export const ANIMATION_STATE = {
  idle: "idle",
  walking: "walking",
} as const;

export type AnimationState = (typeof ANIMATION_STATE)[keyof typeof ANIMATION_STATE];

/** Anyone standing in the office: a player now, an agent employee later. */
export class Occupant extends Schema {
  declare public id: string;
  declare public name: string;
  declare public kind: OccupantKind;
  declare public x: number;
  declare public z: number;
  declare public yaw: number;
  declare public animation: AnimationState;

  public constructor() {
    super();
    this.id = "";
    this.name = "";
    this.kind = OCCUPANT_KIND.human;
    this.x = 0;
    this.z = 0;
    this.yaw = 0;
    this.animation = ANIMATION_STATE.idle;
  }
}

defineTypes(Occupant, {
  id: "string",
  name: "string",
  kind: "string",
  x: "float32",
  z: "float32",
  yaw: "float32",
  animation: "string",
});

/** An occupant driven by a browser. */
export class HumanPlayer extends Occupant {
  /** Set on the first player to join the room, and re-homed if they leave. */
  declare public isCeo: boolean;

  public constructor() {
    super();
    this.isCeo = false;
  }
}

defineTypes(HumanPlayer, { isCeo: "boolean" });

/**
 * Where a ticket sits on the board.
 *
 * The order of these keys is the order of the board's columns, left to right,
 * and the transition table in `tickets.ts` is written against it. Anything that
 * needs to list the statuses should read {@link TICKET_STATUSES} rather than
 * spelling them out again.
 */
export const TICKET_STATUS = {
  backlog: "backlog",
  assigned: "assigned",
  in_progress: "in_progress",
  review: "review",
  done: "done",
} as const;

export type TicketStatus = (typeof TICKET_STATUS)[keyof typeof TICKET_STATUS];

/** Every status, in board-column order. */
export const TICKET_STATUSES: readonly TicketStatus[] = Object.values(TICKET_STATUS);

/** Whether an arbitrary value is one of the five statuses. */
export function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === "string" && (TICKET_STATUSES as readonly string[]).includes(value);
}

/**
 * One unit of work on the board.
 *
 * `assigneeId` and `createdById` hold occupant ids — session ids for the humans
 * in this milestone — rather than object references, because Colyseus replicates
 * trees and not graphs. A consumer resolves them against
 * {@link OfficeState.occupants}; an id that is no longer in that map is a
 * ticket whose assignee has disconnected, which the board renders rather than
 * repairs.
 *
 * `outputArtifact` is the agent employee's deliverable — the thing a reviewer
 * reads before moving the ticket to `done`. Nothing writes it in this
 * milestone: the agents that will are a later issue, and the field is here so
 * that issue does not have to reshape the board to land it.
 *
 * Timestamps are epoch milliseconds under the `number` type, which is
 * variable-length on the wire and so holds a value that `uint32` could not.
 */
export class Ticket extends Schema {
  declare public id: string;
  declare public title: string;
  declare public body: string;
  declare public status: TicketStatus;
  /** Occupant id of the current assignee, or `""` when unassigned. */
  declare public assigneeId: string;
  /** Occupant id of whoever filed it, or {@link SYSTEM_AUTHOR_ID} for a seed. */
  declare public createdById: string;
  /** The assignee's deliverable, written when an agent finishes. `""` until. */
  declare public outputArtifact: string;
  declare public createdAt: number;
  declare public updatedAt: number;

  public constructor() {
    super();
    this.id = "";
    this.title = "";
    this.body = "";
    this.status = TICKET_STATUS.backlog;
    this.assigneeId = "";
    this.createdById = "";
    this.outputArtifact = "";
    this.createdAt = 0;
    this.updatedAt = 0;
  }
}

defineTypes(Ticket, {
  id: "string",
  title: "string",
  body: "string",
  status: "string",
  assigneeId: "string",
  createdById: "string",
  outputArtifact: "string",
  createdAt: "number",
  updatedAt: "number",
});

/**
 * Author recorded on a ticket the room created itself.
 *
 * Not an occupant id, and deliberately not resolvable in
 * {@link OfficeState.occupants}: a consumer that looks it up finds nothing and
 * should render the ticket as unattributed.
 */
export const SYSTEM_AUTHOR_ID = "system";

export class OfficeState extends Schema {
  declare public occupants: MapSchema<Occupant>;
  /** The ticket board, keyed by {@link Ticket.id}. */
  declare public tickets: MapSchema<Ticket>;
  declare public tick: number;

  public constructor() {
    super();
    this.occupants = new MapSchema<Occupant>();
    this.tickets = new MapSchema<Ticket>();
    this.tick = 0;
  }
}

defineTypes(OfficeState, {
  occupants: { map: Occupant },
  tickets: { map: Ticket },
  tick: "uint32",
});

const TAU = Math.PI * 2;

/**
 * Folds a yaw into [-pi, pi).
 *
 * Both sides store yaw in this range so that the shortest rotation between two
 * samples can be found by subtraction, which is what remote interpolation needs
 * to avoid spinning an avatar the long way around.
 */
export function normalizeYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) {
    return 0;
  }
  const wrapped = (((yaw + Math.PI) % TAU) + TAU) % TAU;
  return wrapped - Math.PI;
}

/** The shorter of the two rotations from `from` to `to`, in [-pi, pi). */
export function shortestYawDelta(from: number, to: number): number {
  return normalizeYaw(to - from);
}

/**
 * Narrows an occupant to a human player.
 *
 * Tests the replicated `kind` field rather than using `instanceof`: the browser
 * client builds its state from the schema the server reflects to it on join, so
 * the objects it holds carry the right fields without being instances of these
 * classes. When agent employees arrive they get the same treatment.
 */
export function isHumanPlayer(occupant: Occupant): occupant is HumanPlayer {
  return occupant.kind === OCCUPANT_KIND.human;
}
