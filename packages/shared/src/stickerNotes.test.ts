/**
 * Where each sticky note is, worked out from the board, the work and what the
 * agents carry: that every note is in exactly one place, follows the work
 * through start, hand-in, failure and release. Nothing else goes in, so a
 * client that joins late works out the same boards as one that watched.
 */

import { describe, expect, it } from "vitest";

import { ISSUES_STICKER_BOARD_ID, PULL_REQUESTS_STICKER_BOARD_ID } from "./layout.js";
import { type BoardIssue, EMPTY_BOARD_LISTS, type ProjectBoardSnapshot } from "./projectBoard.js";
import { simulatedPullRequestArtifact } from "./runner.js";
import { WORK_STATUS, type WorkStatus } from "./state.js";
import {
  MAX_SHIPPED_NOTES,
  NOTE_MOOD,
  NOTE_PLACE,
  type NoteCarrier,
  type StickerNote,
  noteDestination,
  noteToFetch,
  stickerNotes,
} from "./stickerNotes.js";
import type { WorkData } from "./work.js";

const LABEL = "agent-ready";
const AGENT = "live-agent:runner:slot-1";
const OTHER = "live-agent:runner:slot-2";
const T0 = 1_700_000_000_000;

function issue(number: number, labels: readonly string[] = [LABEL], title = `Issue ${number}`): BoardIssue {
  return {
    number,
    title,
    body: "",
    labels: labels.map((name) => ({ name, color: "" })),
    assignees: [],
    pullRequests: [],
    closedAt: null,
  };
}

function snapshot(open: readonly BoardIssue[], inProgress: readonly BoardIssue[] = []): ProjectBoardSnapshot {
  return {
    ...EMPTY_BOARD_LISTS,
    repository: "acme/office",
    updatedAt: T0,
    stale: false,
    open,
    inProgress,
    counts: { open: open.length, inProgress: inProgress.length, pullRequests: 0 },
  };
}

function work(issueNumber: number, status: WorkStatus, fields: Partial<WorkData> = {}): WorkData {
  return {
    issueNumber,
    title: `Issue ${issueNumber}`,
    status,
    assigneeId: AGENT,
    outputArtifact: "",
    note: "",
    assignedAt: T0,
    updatedAt: T0,
    ...fields,
  };
}

const NOBODY_CARRIES: readonly NoteCarrier[] = [];

function carrying(issueNumber: number, id = AGENT): NoteCarrier[] {
  return [{ id, carriedIssue: issueNumber }];
}

function noteFor(notes: readonly StickerNote[], issueNumber: number): StickerNote {
  const note = notes.find((candidate) => candidate.issueNumber === issueNumber);
  if (note === undefined) {
    throw new Error(`no note for #${issueNumber}`);
  }
  return note;
}

describe("which issues have a note", () => {
  it("gives every open agent-ready issue one on the issues board, in number order", () => {
    const notes = stickerNotes(snapshot([issue(12), issue(3)], [issue(7)]), [], NOBODY_CARRIES, LABEL);
    expect(notes.map((note) => [note.issueNumber, note.place, note.mood])).toEqual([
      [3, NOTE_PLACE.issues, NOTE_MOOD.open],
      [7, NOTE_PLACE.issues, NOTE_MOOD.open],
      [12, NOTE_PLACE.issues, NOTE_MOOD.open],
    ]);
  });

  it("leaves out an open issue no agent may take, and matches the label as GitHub does, without case", () => {
    const notes = stickerNotes(
      snapshot([issue(1, ["bug"]), issue(2, ["Agent-Ready"])]),
      [],
      NOBODY_CARRIES,
      LABEL,
    );
    expect(notes.map((note) => note.issueNumber)).toEqual([2]);
  });

  it("takes every open issue when the office asks for no label", () => {
    const notes = stickerNotes(snapshot([issue(1, []), issue(2, ["bug"])]), [], NOBODY_CARRIES, "");
    expect(notes.map((note) => note.issueNumber)).toEqual([1, 2]);
  });

  it("keeps the note of work in hand when the snapshot does not list its issue, titled from the work", () => {
    const notes = stickerNotes(undefined, [work(9, WORK_STATUS.review, { title: "Fix it" })], NOBODY_CARRIES, LABEL);
    expect(noteFor(notes, 9)).toMatchObject({ place: NOTE_PLACE.pullRequests, title: "Fix it" });
  });

  it("takes the title from the snapshot, which is the issue's current one", () => {
    const notes = stickerNotes(
      snapshot([issue(4, [LABEL], "Renamed")]),
      [work(4, WORK_STATUS.assigned, { title: "Old name" })],
      NOBODY_CARRIES,
      LABEL,
    );
    expect(noteFor(notes, 4).title).toBe("Renamed");
  });
});

describe("where a note is", () => {
  const board = snapshot([issue(5), issue(6)]);

  it("stays on the issues board, saying who it is for, while the work is only assigned", () => {
    const note = noteFor(stickerNotes(board, [work(5, WORK_STATUS.assigned)], NOBODY_CARRIES, LABEL), 5);
    expect(note).toMatchObject({ place: NOTE_PLACE.issues, mood: NOTE_MOOD.assigned, assigneeId: AGENT });
  });

  it("stays on the issues board after the agent starts, until the agent has taken it", () => {
    const note = noteFor(stickerNotes(board, [work(5, WORK_STATUS.in_progress)], NOBODY_CARRIES, LABEL), 5);
    expect(note.place).toBe(NOTE_PLACE.issues);
  });

  it("is in the agent's hand once the agent carries it", () => {
    const note = noteFor(stickerNotes(board, [work(5, WORK_STATUS.in_progress)], carrying(5), LABEL), 5);
    expect(note).toMatchObject({ place: NOTE_PLACE.carried, mood: NOTE_MOOD.working, carrierId: AGENT });
  });

  it("shows the pull request while it is carried to the pull requests board, then pinned there", () => {
    const handedIn = work(5, WORK_STATUS.review, { outputArtifact: "PR #41: Fix it, https://github.com/acme/office/pull/41" });
    const inHand = noteFor(stickerNotes(board, [handedIn], carrying(5), LABEL), 5);
    expect(inHand).toMatchObject({ place: NOTE_PLACE.carried, mood: NOTE_MOOD.review });
    expect(inHand.pullRequest).toEqual({ number: 41, simulated: false });

    const pinned = noteFor(stickerNotes(board, [handedIn], NOBODY_CARRIES, LABEL), 5);
    expect(pinned).toMatchObject({ place: NOTE_PLACE.pullRequests, mood: NOTE_MOOD.review });
    expect(pinned.pullRequest).toEqual({ number: 41, simulated: false });
  });

  it("marks a simulated pull request as one, with no number", () => {
    const handedIn = work(5, WORK_STATUS.review, { outputArtifact: simulatedPullRequestArtifact("Fix it") });
    const note = noteFor(stickerNotes(board, [handedIn], NOBODY_CARRIES, LABEL), 5);
    expect(note.pullRequest).toEqual({ number: null, simulated: true });
  });

  it("is shipped on the pull requests board once the work is done", () => {
    const note = noteFor(stickerNotes(board, [work(5, WORK_STATUS.done)], NOBODY_CARRIES, LABEL), 5);
    expect(note).toMatchObject({ place: NOTE_PLACE.pullRequests, mood: NOTE_MOOD.shipped });
  });

  it("goes back to the issues board, stuck, when the agent's work stopped with a note saying why", () => {
    const failed = work(5, WORK_STATUS.in_progress, { note: "Timed out after 30 minutes" });
    const note = noteFor(stickerNotes(board, [failed], NOBODY_CARRIES, LABEL), 5);
    expect(note).toMatchObject({ place: NOTE_PLACE.issues, mood: NOTE_MOOD.stuck });
  });

  it("goes back to the issues board, open, when the work is taken back", () => {
    const note = noteFor(stickerNotes(board, [], NOBODY_CARRIES, LABEL), 5);
    expect(note).toMatchObject({ place: NOTE_PLACE.issues, mood: NOTE_MOOD.open, assigneeId: "" });
  });

  it("stays in the hand of an agent walking it back, even after the work it was for is gone", () => {
    const note = noteFor(stickerNotes(board, [], carrying(5), LABEL), 5);
    expect(note).toMatchObject({ place: NOTE_PLACE.carried, carrierId: AGENT });
  });
});

describe("no note lost or duplicated", () => {
  it("lists every issue once, whatever the agents claim to carry", () => {
    const board = snapshot([issue(1), issue(2), issue(3)]);
    const notes = stickerNotes(
      board,
      [work(1, WORK_STATUS.in_progress), work(2, WORK_STATUS.review, { assigneeId: OTHER })],
      [
        { id: AGENT, carriedIssue: 1 },
        { id: OTHER, carriedIssue: 1 },
        { id: "live-agent:idle", carriedIssue: 0 },
      ],
      LABEL,
    );
    const numbers = notes.map((note) => note.issueNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.sort()).toEqual([1, 2, 3]);
    expect(noteFor(notes, 1).carrierId).toBe(AGENT);
  });

  it("orders the boards: issues, then pull requests with reviews first, then notes in hand", () => {
    const board = snapshot([issue(1), issue(2), issue(3), issue(4)]);
    const notes = stickerNotes(
      board,
      [
        work(1, WORK_STATUS.done, { updatedAt: T0 + 1 }),
        work(2, WORK_STATUS.review, { updatedAt: T0 + 2 }),
        work(3, WORK_STATUS.in_progress),
      ],
      carrying(3),
      LABEL,
    );
    expect(notes.map((note) => [note.issueNumber, note.place])).toEqual([
      [4, NOTE_PLACE.issues],
      [2, NOTE_PLACE.pullRequests],
      [1, NOTE_PLACE.pullRequests],
      [3, NOTE_PLACE.carried],
    ]);
  });

  it("keeps only the most recently shipped notes", () => {
    const done = Array.from({ length: MAX_SHIPPED_NOTES + 2 }, (_, index) =>
      work(100 + index, WORK_STATUS.done, { updatedAt: T0 + index }),
    );
    const notes = stickerNotes(undefined, done, NOBODY_CARRIES, LABEL);
    expect(notes.map((note) => note.issueNumber)).toEqual([105, 104, 103, 102]);
  });
});

describe("what an agent does with a note", () => {
  it("fetches the note of the work it has started and is not stuck on", () => {
    expect(noteToFetch(AGENT, [work(5, WORK_STATUS.in_progress)])).toBe(5);
    expect(noteToFetch(AGENT, [work(5, WORK_STATUS.assigned)])).toBe(0);
    expect(noteToFetch(AGENT, [work(5, WORK_STATUS.in_progress, { note: "failed" })])).toBe(0);
    expect(noteToFetch(AGENT, [work(5, WORK_STATUS.in_progress, { assigneeId: OTHER })])).toBe(0);
  });

  it("fetches the most recently changed when it somehow has two", () => {
    const two = [work(5, WORK_STATUS.in_progress, { updatedAt: T0 }), work(6, WORK_STATUS.in_progress, { updatedAt: T0 + 5 })];
    expect(noteToFetch(AGENT, two)).toBe(6);
  });

  it("keeps the note while the work is still its own and under way, a fresh start included", () => {
    expect(noteDestination(AGENT, 5, [work(5, WORK_STATUS.in_progress)])).toBeUndefined();
    expect(noteDestination(AGENT, 5, [work(5, WORK_STATUS.assigned)])).toBeUndefined();
  });

  it("pins it on the pull requests board once handed in or shipped", () => {
    expect(noteDestination(AGENT, 5, [work(5, WORK_STATUS.review)])).toBe(PULL_REQUESTS_STICKER_BOARD_ID);
    expect(noteDestination(AGENT, 5, [work(5, WORK_STATUS.done)])).toBe(PULL_REQUESTS_STICKER_BOARD_ID);
  });

  it("puts it back on the issues board when the work stopped, went elsewhere or is gone", () => {
    expect(noteDestination(AGENT, 5, [work(5, WORK_STATUS.in_progress, { note: "failed" })])).toBe(ISSUES_STICKER_BOARD_ID);
    expect(noteDestination(AGENT, 5, [work(5, WORK_STATUS.in_progress, { assigneeId: OTHER })])).toBe(
      ISSUES_STICKER_BOARD_ID,
    );
    expect(noteDestination(AGENT, 5, [])).toBe(ISSUES_STICKER_BOARD_ID);
  });
});
