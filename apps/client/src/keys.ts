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
 * having the two layers agree about a mode flag.
 */

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}
