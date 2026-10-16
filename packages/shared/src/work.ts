/**
 * The rules of the agents' work on the project board's GitHub issues.
 *
 * The issues are GitHub's: the project board's snapshot says which are open,
 * and nothing here ever writes to GitHub. What the office does about an issue
 * — which agent employee has it, how far they have got, what they handed in —
 * is an {@link IssueWork} in replicated state, and this module says what may
 * be done to one. The split matters because the schema replicates to every
 * browser while these rules only ever decide on the server: a client asks the
 * same questions to grey out a control, but the copy here is the authority.
 *
 * Five things live here:
 *
 * - {@link WORK_TRANSITIONS}, the legal status edges, so a client that asks
 *   for an arbitrary jump is rejected rather than obeyed.
 * - {@link mayActOnWork}, the one place authority is decided, reading the
 *   {@link WORK_ACTION_AUTHORITY} table: the CEO hands the work out and judges
 *   it, and the agent employee an issue was given to does the work on it.
 * - {@link applyWorkCommand}, which validates a parsed command against the
 *   live office and the project board and mutates the work, or rejects it and
 *   leaves everything untouched.
 * - {@link workForAgent}, which issue an agent employee should pick up next,
 *   so that two agents can never be working the same one.
 * - {@link releaseGoneWork}, which takes work off its agent once GitHub says
 *   the issue is closed or gone, and {@link releaseWorkOf}, which does the
 *   same when the agent leaves the office.
 *
 * Who can hold work at all is {@link isIssueAssignee}: an agent employee, or a
 * live coding agent whose source drives its work through these same rules.
 *
 * Everything is synchronous and allocation-light, so a command handler can run
 * inside the room without the simulation tick ever having to wait on it.
 */

import { type MapSchema } from "@colyseus/schema";

import {
  type WorkAssignMessage,
  type WorkMoveMessage,
  type WorkReleaseMessage,
  sanitizeWorkNote,
} from "./messages.js";
import { isLiveAgentKey } from "./liveAgents.js";
import { type ProjectBoardSnapshot, isIssueGone, openBoardIssue } from "./projectBoard.js";
import {
  IssueWork,
  OCCUPANT_KIND,
  type Occupant,
  type OccupantKind,
  WORK_STATUS,
  WORK_STATUSES,
  type WorkStatus,
  isAgentEmployee,
  isCeo,
  isLiveAgent,
  isWorkStatus,
  workKey,
} from "./state.js";

/**
 * The legal status edges, as adjacency.
 *
 * Read it as "from -> the statuses you may move to". Work moves forward one
 * step at a time and can be pushed back one step, so the CEO can send a review
 * back for rework and have a stuck agent try again from the start. `done` is
 * terminal: reopening finished work is a product decision nobody has made.
 *
 * Leaving the board altogether is not an edge here. Work that has not started
 * is {@link WORK_ACTION.release}d instead, which removes it; see
 * {@link mayRelease}.
 */
export const WORK_TRANSITIONS: Readonly<Record<WorkStatus, readonly WorkStatus[]>> = {
  [WORK_STATUS.assigned]: [WORK_STATUS.in_progress],
  [WORK_STATUS.in_progress]: [WORK_STATUS.assigned, WORK_STATUS.review],
  [WORK_STATUS.review]: [WORK_STATUS.in_progress, WORK_STATUS.done],
  [WORK_STATUS.done]: [],
};

/** Whether `to` is reachable from `from` in one move. A self-move is not. */
export function isLegalWorkTransition(from: WorkStatus, to: WorkStatus): boolean {
  return WORK_TRANSITIONS[from].includes(to);
}

/**
 * The statuses this work can move to right now: {@link WORK_TRANSITIONS},
 * except for a `review` whose assignee has left the office.
 *
 * Such a review keeps its assignee as the record of who handed it in, but
 * sending it back for rework cannot return it to them, so the rework edge is
 * dropped and the work is released instead, for the CEO to hand on.
 *
 * @param isPresent Whether an occupant id is in the office.
 */
export function workTransitions(
  work: WorkData,
  isPresent: (occupantId: string) => boolean,
): readonly WorkStatus[] {
  const edges = WORK_TRANSITIONS[work.status];
  if (work.status !== WORK_STATUS.review || isPresent(work.assigneeId)) {
    return edges;
  }
  return edges.filter((to) => to !== WORK_STATUS.in_progress);
}

/**
 * Whether this work can be released: taken off its agent, leaving the issue
 * free on the board.
 *
 * Only work nobody has started, so a release never discards progress, and a
 * review whose assignee has left, which can no longer go back to them; see
 * {@link workTransitions}. Work that has started is walked back a step at a
 * time first.
 */
export function mayRelease(work: WorkData, isPresent: (occupantId: string) => boolean): boolean {
  return (
    work.status === WORK_STATUS.assigned ||
    (work.status === WORK_STATUS.review && !isPresent(work.assigneeId))
  );
}

/** What a command wants to do, for the authority check. */
export const WORK_ACTION = {
  assign: "assign",
  release: "release",
  moveStatus: "move-status",
  /** An agent starts on an issue it was given: `assigned` -> `in_progress`. */
  claim: "claim",
  /** An agent writes its deliverable onto an issue it is working. */
  attachOutput: "attach-output",
  /** An agent hands finished work in for review: `in_progress` -> `review`. */
  handIn: "hand-in",
  /** An agent says why it is stuck. */
  note: "note",
} as const;

export type WorkAction = (typeof WORK_ACTION)[keyof typeof WORK_ACTION];

/** Who an action is open to. */
export const WORK_AUTHORITY = {
  /** Only the player holding the CEO role. */
  ceo: "ceo",
  /** Only the agent the work is assigned to; see {@link isIssueAssignee}. */
  assignee: "assignee",
} as const;

export type WorkAuthority = (typeof WORK_AUTHORITY)[keyof typeof WORK_AUTHORITY];

/**
 * Who may perform each action: the work's authority rules, as data.
 *
 * The CEO decides and everyone else watches and advises, so handing an issue
 * out, taking it back, and every status move — approving a review, sending it
 * back, having a stuck agent try again — is the CEO's.
 *
 * The assignee's own moves — starting work, attaching the deliverable, handing
 * it in, saying why it is stuck — are the agent employee's, and only for an
 * issue the CEO gave it. They are separate actions rather than a wider
 * `move-status` because each is exactly one step of the work: an agent can
 * start what it was given and hand in what it started, and nothing else, so it
 * can neither pick its own issue off the board nor approve itself.
 *
 * Typed as a full record so that adding an action without deciding who may
 * perform it does not compile.
 */
export const WORK_ACTION_AUTHORITY: Readonly<Record<WorkAction, WorkAuthority>> = {
  [WORK_ACTION.assign]: WORK_AUTHORITY.ceo,
  [WORK_ACTION.release]: WORK_AUTHORITY.ceo,
  [WORK_ACTION.moveStatus]: WORK_AUTHORITY.ceo,
  [WORK_ACTION.claim]: WORK_AUTHORITY.assignee,
  [WORK_ACTION.attachOutput]: WORK_AUTHORITY.assignee,
  [WORK_ACTION.handIn]: WORK_AUTHORITY.assignee,
  [WORK_ACTION.note]: WORK_AUTHORITY.assignee,
};

/**
 * Who is asking.
 *
 * A projection of {@link Occupant} rather than the occupant itself, so the
 * authority rules — the work's, the staff's and the manager's — cannot come to
 * depend on a position or an animation state. Build one with {@link actorOf}
 * rather than by hand.
 */
export interface OfficeActor {
  readonly id: string;
  readonly kind: OccupantKind;
  readonly isCeo: boolean;
  /** A live agent's `canTakeIssues`; absent for anyone else. */
  readonly canTakeIssues?: boolean;
}

/**
 * Projects an occupant to the actor the authority rules judge.
 *
 * Shared so that the server judging a command and the client deciding whether
 * to offer it read the role the same way.
 */
export function actorOf(occupant: Occupant): OfficeActor {
  const actor = { id: occupant.id, kind: occupant.kind, isCeo: isCeo(occupant) };
  return isLiveAgent(occupant) ? { ...actor, canTakeIssues: occupant.canTakeIssues } : actor;
}

/**
 * Whether issue work can be given to this occupant: an agent employee, or a
 * live coding agent that can take issues. **Nothing else decides it**: the
 * assignee branch of {@link mayActOnWork} and assigning work both ask this.
 *
 * A live agent only qualifies when its source drives its work through these
 * rules, so one that merely reports what it is doing is never handed an issue
 * it would not know it had. A player has no desk to work one at, and the
 * manager hands work out rather than doing it.
 */
export function isIssueAssignee(occupant: Pick<OfficeActor, "kind" | "canTakeIssues">): boolean {
  return (
    occupant.kind === OCCUPANT_KIND.agent ||
    (occupant.kind === OCCUPANT_KIND.liveAgent && occupant.canTakeIssues === true)
  );
}

/**
 * A piece of work's fields, without the schema around them.
 *
 * The server judges a live {@link IssueWork}; the board panel judges the plain
 * copy it renders from. Both satisfy this, so the authority seam and the move
 * planner below answer the same question for either side.
 */
export type WorkData = Readonly<
  Pick<
    IssueWork,
    "issueNumber" | "title" | "status" | "assigneeId" | "outputArtifact" | "note" | "assignedAt" | "updatedAt"
  >
>;

/** A single authority question: may this actor do this to this work? */
export interface WorkPermissionQuery {
  readonly actor: OfficeActor;
  readonly action: WorkAction;
  /** The work being acted on; absent when nobody is working the issue yet. */
  readonly work?: WorkData;
}

/** The shape {@link mayActOnWork} satisfies, so a caller can substitute one. */
export type WorkPermission = (query: WorkPermissionQuery) => boolean;

/**
 * Whether an actor may perform an action. **The one authority gate.**
 *
 * Every path in {@link applyWorkCommand} consults this exactly once, before it
 * validates anything else, and nothing else in the codebase decides work
 * authority: not a handler, not a message parser, not the transition table.
 * The client asks it too, to show a control as disabled rather than to decide
 * anything.
 *
 * Reads {@link WORK_ACTION_AUTHORITY}, and the work only to see whether an
 * agent asking is the one it is assigned to. A player is never an assignee in
 * this sense, CEO included: the work on an issue is the agent's, not a
 * shortcut the CEO can take past it.
 */
export function mayActOnWork(query: WorkPermissionQuery): boolean {
  switch (WORK_ACTION_AUTHORITY[query.action]) {
    case WORK_AUTHORITY.ceo:
      return query.actor.isCeo;
    case WORK_AUTHORITY.assignee:
      return (
        isIssueAssignee(query.actor) &&
        query.work !== undefined &&
        query.work.assigneeId === query.actor.id
      );
  }
}

/** A change the board panel may offer on work in hand, and the command that makes it. */
export type WorkMove =
  | { readonly action: typeof WORK_ACTION.moveStatus; readonly to: WorkStatus }
  | { readonly action: typeof WORK_ACTION.release };

/**
 * Every change this actor can make to this work right now: the status moves in
 * order, then a release if one is open.
 *
 * The client's mirror of {@link applyWorkCommand}, built from the same
 * transitions and authority seam, so the panel never offers a move the server
 * will refuse.
 *
 * @param isPresent Whether an occupant id is in the office; see
 *   {@link workTransitions}.
 */
export function workMoves(
  work: WorkData,
  actor: OfficeActor,
  isPresent: (occupantId: string) => boolean,
  permit: WorkPermission = mayActOnWork,
): WorkMove[] {
  const moves: WorkMove[] = [];
  if (permit({ actor, action: WORK_ACTION.moveStatus, work })) {
    const edges = [...workTransitions(work, isPresent)].sort(
      (a, b) => WORK_STATUSES.indexOf(a) - WORK_STATUSES.indexOf(b),
    );
    for (const to of edges) {
      moves.push({ action: WORK_ACTION.moveStatus, to });
    }
  }
  if (mayRelease(work, isPresent) && permit({ actor, action: WORK_ACTION.release, work })) {
    moves.push({ action: WORK_ACTION.release });
  }
  return moves;
}

/** Whether the panel should offer this actor a way to hand an issue to an agent. */
export function mayAssignWork(actor: OfficeActor, permit: WorkPermission = mayActOnWork): boolean {
  return permit({ actor, action: WORK_ACTION.assign });
}

/** Why a command was refused. Rejection never changes the office. */
export const WORK_REJECTION = {
  /** The authority seam said no. */
  forbidden: "forbidden",
  /** The project board has no open issue with that number. */
  unknownIssue: "unknown-issue",
  /** Nobody in the office is working that issue. */
  noWork: "no-work",
  /** The requested status is not reachable from the current one. */
  illegalTransition: "illegal-transition",
  /** The named assignee is not in the office, or is not one that can take issues. */
  unknownAssignee: "unknown-assignee",
  /** A hand-in with no deliverable attached, or an attachment with no text. */
  missingArtifact: "missing-artifact",
} as const;

export type WorkRejection = (typeof WORK_REJECTION)[keyof typeof WORK_REJECTION];

/**
 * The issue an agent's own command is about.
 *
 * Not a client message: no client message is an agent's, so these commands
 * are only ever built by the server, for the agent it is running.
 */
export interface WorkClaimPayload {
  readonly issueNumber: number;
}

export interface WorkAttachOutputPayload {
  readonly issueNumber: number;
  /** The deliverable, as the work executor returned it. Never empty. */
  readonly artifact: string;
}

export interface WorkHandInPayload {
  readonly issueNumber: number;
}

export interface WorkNotePayload {
  readonly issueNumber: number;
  /** Sanitized by the applier, so a brain may pass a provider's message as it came. */
  readonly text: string;
}

/** A parsed command, tagged so the applier can switch on it. */
export type WorkCommand =
  | { readonly action: typeof WORK_ACTION.assign; readonly payload: WorkAssignMessage }
  | { readonly action: typeof WORK_ACTION.release; readonly payload: WorkReleaseMessage }
  | { readonly action: typeof WORK_ACTION.moveStatus; readonly payload: WorkMoveMessage }
  | { readonly action: typeof WORK_ACTION.claim; readonly payload: WorkClaimPayload }
  | { readonly action: typeof WORK_ACTION.attachOutput; readonly payload: WorkAttachOutputPayload }
  | { readonly action: typeof WORK_ACTION.handIn; readonly payload: WorkHandInPayload }
  | { readonly action: typeof WORK_ACTION.note; readonly payload: WorkNotePayload };

/**
 * Everything a command needs that is not in its own payload.
 *
 * `now` is passed in rather than read from the clock so that the rules are a
 * pure function of their inputs, which is what makes them testable without a
 * running room.
 */
export interface WorkCommandContext {
  readonly work: MapSchema<IssueWork>;
  /** Consulted to resolve an assignee; the room's occupants map. */
  readonly occupants: MapSchema<Occupant>;
  /** The project board as the server last had it; `undefined` before its first poll. */
  readonly board: ProjectBoardSnapshot | undefined;
  readonly actor: OfficeActor;
  /** Epoch milliseconds to stamp on whatever the command changes. */
  readonly now: number;
  /** Defaults to {@link mayActOnWork}. */
  readonly permit?: WorkPermission;
}

export type WorkCommandResult =
  | { readonly ok: true; readonly work: IssueWork }
  | { readonly ok: false; readonly rejection: WorkRejection };

function reject(rejection: WorkRejection): WorkCommandResult {
  return { ok: false, rejection };
}

/**
 * Validates a command against the live office and applies it, or rejects it.
 *
 * Nothing is written unless every check passes, so a rejected command leaves
 * the work byte-identical and there is no half-applied state for a client to
 * observe. A successful release returns the work it removed.
 *
 * Commands are resolved against the office *as it is now*, never against a
 * view the client sent along. Colyseus delivers a room's messages one at a
 * time on one thread, so two clients acting on the same issue are two
 * sequential calls here: the first wins and the second is measured against the
 * result, which is why a stale click is rejected instead of racing.
 */
export function applyWorkCommand(command: WorkCommand, context: WorkCommandContext): WorkCommandResult {
  const permit = context.permit ?? mayActOnWork;
  const work = context.work.get(workKey(command.payload.issueNumber));

  if (command.action === WORK_ACTION.assign) {
    if (!permit({ actor: context.actor, action: WORK_ACTION.assign, ...(work === undefined ? {} : { work }) })) {
      return reject(WORK_REJECTION.forbidden);
    }
    return assignWork(work, command.payload, context);
  }

  if (work === undefined) {
    return reject(WORK_REJECTION.noWork);
  }
  if (!permit({ actor: context.actor, action: command.action, work })) {
    return reject(WORK_REJECTION.forbidden);
  }

  switch (command.action) {
    case WORK_ACTION.release:
      return releaseWork(work, context);
    case WORK_ACTION.moveStatus:
      return moveWorkStatus(work, command.payload, context);
    case WORK_ACTION.claim:
      return claimWork(work, context);
    case WORK_ACTION.attachOutput:
      return attachWorkOutput(work, command.payload, context);
    case WORK_ACTION.handIn:
      return handInWork(work, context);
    case WORK_ACTION.note:
      return noteOnWork(work, command.payload, context);
  }
}

/**
 * Gives an issue to an agent, or hands its work to another.
 *
 * A new piece of work needs the issue open on the project board: an issue the
 * board does not show as open is closed, or not one the server knows about,
 * and there is nothing to do on either. Giving work in hand to someone else is
 * a reassignment and leaves the status alone — pulling an `in_progress` issue
 * back to `assigned` because it changed hands would lose the fact that work
 * had started.
 *
 * Only an {@link isIssueAssignee} does issues.
 */
function assignWork(
  work: IssueWork | undefined,
  payload: WorkAssignMessage,
  context: WorkCommandContext,
): WorkCommandResult {
  if (work?.status === WORK_STATUS.done) {
    // Reassigning finished work would rewrite the record of who did it, and
    // `done` has no outgoing edge to carry the change anyway.
    return reject(WORK_REJECTION.illegalTransition);
  }
  const issue = work === undefined ? openBoardIssue(context.board, payload.issueNumber) : undefined;
  if (work === undefined && issue === undefined) {
    return reject(WORK_REJECTION.unknownIssue);
  }
  const assignee = context.occupants.get(payload.assigneeId);
  if (assignee === undefined || !isIssueAssignee(assignee)) {
    return reject(WORK_REJECTION.unknownAssignee);
  }

  if (work !== undefined) {
    if (work.assigneeId !== payload.assigneeId) {
      work.assigneeId = payload.assigneeId;
      work.note = "";
      work.updatedAt = context.now;
    }
    return { ok: true, work };
  }

  const created = new IssueWork();
  created.issueNumber = payload.issueNumber;
  created.title = issue?.title ?? "";
  created.status = WORK_STATUS.assigned;
  created.assigneeId = payload.assigneeId;
  created.assignedAt = context.now;
  created.updatedAt = context.now;
  context.work.set(workKey(created.issueNumber), created);
  return { ok: true, work: created };
}

/** Takes work off its agent, leaving the issue free on the board; see {@link mayRelease}. */
function releaseWork(work: IssueWork, context: WorkCommandContext): WorkCommandResult {
  if (!mayRelease(work, (id) => context.occupants.has(id))) {
    return reject(WORK_REJECTION.illegalTransition);
  }
  context.work.delete(workKey(work.issueNumber));
  return { ok: true, work };
}

/**
 * The CEO moves the work a step. The note goes with the status it explained,
 * so an agent sent to try again is no longer shown stuck for the old reason.
 */
function moveWorkStatus(
  work: IssueWork,
  payload: WorkMoveMessage,
  context: WorkCommandContext,
): WorkCommandResult {
  if (!workTransitions(work, (id) => context.occupants.has(id)).includes(payload.status)) {
    return reject(WORK_REJECTION.illegalTransition);
  }
  work.status = payload.status;
  work.note = "";
  work.updatedAt = context.now;
  return { ok: true, work };
}

/**
 * An agent starts the issue it was given.
 *
 * Only from `assigned`: work already `in_progress` is being worked, by this
 * agent or one it was taken from, and claiming it again would change nothing.
 */
function claimWork(work: IssueWork, context: WorkCommandContext): WorkCommandResult {
  if (work.status !== WORK_STATUS.assigned || !isLegalWorkTransition(work.status, WORK_STATUS.in_progress)) {
    return reject(WORK_REJECTION.illegalTransition);
  }
  work.status = WORK_STATUS.in_progress;
  work.updatedAt = context.now;
  return { ok: true, work };
}

/**
 * An agent writes its deliverable onto the work it is doing.
 *
 * Only while `in_progress`, so a deliverable can never land on work that was
 * pulled back to `assigned` or already approved. A rework replaces the last
 * one: the work holds what is up for review, not a history.
 */
function attachWorkOutput(
  work: IssueWork,
  payload: WorkAttachOutputPayload,
  context: WorkCommandContext,
): WorkCommandResult {
  if (work.status !== WORK_STATUS.in_progress) {
    return reject(WORK_REJECTION.illegalTransition);
  }
  if (payload.artifact.trim() === "") {
    return reject(WORK_REJECTION.missingArtifact);
  }
  work.outputArtifact = payload.artifact;
  work.updatedAt = context.now;
  return { ok: true, work };
}

/**
 * An agent hands its work in for the CEO to approve or send back.
 *
 * Refused without a deliverable, so nothing reaches `review` with nothing in
 * it to review.
 */
function handInWork(work: IssueWork, context: WorkCommandContext): WorkCommandResult {
  if (work.status !== WORK_STATUS.in_progress || !isLegalWorkTransition(work.status, WORK_STATUS.review)) {
    return reject(WORK_REJECTION.illegalTransition);
  }
  if (work.outputArtifact === "") {
    return reject(WORK_REJECTION.missingArtifact);
  }
  work.status = WORK_STATUS.review;
  work.note = "";
  work.updatedAt = context.now;
  return { ok: true, work };
}

/** An agent says why it is stuck, replacing whatever the work said before. */
function noteOnWork(work: IssueWork, payload: WorkNotePayload, context: WorkCommandContext): WorkCommandResult {
  if (work.status === WORK_STATUS.done) {
    return reject(WORK_REJECTION.illegalTransition);
  }
  work.note = sanitizeWorkNote(payload.text);
  work.updatedAt = context.now;
  return { ok: true, work };
}

/**
 * The issue an agent employee should work on next, or `undefined`.
 *
 * Only issues the CEO gave this agent, so an agent never chooses its own work
 * off the board. Both `assigned` (new work, to claim) and `in_progress` (work
 * sent back from review, or handed over from another agent) qualify; work
 * another agent still holds as its `currentIssueNumber` does not, so two
 * agents can never be working the same issue, even for the moment after a
 * reassignment while the first one is still putting it down.
 *
 * Longest-waiting first, then by issue number, so the choice is the same every
 * time for the same office.
 */
export function workForAgent(
  work: Iterable<IssueWork>,
  occupants: Iterable<Occupant>,
  agentId: string,
): IssueWork | undefined {
  const heldElsewhere = new Set<number>();
  for (const occupant of occupants) {
    if (isAgentEmployee(occupant) && occupant.id !== agentId && occupant.currentIssueNumber !== 0) {
      heldElsewhere.add(occupant.currentIssueNumber);
    }
  }

  let best: IssueWork | undefined;
  for (const candidate of work) {
    if (
      candidate.assigneeId !== agentId ||
      (candidate.status !== WORK_STATUS.assigned && candidate.status !== WORK_STATUS.in_progress) ||
      heldElsewhere.has(candidate.issueNumber)
    ) {
      continue;
    }
    if (
      best === undefined ||
      candidate.assignedAt < best.assignedAt ||
      (candidate.assignedAt === best.assignedAt && candidate.issueNumber < best.issueNumber)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Brings the office's work up to date with a fresh project board snapshot.
 *
 * Unfinished work on an issue GitHub says is closed or gone is released: the
 * issue is no longer there to do, so its agent puts it down, which the agent's
 * brain notices on its own next look. `done` work stays, as the record of who
 * finished it. Work on an issue the snapshot still lists takes the issue's
 * current title, so a renamed issue reads the same everywhere.
 *
 * The one exception is a live agent's work in `review`. A live agent's
 * deliverable is a pull request, and that pull request merging is what closes
 * the issue, so releasing the work then would erase it at the moment it
 * shipped. It becomes `done` instead, and is collected into `shipped` so the
 * room can say so. Whose work it was is read from the assignee's key, so a
 * review still ships after the live agent that handed it in has left.
 *
 * Run by the room when the feed publishes, never from the simulation tick.
 *
 * @param shipped Collects each live agent's review that the closure finished.
 * @returns the work released, in no particular order.
 */
export function releaseGoneWork(
  work: MapSchema<IssueWork>,
  board: ProjectBoardSnapshot,
  shipped: IssueWork[],
): IssueWork[] {
  const released: IssueWork[] = [];
  for (const [key, candidate] of work) {
    if (candidate.status !== WORK_STATUS.done && isIssueGone(board, candidate.issueNumber)) {
      const closed = board.closed.find((issue) => issue.number === candidate.issueNumber);
      if (closed !== undefined && candidate.status === WORK_STATUS.review && isLiveAgentKey(candidate.assigneeId)) {
        candidate.status = WORK_STATUS.done;
        candidate.note = "";
        candidate.updatedAt = Math.max(candidate.updatedAt, closed.closedAt ?? board.updatedAt ?? 0);
        shipped.push(candidate);
        continue;
      }
      work.delete(key);
      released.push(candidate);
      continue;
    }
    const title = openBoardIssue(board, candidate.issueNumber)?.title;
    if (title !== undefined && title !== candidate.title) {
      candidate.title = title;
    }
  }
  return released;
}

/**
 * Releases the unfinished work of an agent who has left the office, and
 * returns the numbers of the issues it was on, in the order the work was kept.
 *
 * The rule for every departure, an agent employee's or a live agent's: work
 * still `assigned` or `in_progress` is released, so it is never left waiting
 * on someone who has gone and is free on the project board for whoever the CEO
 * hands it to next. This deliberately steps outside the transition table,
 * which only walks `in_progress` back a step at a time: that rule is for a
 * player's command, and the agent whose work it was is no longer there to walk
 * it.
 *
 * `review` and `done` work keeps the agent as its assignee, which is the
 * record of who did it: a review is already handed in with its deliverable, so
 * the CEO can still approve it after the agent has left, or release it; see
 * {@link workTransitions}.
 */
export function releaseWorkOf(assigneeId: string, work: MapSchema<IssueWork>): number[] {
  const releasedIssues: number[] = [];
  for (const [key, entry] of work) {
    if (
      entry.assigneeId !== assigneeId ||
      (entry.status !== WORK_STATUS.assigned && entry.status !== WORK_STATUS.in_progress)
    ) {
      continue;
    }
    work.delete(key);
    releasedIssues.push(entry.issueNumber);
  }
  return releasedIssues;
}

/**
 * Checks the invariants every piece of work is meant to satisfy.
 *
 * Exported for tests in the same spirit as `describeLayoutProblems`: work that
 * breaks one of these is work a downstream panel will render wrongly, and that
 * is far cheaper to catch here.
 */
export function describeWorkProblems(work: MapSchema<IssueWork>): string[] {
  const problems: string[] = [];
  for (const [key, entry] of work) {
    if (key !== workKey(entry.issueNumber)) {
      problems.push(`work keyed ${key} is for issue #${entry.issueNumber}`);
    }
    if (!isWorkStatus(entry.status)) {
      problems.push(`work on #${entry.issueNumber} has unknown status "${entry.status}"`);
    }
    if (entry.assigneeId === "") {
      problems.push(`work on #${entry.issueNumber} has no assignee`);
    }
    if (entry.updatedAt < entry.assignedAt) {
      problems.push(`work on #${entry.issueNumber} was updated before it was assigned`);
    }
  }
  return problems;
}
