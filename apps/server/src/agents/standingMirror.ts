/**
 * The office's copy of every runner's standing tasks: what each runner last
 * reported, refreshed by every sync it sends, and dropped with the runner
 * once it goes silent.
 *
 * Process-wide, beside the runner link that feeds it, so a room opened later,
 * after the office stood empty, shows the tasks at once, and a restarted
 * server shows them again within one sync: the runner owns them, on its own
 * disk, and the server only ever holds what it was last told. Rooms read it
 * on their tick through {@link StandingSource}: a finished list and a version
 * that changes only when the list does, so an unchanged tick copies nothing.
 *
 * Beside the tasks, it keeps what the office needs to choose a runner for a
 * new one: whether each runner takes standing tasks at all, and the tasks
 * it has just been asked to take and has not reported yet, so a second
 * "watch for new pull requests" a moment after the first is not taken for
 * the first. And it holds the tasks' run history (`./standingHistory.ts`),
 * fed by the runners' syncs and read by the wall board.
 *
 * Like the link, it runs on Node's event loop, never inside a tick.
 */

import type { MapSchema, Schema } from "@colyseus/schema";
import {
  MAX_STANDING_TASKS,
  type StandingKind,
  type StandingOff,
  type StandingRunRecord,
  StandingTask,
  type StandingTaskReport,
  liveAgentKey,
  watchesPullRequests,
} from "@sim/shared";

import { runnerSlotAgentId } from "./runnerLink.js";
import { StandingHistory } from "./standingHistory.js";

/** One task, with the runner holding it and the slot running it now. */
export interface StandingTaskRecord {
  readonly runnerId: string;
  readonly report: StandingTaskReport;
  /** The live agent id of the slot running it now, `undefined` while none is. */
  readonly runningAgentId: string | undefined;
}

/** What a room reads of the mirror. */
export interface StandingSource {
  /** Every runner's tasks, by runner then as each reported them. */
  standingTasks(): readonly StandingTaskRecord[];
  /** Changes whenever {@link standingTasks} does, and only then. */
  standingVersion(): number;
  /** A task's last runs, newest first, with their logs. */
  standingRuns(taskId: string): readonly StandingRunRecord[];
}

/** A runner as a new standing task's home. */
export interface StandingRunnerView {
  readonly runnerId: string;
  /** Why it takes no standing tasks, or `undefined` when it does. */
  readonly off: StandingOff | undefined;
  /** Tasks it reported and tasks it was just asked to take. */
  readonly tasks: number;
}

interface RunnerTasks {
  reports: readonly StandingTaskReport[];
  running: ReadonlyMap<string, string>;
  off: StandingOff | undefined;
}

/** How long a task asked for and not yet reported counts as the runner's. */
const EXPECTED_MS = 30_000;

export interface StandingMirrorOptions {
  readonly now?: () => number;
  /** Where the runs are kept; in memory alone by default. */
  readonly history?: StandingHistory;
}

export class StandingMirror implements StandingSource {
  private readonly runners = new Map<string, RunnerTasks>();
  private readonly expected = new Map<string, { readonly runnerId: string; readonly kind: StandingKind; readonly at: number }>();
  private snapshot: readonly StandingTaskRecord[] = [];
  private version = 0;
  private readonly now: () => number;
  private readonly history: StandingHistory;

  public constructor(options: StandingMirrorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.history = options.history ?? new StandingHistory();
  }

  public standingRuns(taskId: string): readonly StandingRunRecord[] {
    return this.history.runs(taskId);
  }

  /** The runs a runner's sync carried. */
  public keepRuns(records: readonly StandingRunRecord[]): void {
    if (records.length > 0) {
      this.history.keep(records);
    }
  }

  /** A task the CEO removed: its runs go with it. */
  public forgetRuns(taskId: string): void {
    this.history.forget(taskId);
  }

  public standingTasks(): readonly StandingTaskRecord[] {
    return this.snapshot;
  }

  public standingVersion(): number {
    return this.version;
  }

  /**
   * One runner's whole standing state, from a sync it sent.
   *
   * @param running the live agent id of each slot on a standing run, by the task's id.
   */
  public update(runnerId: string, reports: readonly StandingTaskReport[], off: StandingOff | undefined, running: ReadonlyMap<string, string>): void {
    for (const report of reports) {
      this.expected.delete(report.id);
    }
    const before = this.runners.get(runnerId);
    this.runners.set(runnerId, { reports, running, off });
    if (before === undefined || !sameReports(before, reports, running)) {
      this.rebuild();
    }
  }

  /** The runner went silent: its tasks leave the office with its slots. */
  public drop(runnerId: string): void {
    for (const [taskId, expected] of this.expected) {
      if (expected.runnerId === runnerId) {
        this.expected.delete(taskId);
      }
    }
    if (this.runners.delete(runnerId)) {
      this.rebuild();
    }
  }

  /** A task a runner has just been asked to take, counted as its own until it reports it. */
  public expect(runnerId: string, taskId: string, kind: StandingKind): void {
    this.expected.set(taskId, { runnerId, kind, at: this.now() });
  }

  /** The runner refused a task it was asked to take. */
  public refused(taskId: string): void {
    this.expected.delete(taskId);
  }

  /** Every runner heard from, as a home for a new task. */
  public runnerViews(): StandingRunnerView[] {
    this.forgetStale();
    return [...this.runners].map(([runnerId, runner]) => ({
      runnerId,
      off: runner.off,
      tasks: runner.reports.length + [...this.expected.values()].filter((expected) => expected.runnerId === runnerId).length,
    }));
  }

  /** Whether any runner holds, or has just been asked to take, a task that watches the pull requests: the watch or the steward. */
  public watchesPullRequests(): boolean {
    this.forgetStale();
    return (
      this.snapshot.some((record) => watchesPullRequests(record.report.kind)) ||
      [...this.expected.values()].some((expected) => watchesPullRequests(expected.kind))
    );
  }

  /** Whether a runner may be given one more task. */
  public static hasRoom(view: StandingRunnerView): boolean {
    return view.off === undefined && view.tasks < MAX_STANDING_TASKS;
  }

  private forgetStale(): void {
    const cutoff = this.now() - EXPECTED_MS;
    for (const [taskId, expected] of this.expected) {
      if (expected.at < cutoff) {
        this.expected.delete(taskId);
      }
    }
  }

  private rebuild(): void {
    const records: StandingTaskRecord[] = [];
    for (const [runnerId, runner] of this.runners) {
      for (const report of runner.reports) {
        records.push({ runnerId, report, runningAgentId: runner.running.get(report.id) });
      }
    }
    this.snapshot = records;
    this.version += 1;
  }
}

function sameReports(before: RunnerTasks, reports: readonly StandingTaskReport[], running: ReadonlyMap<string, string>): boolean {
  if (before.running.size !== running.size || [...running].some(([taskId, agent]) => before.running.get(taskId) !== agent)) {
    return false;
  }
  return JSON.stringify(before.reports) === JSON.stringify(reports);
}

/**
 * Copies the mirror's tasks into a room's replicated map, field by field, so
 * a sync that changed one figure sends only that figure, and a task its
 * runner no longer reports leaves the office.
 */
export function copyStandingTasks(map: MapSchema<StandingTask>, records: readonly StandingTaskRecord[]): void {
  const seen = new Set<string>();
  for (const { runnerId, report, runningAgentId } of records) {
    seen.add(report.id);
    let task = map.get(report.id);
    if (task === undefined) {
      task = new StandingTask();
      task.id = report.id;
      map.set(report.id, task);
    }
    const latest = report.recent[0];
    const fields: Omit<StandingTask, keyof Schema | "id"> = {
      runnerId,
      kind: report.kind,
      name: report.name,
      status: report.status,
      trigger: report.trigger,
      cron: "cron" in report.schedule ? report.schedule.cron : "",
      intervalSeconds: "intervalSeconds" in report.schedule ? report.schedule.intervalSeconds : 0,
      agentId: report.agent === undefined ? "" : liveAgentKey(runnerSlotAgentId(runnerId, report.agent)),
      lastCheckAt: report.lastCheckAt ?? 0,
      nextCheckAt: report.nextCheckAt ?? 0,
      queued: report.queued,
      handledToday: report.handledToday,
      spentTodayUsd: report.spentTodayUsd,
      dailyUsd: report.dailyUsd ?? 0,
      lastError: report.lastError,
      lastOutcome: latest?.outcome ?? "",
      lastRunAt: latest?.at ?? 0,
      lastRunPr: latest?.pr ?? 0,
      runningAgentId: runningAgentId ?? "",
    };
    for (const [key, value] of Object.entries(fields) as Array<[keyof typeof fields, string | number]>) {
      if (task[key] !== value) {
        (task as unknown as Record<string, string | number>)[key] = value;
      }
    }
  }
  for (const id of [...map.keys()]) {
    if (!seen.has(id)) {
      map.delete(id);
    }
  }
}
