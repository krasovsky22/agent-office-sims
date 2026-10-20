/**
 * The one text-cleaning policy for everything players and agents type.
 *
 * Every sanitizer and parser in the contract cleans text through these, so a
 * name, a chat line, a title and a terminal row all refuse the same
 * characters, and a new parser inherits the rule instead of copying a weaker
 * variant of it.
 */

/**
 * Everything that is not printable text: the C0 controls, DEL, the C1
 * controls, and the invisible marks that reorder text for whoever reads it
 * (`U+200E`, `U+200F`, `U+202A`–`U+202E`, `U+2066`–`U+2069`). A right-to-left
 * override in a name would read the rest of a nameplate backwards.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * Replaces every control character with `replacement`. A newline is let
 * through when `keepNewlines`, for text whose line breaks are its content.
 */
export function replaceControls(text: string, replacement: string, keepNewlines = false): string {
  return text.replace(CONTROL_CHARACTERS, (character) => (keepNewlines && character === "\n" ? character : replacement));
}

/** Whether `text` holds any control character. */
export function hasControls(text: string): boolean {
  return text.search(CONTROL_CHARACTERS) !== -1;
}

/** At most `maxLength` code points of `text`, so a cut never splits an emoji's surrogate pair. */
export function truncate(text: string, maxLength: number): string {
  return Array.from(text).slice(0, maxLength).join("");
}

/** An untrusted value as a JSON object, or `undefined` for `null`, an array or a primitive. */
export function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

/** Larger than any issue number GitHub will hand out, and what `uint32` holds. */
export const MAX_ISSUE_NUMBER = 0xffffffff;

/** Whether a value is usable as a GitHub issue or pull request number: a positive whole number. */
export function isIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_ISSUE_NUMBER;
}
