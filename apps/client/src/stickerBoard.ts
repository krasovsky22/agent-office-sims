/**
 * What the sticker boards' notes say, how each one looks, where it hangs on its
 * board and when it is seen moving between a board and an agent's hand.
 *
 * Where a note *is* is `@sim/shared`'s `stickerNotes`, worked out from
 * replicated state. This is the presentation on top of it, kept free of
 * Three.js and the canvas so it can be tested: `scene/stickerBoards.ts` paints
 * what this decides.
 *
 * A note's look follows from its issue number alone, so the same issue is the
 * same colour and tilt on every client, on the board, in hand and after a
 * reload.
 */

import { NOTE_MOOD, NOTE_PLACE, type NoteMood, type NotePlace, type StickerNote } from "@sim/shared";

/**
 * Pastel papers, picked by issue number. Bright enough to pop against cork and
 * pale enough that the dark outline and lettering read on every one.
 */
export const NOTE_PAPERS: readonly { readonly paper: string; readonly fold: string }[] = [
  { paper: "#ffd1e6", fold: "#f4a9cb" },
  { paper: "#fff2a1", fold: "#f1d966" },
  { paper: "#c9f5dc", fold: "#93e0b5" },
  { paper: "#d9ccff", fold: "#b6a2f5" },
  { paper: "#cdeaff", fold: "#97ccf2" },
  { paper: "#ffdcc0", fold: "#f6b98d" },
];

/** Largest tilt either way, in radians: enough to look pinned by hand, not enough to slow reading. */
export const MAX_NOTE_TILT = 0.09;

/** The doodled face a note wears. */
export type NoteFace = "smile" | "wink" | "determined" | "teary" | "starry" | "joy";

const FACE_OF_MOOD: Readonly<Record<NoteMood, NoteFace>> = {
  [NOTE_MOOD.open]: "smile",
  [NOTE_MOOD.assigned]: "wink",
  [NOTE_MOOD.working]: "determined",
  [NOTE_MOOD.stuck]: "teary",
  [NOTE_MOOD.review]: "starry",
  [NOTE_MOOD.shipped]: "joy",
};

export interface NoteLook {
  readonly paper: string;
  readonly fold: string;
  /** Radians, positive clockwise as drawn on the canvas. */
  readonly tilt: number;
  readonly face: NoteFace;
}

/** A small integer hash, so neighbouring issue numbers do not get neighbouring tilts. */
function scramble(value: number): number {
  let hash = Math.imul(value ^ 0x9e3779b9, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** How a note looks: its paper and tilt from its issue, its face from its mood. */
export function noteLook(note: Pick<StickerNote, "issueNumber" | "mood">): NoteLook {
  const hash = scramble(note.issueNumber);
  const papers = NOTE_PAPERS[note.issueNumber % NOTE_PAPERS.length] ?? NOTE_PAPERS[0];
  // Spread over [-1, 1] in 64 steps.
  const lean = ((hash % 64) / 63) * 2 - 1;
  return {
    paper: papers?.paper ?? "#fff2a1",
    fold: papers?.fold ?? "#f1d966",
    tilt: lean * MAX_NOTE_TILT,
    face: FACE_OF_MOOD[note.mood],
  };
}

/** The words on a note's face. */
export interface NoteWording {
  /** The big line, read from the desk rows: `#12`, or `PR #41` once handed in. */
  readonly heading: string;
  /** The issue's title; the board draws as much as fits. */
  readonly title: string;
  /** A few words on who has it or how it stands; `""` for nothing. */
  readonly tag: string;
  /** Stamped across the note, `SIMULATED` or `SHIPPED`; `""` for none. */
  readonly stamp: string;
}

/**
 * What a note says.
 *
 * On the pull requests board the pull request is the headline, with the issue
 * it closes ahead of the title. A simulated pull request has no number to show,
 * so it says what it is instead, and is stamped as one in case the headline is
 * all that reads from where the viewer stands.
 *
 * @param nameOf an agent's name by occupant id, `undefined` for one who has left.
 */
export function noteWording(note: StickerNote, nameOf: (id: string) => string | undefined): NoteWording {
  const issue = `#${note.issueNumber}`;
  const pull = note.pullRequest;
  if (pull !== undefined) {
    const heading = pull.number !== null ? `PR #${pull.number}` : pull.simulated ? "Sim PR" : "PR";
    const stamp = pull.simulated ? "SIMULATED" : note.mood === NOTE_MOOD.shipped ? "SHIPPED" : "";
    const tag = note.mood === NOTE_MOOD.shipped ? "merged!" : "in review";
    return { heading, title: `${issue} ${note.title}`, tag, stamp };
  }
  const assignee = note.assigneeId === "" ? undefined : (nameOf(note.assigneeId) ?? "someone who left");
  switch (note.mood) {
    case NOTE_MOOD.assigned:
      return { heading: issue, title: note.title, tag: assignee === undefined ? "" : `for ${assignee}`, stamp: "" };
    case NOTE_MOOD.stuck:
      return { heading: issue, title: note.title, tag: "stuck!", stamp: "" };
    case NOTE_MOOD.working:
      return { heading: issue, title: note.title, tag: "on it!", stamp: "" };
    default:
      return { heading: issue, title: note.title, tag: "", stamp: "" };
  }
}

/** A note's cell on its board, in metres from the board's centre, x right and y up. */
export interface NoteSlot {
  readonly x: number;
  readonly y: number;
}

/** How a board of a given size is laid out. */
export interface BoardGrid {
  readonly columns: number;
  readonly rows: number;
  /** Side of a note, in metres. */
  readonly noteSize: number;
  /** Height of the header band across the top, in metres. */
  readonly header: number;
  /** The cell at this index, filling rows left to right from the top. */
  slot(index: number): NoteSlot;
}

/** Room for the board's name across the top. */
const HEADER_FRACTION = 0.17;

/** Margin round the grid, in metres. */
const GRID_MARGIN = 0.08;

/** A note's share of its cell, the rest being the gap to its neighbours. */
const NOTE_FILL = 0.86;

/**
 * The grids a board tries, as columns by rows, biggest notes first. A board
 * with a few notes shows them large enough to read the title from the desk
 * rows; a busy one shrinks them to keep every note up rather than hide most.
 */
export const GRID_SHAPES: readonly (readonly [number, number])[] = [
  [4, 2],
  [5, 3],
  [6, 4],
];

/**
 * The note grid for a board holding `noteCount` notes: the first of
 * {@link GRID_SHAPES} with a cell for each, or the last, with square cells as
 * large as fit under the header, centred in what is left.
 */
export function boardGrid(size: { readonly width: number; readonly height: number }, noteCount: number): BoardGrid {
  const last = GRID_SHAPES[GRID_SHAPES.length - 1] ?? [6, 4];
  const [columns, rows] = GRID_SHAPES.find(([c, r]) => c * r >= noteCount) ?? last;
  const header = size.height * HEADER_FRACTION;
  const innerWidth = size.width - GRID_MARGIN * 2;
  const innerHeight = size.height - header - GRID_MARGIN * 2;
  const cell = Math.min(innerWidth / columns, innerHeight / rows);
  const left = -(cell * columns) / 2;
  const top = size.height / 2 - header - GRID_MARGIN - (innerHeight - cell * rows) / 2;
  return {
    columns,
    rows,
    noteSize: cell * NOTE_FILL,
    header,
    slot: (index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      return { x: left + cell * (column + 0.5), y: top - cell * (row + 0.5) };
    },
  };
}

/** The notes pinned on one board, in the order they hang. */
export function notesOn(notes: readonly StickerNote[], place: Exclude<NotePlace, "carried">): StickerNote[] {
  return notes.filter((note) => note.place === place);
}

/**
 * What a board shows in its cells: as many notes as fit, and how many more
 * there are. A board with more notes than cells gives its last cell to the
 * count rather than hiding the excess without a word.
 */
export function boardPage(pinned: readonly StickerNote[], capacity: number): { shown: StickerNote[]; more: number } {
  if (pinned.length <= capacity) {
    return { shown: [...pinned], more: 0 };
  }
  const shown = pinned.slice(0, Math.max(capacity - 1, 0));
  return { shown, more: pinned.length - shown.length };
}

/** A note seen changing hands: taken off a board into an agent's hand, or pinned from a hand onto a board. */
export interface NoteMove {
  readonly issueNumber: number;
  readonly kind: "take" | "pin";
  /** The pinned place it left or lands on. */
  readonly place: Exclude<NotePlace, "carried">;
  /** The agent whose hand it leaves or lands in. */
  readonly carrierId: string;
}

/**
 * The notes that changed hands between two lists, for the take and pin
 * animations. A note that only moved between boards, appeared or went is not
 * animated: nobody was seen carrying it.
 */
export function noteMoves(previous: readonly StickerNote[], next: readonly StickerNote[]): NoteMove[] {
  const before = new Map(previous.map((note) => [note.issueNumber, note]));
  const moves: NoteMove[] = [];
  for (const note of next) {
    const was = before.get(note.issueNumber);
    if (was === undefined || was.place === note.place) {
      continue;
    }
    if (was.place !== NOTE_PLACE.carried && note.place === NOTE_PLACE.carried) {
      moves.push({ issueNumber: note.issueNumber, kind: "take", place: was.place, carrierId: note.carrierId });
    } else if (was.place === NOTE_PLACE.carried && note.place !== NOTE_PLACE.carried) {
      moves.push({ issueNumber: note.issueNumber, kind: "pin", place: note.place, carrierId: was.carrierId });
    }
  }
  return moves;
}

/**
 * Breaks `text` into at most `maxLines` lines no wider than `maxWidth`,
 * ending the last with an ellipsis when the text runs on. A word wider than
 * a line is cut a character at a time rather than left to overflow.
 */
export function wrapLines(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (measure(candidate) <= maxWidth) {
      line = candidate;
      used += 1;
      continue;
    }
    if (line !== "") {
      lines.push(line);
      line = "";
      if (lines.length === maxLines) {
        break;
      }
    }
    used += 1;
    if (measure(word) <= maxWidth) {
      line = word;
      continue;
    }
    // One word too wide for a line of its own.
    lines.push(fit(measure, word, maxWidth));
    if (lines.length === maxLines) {
      break;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  const last = lines[lines.length - 1];
  if (used < words.length && last !== undefined && !last.endsWith("…")) {
    lines[lines.length - 1] = fit(measure, `${last}…`, maxWidth);
  }
  return lines;
}

/** Shortens `text` a character at a time until it fits, ending it with an ellipsis. */
function fit(measure: (text: string) => number, text: string, maxWidth: number): string {
  if (measure(text) <= maxWidth) {
    return text;
  }
  const characters = Array.from(text.endsWith("…") ? text.slice(0, -1) : text);
  while (characters.length > 1 && measure(`${characters.join("").trimEnd()}…`) > maxWidth) {
    characters.pop();
  }
  return `${characters.join("").trimEnd()}…`;
}
