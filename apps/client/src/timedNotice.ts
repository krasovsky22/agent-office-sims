/**
 * A line on the HUD that takes itself down again: a notice about the player's
 * own last action, on the board's close-up or in the standup panel. Showing
 * another before the last has gone replaces it and restarts the wait.
 */

/**
 * @param show puts a line up, or takes it down for `undefined`.
 * @returns what shows a line for `durationMs`.
 */
export function timedNotice(show: (text: string | undefined) => void, durationMs: number): (text: string) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (text) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    show(text);
    timer = setTimeout(() => {
      timer = undefined;
      show(undefined);
    }, durationMs);
  };
}
