/**
 * The AI manager's hand-off to the agent orchestrator.
 *
 * The manager decides who should take an issue; the orchestrator — the process
 * outside the game that runs the real coding agents — carries it out. This
 * queue sits between the two. The manager queues "give #39 to crewmate-7"; the
 * orchestrator collects with the secret it already reports with, from
 * `POST /agents/assignments` (`../agents/endpoint.ts`), and every assignment is
 * handed out by exactly one collection: once collected it is never handed out
 * again. An orchestrator that loses a response loses what was in it, which is
 * the price of never starting the same work twice; each assignment carries an
 * id, so one that retries can tell what it has already seen.
 *
 * Until the agent reports working on what it was given, the assignment is
 * shown on it. That is done by wrapping the registry: this class is a
 * {@link LiveAgentSource} whose records are the registry's with the
 * outstanding assignment added, so the room and the crew that walks the bodies
 * need no second feed. The agent's own task still comes only from its reports.
 *
 * Server-wide, like the registry: the live agents are the same people in every
 * room. Each assignment remembers which room's manager made it, so only that
 * manager reports on it.
 *
 * Everything here is synchronous and runs on Node's event loop, from the
 * manager's own loop or an HTTP request, never inside a simulation tick.
 */

import type { LiveAgentTask } from "@sim/shared";

import type { LiveAgentRecord, LiveAgentSource } from "../agents/registry.js";

/** Where an assignment has got to. */
export const LIVE_ASSIGNMENT_STATUS = {
  /** Queued, and not yet collected by the orchestrator. */
  pending: "pending",
  /** Collected, and the agent has not yet reported working on it. */
  collected: "collected",
  /** The agent has reported working on it. */
  started: "started",
} as const;

export type LiveAssignmentStatus = (typeof LIVE_ASSIGNMENT_STATUS)[keyof typeof LIVE_ASSIGNMENT_STATUS];

/** The GitHub issue or pull request being handed out. */
export interface AssignedItem {
  readonly kind: "issue" | "pull";
  readonly number: number;
  /** Sanitized by the project board's feed. */
  readonly title: string;
  /** Always `https:`, on github.com. */
  readonly url: string;
}

/** What the manager asks for. */
export interface LiveAssignmentRequest {
  /** The live agent's id, as its orchestrator reports it. */
  readonly agentId: string;
  readonly item: AssignedItem;
  /** The CEO the manager acted for, by name. */
  readonly requestedBy: string;
  /** The CEO's words, so the orchestrator can pass them on to the agent. */
  readonly note: string;
  /** Which room's manager made it; never sent to the orchestrator. */
  readonly origin: string;
}

export interface LiveAssignment extends LiveAssignmentRequest {
  /** Unique for the life of the server process, e.g. `assignment-3`. */
  readonly id: string;
  /** Epoch milliseconds. */
  readonly assignedAt: number;
  readonly status: LiveAssignmentStatus;
}

/** One assignment as the orchestrator receives it. */
export interface LiveAssignmentWire {
  readonly id: string;
  readonly agentId: string;
  readonly kind: AssignedItem["kind"];
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly requestedBy: string;
  readonly note: string;
  readonly assignedAt: number;
}

export function toWire(assignment: LiveAssignment): LiveAssignmentWire {
  return {
    id: assignment.id,
    agentId: assignment.agentId,
    kind: assignment.item.kind,
    number: assignment.item.number,
    title: assignment.item.title,
    url: assignment.item.url,
    requestedBy: assignment.requestedBy,
    note: assignment.note,
    assignedAt: assignment.assignedAt,
  };
}

/**
 * Whether a room option is the queue the server handed over, rather than
 * whatever a client put in its join options under the same name.
 */
export function isLiveAssignmentQueue(value: unknown): value is LiveAssignmentQueue {
  return value instanceof LiveAssignmentQueue;
}

export interface LiveAssignmentQueueOptions {
  /** The registry, or anything else the live agents come from. */
  readonly agents: LiveAgentSource;
  /**
   * Most assignments waiting to be collected; one more is refused. An
   * orchestrator that has stopped collecting should not let the queue grow.
   */
  readonly maxPending?: number;
  /** Most assignments remembered in all, settled ones dropped first. */
  readonly maxKept?: number;
  /** Epoch milliseconds. Injected so a test controls the clock. */
  readonly now?: () => number;
}

const DEFAULT_MAX_PENDING = 50;
const DEFAULT_MAX_KEPT = 200;

/** `owner/name#12` for a GitHub issue or pull request URL, or `undefined`. */
const GITHUB_ITEM = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/;

function itemKey(url: string): string | undefined {
  const match = GITHUB_ITEM.exec(url);
  return match === null ? undefined : `${(match[1] ?? "").toLowerCase()}#${match[2] ?? ""}`;
}

/**
 * Whether a reported task is the assigned item. By repository and number, so
 * an agent reporting the pull request for an issue it was given still counts
 * only when the numbers agree; anything that is not a GitHub link never does.
 */
function isWorkingOn(record: LiveAgentRecord, item: AssignedItem): boolean {
  const reported = record.task?.url;
  if (record.status !== "working" || reported === undefined || reported === "") {
    return false;
  }
  const key = itemKey(item.url);
  return key !== undefined && itemKey(reported) === key;
}

function isOutstanding(assignment: LiveAssignment): boolean {
  return assignment.status !== LIVE_ASSIGNMENT_STATUS.started;
}

export class LiveAssignmentQueue implements LiveAgentSource {
  /** Every assignment remembered, oldest first. */
  private readonly kept = new Map<string, LiveAssignment>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly maxKept: number;
  private readonly unsubscribe: () => void;
  private snapshot: readonly LiveAgentRecord[] = [];
  private nextId = 1;

  public constructor(private readonly options: LiveAssignmentQueueOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.maxKept = options.maxKept ?? DEFAULT_MAX_KEPT;
    this.unsubscribe = options.agents.subscribe(() => this.reconcile());
    this.reconcile();
  }

  /** The live agents, each with what it has been handed and not yet started. */
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
   * Queues one assignment for the orchestrator.
   *
   * @returns the assignment, or `undefined` when the orchestrator has
   * {@link LiveAssignmentQueueOptions.maxPending} waiting already.
   */
  public assign(request: LiveAssignmentRequest): LiveAssignment | undefined {
    if (this.pending().length >= this.maxPending) {
      return undefined;
    }
    const assignment: LiveAssignment = {
      ...request,
      id: `assignment-${this.nextId}`,
      assignedAt: this.now(),
      status: LIVE_ASSIGNMENT_STATUS.pending,
    };
    this.nextId += 1;
    this.kept.set(assignment.id, assignment);
    this.forget();
    this.reconcile();
    return assignment;
  }

  /**
   * Hands every waiting assignment to the orchestrator, oldest first, and
   * never hands any of them out again.
   */
  public collect(): readonly LiveAssignment[] {
    const collected = this.pending().map((assignment) => this.settle(assignment, LIVE_ASSIGNMENT_STATUS.collected));
    if (collected.length > 0) {
      this.reconcile();
    }
    return collected;
  }

  /** The assignments one room's manager made, oldest first, as they stand now. */
  public madeBy(origin: string): readonly LiveAssignment[] {
    return [...this.kept.values()].filter((assignment) => assignment.origin === origin);
  }

  /** Stops listening to the agents' source. */
  public stop(): void {
    this.unsubscribe();
  }

  private pending(): LiveAssignment[] {
    return [...this.kept.values()].filter((assignment) => assignment.status === LIVE_ASSIGNMENT_STATUS.pending);
  }

  private settle(assignment: LiveAssignment, status: LiveAssignmentStatus): LiveAssignment {
    const settled = { ...assignment, status };
    this.kept.set(assignment.id, settled);
    return settled;
  }

  /**
   * Marks what agents have started, rebuilds the records the room reads, and
   * tells the rooms. An agent that has left keeps its assignment outstanding:
   * the orchestrator may bring it back to do it.
   */
  private reconcile(): void {
    const agents = this.options.agents.current();
    const byId = new Map(agents.map((record) => [record.id, record]));
    const latest = new Map<string, LiveAgentTask>();
    for (const assignment of this.kept.values()) {
      if (!isOutstanding(assignment)) {
        continue;
      }
      const record = byId.get(assignment.agentId);
      if (record !== undefined && isWorkingOn(record, assignment.item)) {
        this.settle(assignment, LIVE_ASSIGNMENT_STATUS.started);
        continue;
      }
      // Oldest first, so the newest outstanding one is what the agent shows.
      latest.set(assignment.agentId, { title: assignment.item.title, url: assignment.item.url });
    }
    this.snapshot = agents.map((record) => {
      const assignment = latest.get(record.id);
      return assignment === undefined ? record : { ...record, assignment };
    });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One room failing must not stop the others hearing.
      }
    }
  }

  /** Drops the oldest settled assignments once more than the cap are kept. */
  private forget(): void {
    for (const [id, assignment] of this.kept) {
      if (this.kept.size <= this.maxKept) {
        return;
      }
      if (assignment.status !== LIVE_ASSIGNMENT_STATUS.pending) {
        this.kept.delete(id);
      }
    }
  }
}
