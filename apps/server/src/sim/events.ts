/**
 * Where office events go.
 *
 * One function, and for now it writes a line to stdout. It exists as a named
 * seam rather than a scattering of `console.log` calls because the whiteboard
 * interaction is deliberately a placeholder: the ticket board milestone either
 * replaces this sink with something that moves a company metric, or sits beside
 * it and consumes the same events. Callers should not have to change when that
 * happens.
 *
 * Called from message handlers and the room's own timers, never from the
 * simulation tick.
 */

/** A value an event is allowed to carry. Events are for reading, not for state. */
export type EventDetail = Record<string, string | number>;

export function recordOfficeEvent(name: string, detail: EventDetail): void {
  // eslint-disable-next-line no-console -- stdout is the whole sink until the ticket board lands
  console.log(`[office] ${name} ${JSON.stringify(detail)}`);
}
