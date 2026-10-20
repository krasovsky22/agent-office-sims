/**
 * The recurring tasks' run history, for the wall board: each task's last
 * runs, with their logs, results and summaries, as the runners sent them.
 *
 * A runner sends each run's record once, on the sync after it ended, and
 * keeps it until a sync carrying it is answered; it keeps no history itself.
 * So the server keeps it, in `<SERVER_DATA_DIR>/standing-runs.json`, and a
 * restarted server shows a task's past runs as before. Kept by task id,
 * newest first, {@link MAX_STANDING_HISTORY} a task, and the tasks heard from
 * least lately go first past {@link MAX_KEPT_TASKS}; a task the CEO removes
 * takes its history with it.
 *
 * Written whole and moved into place, so a server killed mid-write leaves the
 * last good file. Read defensively: a record the contract would not take is
 * dropped, and an unreadable file is read as no history, which the log says,
 * rather than stopping the server. Nothing in it is secret beyond what every
 * visitor already sees on the agents' screens, which the runner masks the
 * same way.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { MAX_STANDING_HISTORY, type StandingRunRecord, asRecord, isStandingTaskId, parseStandingRunRecord } from "@sim/shared";

/** Tasks whose history is kept: every runner's four, and room for some since removed by deleting a runner's file. */
export const MAX_KEPT_TASKS = 16;

export interface StandingHistoryOptions {
  /** `<SERVER_DATA_DIR>/standing-runs.json`; kept in memory alone without one. */
  readonly file?: string;
  readonly log?: (line: string) => void;
}

export class StandingHistory {
  /** By task id, each newest first; a Map keeps the tasks in the order they were last heard of. */
  private readonly tasks = new Map<string, StandingRunRecord[]>();
  private readonly log: (line: string) => void;

  public constructor(private readonly options: StandingHistoryOptions = {}) {
    this.log = options.log ?? (() => undefined);
    this.load();
  }

  /** A task's last runs, newest first. */
  public runs(taskId: string): readonly StandingRunRecord[] {
    return this.tasks.get(taskId) ?? [];
  }

  /** Keeps records a runner sent, each once whatever it repeats. */
  public keep(records: readonly StandingRunRecord[]): void {
    let changed = false;
    for (const record of records) {
      const runs = this.tasks.get(record.taskId) ?? [];
      if (runs.some((run) => run.id === record.id)) {
        continue;
      }
      this.tasks.delete(record.taskId);
      this.tasks.set(record.taskId, [record, ...runs].sort((a, b) => b.endedAt - a.endedAt).slice(0, MAX_STANDING_HISTORY));
      changed = true;
    }
    for (const taskId of this.tasks.keys()) {
      if (this.tasks.size <= MAX_KEPT_TASKS) {
        break;
      }
      this.tasks.delete(taskId);
    }
    if (changed) {
      this.save();
    }
  }

  /** The task was removed: its history goes with it. */
  public forget(taskId: string): void {
    if (this.tasks.delete(taskId)) {
      this.save();
    }
  }

  private load(): void {
    const { file } = this.options;
    if (file === undefined || !existsSync(file)) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      this.log(`could not read ${file}, so no standing run is kept from before: ${(error as Error).message}`);
      return;
    }
    for (const [taskId, value] of Object.entries(asRecord(asRecord(raw)?.["tasks"]) ?? {})) {
      if (!isStandingTaskId(taskId) || !Array.isArray(value)) {
        continue;
      }
      const runs = value.flatMap((item: unknown) => {
        const record = parseStandingRunRecord(item);
        return record === undefined || record.taskId !== taskId ? [] : [record];
      });
      if (runs.length > 0 && this.tasks.size < MAX_KEPT_TASKS) {
        this.tasks.set(taskId, runs.slice(0, MAX_STANDING_HISTORY));
      }
    }
  }

  /** Written whole and moved into place, readable by the server's user alone. */
  private save(): void {
    const { file } = this.options;
    if (file === undefined) {
      return;
    }
    const partial = `${file}.partial`;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(partial, `${JSON.stringify({ tasks: Object.fromEntries(this.tasks) }, null, 2)}\n`, { mode: 0o600 });
      renameSync(partial, file);
    } catch (error) {
      this.log(`could not save the standing runs to ${file}: ${(error as Error).message}`);
    }
  }
}
