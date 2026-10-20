/**
 * Where the runner keeps its standing tasks between runs:
 * `<RUNNER_DATA_DIR>/standing.json`, private to the runner's user.
 *
 * It holds each task's definition, its ledger of what it has handled, and
 * what it and all standing tasks together have spent today, so a restarted
 * runner keeps its day: a pull request already reviewed is not reviewed
 * again, a run cut short by the restart is tried again, and a crash loop
 * cannot spend a day's standing budget twice.
 *
 * Written whole and moved into place, as the worktree records are, so a
 * runner killed mid-write leaves the last good file. Read defensively: a
 * definition the contract no longer takes is dropped with the reason logged,
 * and an unreadable file is read as no tasks, which the log says, rather
 * than stopping the runner.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import {
  MAX_STANDING_RECENT,
  MAX_STANDING_TASKS,
  type StandingRunSummary,
  type StandingTaskSpec,
  asRecord,
  isStandingOutcome,
  parseStandingTaskSpec,
} from "@sim/shared";

/** Where one event a task looked at stands. */
export const LEDGER_STATE = {
  /** There before the task was: never reviewed. */
  baseline: "baseline",
  /** Waiting for a slot. */
  queued: "queued",
  /** Saved before its agent starts, so a restart knows it was cut short. */
  running: "running",
  done: "done",
  /** Its run failed; tried again at `retryAt` until it has had its attempts. */
  failed: "failed",
  /** Left alone, for its `reason`. */
  skipped: "skipped",
} as const;

export type LedgerState = (typeof LEDGER_STATE)[keyof typeof LEDGER_STATE];

/** Why an event was left alone. */
export type SkipReason = "draft" | "outside" | "closed" | "missed" | "superseded";

/** One event, keyed `pr:<number>` for a pull request, or `at:<epoch ms>` for a schedule's firing. */
export interface LedgerEntry {
  state: LedgerState;
  /** Runs started for it, a preempted one not counted. */
  attempts: number;
  /** When it was first seen, or the firing it is, epoch ms. */
  at: number;
  /** A pull request's title, as last listed. */
  title?: string | undefined;
  headSha?: string | undefined;
  /** Its review comment, once posted. */
  commentId?: number | undefined;
  /** When a failed one is queued again. */
  retryAt?: number | undefined;
  reason?: SkipReason | undefined;
  /** When it was last seen open, for pruning. */
  seenAt?: number | undefined;
}

export interface StoredTask {
  spec: StandingTaskSpec;
  /** The CEO who set it up, for a posted review's attribution line. */
  requestedBy: string;
  /** Whether its first look has recorded what was there already. */
  baselined: boolean;
  ledger: Record<string, LedgerEntry>;
  spentTodayUsd: number;
  handledToday: number;
  /** When its runs started, epoch ms, the last hour's. */
  runStarts: number[];
  /** The day it reached its runs an hour, after which it starts nothing more that day. */
  hourCapDay?: string | undefined;
  lastCheckAt?: number | undefined;
  nextCheckAt?: number | undefined;
  /** The pull request listing's ETag, so an unchanged repository costs nothing. */
  etag?: string | undefined;
  /** Its last check's error, and its last run's; `""` for none. */
  checkError: string;
  runError: string;
  /** Newest first. */
  recent: StandingRunSummary[];
  /** The day a refused budget was last said, so it is said once a day. */
  refusedDay?: string | undefined;
}

export interface StandingFile {
  /** The day `spentTodayUsd` and each task's day figures are for, on the machine's calendar. */
  day: string;
  /** What every standing task spent on {@link day}, those since removed too. */
  spentTodayUsd: number;
  tasks: StoredTask[];
}

const LEDGER_STATES: ReadonlySet<string> = new Set(Object.values(LEDGER_STATE));
const SKIP_REASONS: ReadonlySet<string> = new Set(["draft", "outside", "closed", "missed", "superseded"]);
const LEDGER_KEY = /^(?:pr:\d{1,10}|at:\d{1,16})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function number(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function text(raw: unknown, max = 200): string | undefined {
  return typeof raw === "string" ? raw.slice(0, max) : undefined;
}

function readEntry(raw: unknown): LedgerEntry | undefined {
  const entry = asRecord(raw);
  if (entry === undefined || typeof entry["state"] !== "string" || !LEDGER_STATES.has(entry["state"])) {
    return undefined;
  }
  const at = number(entry["at"]);
  if (at === undefined) {
    return undefined;
  }
  const reason = typeof entry["reason"] === "string" && SKIP_REASONS.has(entry["reason"]) ? (entry["reason"] as SkipReason) : undefined;
  return {
    state: entry["state"] as LedgerState,
    attempts: Math.floor(number(entry["attempts"]) ?? 0),
    at,
    title: text(entry["title"]),
    headSha: text(entry["headSha"], 64),
    commentId: number(entry["commentId"]),
    retryAt: number(entry["retryAt"]),
    reason,
    seenAt: number(entry["seenAt"]),
  };
}

function readRecent(raw: unknown): StandingRunSummary[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.slice(0, MAX_STANDING_RECENT).flatMap((item): StandingRunSummary[] => {
    const run = asRecord(item);
    const at = number(run?.["at"]);
    const outcome = run?.["outcome"];
    if (at === undefined || !isStandingOutcome(outcome)) {
      return [];
    }
    return [{ at, outcome, pr: number(run?.["pr"]) }];
  });
}

/** One task as stored, or `undefined` with why for one that cannot be kept. */
function readTask(raw: unknown): StoredTask | string {
  const task = asRecord(raw);
  const spec = parseStandingTaskSpec(task?.["spec"]);
  if (task === undefined || spec === undefined) {
    return "its definition is not one this runner takes";
  }
  const ledger: Record<string, LedgerEntry> = {};
  for (const [key, value] of Object.entries(asRecord(task["ledger"]) ?? {})) {
    const entry = readEntry(value);
    if (LEDGER_KEY.test(key) && entry !== undefined) {
      ledger[key] = entry;
    }
  }
  const day = (raw: unknown): string | undefined => (typeof raw === "string" && DAY.test(raw) ? raw : undefined);
  return {
    spec,
    requestedBy: text(task["requestedBy"], 64) ?? "",
    baselined: task["baselined"] === true,
    ledger,
    spentTodayUsd: number(task["spentTodayUsd"]) ?? 0,
    handledToday: Math.floor(number(task["handledToday"]) ?? 0),
    runStarts: Array.isArray(task["runStarts"]) ? task["runStarts"].flatMap((at) => (number(at) === undefined ? [] : [at as number])) : [],
    hourCapDay: day(task["hourCapDay"]),
    lastCheckAt: number(task["lastCheckAt"]),
    nextCheckAt: number(task["nextCheckAt"]),
    etag: text(task["etag"]),
    checkError: text(task["checkError"]) ?? "",
    runError: text(task["runError"]) ?? "",
    recent: readRecent(task["recent"]),
    refusedDay: day(task["refusedDay"]),
  };
}

export interface StandingStoreOptions {
  /** `<RUNNER_DATA_DIR>/standing.json`. */
  readonly file: string;
  readonly log?: (line: string) => void;
}

export class StandingStore {
  private readonly log: (line: string) => void;

  public constructor(private readonly options: StandingStoreOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** What the last run kept, or an empty day when it kept nothing readable. */
  public load(today: string): StandingFile {
    const { file } = this.options;
    const empty: StandingFile = { day: today, spentTodayUsd: 0, tasks: [] };
    if (!existsSync(file)) {
      return empty;
    }
    let raw: Record<string, unknown> | undefined;
    try {
      raw = asRecord(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      this.log(`could not read ${file}, so the runner starts with no standing tasks: ${(error as Error).message}`);
      return empty;
    }
    const tasks: StoredTask[] = [];
    for (const item of Array.isArray(raw?.["tasks"]) ? raw["tasks"] : []) {
      const task = readTask(item);
      if (typeof task === "string") {
        this.log(`dropped a standing task from ${file}: ${task}`);
      } else if (tasks.length < MAX_STANDING_TASKS && !tasks.some((kept) => kept.spec.id === task.spec.id)) {
        tasks.push(task);
      }
    }
    const day = typeof raw?.["day"] === "string" && DAY.test(raw["day"]) ? raw["day"] : today;
    return { day, spentTodayUsd: number(raw?.["spentTodayUsd"]) ?? 0, tasks };
  }

  /** Written whole and moved into place, readable by the runner's user alone. */
  public save(data: StandingFile): void {
    const { file } = this.options;
    const partial = `${file}.partial`;
    try {
      writeFileSync(partial, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      renameSync(partial, file);
    } catch (error) {
      this.log(`could not save the standing tasks to ${file}: ${(error as Error).message}`);
    }
  }
}
