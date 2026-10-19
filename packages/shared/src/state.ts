/**
 * Replicated room state.
 *
 * {@link Occupant} is deliberately the base type for everyone who can stand in
 * the office, not just for players. The map holds three siblings of it:
 * {@link HumanPlayer}, one per browser, {@link LiveAgent}, moved by the server
 * on a real coding agent's behalf, and {@link AiManager}, the one manager who
 * hands the work out, plus one plain occupant, the concierge at reception,
 * who has nothing to replicate beyond a body and a name.
 * All are read through the same map, so anything that
 * only needs a body and a name — the renderer, the board's assignee lookup —
 * treats them alike, and only what is particular to one kind narrows by `kind`.
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

import { STARTING_MINUTE_OF_DAY } from "./clock.js";

/**
 * What sort of thing an occupant is.
 *
 * `liveAgent` is one of the real coding agents working on this repository,
 * reported by its orchestrator or runner. `manager` is the AI manager the CEO
 * talks to, who hands the live agents their work. `concierge` is the scripted
 * host at the lobby's reception desk, who welcomes people in and does nothing
 * else.
 */
export const OCCUPANT_KIND = {
  human: "human",
  liveAgent: "live-agent",
  manager: "manager",
  concierge: "concierge",
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

/** Anyone standing in the office: a player, a live coding agent or the AI manager. */
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
  /**
   * Sips left in the coffee this occupant has in hand, `0` for no cup.
   *
   * Counted down by the server, so a client that sees it drop plays a sip and
   * a client that sees it reach zero takes the cup away: one number carries
   * the cup, every sip and its disappearance to everyone in the room.
   */
  declare public coffeeSips: number;

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
    this.coffeeSips = 0;
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
  coffeeSips: "uint8",
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
 * What a live coding agent is doing, as its orchestrator last reported it.
 *
 * Only these are bodies in the office. An agent that stops is removed, so
 * "stopped" is a report, never a state anyone is replicated in.
 */
export const LIVE_AGENT_STATUS = {
  working: "working",
  /**
   * Still holding its work, and stuck until a person acts: a permission, a
   * question, a sign-in. It keeps its chair; the office makes it hard to miss.
   */
  needsInput: "needs-input",
  idle: "idle",
} as const;

export type LiveAgentStatus = (typeof LIVE_AGENT_STATUS)[keyof typeof LIVE_AGENT_STATUS];

/**
 * Whether an agent in this status holds work: it sits at a desk with its task,
 * where an idle one wanders. Waiting on a person is still being on the task.
 */
export function isLiveAgentOnTask(status: LiveAgentStatus): boolean {
  return status === LIVE_AGENT_STATUS.working || status === LIVE_AGENT_STATUS.needsInput;
}

/**
 * A real coding agent working on this repository, shown as a person on the floor.
 *
 * The server moves it, not a browser: it walks the waypoint graph to a free
 * workstation while it has a task and wanders while it has none. What is
 * replicated is only what a client draws — the body through {@link Occupant}'s
 * fields and the label through these.
 */
export class LiveAgent extends Occupant {
  declare public status: LiveAgentStatus;
  /** What it is working on, or `""` when idle or unknown. */
  declare public taskTitle: string;
  /** The issue or pull request the task is, or `""` when not known. Always `https:`. */
  declare public taskUrl: string;
  /**
   * The issue or pull request the AI manager has handed this agent and it has
   * not reported working on yet, or `""`. Its own task still comes only from
   * the orchestrator's reports; this is what it has been asked to do next.
   */
  declare public assignedTitle: string;
  /** The assignment's link, `""` with no assignment. Always `https:`. */
  declare public assignedUrl: string;
  /**
   * Whether issue work can be given to this agent; see `isIssueAssignee` in
   * `work.ts`. Only a source that drives
   * the agent's work through the office's work rules sets it.
   */
  declare public canTakeIssues: boolean;
  /**
   * What it is doing right now, e.g. `Bash: pnpm test`, or what it is waiting
   * on while it needs input; `""` when unknown. One line, sanitised and capped
   * by whoever reported it.
   */
  declare public activity: string;
  /**
   * The issue whose sticky note this agent has in hand, taken off the issues
   * sticker board and not yet pinned anywhere, or `0`. Replicated because it
   * is the one part of a note's place the work does not say; see
   * `stickerNotes.ts`. Only the server's crew writes it.
   */
  declare public carriedIssue: number;
  /** Its title, `Software Developer` say, under its name; `""` when its source gives none. See `agentProfile.ts`. */
  declare public title: string;
  /** What it is for, in the CEO's words: with the title, its system prompt. `""` for none. */
  declare public description: string;
  /**
   * Whether the CEO can edit its name, title and description from the office:
   * a runner's agent, whose runner keeps the profile and prompts with it.
   */
  declare public profileEditable: boolean;

  public constructor() {
    super();
    this.kind = OCCUPANT_KIND.liveAgent;
    this.status = LIVE_AGENT_STATUS.idle;
    this.taskTitle = "";
    this.taskUrl = "";
    this.assignedTitle = "";
    this.assignedUrl = "";
    this.canTakeIssues = false;
    this.activity = "";
    this.carriedIssue = 0;
    this.title = "";
    this.description = "";
    this.profileEditable = false;
  }
}

defineTypes(LiveAgent, {
  status: "string",
  taskTitle: "string",
  taskUrl: "string",
  assignedTitle: "string",
  assignedUrl: "string",
  canTakeIssues: "boolean",
  activity: "string",
  carriedIssue: "uint32",
  title: "string",
  description: "string",
  profileEditable: "boolean",
});

/**
 * What the AI manager is doing, for its badge.
 *
 * `thinking` while a question from the CEO is with its model, so a slow answer
 * reads as a manager at work rather than one that did not hear.
 */
export const MANAGER_STATUS = {
  idle: "idle",
  thinking: "thinking",
} as const;

export type ManagerStatus = (typeof MANAGER_STATUS)[keyof typeof MANAGER_STATUS];

/**
 * The AI manager: the one occupant who takes the CEO's instructions and hands
 * the work out to the live agents.
 *
 * Seated at its own desk for good and moved by nobody, so nothing here is a
 * position; what is replicated is what a client draws — a badge saying
 * whether it is thinking. The conversation itself is not state: it is relayed
 * as messages, like chat.
 */
export class AiManager extends Occupant {
  declare public status: ManagerStatus;

  public constructor() {
    super();
    this.kind = OCCUPANT_KIND.manager;
    this.status = MANAGER_STATUS.idle;
  }
}

defineTypes(AiManager, { status: "string" });

/**
 * Where an agent's work on a GitHub issue stands.
 *
 * An open issue nobody in the office is working has no status at all: it is
 * simply on the project board, with no {@link IssueWork} for it. Everything
 * from the moment the CEO hands it to an agent is one of these, and the order
 * of the keys is the order the work moves through them. Anything that needs
 * to list the statuses should read {@link WORK_STATUSES} rather than spelling
 * them out again.
 *
 * None of this is written back to GitHub. `done` is the office's own verdict
 * on the agent's deliverable, and the issue stays open on GitHub until
 * somebody closes it there.
 */
export const WORK_STATUS = {
  assigned: "assigned",
  in_progress: "in_progress",
  review: "review",
  done: "done",
} as const;

export type WorkStatus = (typeof WORK_STATUS)[keyof typeof WORK_STATUS];

/** Every status, in the order work moves through them. */
export const WORK_STATUSES: readonly WorkStatus[] = Object.values(WORK_STATUS);

/** Whether an arbitrary value is one of the statuses. */
export function isWorkStatus(value: unknown): value is WorkStatus {
  return typeof value === "string" && (WORK_STATUSES as readonly string[]).includes(value);
}

/**
 * An agent's work on one GitHub issue from the project board.
 *
 * The issue itself is GitHub's and arrives with the project board's snapshot;
 * this is only what the office has done about it, and it never travels back.
 * Keyed in {@link OfficeState.work} by the issue number as a string, so there
 * is at most one piece of work per issue.
 *
 * `assigneeId` holds an occupant id rather than a reference, because Colyseus
 * replicates trees and not graphs; an id no longer in
 * {@link OfficeState.occupants} is an agent who has left, which a panel renders
 * rather than repairs. `title` is the issue's, as of the last snapshot that
 * listed it, so the record still reads once GitHub's list has moved on.
 *
 * `outputArtifact` is the agent's deliverable — the thing the CEO reads before
 * approving the work — and `note` is the latest word on it from the agent or
 * the office: why the agent is stuck, or why the work changed hands.
 *
 * Timestamps are epoch milliseconds under the `number` type, which is
 * variable-length on the wire and so holds a value that `uint32` could not.
 */
export class IssueWork extends Schema {
  declare public issueNumber: number;
  declare public title: string;
  declare public status: WorkStatus;
  /** Occupant id of the live agent doing it. Never `""`. */
  declare public assigneeId: string;
  /** The assignee's deliverable, written when an agent finishes. `""` until. */
  declare public outputArtifact: string;
  /** Sanitized and length-capped. `""` when there is nothing to say. */
  declare public note: string;
  declare public assignedAt: number;
  declare public updatedAt: number;

  public constructor() {
    super();
    this.issueNumber = 0;
    this.title = "";
    this.status = WORK_STATUS.assigned;
    this.assigneeId = "";
    this.outputArtifact = "";
    this.note = "";
    this.assignedAt = 0;
    this.updatedAt = 0;
  }
}

defineTypes(IssueWork, {
  issueNumber: "uint32",
  title: "string",
  status: "string",
  assigneeId: "string",
  outputArtifact: "string",
  note: "string",
  assignedAt: "number",
  updatedAt: "number",
});

/** The key an issue's work is stored under in {@link OfficeState.work}. */
export function workKey(issueNumber: number): string {
  return String(issueNumber);
}

/**
 * One standing task, as its runner last reported it: a recurring job an
 * office agent does, such as watching for new pull requests (see
 * `standing.ts`). The runner owns it; this is the office's copy, refreshed
 * from every sync, so a room opened later, or a server restarted, shows it
 * within one sync. Keyed in {@link OfficeState.standing} by its id.
 *
 * Times are epoch milliseconds, `0` for never; amounts are US dollars.
 */
export class StandingTask extends Schema {
  declare public id: string;
  /** The runner holding it, which every command about it goes to. */
  declare public runnerId: string;
  /** A `StandingKind`. */
  declare public kind: string;
  declare public name: string;
  /** A `StandingStatus`. */
  declare public status: string;
  /** Its trigger in a few words: `every 2 min`, `weekdays 09:00`. */
  declare public trigger: string;
  declare public lastCheckAt: number;
  declare public nextCheckAt: number;
  /** Events waiting for a slot. */
  declare public queued: number;
  declare public handledToday: number;
  declare public spentTodayUsd: number;
  declare public dailyUsd: number;
  /** `""` when its last check and run went well. */
  declare public lastError: string;
  /** The newest run's `StandingOutcome`, `""` before the first. */
  declare public lastOutcome: string;
  declare public lastRunAt: number;
  /** The pull request the newest run was about, `0` for none. */
  declare public lastRunPr: number;
  /** Occupant key of the coding agent running it now, `""` while none is. */
  declare public runningAgentId: string;

  public constructor() {
    super();
    this.id = "";
    this.runnerId = "";
    this.kind = "";
    this.name = "";
    this.status = "";
    this.trigger = "";
    this.lastCheckAt = 0;
    this.nextCheckAt = 0;
    this.queued = 0;
    this.handledToday = 0;
    this.spentTodayUsd = 0;
    this.dailyUsd = 0;
    this.lastError = "";
    this.lastOutcome = "";
    this.lastRunAt = 0;
    this.lastRunPr = 0;
    this.runningAgentId = "";
  }
}

defineTypes(StandingTask, {
  id: "string",
  runnerId: "string",
  kind: "string",
  name: "string",
  status: "string",
  trigger: "string",
  lastCheckAt: "number",
  nextCheckAt: "number",
  queued: "uint32",
  handledToday: "uint32",
  spentTodayUsd: "float64",
  dailyUsd: "float64",
  lastError: "string",
  lastOutcome: "string",
  lastRunAt: "number",
  lastRunPr: "uint32",
  runningAgentId: "string",
});

/**
 * One agent's update at a standup: what it has worked on so far and what
 * holds it up, as the office read it off the agent's real state when its turn
 * came. Every string is the server's own words over sanitised fields.
 */
export class StandupUpdate extends Schema {
  /** The agent's occupant key. */
  declare public agentId: string;
  /** By name, since the agent may leave before the standup ends. */
  declare public agentName: string;
  /** Its issue, how far it got and its pull request, in a line. */
  declare public workedOn: string;
  /** What holds it up, `""` for nothing. */
  declare public blockers: string;
  /** It waited on a person when it spoke: a permission, a question, a sign-in. */
  declare public needsYou: boolean;
  /** It waited on a person when it spoke, and has carried on since. */
  declare public resolved: boolean;
  /** Epoch milliseconds. */
  declare public at: number;

  public constructor() {
    super();
    this.agentId = "";
    this.agentName = "";
    this.workedOn = "";
    this.blockers = "";
    this.needsYou = false;
    this.resolved = false;
    this.at = 0;
  }
}

defineTypes(StandupUpdate, {
  agentId: "string",
  agentName: "string",
  workedOn: "string",
  blockers: "string",
  needsYou: "boolean",
  resolved: "boolean",
  at: "number",
});

/**
 * A direction the CEO gave one agent at a standup, and what came of it; one
 * given to everyone is one of these per agent, each marked `everyone`. The
 * statuses are `STANDUP_DIRECTION_STATUS` in `standup.ts`.
 */
export class StandupDirection extends Schema {
  /** Increasing within a room. */
  declare public id: number;
  declare public agentId: string;
  declare public agentName: string;
  declare public authorName: string;
  /** Sanitised as a prompt is: printable text and newlines. */
  declare public text: string;
  declare public everyone: boolean;
  declare public status: string;
  /** Why it was not typed, for a direction that failed; `""` otherwise. */
  declare public reason: string;
  /** Epoch milliseconds. */
  declare public at: number;

  public constructor() {
    super();
    this.id = 0;
    this.agentId = "";
    this.agentName = "";
    this.authorName = "";
    this.text = "";
    this.everyone = false;
    this.status = "";
    this.reason = "";
    this.at = 0;
  }
}

defineTypes(StandupDirection, {
  id: "uint32",
  agentId: "string",
  agentName: "string",
  authorName: "string",
  text: "string",
  everyone: "boolean",
  status: "string",
  reason: "string",
  at: "number",
});

/**
 * The office's standup: whether one is on, who called it, the order the
 * agents speak in, what each said, and the CEO's directions. State rather
 * than a broadcast, because a standup lasts minutes and a tab that joins or
 * reloads in the middle of one must see it as everyone else does. The record
 * of the last one stays after it ends, until the next is called, so a
 * direction queued for after it can still be seen to arrive.
 */
export class Standup extends Schema {
  declare public active: boolean;
  /** The CEO who called it, by name. */
  declare public calledBy: string;
  /** Epoch milliseconds; `0` before the first standup. */
  declare public startedAt: number;
  declare public endedAt: number;
  /** Agent occupant keys, in the order they give their updates. */
  declare public order: ArraySchema<string>;
  /** Whose turn it is to speak, `""` before the first and after the last. */
  declare public speakerId: string;
  declare public updates: ArraySchema<StandupUpdate>;
  declare public directions: ArraySchema<StandupDirection>;

  public constructor() {
    super();
    this.active = false;
    this.calledBy = "";
    this.startedAt = 0;
    this.endedAt = 0;
    this.order = new ArraySchema<string>();
    this.speakerId = "";
    this.updates = new ArraySchema<StandupUpdate>();
    this.directions = new ArraySchema<StandupDirection>();
  }
}

defineTypes(Standup, {
  active: "boolean",
  calledBy: "string",
  startedAt: "number",
  endedAt: "number",
  order: ["string"],
  speakerId: "string",
  updates: [StandupUpdate],
  directions: [StandupDirection],
});

/**
 * The CEO's desk terminal (`./deskTerminal.ts`): the desk the CEO sits at,
 * the coding agent lent to it, and how its session stands. State rather than
 * a broadcast, so every tab draws the session's terminal on that desk's
 * monitor, and the CEO's own tab opens the panel, from the same record. Only
 * the CEO has one, so there is one, empty while the CEO sits at no computer.
 */
export class DeskTerminal extends Schema {
  /** The seat's interactable id; `""` while there is no session. */
  declare public seatId: string;
  /** The CEO sitting there, by occupant id. */
  declare public ownerId: string;
  /** The lent agent's occupant key, whose screen the desk shows; `""` until one is lent. */
  declare public agentId: string;
  /** A `DeskTerminalPhase`. */
  declare public phase: string;
  /** The session waits on a choice on its screen, which takes keys rather than a prompt. */
  declare public needsInput: boolean;
  /** What its agent is doing, or what it waits on. */
  declare public activity: string;
  /** Why it ended, in the `ended` phase. */
  declare public note: string;

  public constructor() {
    super();
    this.seatId = "";
    this.ownerId = "";
    this.agentId = "";
    this.phase = "";
    this.needsInput = false;
    this.activity = "";
    this.note = "";
  }
}

defineTypes(DeskTerminal, {
  seatId: "string",
  ownerId: "string",
  agentId: "string",
  phase: "string",
  needsInput: "boolean",
  activity: "string",
  note: "string",
});

export class OfficeState extends Schema {
  declare public occupants: MapSchema<Occupant>;
  /** The agents' work on the project board's issues, keyed by {@link workKey}. */
  declare public work: MapSchema<IssueWork>;
  /** The runners' standing tasks, keyed by id. */
  declare public standing: MapSchema<StandingTask>;
  /**
   * Minutes since midnight on the in-game clock, 0 to 1439, which the lighting
   * reads. Only the server writes it, at whole-minute resolution; the server
   * keeps the fraction to itself.
   */
  declare public minuteOfDay: number;
  declare public tick: number;
  /**
   * The GitHub label that keeps an issue from the live coding agents,
   * `agent-restricted` unless the server says otherwise; `""` when the office
   * restricts nothing. Every other open issue may go to an agent. Replicated
   * so the board can say why an issue would be refused.
   */
  declare public agentRestrictLabel: string;
  /**
   * What the runners' real agents have spent today, in US dollars, all
   * runners together, and against their daily budgets added up; see
   * `./spend.ts`. Replicated so every tab shows the same books. With no runner
   * reporting, {@link spendRunners} is `0` and the rest means nothing.
   */
  declare public spendRunners: number;
  declare public spentUsd: number;
  /** Whether every runner reporting has a budget; {@link budgetUsd} means nothing otherwise. */
  declare public budgeted: boolean;
  declare public budgetUsd: number;
  /** Whether any runner reporting has spent its own budget and refuses new starts. */
  declare public budgetSpent: boolean;
  /** The standup, on or the last one held; see `./standup.ts`. */
  declare public standup: Standup;
  /**
   * Whether an agent runner that can close and reopen the board's issues on
   * GitHub is connected; see `./issueState.ts`. Replicated so the board only
   * offers the drops that would be made, and says why while it offers none.
   */
  declare public issuesWritable: boolean;
  /** The CEO's desk terminal; see `./deskTerminal.ts`. */
  declare public desk: DeskTerminal;

  public constructor() {
    super();
    this.occupants = new MapSchema<Occupant>();
    this.work = new MapSchema<IssueWork>();
    this.standing = new MapSchema<StandingTask>();
    this.minuteOfDay = STARTING_MINUTE_OF_DAY;
    this.tick = 0;
    this.agentRestrictLabel = "";
    this.spendRunners = 0;
    this.spentUsd = 0;
    this.budgeted = false;
    this.budgetUsd = 0;
    this.budgetSpent = false;
    this.standup = new Standup();
    this.issuesWritable = false;
    this.desk = new DeskTerminal();
  }
}

defineTypes(OfficeState, {
  occupants: { map: Occupant },
  work: { map: IssueWork },
  standing: { map: StandingTask },
  minuteOfDay: "uint16",
  tick: "uint32",
  agentRestrictLabel: "string",
  spendRunners: "uint8",
  spentUsd: "float64",
  budgeted: "boolean",
  budgetUsd: "float64",
  budgetSpent: "boolean",
  standup: Standup,
  issuesWritable: "boolean",
  desk: DeskTerminal,
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

/** Narrows an occupant to a live coding agent, by `kind` for the same reason. */
export function isLiveAgent(occupant: Occupant): occupant is LiveAgent {
  return occupant.kind === OCCUPANT_KIND.liveAgent;
}

/** Narrows an occupant to the AI manager, by `kind` for the same reason. */
export function isAiManager(occupant: Occupant): occupant is AiManager {
  return occupant.kind === OCCUPANT_KIND.manager;
}
