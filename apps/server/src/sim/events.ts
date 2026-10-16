/**
 * Where office events go.
 *
 * One function, and for now it writes a line to stdout. It exists as a named
 * seam rather than a scattering of `console.log` calls because stdout is a
 * placeholder: whatever later replaces this sink, or sits beside it and
 * consumes the same events, should not need its callers to change.
 *
 * Called from message handlers and the room's own timers, never from the
 * simulation tick.
 */

/** A value an event is allowed to carry. Events are for reading, not for state. */
export type EventDetail = Record<string, string | number>;

export function recordOfficeEvent(name: string, detail: EventDetail): void {
  // eslint-disable-next-line no-console -- stdout is the whole sink for now
  console.log(`[office] ${name} ${JSON.stringify(detail)}`);
}
