/**
 * The sticker boards' presentation: that a note looks the same wherever it is
 * drawn, says the pull request once handed in and that a simulated one is
 * simulated, fits its board's cells, and is animated only when it changes hands.
 */

import { NOTE_MOOD, NOTE_PLACE, type StickerNote } from "@sim/shared";
import { describe, expect, it } from "vitest";

import {
  GRID_SHAPES,
  MAX_NOTE_TILT,
  NOTE_PAPERS,
  boardGrid,
  boardPage,
  noteLook,
  noteMoves,
  noteWording,
  wrapLines,
} from "./stickerBoard.js";

const AGENT = "live-agent:runner:slot-1";

function note(issueNumber: number, fields: Partial<StickerNote> = {}): StickerNote {
  return {
    issueNumber,
    title: `Issue ${issueNumber}`,
    place: NOTE_PLACE.issues,
    mood: NOTE_MOOD.open,
    carrierId: "",
    assigneeId: "",
    pullRequest: undefined,
    ...fields,
  };
}

const names = (id: string) => (id === AGENT ? "Claude 1" : undefined);

describe("a note's look", () => {
  it("follows from its issue alone, so it is the same on the board and in hand", () => {
    const pinned = noteLook(note(111, { mood: NOTE_MOOD.open }));
    const held = noteLook(note(111, { place: NOTE_PLACE.carried, mood: NOTE_MOOD.working }));
    expect(held.paper).toBe(pinned.paper);
    expect(held.tilt).toBe(pinned.tilt);
  });

  it("is tilted a little either way, never more than the limit", () => {
    const tilts = Array.from({ length: 200 }, (_, index) => noteLook(note(index + 1)).tilt);
    expect(Math.max(...tilts.map(Math.abs))).toBeLessThanOrEqual(MAX_NOTE_TILT);
    expect(tilts.some((tilt) => tilt < 0)).toBe(true);
    expect(tilts.some((tilt) => tilt > 0)).toBe(true);
  });

  it("uses every paper colour, and its face says how the work stands", () => {
    const papers = new Set(Array.from({ length: NOTE_PAPERS.length }, (_, index) => noteLook(note(index)).paper));
    expect(papers.size).toBe(NOTE_PAPERS.length);
    expect(noteLook(note(1, { mood: NOTE_MOOD.stuck })).face).toBe("teary");
    expect(noteLook(note(1, { mood: NOTE_MOOD.shipped })).face).toBe("joy");
  });
});

describe("what a note says", () => {
  it("leads with the issue number, with the title under it", () => {
    expect(noteWording(note(12, { title: "Player jumping" }), names)).toEqual({
      heading: "#12",
      title: "Player jumping",
      tag: "",
      stamp: "",
    });
  });

  it("says who an assigned issue is for, and that a stopped one is stuck", () => {
    expect(noteWording(note(12, { mood: NOTE_MOOD.assigned, assigneeId: AGENT }), names).tag).toBe("for Claude 1");
    expect(noteWording(note(12, { mood: NOTE_MOOD.assigned, assigneeId: "gone" }), names).tag).toBe(
      "for someone who left",
    );
    expect(noteWording(note(12, { mood: NOTE_MOOD.stuck, assigneeId: AGENT }), names).tag).toBe("stuck!");
  });

  it("leads with the pull request once handed in, naming the issue it closes", () => {
    const handedIn = note(12, {
      title: "Player jumping",
      place: NOTE_PLACE.pullRequests,
      mood: NOTE_MOOD.review,
      pullRequest: { number: 41, simulated: false },
    });
    expect(noteWording(handedIn, names)).toEqual({
      heading: "PR #41",
      title: "#12 Player jumping",
      tag: "in review",
      stamp: "",
    });
  });

  it("marks a simulated pull request as simulated, with no number", () => {
    const simulated = note(12, {
      place: NOTE_PLACE.pullRequests,
      mood: NOTE_MOOD.review,
      pullRequest: { number: null, simulated: true },
    });
    expect(noteWording(simulated, names)).toMatchObject({ heading: "Sim PR", stamp: "SIMULATED" });
  });

  it("stamps a shipped one", () => {
    const shipped = note(12, {
      place: NOTE_PLACE.pullRequests,
      mood: NOTE_MOOD.shipped,
      pullRequest: { number: 41, simulated: false },
    });
    expect(noteWording(shipped, names)).toMatchObject({ stamp: "SHIPPED", tag: "merged!" });
  });
});

describe("a board's cells", () => {
  const board = { width: 3.6, height: 2.1 };

  it("fit inside the board, under its header, without overlapping, whatever the grid", () => {
    for (const [columns, rows] of GRID_SHAPES) {
      const grid = boardGrid(board, columns * rows);
      expect([grid.columns, grid.rows]).toEqual([columns, rows]);
      const half = grid.noteSize / 2;
      for (let index = 0; index < columns * rows; index += 1) {
        const slot = grid.slot(index);
        expect(Math.abs(slot.x) + half).toBeLessThanOrEqual(board.width / 2);
        expect(slot.y + half).toBeLessThanOrEqual(board.height / 2 - grid.header);
        expect(slot.y - half).toBeGreaterThanOrEqual(-board.height / 2);
      }
      const first = grid.slot(0);
      expect(grid.slot(1).x - first.x).toBeGreaterThan(grid.noteSize);
      expect(first.y - grid.slot(columns).y).toBeGreaterThan(grid.noteSize);
    }
  });

  it("are as big as the notes allow: large for a few, smaller to keep a busy board's notes all up", () => {
    const few = boardGrid(board, 3);
    const many = boardGrid(board, 12);
    expect(few.noteSize).toBeGreaterThan(0.6);
    expect(many.noteSize).toBeLessThan(few.noteSize);
    expect(many.columns * many.rows).toBeGreaterThanOrEqual(12);
    expect(boardGrid(board, 0)).toMatchObject({ columns: few.columns, rows: few.rows });
  });

  it("keep the busiest grid past its last cell, for the count to say the rest", () => {
    const last = GRID_SHAPES[GRID_SHAPES.length - 1] ?? [0, 0];
    expect(boardGrid(board, 100)).toMatchObject({ columns: last[0], rows: last[1] });
  });

  it("give the last cell to a count when there are more notes than cells", () => {
    const notes = Array.from({ length: 20 }, (_, index) => note(index + 1));
    const page = boardPage(notes, 15);
    expect(page.shown).toHaveLength(14);
    expect(page.more).toBe(6);
    expect(boardPage(notes.slice(0, 15), 15)).toEqual({ shown: notes.slice(0, 15), more: 0 });
  });
});

describe("when a note is seen moving", () => {
  it("is taken when it goes from a board to a hand, and pinned when it comes back down", () => {
    const onBoard = [note(5)];
    const inHand = [note(5, { place: NOTE_PLACE.carried, mood: NOTE_MOOD.working, carrierId: AGENT })];
    const pinned = [note(5, { place: NOTE_PLACE.pullRequests, mood: NOTE_MOOD.review })];
    expect(noteMoves(onBoard, inHand)).toEqual([
      { issueNumber: 5, kind: "take", place: NOTE_PLACE.issues, carrierId: AGENT },
    ]);
    expect(noteMoves(inHand, pinned)).toEqual([
      { issueNumber: 5, kind: "pin", place: NOTE_PLACE.pullRequests, carrierId: AGENT },
    ]);
  });

  it("is not animated when it only appears, goes, or changes how it reads", () => {
    expect(noteMoves([], [note(5)])).toEqual([]);
    expect(noteMoves([note(5)], [])).toEqual([]);
    expect(noteMoves([note(5)], [note(5, { mood: NOTE_MOOD.assigned })])).toEqual([]);
  });
});

describe("wrapping a title", () => {
  // Every character is ten wide.
  const measure = (text: string) => text.length * 10;

  it("breaks between words to fit the width", () => {
    expect(wrapLines(measure, "sticker boards for agents", 140, 3)).toEqual(["sticker boards", "for agents"]);
  });

  it("ends the last line with an ellipsis when the title runs on", () => {
    const lines = wrapLines(measure, "one two three four five six", 90, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith("…")).toBe(true);
    expect(lines.every((line) => measure(line) <= 90)).toBe(true);
  });

  it("cuts a word too long for a line rather than letting it overflow", () => {
    const lines = wrapLines(measure, "supercalifragilistic", 80, 3);
    expect(lines).toEqual(["superca…"]);
  });
});
