/**
 * The jump: one fixed arc every client draws the same way.
 *
 * A jump only lifts the body; it never changes where it is on the floor, so
 * walking during it still goes through the shared collision and nothing can be
 * jumped over or into. Because the arc is fixed, a jump travels as a single
 * relayed event rather than a height streamed in every pose, and the server
 * can tell from its start alone whether an occupant is still in the air.
 */

/** How long a jump keeps the feet off the floor, in seconds. */
export const JUMP_SECONDS = 0.6;

/** How high the feet get at the top of the arc, in metres. */
export const JUMP_HEIGHT = 0.5;

/** How far off the floor a jump that started `elapsedSeconds` ago has the feet: a parabola, `0` before and after it. */
export function jumpHeight(elapsedSeconds: number): number {
  if (!(elapsedSeconds > 0 && elapsedSeconds < JUMP_SECONDS)) {
    return 0;
  }
  const t = elapsedSeconds / JUMP_SECONDS;
  return 4 * JUMP_HEIGHT * t * (1 - t);
}

/**
 * How near a player has to be to an agent for a high five, in metres. Looser
 * than the client's facing reach, since the server judges by poses a little
 * ahead of the bodies a browser draws.
 */
export const HIGH_FIVE_REACH = 3.3;

/** Whether two bodies on the floor are near enough to high-five. */
export function inHighFiveReach(a: { readonly x: number; readonly z: number }, b: { readonly x: number; readonly z: number }): boolean {
  return Math.hypot(a.x - b.x, a.z - b.z) <= HIGH_FIVE_REACH;
}
