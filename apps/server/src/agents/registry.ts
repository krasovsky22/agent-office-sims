/**
 * The set of live coding agents, as their orchestrator last reported them.
 *
 * This is the feed side of the live agents, and it knows nothing about the
 * office: no positions, no chairs, no rooms. The world side — `sim/liveAgents.ts`,
 * run inside each room's tick — reads it through {@link LiveAgentSource} and
 * nothing else, so a second source (say, open pull requests with recent pushes,
 * read through the project board's GitHub client) can be dropped in beside this
 * one without the world side changing.
 *
 * Reports land here from HTTP requests, on Node's event loop, never inside a
 * simulation tick. The registry only records them and raises a flag; each room
 * drains the current set on its next tick, which reads it without waiting. A
 * flood of reports therefore costs the tick one reconcile per tick at most, and
 * a heartbeat that changes nothing costs it nothing at all.
 *
 * An agent the orchestrator stops reporting is dropped after the configured
 * silence, by a sweep on this module's own timer — the same separation the
 * project board's poll loop keeps.
 */

import {
  LIVE_AGENT_REPORT_STATUS,
  type LiveAgentReport,
  type LiveAgentStatus,
  type LiveAgentTask,
} from "@sim/shared";

/** One live agent, as the world side reads it. */
export interface LiveAgentRecord {
  readonly id: string;
  readonly name: string;
  readonly status: LiveAgentStatus;
  readonly task: LiveAgentTask | undefined;
  /**
   * What the AI manager has handed this agent and it has not yet reported
   * working on, when a source knows; see `manager/liveAssignments.ts`.
   */
  readonly assignment?: LiveAgentTask | undefined;
}

/**
 * What a room needs from wherever live agents come from.
 *
 * Synchronous on purpose. A source that has to fetch does so on its own clock
 * and keeps its answer ready, as the project board's feed does.
 */
export interface LiveAgentSource {
  /** Every agent currently in the office. The array is not mutated after it is returned. */
  current(): readonly LiveAgentRecord[];
  /**
   * Told whenever {@link current} would answer differently. Carries nothing:
   * a listener only marks itself dirty and reads {@link current} when it is ready.
   *
   * @returns a function that unsubscribes.
   */
  subscribe(listener: () => void): () => void;
}

/**
 * Whether a room option is a source the server handed over, rather than
 * whatever a client put in its join options under the same name.
 *
 * Colyseus merges the two with the server's winning, so this is belt and
 * braces, as it is for the project board: a JSON payload cannot carry a function.
 */
export function isLiveAgentSource(value: unknown): value is LiveAgentSource {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof LiveAgentSource, unknown>>;
  return typeof candidate.current === "function" && typeof candidate.subscribe === "function";
}

/** What came of one report. */
export type ReportOutcome = "accepted" | "stopped" | "full";

export interface LiveAgentRegistryOptions {
  /** Silence after which an agent is taken off the floor. */
  readonly timeoutMs: number;
  /** Most agents on the floor at once; a report for one more is refused. */
  readonly maxAgents: number;
  /** How often the timeout is checked. Defaults to a second. */
  readonly sweepIntervalMs?: number;
  /** Epoch milliseconds. Injected so a test controls the clock. */
  readonly now?: () => number;
}

interface Entry {
  record: LiveAgentRecord;
  lastSeenAt: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 1000;

function sameTask(a: LiveAgentTask | undefined, b: LiveAgentTask | undefined): boolean {
  return a?.title === b?.title && a?.url === b?.url;
}

export class LiveAgentRegistry implements LiveAgentSource {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private snapshot: readonly LiveAgentRecord[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(private readonly options: LiveAgentRegistryOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  public current(): readonly LiveAgentRecord[] {
    return this.snapshot;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Applies one report.
   *
   * A report that repeats what the registry already holds refreshes the
   * agent's heartbeat and tells nobody, which is what keeps a well-behaved
   * orchestrator's steady heartbeats free for every room.
   */
  public report(report: LiveAgentReport): ReportOutcome {
    if (report.status === LIVE_AGENT_REPORT_STATUS.stopped) {
      if (this.entries.delete(report.id)) {
        this.changed();
      }
      return "stopped";
    }

    const record: LiveAgentRecord = {
      id: report.id,
      name: report.name,
      status: report.status,
      task: report.task,
    };
    const existing = this.entries.get(report.id);
    if (existing === undefined) {
      if (this.entries.size >= this.options.maxAgents) {
        return "full";
      }
      this.entries.set(report.id, { record, lastSeenAt: this.now() });
      this.changed();
      return "accepted";
    }

    existing.lastSeenAt = this.now();
    const previous = existing.record;
    if (
      previous.name !== record.name ||
      previous.status !== record.status ||
      !sameTask(previous.task, record.task)
    ) {
      existing.record = record;
      this.changed();
    }
    return "accepted";
  }

  /** Drops every agent that has been silent for longer than the timeout. Exposed for the tests. */
  public sweep(): void {
    const cutoff = this.now() - this.options.timeoutMs;
    let dropped = false;
    for (const [id, entry] of this.entries) {
      if (entry.lastSeenAt < cutoff) {
        this.entries.delete(id);
        dropped = true;
      }
    }
    if (dropped) {
      this.changed();
    }
  }

  /** Starts checking the timeout. */
  public start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      this.sweep();
    }, this.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    // The sweep alone should not keep the process alive; the listening socket does.
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private changed(): void {
    this.snapshot = [...this.entries.values()].map((entry) => entry.record);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One room failing must not stop the others hearing.
      }
    }
  }
}
