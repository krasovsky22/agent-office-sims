/**
 * The server's side of the runner link: the runners' slots as live agents,
 * the commands waiting for each runner, and the events they report.
 *
 * A runner (`apps/runner`) is the separate process that owns real coding
 * agents. It syncs over `POST /agents/runner/sync` (`./runnerEndpoint.ts`),
 * and each sync is its whole state, so this module only ever replaces what it
 * held for that runner; nothing here is a running total a lost request could
 * skew.
 *
 * Commands are what make the link more than the orchestrator's report route.
 * Starting an agent spends money, so a command must neither be lost nor
 * carried out twice. A queued command is in every sync reply to its runner
 * until a later sync acks its id, and never after; a runner that loses a reply
 * gets the same commands again on the next one, and tells a repeat by its id.
 * The ids are random, so a runner never mistakes a restarted server's command
 * for one it has already carried out.
 *
 * Events travel the other way. A runner reports each one until a sync
 * carrying it is answered, so the same event can arrive twice; it is passed on
 * once, by id. Each room opens its own inbox and drains it on its tick, so a
 * flood of syncs is only ever a longer list for the next tick to read.
 *
 * Like the registry, everything here runs on Node's event loop, from an HTTP
 * request or this module's own sweep timer, and never inside a tick. The
 * slots reach the rooms through {@link LiveAgentSource}: a finished list, and
 * a flag raised only when it changes.
 */

import { randomUUID } from "node:crypto";

import {
  LIVE_AGENT_STATUS,
  type LiveAgentStatus,
  type LiveAgentTask,
  isLiveAgentOnTask,
  MAX_RUNNER_SLOTS,
  RUNNER_COMMAND_KIND,
  RUNNER_SLOT_STATUS,
  type RunnerCommand,
  type RunnerCommandDraft,
  type RunnerEvent,
  type RunnerSlotReport,
  type RunnerSlotStatus,
  type RunnerSync,
  toRunnerCommand,
} from "@sim/shared";

import type { LiveAgentRecord, LiveAgentSource } from "./registry.js";

/** What came of one sync. */
export type RunnerSyncOutcome =
  | { readonly kind: "accepted"; readonly commands: readonly RunnerCommand[] }
  /** The runner works on a repository other than the project board's. */
  | { readonly kind: "wrong-repo" }
  /** Taking this runner's slots would put more than {@link MAX_RUNNER_SLOTS} on the floor. */
  | { readonly kind: "full" };

/** One event, with the runner it came from. */
export interface RunnerEventRecord {
  readonly runnerId: string;
  readonly event: RunnerEvent;
}

/** One room's view of the events: what has arrived since it last looked. */
export interface RunnerEventInbox {
  /** Everything since the last drain, oldest first; empty when nothing arrived. */
  drain(): readonly RunnerEventRecord[];
  /** Stops collecting; a closed inbox is never written to again. */
  close(): void;
}

/** Where a room opens its inbox. */
export interface RunnerEventSource {
  openEventInbox(): RunnerEventInbox;
}

/**
 * Whether a room option is the event source the server handed over, rather
 * than whatever a client put in its join options under the same name.
 */
export function isRunnerEventSource(value: unknown): value is RunnerEventSource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<Record<keyof RunnerEventSource, unknown>>).openEventInbox === "function"
  );
}

export interface RunnerLinkOptions {
  /** `owner/name`, the project board's; a runner on any other repository is refused. */
  readonly repository: string;
  /** Silence after which a runner's slots are taken off the floor. */
  readonly timeoutMs: number;
  /** Most runners heard from at once. */
  readonly maxRunners?: number;
  /** Most commands waiting for one runner; one more is refused. */
  readonly maxPendingCommands?: number;
  /** How often the timeout is checked. Defaults to a second. */
  readonly sweepIntervalMs?: number;
  /** Epoch milliseconds. Injected so a test controls the clock. */
  readonly now?: () => number;
  /** Command ids. Injected so a test can read them. */
  readonly commandId?: () => string;
}

const DEFAULT_MAX_RUNNERS = 4;
const DEFAULT_MAX_PENDING_COMMANDS = 32;
const DEFAULT_SWEEP_INTERVAL_MS = 1000;

/** Events one inbox holds before the oldest go; far more than a tick ever sees. */
const MAX_INBOX_EVENTS = 256;

/** Event ids remembered per runner, so a re-sent one is passed on only once. */
const REMEMBERED_EVENT_IDS = 512;

/**
 * Prefixes every slot's live agent id. A colon is outside the alphabet an
 * orchestrator's agent ids are drawn from, so a slot can never collide with a
 * reported agent on the floor.
 */
const SLOT_ID_PREFIX = "runner:";

/** A slot's id among the live agents. */
export function runnerSlotAgentId(runnerId: string, slotId: string): string {
  return `${SLOT_ID_PREFIX}${runnerId}:${slotId}`;
}

/** What a slot's status shows as on the floor. */
const FLOOR_STATUS: Readonly<Record<RunnerSlotStatus, LiveAgentStatus>> = {
  [RUNNER_SLOT_STATUS.idle]: LIVE_AGENT_STATUS.idle,
  [RUNNER_SLOT_STATUS.starting]: LIVE_AGENT_STATUS.working,
  [RUNNER_SLOT_STATUS.working]: LIVE_AGENT_STATUS.working,
  [RUNNER_SLOT_STATUS.needsInput]: LIVE_AGENT_STATUS.needsInput,
  [RUNNER_SLOT_STATUS.exited]: LIVE_AGENT_STATUS.idle,
};

interface Runner {
  slots: readonly RunnerSlotReport[];
  records: readonly LiveAgentRecord[];
  lastSeenAt: number;
  /** Queued and not yet acked, oldest first. */
  readonly outbox: Map<string, RunnerCommand>;
  /** The title of the issue each slot was last started on, by slot id. */
  readonly startedTitles: Map<string, { readonly issueNumber: number; readonly title: string }>;
  readonly seenEvents: Set<string>;
}

interface Inbox {
  events: RunnerEventRecord[];
}

/** What an inbox drains to when nothing arrived, so an idle tick allocates nothing. */
const NOTHING: readonly RunnerEventRecord[] = [];

function sameRecord(a: LiveAgentRecord, b: LiveAgentRecord): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.status === b.status &&
    a.activity === b.activity &&
    a.task?.title === b.task?.title &&
    a.task?.url === b.task?.url
  );
}

function sameRecords(a: readonly LiveAgentRecord[], b: readonly LiveAgentRecord[]): boolean {
  return a.length === b.length && a.every((record, index) => {
    const other = b[index];
    return other !== undefined && sameRecord(record, other);
  });
}

export class RunnerLink implements LiveAgentSource, RunnerEventSource {
  private readonly runners = new Map<string, Runner>();
  private readonly listeners = new Set<() => void>();
  private readonly inboxes = new Set<Inbox>();
  private readonly now: () => number;
  private readonly commandId: () => string;
  private readonly repository: string;
  private snapshot: readonly LiveAgentRecord[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(private readonly options: RunnerLinkOptions) {
    this.now = options.now ?? (() => Date.now());
    this.commandId = options.commandId ?? (() => `command-${randomUUID()}`);
    this.repository = options.repository.toLowerCase();
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
   * Applies one sync: settles what it acks, replaces the runner's slots,
   * passes on its new events, and answers with every command still waiting.
   *
   * Refused whole, with nothing applied, for a runner on another repository or
   * one whose slots the floor has no room for.
   */
  public sync(sync: RunnerSync): RunnerSyncOutcome {
    // GitHub's owner and repository names are not case-sensitive.
    if (sync.repo.toLowerCase() !== this.repository) {
      return { kind: "wrong-repo" };
    }
    let runner = this.runners.get(sync.runnerId);
    const othersSlots = this.slotCount() - (runner?.slots.length ?? 0);
    if (othersSlots + sync.slots.length > MAX_RUNNER_SLOTS) {
      return { kind: "full" };
    }
    if (runner === undefined) {
      if (this.runners.size >= (this.options.maxRunners ?? DEFAULT_MAX_RUNNERS)) {
        return { kind: "full" };
      }
      runner = {
        slots: [],
        records: [],
        lastSeenAt: this.now(),
        outbox: new Map(),
        startedTitles: new Map(),
        seenEvents: new Set(),
      };
      this.runners.set(sync.runnerId, runner);
    }

    runner.lastSeenAt = this.now();
    for (const id of sync.acked) {
      runner.outbox.delete(id);
    }
    this.receive(sync.runnerId, runner, sync.events);

    const records = sync.slots.map((slot) => this.record(sync.runnerId, runner, slot));
    runner.slots = sync.slots;
    for (const slotId of runner.startedTitles.keys()) {
      if (!sync.slots.some((slot) => slot.id === slotId)) {
        runner.startedTitles.delete(slotId);
      }
    }
    if (!sameRecords(runner.records, records)) {
      runner.records = records;
      this.changed();
    }
    return { kind: "accepted", commands: [...runner.outbox.values()] };
  }

  /**
   * Queues a command for one of a runner's slots. It goes out in every sync
   * reply to that runner until the runner acks it.
   *
   * @returns the command, or `undefined` when the runner is not connected, the
   * slot is not one it reported, the command is malformed, or the runner has
   * {@link RunnerLinkOptions.maxPendingCommands} waiting already.
   */
  public enqueue(runnerId: string, draft: RunnerCommandDraft): RunnerCommand | undefined {
    const runner = this.runners.get(runnerId);
    if (runner === undefined || !runner.slots.some((slot) => slot.id === draft.slotId)) {
      return undefined;
    }
    if (runner.outbox.size >= (this.options.maxPendingCommands ?? DEFAULT_MAX_PENDING_COMMANDS)) {
      return undefined;
    }
    const command = toRunnerCommand(this.commandId(), draft);
    if (command === undefined) {
      return undefined;
    }
    runner.outbox.set(command.id, command);
    if (command.kind === RUNNER_COMMAND_KIND.start) {
      runner.startedTitles.set(command.slotId, { issueNumber: command.issueNumber, title: command.title });
    }
    return command;
  }

  /** Whether a runner's last sync was taken, and it has not gone silent since. */
  public hasRunner(runnerId: string): boolean {
    return this.runners.has(runnerId);
  }

  /** Whether a runner reported a slot in its last sync. */
  public hasSlot(runnerId: string, slotId: string): boolean {
    return this.runners.get(runnerId)?.slots.some((slot) => slot.id === slotId) ?? false;
  }

  /** The commands waiting for a runner, oldest first. */
  public pending(runnerId: string): readonly RunnerCommand[] {
    return [...(this.runners.get(runnerId)?.outbox.values() ?? [])];
  }

  public openEventInbox(): RunnerEventInbox {
    const inbox: Inbox = { events: [] };
    this.inboxes.add(inbox);
    return {
      drain: () => {
        if (inbox.events.length === 0) {
          return NOTHING;
        }
        const drained = inbox.events;
        inbox.events = [];
        return drained;
      },
      close: () => {
        this.inboxes.delete(inbox);
      },
    };
  }

  /** Drops every runner silent for longer than the timeout, with its slots and commands. Exposed for the tests. */
  public sweep(): void {
    const cutoff = this.now() - this.options.timeoutMs;
    let dropped = false;
    for (const [id, runner] of this.runners) {
      if (runner.lastSeenAt < cutoff) {
        // Its commands go too: they name slots that are gone, and a runner
        // that comes back starts from what it reports then.
        this.runners.delete(id);
        dropped ||= runner.records.length > 0;
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

  private slotCount(): number {
    let count = 0;
    for (const runner of this.runners.values()) {
      count += runner.slots.length;
    }
    return count;
  }

  /** Passes each event not seen before to every open inbox. */
  private receive(runnerId: string, runner: Runner, events: readonly RunnerEvent[]): void {
    for (const event of events) {
      if (runner.seenEvents.has(event.id)) {
        continue;
      }
      runner.seenEvents.add(event.id);
      if (runner.seenEvents.size > REMEMBERED_EVENT_IDS) {
        // A Set iterates in insertion order, so this forgets the oldest.
        const oldest = runner.seenEvents.values().next().value;
        if (oldest !== undefined) {
          runner.seenEvents.delete(oldest);
        }
      }
      for (const inbox of this.inboxes) {
        inbox.events.push({ runnerId, event });
        if (inbox.events.length > MAX_INBOX_EVENTS) {
          inbox.events.shift();
        }
      }
    }
  }

  /** A slot as a live agent on the floor. */
  private record(runnerId: string, runner: Runner, slot: RunnerSlotReport): LiveAgentRecord {
    return {
      id: runnerSlotAgentId(runnerId, slot.id),
      name: slot.name,
      status: FLOOR_STATUS[slot.status],
      task: this.task(runner, slot),
      activity: slot.activity,
      // A slot's work goes through the office's work rules, so it can take issues.
      canTakeIssues: true,
    };
  }

  /**
   * The issue a slot is on, titled from the start command that put it there
   * when there was one. What it is doing travels as its activity, not here.
   */
  private task(runner: Runner, slot: RunnerSlotReport): LiveAgentTask | undefined {
    if (slot.issueNumber === undefined || !isLiveAgentOnTask(FLOOR_STATUS[slot.status])) {
      return undefined;
    }
    const started = runner.startedTitles.get(slot.id);
    const title = started?.issueNumber === slot.issueNumber ? started.title : `Issue #${slot.issueNumber}`;
    return { title, url: `https://github.com/${this.options.repository}/issues/${slot.issueNumber}` };
  }

  private changed(): void {
    const records: LiveAgentRecord[] = [];
    for (const runner of this.runners.values()) {
      records.push(...runner.records);
    }
    this.snapshot = records;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One room failing must not stop the others hearing.
      }
    }
  }
}
