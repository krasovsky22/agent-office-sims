/**
 * What the runner has to tell the server, held until a sync carrying it is
 * answered, so a lost sync loses none of it.
 *
 * The slot pool and the standing scheduler each keep their events here, and
 * the pool what came of the CEO's prompts, under the same cap.
 */

/**
 * Events held while the server cannot be reached. Far more than a few slots
 * produce in any outage worth riding out; past it the oldest go, so a runner
 * cut off for days holds what is newest rather than growing without end.
 */
export const MAX_PENDING_EVENTS = 256;

export class EventOutbox<T> {
  private readonly queue: T[] = [];

  /** What is not yet delivered, oldest first. */
  public pending(): readonly T[] {
    return this.queue;
  }

  /** Queues one more, dropping the oldest past {@link MAX_PENDING_EVENTS}. */
  public push(item: T): void {
    this.queue.push(item);
    if (this.queue.length > MAX_PENDING_EVENTS) {
      this.queue.shift();
    }
  }

  /** Forgets what a sync has delivered. */
  public forget(delivered: (item: T) => boolean): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (item !== undefined && delivered(item)) {
        this.queue.splice(index, 1);
      }
    }
  }
}
