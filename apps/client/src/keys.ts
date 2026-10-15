/**
 * Who a keystroke belongs to.
 *
 * Both the player controller and the HUD listen for keys on `window`, because
 * that is the only way to catch a key wherever the focus happens to be. The
 * cost is that both of them hear the keys meant for a text field, and neither
 * may act on those: `A` while typing is a letter, not a step to the left, and
 * `1` is a digit, not a wave.
 *
 * The focused element already answers the question, so this asks it rather than
 * having the two layers agree about a mode flag. A panel that wants every key
 * while it has focus — buttons and all, not just its text fields — marks itself
 * with {@link KEYBOARD_OWNER_ATTRIBUTE}.
 */

/** Set on a container whose descendants keep every key they are given. */
export const KEYBOARD_OWNER_ATTRIBUTE = "data-owns-keyboard";

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable ||
    target.closest(`[${KEYBOARD_OWNER_ATTRIBUTE}]`) !== null
  );
}
