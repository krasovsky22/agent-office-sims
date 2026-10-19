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
 * Each sync also carries what the runner's agents have spent today against its
 * budget; the rooms show every runner's together, through {@link RunnerSpendSource}.
 *
 * Each reply also says whether a standup is on in any room
 * ({@link RunnerStandupHold}), so the runner pauses its agents for it, and
 * says so again on every reply until it ends: a runner that restarts in the
 * middle of one is told on its first sync.
 *
 * Events travel the other way. A runner reports each one until a sync
 * carrying it is answered, so the same event can arrive twice; it is passed on
 * once, by id. Each room opens its own inbox and drains it on its tick, so a
 * flood of syncs is only ever a longer list for the next tick to read. What
 * came of the CEO's prompts travels the same way, in the same inbox; the room
 * that sent a prompt is the one that knows it, and takes its first report.
 *
 * The board's drops on Closed and Open ride the link as well: the game server
 * never writes to GitHub, so closing or reopening an issue for the CEO is a
 * command for a runner that says it can ({@link RunnerLink.changeIssueState}),
 * carried out with that runner's own GitHub identity and answered on a later
 * sync.
 *
 * Each sync carries the runner's standing tasks too (`@sim/shared`'s
 * `standing.ts`), which go to the process-wide {@link StandingMirror}; a slot
 * on a standing run is on the floor with the pull request it reviews, or the
 * schedule it runs, as its task. Commands for standing tasks address the
 * runner rather than a slot, and ride the same outbox.
 *
 * A slot lent to the CEO's desk (`./deskTerminal.ts`) is on the floor too,
 * idle and taking no issues while it is lent, so neither the board nor the
 * manager hands it work; its session's own status and activity are read by
 * the desk terminal through {@link RunnerLink.deskSlots}, not shown on its
 * body.
 *
 * Like the registry, everything here runs on Node's event loop, from an HTTP
 * request or this module's own sweep timer, and never inside a tick. The
 * slots reach the rooms through {@link LiveAgentSource}: a finished list, and
 * a flag raised only when it changes.
 */

import { randomUUID } from "node:crypto";

import {
  ISSUE_STATE_REJECTION,
  type IssueState,
  type IssueStateRejection,
  LENT_TO_DESK_ACTIVITY,
  LIVE_AGENT_STATUS,
  type LiveAgentStatus,
  type LiveAgentTask,
  isBudgetSpent,
  isLiveAgentOnTask,
  MAX_RUNNER_SLOTS,
  NO_RUNNER_SPEND,
  RUNNER_COMMAND_KIND,
  RUNNER_ISSUE_STATE_OUTCOME,
  RUNNER_SLOT_STATUS,
  type RunnerCommand,
  type RunnerCommandDraft,
  type RunnerEvent,
  type RunnerIssueStateOutcome,
  type RunnerPromptOutcome,
  type RunnerSlotReport,
  type RunnerSlotStatus,
  type RunnerSpendReport,
  type RunnerSpendTotal,
  type RunnerSync,
  isRunnerSlotCommand,
  sanitizeTitle,
  liveAgentKey,
  toRunnerCommand,
} from "@sim/shared";

import type { LiveAgentRecord, LiveAgentSource } from "./registry.js";
import type { IssueStates } from "../rooms/issueStateHandlers.js";
import type { StandingMirror } from "./standingMirror.js";

/** What came of one sync. */
export type RunnerSyncOutcome =
  | {
      readonly kind: "accepted";
      readonly commands: readonly RunnerCommand[];
      /** A standup is on: the runner's agents pause for it. */
      readonly standup: boolean;
    }
  /** The runner works on a repository other than the project board's. */
  | { readonly kind: "wrong-repo" }
  /** Taking this runner's slots would put more than {@link MAX_RUNNER_SLOTS} on the floor. */
  | { readonly kind: "full" };

/** One event, with the runner it came from. */
export interface RunnerEventRecord {
  readonly runnerId: string;
  readonly event: RunnerEvent;
}

/** What came of one of the CEO's prompts, with the runner that said so. */
export interface RunnerPromptRecord {
  readonly runnerId: string;
  readonly outcome: RunnerPromptOutcome;
}

/** One room's view of the events: what has arrived since it last looked. */
export interface RunnerEventInbox {
  /** Everything since the last drain, oldest first; empty when nothing arrived. */
  drain(): readonly RunnerEventRecord[];
  /** Every prompt outcome since the last drain of them, oldest first, repeats included. */
  drainPrompts(): readonly RunnerPromptRecord[];
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

/** What every runner reports spending today, together. */
export interface RunnerSpendSource {
  /** Cheap: worked out as syncs arrive, so a room can read it every tick. */
  spend(): RunnerSpendTotal;
}

/**
 * Whether a room option is the spend source the server handed over, rather
 * than whatever a client put in its join options under the same name.
 */
export function isRunnerSpendSource(value: unknown): value is RunnerSpendSource {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<Record<keyof RunnerSpendSource, unknown>>).spend === "function"
  );
}

/** Where a room says it holds a standup, so the runners pause their agents for it. */
export interface RunnerStandupHold {
  /** `on` while the room `origin` holds a standup; the runners hear it on their next sync. */
  holdForStandup(origin: string, on: boolean): void;
}

/**
 * Whether a room option is the standup hold the server handed over, rather
 * than whatever a client put in its join options under the same name.
 */
export function isRunnerStandupHold(value: unknown): value is RunnerStandupHold {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<Record<keyof RunnerStandupHold, unknown>>).holdForStandup === "function"
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
  /** Where every runner's standing tasks are mirrored for the rooms; none kept without it. */
  readonly standing?: StandingMirror;
  /** An open pull request's title on the project board, for a slot reviewing it; `undefined` when the board does not list it. */
  readonly pullTitle?: (number: number) => string | undefined;
  /** How long a change to an issue's state waits on its runner before it is given up. Defaults to 20 seconds. */
  readonly issueStateWaitMs?: number;
}

const DEFAULT_MAX_RUNNERS = 4;
const DEFAULT_MAX_PENDING_COMMANDS = 32;
const DEFAULT_SWEEP_INTERVAL_MS = 1000;
/** Past a sync a second and `gh`'s own few seconds; well inside the client's own wait. */
const DEFAULT_ISSUE_STATE_WAIT_MS = 20_000;

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

/** A runner's slot, as the commands for it are addressed. */
export interface RunnerSlotRef {
  readonly runnerId: string;
  readonly slotId: string;
}

/**
 * The runner and slot a live agent's id names, or `undefined` for an agent
 * that is not a runner's slot. Neither id can hold a colon, so the first one
 * after the prefix splits them.
 */
export function runnerSlotOf(agentId: string): RunnerSlotRef | undefined {
  if (!agentId.startsWith(SLOT_ID_PREFIX)) {
    return undefined;
  }
  const rest = agentId.slice(SLOT_ID_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0 || colon === rest.length - 1) {
    return undefined;
  }
  return { runnerId: rest.slice(0, colon), slotId: rest.slice(colon + 1) };
}

/** A slot as the desk terminal reads it, at its runner's last sync. */
export interface RunnerDeskSlot extends RunnerSlotRef {
  readonly status: RunnerSlotStatus;
  readonly activity: string;
  /** The desk it is lent to, by seat id, if any. */
  readonly seatId: string | undefined;
  /** It holds nothing: idle, with no issue, standing run or desk. */
  readonly free: boolean;
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
  /** What its last sync said it spent; `undefined` from a runner that does not meter. */
  spend: RunnerSpendReport | undefined;
  /** Its standing tasks' names, by id, for a slot running one. */
  standingNames: ReadonlyMap<string, string>;
  /** Whether its last sync said it closes and reopens issues. */
  changesIssues: boolean;
}

/** A change to an issue's state sent to a runner, waiting for what came of it. */
interface IssueStateWait {
  readonly runnerId: string;
  readonly settle: (rejection: IssueStateRejection | undefined) => void;
}

/** What each outcome a runner reports tells the CEO; `undefined` for the change made. */
const ISSUE_STATE_REJECTIONS: Readonly<Record<RunnerIssueStateOutcome["outcome"], IssueStateRejection | undefined>> = {
  [RUNNER_ISSUE_STATE_OUTCOME.done]: undefined,
  [RUNNER_ISSUE_STATE_OUTCOME.refused]: ISSUE_STATE_REJECTION.refused,
  [RUNNER_ISSUE_STATE_OUTCOME.failed]: ISSUE_STATE_REJECTION.unreachable,
};

interface Inbox {
  events: RunnerEventRecord[];
  prompts: RunnerPromptRecord[];
}

/** What an inbox drains to when nothing arrived, so an idle tick allocates nothing. */
const NOTHING: readonly RunnerEventRecord[] = [];
const NO_PROMPTS: readonly RunnerPromptRecord[] = [];

function sameRecord(a: LiveAgentRecord, b: LiveAgentRecord): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.title === b.title &&
    a.description === b.description &&
    a.status === b.status &&
    a.activity === b.activity &&
    a.canTakeIssues === b.canTakeIssues &&
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

export class RunnerLink implements LiveAgentSource, RunnerEventSource, RunnerSpendSource, RunnerStandupHold, IssueStates {
  private readonly runners = new Map<string, Runner>();
  /** Changes to issues' states sent and not yet answered, by command id. */
  private readonly issueStateWaits = new Map<string, IssueStateWait>();
  /** The rooms holding a standup. */
  private readonly standups = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly inboxes = new Set<Inbox>();
  private readonly now: () => number;
  private readonly commandId: () => string;
  private readonly repository: string;
  private snapshot: readonly LiveAgentRecord[] = [];
  private spendTotal: RunnerSpendTotal = NO_RUNNER_SPEND;
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

  public spend(): RunnerSpendTotal {
    return this.spendTotal;
  }

  public holdForStandup(origin: string, on: boolean): void {
    if (on) {
      this.standups.add(origin);
    } else {
      this.standups.delete(origin);
    }
  }

  /** Whether any room holds a standup. */
  public get standup(): boolean {
    return this.standups.size > 0;
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
        spend: undefined,
        standingNames: new Map(),
        changesIssues: false,
      };
      this.runners.set(sync.runnerId, runner);
    }

    runner.lastSeenAt = this.now();
    runner.spend = sync.spend;
    this.totalSpend();
    for (const id of sync.acked) {
      runner.outbox.delete(id);
    }
    this.receive(sync.runnerId, runner, sync.events);
    this.receivePrompts(sync.runnerId, sync.prompts ?? []);
    runner.changesIssues = sync.changesIssues === true;
    for (const { commandId, outcome } of sync.issueStates ?? []) {
      const wait = this.issueStateWaits.get(commandId);
      if (wait?.runnerId === sync.runnerId) {
        wait.settle(ISSUE_STATE_REJECTIONS[outcome]);
      }
    }
    const standing = sync.standing ?? [];
    runner.standingNames = new Map(standing.map((task) => [task.id, task.name]));
    if (this.options.standing !== undefined) {
      const running = new Map<string, string>();
      for (const slot of sync.slots) {
        if (slot.standing !== undefined) {
          running.set(slot.standing.taskId, liveAgentKey(runnerSlotAgentId(sync.runnerId, slot.id)));
        }
      }
      this.options.standing.update(sync.runnerId, standing, sync.standingOff, running);
    }

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
    return { kind: "accepted", commands: [...runner.outbox.values()], standup: this.standup };
  }

  /**
   * Queues a command for one of a runner's slots, or for its standing tasks.
   * It goes out in every sync reply to that runner until the runner acks it.
   *
   * @returns the command, or `undefined` when the runner is not connected, the
   * slot is not one it reported, the command is malformed, or the runner has
   * {@link RunnerLinkOptions.maxPendingCommands} waiting already.
   */
  public enqueue(runnerId: string, draft: RunnerCommandDraft): RunnerCommand | undefined {
    const runner = this.runners.get(runnerId);
    if (runner === undefined || (isRunnerSlotCommand(draft) && !runner.slots.some((slot) => slot.id === draft.slotId))) {
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

  /**
   * Takes back a command its runner has not acked yet, so it never goes out.
   *
   * @returns whether it was still waiting to.
   */
  public withdraw(runnerId: string, commandId: string): boolean {
    return this.runners.get(runnerId)?.outbox.delete(commandId) ?? false;
  }

  /** Whether a connected runner closes and reopens issues on GitHub. */
  public canChangeIssues(): boolean {
    return [...this.runners.values()].some((runner) => runner.changesIssues);
  }

  /**
   * Has a runner that can close or reopen an issue on GitHub do it, for
   * `requestedBy`, and resolves to what came of it: `undefined` when GitHub
   * made the change, or why not. Never rejects.
   *
   * A runner that does not answer in time, or goes silent, is given up on as
   * unreachable, and a command it has not taken yet is taken back so it does
   * not close the issue after the CEO has been told it did not.
   */
  public changeIssueState(issueNumber: number, state: IssueState, requestedBy: string): Promise<IssueStateRejection | undefined> {
    const runnerId = [...this.runners].find(([, runner]) => runner.changesIssues)?.[0];
    if (runnerId === undefined) {
      return Promise.resolve(ISSUE_STATE_REJECTION.unavailable);
    }
    const command = this.enqueue(runnerId, { kind: RUNNER_COMMAND_KIND.issueState, issueNumber, state, requestedBy });
    if (command === undefined) {
      return Promise.resolve(ISSUE_STATE_REJECTION.unreachable);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.withdraw(runnerId, command.id);
        settle(ISSUE_STATE_REJECTION.unreachable);
      }, this.options.issueStateWaitMs ?? DEFAULT_ISSUE_STATE_WAIT_MS);
      timer.unref();
      const settle = (rejection: IssueStateRejection | undefined) => {
        clearTimeout(timer);
        this.issueStateWaits.delete(command.id);
        resolve(rejection);
      };
      this.issueStateWaits.set(command.id, { runnerId, settle });
    });
  }

  /** Whether a runner's last sync was taken, and it has not gone silent since. */
  public hasRunner(runnerId: string): boolean {
    return this.runners.has(runnerId);
  }

  /** Whether a runner reported a slot in its last sync. */
  public hasSlot(runnerId: string, slotId: string): boolean {
    return this.runners.get(runnerId)?.slots.some((slot) => slot.id === slotId) ?? false;
  }

  /** Every slot holding an issue at its runner's last sync. */
  public heldIssues(): Array<RunnerSlotRef & { readonly issueNumber: number }> {
    const held: Array<RunnerSlotRef & { readonly issueNumber: number }> = [];
    for (const [runnerId, runner] of this.runners) {
      for (const slot of runner.slots) {
        if (slot.issueNumber !== undefined) {
          held.push({ runnerId, slotId: slot.id, issueNumber: slot.issueNumber });
        }
      }
    }
    return held;
  }

  /** Whether any runner's last sync was taken and it has not gone silent since. */
  public hasRunners(): boolean {
    return this.runners.size > 0;
  }

  /** Every slot of every runner, as the desk terminal reads it. */
  public deskSlots(): RunnerDeskSlot[] {
    const slots: RunnerDeskSlot[] = [];
    for (const [runnerId, runner] of this.runners) {
      for (const slot of runner.slots) {
        slots.push({
          runnerId,
          slotId: slot.id,
          status: slot.status,
          activity: slot.activity,
          seatId: slot.desk?.seatId,
          free:
            (slot.status === RUNNER_SLOT_STATUS.idle || slot.status === RUNNER_SLOT_STATUS.exited) &&
            slot.issueNumber === undefined &&
            slot.standing === undefined &&
            slot.desk === undefined,
        });
      }
    }
    return slots;
  }

  /** The issue a slot was holding at the runner's last sync, if any. */
  public slotIssue(runnerId: string, slotId: string): number | undefined {
    return this.runners.get(runnerId)?.slots.find((slot) => slot.id === slotId)?.issueNumber;
  }

  /** An issue's link on the project board's repository. */
  public issueUrl(issueNumber: number): string {
    return `https://github.com/${this.options.repository}/issues/${issueNumber}`;
  }

  /** The commands waiting for a runner, oldest first. */
  public pending(runnerId: string): readonly RunnerCommand[] {
    return [...(this.runners.get(runnerId)?.outbox.values() ?? [])];
  }

  public openEventInbox(): RunnerEventInbox {
    const inbox: Inbox = { events: [], prompts: [] };
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
      drainPrompts: () => {
        if (inbox.prompts.length === 0) {
          return NO_PROMPTS;
        }
        const drained = inbox.prompts;
        inbox.prompts = [];
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
        this.options.standing?.drop(id);
        for (const wait of [...this.issueStateWaits.values()].filter((candidate) => candidate.runnerId === id)) {
          wait.settle(ISSUE_STATE_REJECTION.unreachable);
        }
        dropped ||= runner.records.length > 0;
      }
    }
    this.totalSpend();
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

  /**
   * Adds up what the runners that meter said they spent, and their budgets
   * while every one has one, noting whether any of them has spent its own.
   */
  private totalSpend(): void {
    let runners = 0;
    let spentUsd = 0;
    let budgetUsd: number | undefined = 0;
    let budgetSpent = false;
    for (const { spend } of this.runners.values()) {
      if (spend === undefined) {
        continue;
      }
      runners += 1;
      spentUsd += spend.spentUsd;
      budgetUsd = budgetUsd === undefined || spend.budgetUsd === undefined ? undefined : budgetUsd + spend.budgetUsd;
      budgetSpent ||= isBudgetSpent(spend.spentUsd, spend.budgetUsd);
    }
    this.spendTotal = runners === 0 ? NO_RUNNER_SPEND : { runners, spentUsd, budgetUsd, budgetSpent };
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

  /**
   * Passes every prompt outcome to every open inbox. Not deduplicated here: a
   * room forgets a prompt once it has heard what came of it, so a repeat finds
   * nothing to settle.
   */
  private receivePrompts(runnerId: string, outcomes: readonly RunnerPromptOutcome[]): void {
    for (const outcome of outcomes) {
      for (const inbox of this.inboxes) {
        inbox.prompts.push({ runnerId, outcome });
        if (inbox.prompts.length > MAX_INBOX_EVENTS) {
          inbox.prompts.shift();
        }
      }
    }
  }

  /** A slot as a live agent on the floor. */
  private record(runnerId: string, runner: Runner, slot: RunnerSlotReport): LiveAgentRecord {
    if (slot.desk !== undefined) {
      // Lent to the CEO: free on the floor, with no task, and given none while it is.
      return {
        id: runnerSlotAgentId(runnerId, slot.id),
        name: slot.name,
        status: LIVE_AGENT_STATUS.idle,
        task: undefined,
        activity: LENT_TO_DESK_ACTIVITY,
        canTakeIssues: false,
      };
    }
    return {
      id: runnerSlotAgentId(runnerId, slot.id),
      name: slot.name,
      title: slot.title,
      description: slot.description,
      status: FLOOR_STATUS[slot.status],
      task: this.task(runner, slot),
      activity: slot.activity,
      // A slot's work goes through the office's work rules, so it can take issues.
      canTakeIssues: true,
      // Its runner keeps its profile and prompts its agent with it.
      profileEditable: true,
    };
  }

  /**
   * The issue a slot is on, titled from the start command that put it there
   * when there was one. What it is doing travels as its activity, not here.
   */
  private task(runner: Runner, slot: RunnerSlotReport): LiveAgentTask | undefined {
    if (slot.standing !== undefined && isLiveAgentOnTask(FLOOR_STATUS[slot.status])) {
      return this.standingTask(runner, slot.standing.taskId, slot.standing.pr);
    }
    if (slot.issueNumber === undefined || !isLiveAgentOnTask(FLOOR_STATUS[slot.status])) {
      return undefined;
    }
    const started = runner.startedTitles.get(slot.id);
    const title = started?.issueNumber === slot.issueNumber ? started.title : `Issue #${slot.issueNumber}`;
    return { title, url: this.issueUrl(slot.issueNumber) };
  }

  /**
   * A standing run as a slot's task: the pull request it reviews, linked and
   * titled from the project board where it lists it, or the schedule it runs.
   */
  private standingTask(runner: Runner, taskId: string, pr: number | undefined): LiveAgentTask {
    if (pr === undefined) {
      return { title: sanitizeTitle(`Scheduled: ${runner.standingNames.get(taskId) ?? "a standing task"}`), url: "" };
    }
    const title = this.options.pullTitle?.(pr);
    return {
      title: sanitizeTitle(title === undefined || title === "" ? `Review PR #${pr}` : `Review PR #${pr}: ${title}`),
      url: this.pullUrl(pr),
    };
  }

  /** A pull request's link on the project board's repository. */
  public pullUrl(number: number): string {
    return `https://github.com/${this.options.repository}/pull/${number}`;
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
