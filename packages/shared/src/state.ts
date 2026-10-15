/**
 * Replicated room state.
 *
 * {@link Occupant} is deliberately the base type for everyone who can stand in
 * the office, not just for players. The map holds two siblings of it:
 * {@link HumanPlayer}, one per browser, and {@link AgentEmployee}, the staff the
 * room hires itself. Both are read through the same map, so anything that only
 * needs a body and a name — the renderer, the board's assignee lookup — treats
 * them alike, and only what is particular to one kind narrows by `kind`.
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

import { ArraySchema, MapSchema, Schema, defineTypes } from "@colyseus/schema";

import {
  COMPANY_STATUS,
  type CompanyStatus,
  STARTING_CASH,
  STARTING_MINUTE_OF_DAY,
  STARTING_MORALE,
  STARTING_PRODUCTIVITY,
} from "./company.js";

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
 *
 * `sitting` is produced by the server when it seats an occupant at a desk.
 * `typing` is carried but not yet produced: it is listed because the renderer
 * has a clip for it, so the milestone that adds desk work only has to write
 * this field rather than extend the protocol.
 */
export const ANIMATION_STATE = {
  idle: "idle",
  walking: "walking",
  sitting: "sitting",
  typing: "typing",
} as const;

export type AnimationState = (typeof ANIMATION_STATE)[keyof typeof ANIMATION_STATE];

const ANIMATION_STATES: ReadonlySet<string> = new Set(Object.values(ANIMATION_STATE));

/**
 * Whether an untrusted value is one of the {@link ANIMATION_STATE} members.
 *
 * Derived from the object rather than written out, so that adding a state here
 * cannot leave the server rejecting poses that carry it.
 */
export function isAnimationState(value: unknown): value is AnimationState {
  return typeof value === "string" && ANIMATION_STATES.has(value);
}

/**
 * The states a client is allowed to claim for itself.
 *
 * Walking is client-authoritative, so a client reports its own idle or walking.
 * The rest are consequences of an interaction the server granted, and a client
 * that could simply assert one would be sitting at a desk from across the room.
 */
export type ReportedAnimation = typeof ANIMATION_STATE.idle | typeof ANIMATION_STATE.walking;

/** Anyone standing in the office: a player or an agent employee. */
export class Occupant extends Schema {
  declare public id: string;
  declare public name: string;
  declare public kind: OccupantKind;
  declare public x: number;
  declare public z: number;
  declare public yaw: number;
  declare public animation: AnimationState;
  /**
   * Id of the interactable this occupant is engaged with, or `""` when free.
   *
   * Replicated rather than kept server-side because every client needs it: it
   * is what tells the other tab to draw this body at a particular desk, and
   * what tells a client a chair is already taken.
   */
  declare public interactableId: string;

  public constructor() {
    super();
    this.id = "";
    this.name = "";
    this.kind = OCCUPANT_KIND.human;
    this.x = 0;
    this.z = 0;
    this.yaw = 0;
    this.animation = ANIMATION_STATE.idle;
    this.interactableId = "";
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
  interactableId: "string",
});

/**
 * What a human player may do in the office.
 *
 * Two values, not a permission set: the CEO runs the board and everyone else
 * is an executive who reads it, comments on it and advises. A finer-grained
 * scheme is a product decision nobody has made, and a string field leaves room
 * for one without reshaping the schema.
 */
export const PLAYER_ROLE = {
  ceo: "ceo",
  exec: "exec",
} as const;

export type PlayerRole = (typeof PLAYER_ROLE)[keyof typeof PLAYER_ROLE];

/** An occupant driven by a browser. */
export class HumanPlayer extends Occupant {
  /**
   * {@link PLAYER_ROLE.ceo} on exactly one player while anyone is in the room:
   * the first to join, and on their departure whoever has been connected
   * longest. The server's `sim/roles.ts` is the only writer.
   */
  declare public role: PlayerRole;

  public constructor() {
    super();
    this.role = PLAYER_ROLE.exec;
  }
}

defineTypes(HumanPlayer, { role: "string" });

/**
 * Whether an occupant holds the CEO role.
 *
 * The one reading of the role every consumer should use, so that an agent —
 * which has no role at all — is never mistaken for a CEO by a check that only
 * looked at the field.
 */
export function isCeo(occupant: Occupant): boolean {
  return isHumanPlayer(occupant) && occupant.role === PLAYER_ROLE.ceo;
}

/**
 * What an agent employee is doing, as the floor should read it.
 *
 * Separate from {@link ANIMATION_STATE}, which is what the body is doing. An
 * agent stuck on a ticket and an agent with nothing to do may both be standing
 * still; this is the field that tells them apart, and it is what the badge
 * above an agent's head shows.
 *
 * Agent movement writes `walking`, and `blocked` when a body cannot get where
 * it was sent; an agent's brain (`apps/server/src/sim/agentBrain.ts`) writes
 * `working` while it has a ticket, `blocked` when the work on one failed, and
 * `idle` in between. `meeting` waits for the issue that gives agents meetings.
 */
export const AGENT_ACTIVITY = {
  idle: "idle",
  walking: "walking",
  working: "working",
  meeting: "meeting",
  blocked: "blocked",
} as const;

export type AgentActivity = (typeof AGENT_ACTIVITY)[keyof typeof AGENT_ACTIVITY];

/** Ceiling of an agent's morale and energy, which run from 0 to this. */
export const AGENT_STAT_MAX = 100;

/**
 * An occupant the room hires rather than one a browser drives.
 *
 * Every field is written by the server alone: no client message names an agent,
 * so nothing a client sends can reach one.
 *
 * `currentTicketId` holds a {@link Ticket.id}, or `""` when the agent has
 * nothing, for the same reason a ticket holds occupant ids rather than
 * references — Colyseus replicates trees, not graphs. An id that is no longer
 * on the board is rendered as no ticket rather than repaired.
 *
 * Morale and energy are whole numbers out of {@link AGENT_STAT_MAX}, `uint8` on
 * the wire, because nothing reads them finer than a percentage.
 *
 * `salary` is what the agent costs each midnight, in whole currency units, and
 * is replicated because the HUD shows the payroll it adds up to. It is fixed at
 * hire: raises are not part of this office.
 */
export class AgentEmployee extends Occupant {
  declare public jobTitle: string;
  /** Id of the desk in the layout this agent works at. */
  declare public deskId: string;
  declare public currentTicketId: string;
  declare public activity: AgentActivity;
  declare public morale: number;
  declare public energy: number;
  declare public salary: number;

  public constructor() {
    super();
    this.kind = OCCUPANT_KIND.agent;
    this.jobTitle = "";
    this.deskId = "";
    this.currentTicketId = "";
    this.activity = AGENT_ACTIVITY.idle;
    this.morale = AGENT_STAT_MAX;
    this.energy = AGENT_STAT_MAX;
    this.salary = 0;
  }
}

defineTypes(AgentEmployee, {
  jobTitle: "string",
  deskId: "string",
  currentTicketId: "string",
  activity: "string",
  morale: "uint8",
  energy: "uint8",
  salary: "number",
});

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
 * How urgent a ticket is, lowest first.
 *
 * Set by the CEO and only by the CEO: deciding what matters most is the
 * decision this role exists to make. Iterate {@link TICKET_PRIORITIES} rather
 * than these keys when an order is needed.
 */
export const TICKET_PRIORITY = {
  low: "low",
  normal: "normal",
  high: "high",
} as const;

export type TicketPriority = (typeof TICKET_PRIORITY)[keyof typeof TICKET_PRIORITY];

/** Every priority, lowest first. */
export const TICKET_PRIORITIES: readonly TicketPriority[] = Object.values(TICKET_PRIORITY);

/** Whether an arbitrary value is one of the priorities. */
export function isTicketPriority(value: unknown): value is TicketPriority {
  return typeof value === "string" && (TICKET_PRIORITIES as readonly string[]).includes(value);
}

/**
 * A remark left on a ticket.
 *
 * The one board write open to everyone, so it is how an executive who may not
 * move a ticket still advises on it. Append-only: a comment is never edited,
 * and the oldest are dropped once a ticket holds `MAX_TICKET_COMMENTS`.
 */
export class TicketComment extends Schema {
  /** Occupant id of whoever wrote it; resolved like {@link Ticket.createdById}. */
  declare public authorId: string;
  /** Sanitized and length-capped by the parser. Safe to render as text. */
  declare public text: string;
  declare public createdAt: number;

  public constructor() {
    super();
    this.authorId = "";
    this.text = "";
    this.createdAt = 0;
  }
}

defineTypes(TicketComment, {
  authorId: "string",
  text: "string",
  createdAt: "number",
});

/**
 * One unit of work on the board.
 *
 * `assigneeId` and `createdById` hold occupant ids — a session id for a human,
 * an `agent-` id for an agent employee — rather than object references, because
 * Colyseus replicates trees and not graphs. A consumer resolves them against
 * {@link OfficeState.occupants}; an id that is no longer in that map is a
 * ticket whose assignee has disconnected, which the board renders rather than
 * repairs.
 *
 * `outputArtifact` is the agent employee's deliverable — the thing a reviewer
 * reads before moving the ticket to `done`. Only the assignee's
 * `attach-output` command writes it, from the agent's brain on the server.
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
  declare public priority: TicketPriority;
  /** Oldest first. */
  declare public comments: ArraySchema<TicketComment>;
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
    this.priority = TICKET_PRIORITY.normal;
    this.comments = new ArraySchema<TicketComment>();
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
  priority: "string",
  comments: [TicketComment],
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

/**
 * The company's vital signs and the in-game clock that moves them.
 *
 * Only the server writes these. The numbers come from `company.ts`, where every
 * starting value and every formula lives, so the constructor reads its defaults
 * from there rather than writing a second copy of them here.
 *
 * Cash is whole currency units under `number`, which is variable-length on the
 * wire and exact as a double; morale and productivity are 0–100 under `number`
 * too, so a formula that produces a fraction replicates it rather than having a
 * narrower type truncate it. The clock replicates at whole-minute resolution:
 * the server keeps the fraction to itself.
 */
export class Company extends Schema {
  declare public cash: number;
  declare public morale: number;
  declare public productivity: number;
  /** The in-game day, counting from 1. */
  declare public day: number;
  /** Minutes since midnight of {@link day}, 0 to 1439. */
  declare public minuteOfDay: number;
  declare public status: CompanyStatus;
  /**
   * Consecutive day closes that ended with morale below the quitting
   * threshold. Replicated so the HUD can warn before anyone actually quits.
   */
  declare public lowMoraleDays: number;

  public constructor() {
    super();
    this.cash = STARTING_CASH;
    this.morale = STARTING_MORALE;
    this.productivity = STARTING_PRODUCTIVITY;
    this.day = 1;
    this.minuteOfDay = STARTING_MINUTE_OF_DAY;
    this.status = COMPANY_STATUS.operating;
    this.lowMoraleDays = 0;
  }
}

defineTypes(Company, {
  cash: "number",
  morale: "number",
  productivity: "number",
  day: "uint16",
  minuteOfDay: "uint16",
  status: "string",
  lowMoraleDays: "uint16",
});

export class OfficeState extends Schema {
  declare public occupants: MapSchema<Occupant>;
  /** The ticket board, keyed by {@link Ticket.id}. */
  declare public tickets: MapSchema<Ticket>;
  declare public company: Company;
  declare public tick: number;

  public constructor() {
    super();
    this.occupants = new MapSchema<Occupant>();
    this.tickets = new MapSchema<Ticket>();
    this.company = new Company();
    this.tick = 0;
  }
}

defineTypes(OfficeState, {
  occupants: { map: Occupant },
  tickets: { map: Ticket },
  company: Company,
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
 * classes.
 */
export function isHumanPlayer(occupant: Occupant): occupant is HumanPlayer {
  return occupant.kind === OCCUPANT_KIND.human;
}

/** Narrows an occupant to an agent employee, by `kind` as {@link isHumanPlayer} does. */
export function isAgentEmployee(occupant: Occupant): occupant is AgentEmployee {
  return occupant.kind === OCCUPANT_KIND.agent;
}
