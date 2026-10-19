/**
 * The runner's heartbeat: a sync about once a second, carrying the slots, the
 * commands taken, the events not yet delivered and the day's spend, and carrying out whatever
 * commands come back.
 *
 * A command must neither be lost nor carried out twice, since starting an
 * agent will spend money. The server repeats a command in every reply until a
 * sync acks it, so this side remembers which ids it has taken and acks each
 * one until a sync carrying the ack is answered. Events work the same way in
 * the other direction: they stay queued in the slot pool until a sync carrying
 * them is answered, and the server passes each id on once. What came of the
 * CEO's prompts rides along the same way. Every reply also says whether a
 * standup is on in the office, which the slot pool pauses its agents for.
 *
 * The runner's standing tasks (`./standing/`) ride the same sync: their
 * reports with the slots', their events beside the slots' (a couple of places
 * kept for them, so a busy pool never holds them back), and the commands for
 * them handed to the scheduler rather than a slot.
 *
 * So does closing and reopening issues for the CEO (`./issueStates.ts`): the
 * sync says whether this runner can, its commands go to the issue desk, and
 * what came of them rides back like a prompt's outcome.
 *
 * Syncs run one at a time, never overlapping, so an answer always settles
 * exactly what its own request carried. A failed sync is retried with backoff
 * up to {@link MAX_BACKOFF_MS}, which keeps a runner pointed at a server that is
 * down from hammering it, and still well inside the server's timeout once it
 * is back.
 */

import {
  MAX_RUNNER_ACKS,
  MAX_RUNNER_EVENTS,
  MAX_RUNNER_ISSUE_STATE_OUTCOMES,
  MAX_RUNNER_PROMPT_OUTCOMES,
  RUNNER_COMMAND_KIND,
  type RunnerEvent,
  type RunnerStandingCommand,
  type RunnerSync,
  type StandingOff,
  type StandingTaskReport,
  isRunnerSlotCommand,
} from "@sim/shared";

import type { IssueStateDesk } from "./issueStates.js";
import type { SlotPool } from "./slots.js";
import type { SyncClient } from "./syncClient.js";

/** What the sync needs of the runner's standing tasks. */
export interface StandingSyncSource {
  report(): StandingTaskReport[];
  /** Why the runner takes no standing tasks, or `undefined` when it does. */
  off(): StandingOff | undefined;
  pendingEvents(): readonly RunnerEvent[];
  delivered(ids: ReadonlySet<string>): void;
  handle(command: RunnerStandingCommand): void;
}

/** Places in a sync's events kept for the standing tasks' while they have any. */
const STANDING_EVENT_PLACES = 2;

const DEFAULT_INTERVAL_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** Command ids remembered as taken, so a repeat is never carried out twice. */
const REMEMBERED_COMMAND_IDS = 512;

export interface SyncLoopOptions {
  readonly runnerId: string;
  readonly repo: string;
  readonly pool: Pick<SlotPool, "report" | "pendingEvents" | "pendingPromptOutcomes" | "delivered" | "handle" | "spend"> &
    Partial<Pick<SlotPool, "setStandup">>;
  /** The standing tasks; none by default. */
  readonly standing?: StandingSyncSource;
  /** Closes and reopens issues for the CEO; absent for a runner with no GitHub identity, which then says it cannot. */
  readonly issues?: Pick<IssueStateDesk, "handle" | "pending" | "delivered">;
  readonly client: SyncClient;
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly log?: (line: string) => void;
}

export class SyncLoop {
  /** Commands taken and not yet acked in an answered sync, oldest first. */
  private acks: string[] = [];
  private readonly taken = new Set<string>();
  private failures = 0;
  private lastError: string | undefined;
  private everSynced = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private readonly log: (line: string) => void;

  public constructor(private readonly options: SyncLoopOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** Failed syncs since the last one that was answered. */
  public get consecutiveFailures(): number {
    return this.failures;
  }

  /** How long until the next sync: the interval, or longer while syncs are failing. */
  public nextDelayMs(): number {
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;
    if (this.failures === 0) {
      return interval;
    }
    const maxBackoff = this.options.maxBackoffMs ?? MAX_BACKOFF_MS;
    return Math.min(interval * 2 ** Math.min(this.failures, 16), maxBackoff);
  }

  /**
   * One sync, start to finish.
   *
   * @returns whether the server answered it.
   */
  public async syncOnce(): Promise<boolean> {
    const { pool, standing, issues } = this.options;
    const acked = this.acks.slice(0, MAX_RUNNER_ACKS);
    const standingEvents = standing?.pendingEvents() ?? [];
    const slotEvents = pool.pendingEvents().slice(0, MAX_RUNNER_EVENTS - Math.min(standingEvents.length, STANDING_EVENT_PLACES));
    const events = [...slotEvents, ...standingEvents.slice(0, MAX_RUNNER_EVENTS - slotEvents.length)];
    const prompts = pool.pendingPromptOutcomes().slice(0, MAX_RUNNER_PROMPT_OUTCOMES);
    const issueStates = issues?.pending().slice(0, MAX_RUNNER_ISSUE_STATE_OUTCOMES) ?? [];
    const sync: RunnerSync = {
      runnerId: this.options.runnerId,
      repo: this.options.repo,
      acked,
      slots: pool.report(),
      events,
      spend: pool.spend(),
      prompts,
      ...(standing === undefined ? {} : { standing: standing.report(), standingOff: standing.off() }),
      changesIssues: issues !== undefined,
      issueStates,
    };

    let reply;
    try {
      reply = await this.options.client(sync);
    } catch (error) {
      this.failed(error);
      return false;
    }
    this.answered();

    const settled = new Set(acked);
    this.acks = this.acks.filter((id) => !settled.has(id));
    const delivered = new Set([...events.map((event) => event.id), ...prompts.map((prompt) => prompt.commandId)]);
    // The outcomes themselves as well as their ids: a standup's direction is
    // reported twice by one id, kept and then typed, and only what this sync
    // carried is settled.
    pool.delivered(delivered, prompts);
    standing?.delivered(delivered);
    issues?.delivered(new Set(issueStates.map((outcome) => outcome.commandId)));

    for (const id of reply.unreadable) {
      if (this.take(id)) {
        this.log(`command ${id} could not be read; acked without acting on it`);
      }
    }
    for (const command of reply.commands) {
      if (!this.take(command.id)) {
        continue;
      }
      if (isRunnerSlotCommand(command)) {
        pool.handle(command);
      } else if (command.kind === RUNNER_COMMAND_KIND.issueState) {
        if (issues === undefined) {
          this.log(`command ${command.id} would change an issue on GitHub, which this runner cannot; acked without acting on it`);
        } else {
          void issues.handle(command);
        }
      } else if (standing !== undefined) {
        standing.handle(command);
      } else {
        this.log(`command ${command.id} is for standing tasks, which this runner does not run; acked without acting on it`);
      }
    }
    // After the commands, so a direction that came with the end of a standup is kept before the agents carry on.
    pool.setStandup?.(reply.standup === true);
    return true;
  }

  /** Syncs now, and keeps syncing until {@link stop}. */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.loop();
  }

  public stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async loop(): Promise<void> {
    if (!this.running) {
      return;
    }
    await this.syncOnce();
    if (this.running) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.loop();
      }, this.nextDelayMs());
    }
  }

  /**
   * Marks a command as taken and queues its ack.
   *
   * @returns whether it is new, and so should be acted on.
   */
  private take(id: string): boolean {
    if (!this.acks.includes(id)) {
      this.acks.push(id);
    }
    if (this.taken.has(id)) {
      return false;
    }
    this.taken.add(id);
    if (this.taken.size > REMEMBERED_COMMAND_IDS) {
      // A Set iterates in insertion order, so this forgets the oldest.
      const oldest = this.taken.values().next().value;
      if (oldest !== undefined) {
        this.taken.delete(oldest);
      }
    }
    return true;
  }

  private answered(): void {
    if (this.failures > 0) {
      this.log(`synced with the server after ${this.failures} failed ${this.failures === 1 ? "sync" : "syncs"}`);
    } else if (!this.everSynced) {
      this.log("synced with the server");
    }
    this.everSynced = true;
    this.failures = 0;
    this.lastError = undefined;
  }

  /** Counts a failure, and says so once per distinct reason rather than once a second. */
  private failed(error: unknown): void {
    this.failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.lastError) {
      this.log(`sync failed: ${message}; retrying with backoff`);
      this.lastError = message;
    }
  }
}
