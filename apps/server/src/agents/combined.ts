/**
 * Several live agent feeds as one, so the orchestrator's reported agents and
 * the runners' slots share the floor.
 *
 * A room reads one {@link LiveAgentSource} and nothing else; this keeps it that
 * way however many feeds there are. Each feed's ids are its own business, so
 * the feeds are responsible for keeping them apart (the runner link prefixes
 * its slots with a character no reported agent's id may contain).
 */

import type { LiveAgentRecord, LiveAgentSource } from "./registry.js";

export class CombinedLiveAgentSource implements LiveAgentSource {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: (() => void)[];
  private snapshot: readonly LiveAgentRecord[] = [];
  private stale = true;

  public constructor(private readonly sources: readonly LiveAgentSource[]) {
    this.unsubscribes = sources.map((source) =>
      source.subscribe(() => {
        this.stale = true;
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            // One room failing must not stop the others hearing.
          }
        }
      }),
    );
  }

  /** Every feed's agents, in the order the feeds were given; rebuilt only after one changes. */
  public current(): readonly LiveAgentRecord[] {
    if (this.stale) {
      this.stale = false;
      this.snapshot = this.sources.flatMap((source) => source.current());
    }
    return this.snapshot;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stops listening to the feeds. */
  public stop(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
  }
}
