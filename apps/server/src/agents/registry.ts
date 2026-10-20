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
   * What it is doing right now, or what it waits on while it needs input, when
   * a source knows: one sanitised line, such as `Bash: pnpm test`.
   */
  readonly activity?: string;
  /**
   * What the AI manager has handed this agent and it has not yet reported
   * working on, when a source knows; see `manager/liveAssignments.ts`.
   */
  readonly assignment?: LiveAgentTask | undefined;
  /**
   * Whether issue work can be given to this agent; see `isIssueAssignee` in
   * `@sim/shared`. Only a source that drives the agent's work through the
   * office's work rules sets it, and absent means it cannot.
   */
  readonly canTakeIssues?: boolean;
  /** Its title, `Software Developer` say, when its source gives one; see `agentProfile.ts` in `@sim/shared`. */
  readonly title?: string;
  /** Its description, in the CEO's words, when its source gives one. */
  readonly description?: string;
  /**
   * Whether the CEO can edit its name, title and description from the office:
   * only a source that keeps the profile and prompts its agent with it, a
   * runner, sets it, and absent means it cannot.
   */
  readonly profileEditable?: boolean;
  /**
   * It has just been hired, and this is its first appearance: it walks in
   * from the street and waves before anything else. Only a runner's slot the
   * AI Manager hired sets it, and only until the floor has seen it once.
   */
  readonly hired?: boolean;
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
  private readonly reportListeners = new Set<(id: string) => void>();
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
   * Told of every report the registry takes, by agent id, after
   * {@link subscribe}'s listeners — including a heartbeat that changes
   * nothing, which they never hear of.
   *
   * @returns a function that unsubscribes.
   */
  public subscribeReports(listener: (id: string) => void): () => void {
    this.reportListeners.add(listener);
    return () => {
      this.reportListeners.delete(listener);
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
    const outcome = this.record(report);
    if (outcome !== "full") {
      for (const listener of this.reportListeners) {
        try {
          listener(report.id);
        } catch {
          // One listener failing must not stop the others hearing.
        }
      }
    }
    return outcome;
  }

  private record(report: LiveAgentReport): ReportOutcome {
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
