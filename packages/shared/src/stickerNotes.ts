/**
 * The sticky notes on the open floor's two sticker boards: which issues have a
 * note, and where each note is right now — pinned on the issues board, in a
 * coding agent's hand, or pinned on the pull requests board.
 *
 * A note has no state of its own. Its place follows from what is already
 * replicated: the project board's open issues, the office's work on each, and
 * the one issue each live agent is carrying ({@link LiveAgent.carriedIssue}).
 * So every client, a late joiner's included, works the same boards out of the
 * same patch, and a note can be neither in two places nor lost between them.
 *
 * The server's crew reads the same rules to decide which note an agent should
 * go and take, and where a note in its hand should be pinned
 * ({@link noteToFetch}, {@link noteDestination}), so the walk it sends the
 * agent on always ends with the note where these functions put it.
 */

import { ISSUES_STICKER_BOARD_ID, PULL_REQUESTS_STICKER_BOARD_ID } from "./layout.js";
import type { ProjectBoardSnapshot } from "./projectBoard.js";
import { isSimulatedPullRequestArtifact, pullRequestOfArtifact } from "./runner.js";
import { WORK_STATUS } from "./state.js";
import { type WorkData, isAgentReady } from "./work.js";

/** Where a note is. */
export const NOTE_PLACE = {
  issues: "issues",
  carried: "carried",
  pullRequests: "pull-requests",
} as const;

export type NotePlace = (typeof NOTE_PLACE)[keyof typeof NOTE_PLACE];

/** The sticker board each pinned place is, by its layout id. */
export const NOTE_BOARD_ID: Readonly<Record<Exclude<NotePlace, "carried">, string>> = {
  [NOTE_PLACE.issues]: ISSUES_STICKER_BOARD_ID,
  [NOTE_PLACE.pullRequests]: PULL_REQUESTS_STICKER_BOARD_ID,
};

/** How a note reads: what its face says and the expression its doodle wears. */
export const NOTE_MOOD = {
  /** On the issues board, and nobody has it. */
  open: "open",
  /** Given to an agent who has not taken it yet. */
  assigned: "assigned",
  /** Its agent stopped or could not carry on, so it is back on the issues board, saying so. */
  stuck: "stuck",
  /** In its agent's hand while the work is under way. */
  working: "working",
  /** Pinned with the pull request that is up for review. */
  review: "review",
  /** Its pull request shipped. */
  shipped: "shipped",
} as const;

export type NoteMood = (typeof NOTE_MOOD)[keyof typeof NOTE_MOOD];

/** The pull request a note on the pull requests board shows. */
export interface NotePullRequest {
  /** `null` for a simulated one, which has no number, or a deliverable that names none. */
  readonly number: number | null;
  readonly simulated: boolean;
}

export interface StickerNote {
  readonly issueNumber: number;
  /** The issue's title, from the snapshot when it lists the issue, else from the work. */
  readonly title: string;
  readonly place: NotePlace;
  readonly mood: NoteMood;
  /** The live agent with the note in hand while {@link place} is `carried`, else `""`. */
  readonly carrierId: string;
  /** The live agent the issue's work is assigned to, or `""` with no work. */
  readonly assigneeId: string;
  /** What was handed in, for a note on the pull requests board; `undefined` elsewhere. */
  readonly pullRequest: NotePullRequest | undefined;
}

/** A live agent as far as the notes care: who it is and which note it has in hand. */
export interface NoteCarrier {
  readonly id: string;
  /** `0` when it has none. */
  readonly carriedIssue: number;
}

/**
 * Shipped notes kept on the pull requests board, newest first. The office
 * keeps `done` work for good, and the board shows momentum, not a history.
 */
export const MAX_SHIPPED_NOTES = 4;

/** Whether this work has its agent on it and nothing stopping it: the note belongs in that agent's hand. */
function isUnderWay(work: WorkData): boolean {
  return work.status === WORK_STATUS.in_progress && work.note === "";
}

/** Whether the work is handed in or shipped, so its note belongs on the pull requests board. */
function isHandedIn(work: WorkData): boolean {
  return work.status === WORK_STATUS.review || work.status === WORK_STATUS.done;
}

/**
 * The issue whose note this agent should go and take off the issues board:
 * work given to it that it has started and is not stuck on, the most recently
 * changed if there is more than one. `0` for none.
 *
 * Only `in_progress` counts, because a note is taken when the agent starts,
 * which is the runner's `started` event claiming the work; a note on work
 * merely `assigned` stays on the board, marked with who it is for.
 */
export function noteToFetch(agentId: string, work: Iterable<WorkData>): number {
  let best: WorkData | undefined;
  for (const entry of work) {
    if (entry.assigneeId === agentId && isUnderWay(entry) && (best === undefined || entry.updatedAt > best.updatedAt)) {
      best = entry;
    }
  }
  return best?.issueNumber ?? 0;
}

/**
 * Where the note in an agent's hand should go, or `undefined` while it should
 * stay there.
 *
 * It stays while the work is still the agent's and nothing has stopped it —
 * `assigned` included, so an agent the CEO has start again keeps the note it
 * already holds. Handed in, it goes to the pull requests board; anything else
 * — taken back, given to someone else, stopped or failed with a note saying
 * why, closed on GitHub — puts it back on the issues board.
 */
export function noteDestination(agentId: string, issueNumber: number, work: Iterable<WorkData>): string | undefined {
  let entry: WorkData | undefined;
  for (const candidate of work) {
    if (candidate.issueNumber === issueNumber) {
      entry = candidate;
      break;
    }
  }
  if (entry !== undefined && entry.assigneeId === agentId) {
    if (isHandedIn(entry)) {
      return NOTE_BOARD_ID[NOTE_PLACE.pullRequests];
    }
    if (entry.note === "" && (entry.status === WORK_STATUS.in_progress || entry.status === WORK_STATUS.assigned)) {
      return undefined;
    }
  }
  return NOTE_BOARD_ID[NOTE_PLACE.issues];
}

/** The pull request a handed-in deliverable names, read off the text the runner wrote. */
function pullRequestOf(work: WorkData): NotePullRequest {
  if (isSimulatedPullRequestArtifact(work.outputArtifact)) {
    return { number: null, simulated: true };
  }
  return { number: pullRequestOfArtifact(work.outputArtifact)?.number ?? null, simulated: false };
}

/** What a note pinned on a board, rather than carried, reads as. */
function pinnedMood(work: WorkData | undefined): NoteMood {
  if (work === undefined) {
    return NOTE_MOOD.open;
  }
  if (work.status === WORK_STATUS.done) {
    return NOTE_MOOD.shipped;
  }
  if (work.status === WORK_STATUS.review) {
    return NOTE_MOOD.review;
  }
  return work.note === "" ? NOTE_MOOD.assigned : NOTE_MOOD.stuck;
}

/**
 * Every note, each exactly once: the issues board's in issue-number order,
 * then the pull requests board's (reviews newest first, then the most recent
 * shipped), then the ones in agents' hands.
 *
 * An issue gets a note when it is open on GitHub and an agent may take it
 * ({@link isAgentReady} with the office's label), or when the office has work
 * on it — work outlives the snapshot listing its issue, so a note in hand or
 * up for review is never lost to a board poll or a list cap. Done work keeps
 * only the {@link MAX_SHIPPED_NOTES} most recent.
 *
 * A note is wherever an agent says it is carrying it, first; a second agent
 * claiming the same issue does not get a copy. Otherwise handed-in work pins
 * it on the pull requests board and everything else on the issues board.
 *
 * @param board the project board, `undefined` before its first snapshot.
 * @param issueLabel the replicated `agentIssueLabel`; `""` takes every open issue.
 */
export function stickerNotes(
  board: ProjectBoardSnapshot | undefined,
  work: Iterable<WorkData>,
  carriers: Iterable<NoteCarrier>,
  issueLabel: string,
): StickerNote[] {
  const workByIssue = new Map<number, WorkData>();
  for (const entry of work) {
    workByIssue.set(entry.issueNumber, entry);
  }
  const carrierOf = new Map<number, string>();
  for (const carrier of carriers) {
    if (carrier.carriedIssue > 0 && !carrierOf.has(carrier.carriedIssue)) {
      carrierOf.set(carrier.carriedIssue, carrier.id);
    }
  }

  const titles = new Map<number, string>();
  for (const issue of [...(board?.open ?? []), ...(board?.inProgress ?? [])]) {
    if (isAgentReady(issue, issueLabel) || workByIssue.has(issue.number)) {
      titles.set(issue.number, issue.title);
    }
  }

  const shipped = [...workByIssue.values()]
    .filter((entry) => entry.status === WORK_STATUS.done)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.issueNumber - b.issueNumber);
  const keptShipped = new Set(shipped.slice(0, MAX_SHIPPED_NOTES).map((entry) => entry.issueNumber));

  const numbers = new Set<number>(titles.keys());
  for (const entry of workByIssue.values()) {
    if (entry.status !== WORK_STATUS.done || keptShipped.has(entry.issueNumber)) {
      numbers.add(entry.issueNumber);
    }
  }
  for (const issueNumber of carrierOf.keys()) {
    numbers.add(issueNumber);
  }

  const notes: StickerNote[] = [];
  for (const issueNumber of numbers) {
    const entry = workByIssue.get(issueNumber);
    const carrierId = carrierOf.get(issueNumber) ?? "";
    const title = titles.get(issueNumber) ?? (entry?.title !== undefined && entry.title !== "" ? entry.title : `Issue #${issueNumber}`);
    const handedIn = entry !== undefined && isHandedIn(entry);
    const place =
      carrierId !== "" ? NOTE_PLACE.carried : handedIn ? NOTE_PLACE.pullRequests : NOTE_PLACE.issues;
    notes.push({
      issueNumber,
      title,
      place,
      // A note on its way to the pull requests board already shows what it will be pinned as.
      mood: place === NOTE_PLACE.carried && !handedIn ? NOTE_MOOD.working : pinnedMood(entry),
      carrierId,
      assigneeId: entry?.assigneeId ?? "",
      pullRequest: handedIn ? pullRequestOf(entry) : undefined,
    });
  }

  const rank: Readonly<Record<NotePlace, number>> = {
    [NOTE_PLACE.issues]: 0,
    [NOTE_PLACE.pullRequests]: 1,
    [NOTE_PLACE.carried]: 2,
  };
  const updatedAt = (note: StickerNote) => workByIssue.get(note.issueNumber)?.updatedAt ?? 0;
  return notes.sort((a, b) => {
    if (a.place !== b.place) {
      return rank[a.place] - rank[b.place];
    }
    if (a.place === NOTE_PLACE.pullRequests && a.mood !== b.mood) {
      return a.mood === NOTE_MOOD.review ? -1 : 1;
    }
    if (a.place === NOTE_PLACE.pullRequests) {
      return updatedAt(b) - updatedAt(a) || a.issueNumber - b.issueNumber;
    }
    return a.issueNumber - b.issueNumber;
  });
}
