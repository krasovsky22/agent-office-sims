/**
 * What the runner reads off an agent's terminal output without drawing it:
 * OSC 9;4 progress reports, and the recent output as plain text.
 *
 * Progress is how an agent says it is busy or idle when no hook fires, a turn
 * cancelled with Esc, say. The text is for spotting the first-run and sign-in
 * screens an agent can sit on before its hooks ever run. Neither needs the
 * screen itself, so this reads the byte stream as it comes, holding back an
 * escape sequence a chunk cut in two until the rest of it arrives.
 */

/** Recent output kept as text: a screen or two, enough for any first-run screen. */
const TEXT_KEPT = 4096;

/** Longest unfinished escape sequence held back for the next chunk; past it, it is dropped. */
const MAX_PENDING = 512;

/* eslint-disable no-control-regex -- reading terminal escape sequences is the point */
/** OSC 9;4 progress: `ESC ] 9 ; 4 ; <state> [; <percent>] (BEL | ESC \)`; state 0 is idle. */
const PROGRESS = /\x1b\]9;4;(\d)[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;
const CSI = /\x1b\[([0-?]*)[ -/]*([@-~])/y;
/** Any other escape: `ESC ( B`, `ESC =`, `ESC 7`. */
const OTHER_ESCAPE = /\x1b[ -/]*[0-~]/y;
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/** Cursor moves along the line, read as a space: Claude Code puts its words in place with them. */
const SAME_LINE_MOVES = new Set(["C", "G"]);

/** Cursor moves to another line, read as a line break so words on different lines never run together. */
const LINE_MOVES = new Set(["A", "B", "E", "F", "H", "f"]);

export class ScreenReader {
  private pending = "";
  private recent = "";

  /** The recent output as plain text, newest last. */
  public get text(): string {
    return this.recent;
  }

  /** Forgets the output so far: what is on the screen from now on is what counts. */
  public clear(): void {
    this.recent = "";
  }

  /**
   * Reads one chunk of output.
   *
   * @returns the last progress report in it, `true` for busy, or `undefined` when it has none.
   */
  public feed(data: string): boolean | undefined {
    let input = this.pending + data;
    this.pending = "";
    const held = unfinishedEscape(input);
    if (held !== undefined) {
      const tail = input.slice(held);
      input = input.slice(0, held);
      if (tail.length <= MAX_PENDING) {
        this.pending = tail;
      }
    }
    let busy: boolean | undefined;
    for (const match of input.matchAll(PROGRESS)) {
      busy = match[1] !== "0";
    }
    this.recent = (this.recent + plain(input)).slice(-TEXT_KEPT);
    return busy;
  }
}

/** Where an escape sequence the chunk ends in the middle of starts, if one does. */
function unfinishedEscape(input: string): number | undefined {
  const start = input.lastIndexOf("\x1b");
  if (start === -1) {
    return undefined;
  }
  const next = input[start + 1];
  if (next === undefined) {
    return start;
  }
  const pattern = next === "]" ? OSC : next === "[" ? CSI : OTHER_ESCAPE;
  pattern.lastIndex = start;
  return pattern.test(input) ? undefined : start;
}

/** Output with its escape sequences and control characters taken out. */
function plain(input: string): string {
  let text = "";
  let index = 0;
  while (index < input.length) {
    const escape = input.indexOf("\x1b", index);
    if (escape === -1) {
      text += input.slice(index);
      break;
    }
    text += input.slice(index, escape);
    index = escape + 1;
    for (const pattern of [OSC, CSI, OTHER_ESCAPE]) {
      pattern.lastIndex = escape;
      const match = pattern.exec(input);
      if (match !== null) {
        index = pattern.lastIndex;
        if (pattern === CSI) {
          const final = match[2] ?? "";
          // A move along the line stands in for spaces, as Claude Code draws them; a move to another line for a line break.
          text += SAME_LINE_MOVES.has(final) ? " " : LINE_MOVES.has(final) ? "\n" : "";
        }
        break;
      }
    }
  }
  return text.replace(/\r\n?/g, "\n").replace(CONTROL, "");
}
