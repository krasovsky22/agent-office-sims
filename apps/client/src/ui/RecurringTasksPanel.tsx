/**
 * The recurring tasks board's close-up, opened with `E` at the board on the
 * open floor's west wall: every standing task, and, opened, its last runs
 * with each one's summary, result and log, and the CEO's controls to change
 * how often it runs or delete it; and a form for the CEO to set a new one up,
 * saying what it does, which agent runs it and how often.
 *
 * Everyone may read it, as everyone reads the agents' screens the logs come
 * off; the controls are the CEO's, disabled with the reason for anyone else,
 * from `standingAccess.ts`, which asks the server's own rule. A task's runs
 * are asked for when it is opened, and again whenever it runs while open;
 * they come back to this tab alone. Deleting asks once more before it goes.
 *
 * Every string is a React text node, from text the server or the runner
 * sanitized, so a log holding markup is shown rather than interpreted, and a
 * run's link is the one the server built on the board's repository.
 */

import {
  MAX_STANDING_INSTRUCTION_LENGTH,
  STANDING_KIND,
  STANDING_OUTCOME_TEXT,
  type StandingCreateMessage,
  type StandingKind,
  type StandingRunView,
  type StandingSchedule,
  formatUsd,
  isStandingOutcome,
} from "@sim/shared";
import { useEffect, useRef, useState } from "react";

import type { BoardAgent } from "../projectBoard.js";
import {
  CHECK_MINUTES,
  STANDING_KIND_TEXT,
  type ScheduleChoice,
  type StandingAccess,
  type StandingTaskData,
  cronOfChoice,
  recurringRow,
  scheduleChoice,
} from "../standingAccess.js";

export interface RecurringTasksActions {
  /** Asks for a task's last runs; they arrive in the panel's `history`. */
  readonly history: (taskId: string) => void;
  readonly reschedule: (taskId: string, schedule: StandingSchedule) => void;
  readonly remove: (taskId: string) => void;
  readonly create: (task: StandingCreateMessage) => void;
}

interface RecurringTasksPanelProps {
  readonly tasks: readonly StandingTaskData[];
  /** Each task's last runs as the server last sent them, newest first; a task not asked about yet is absent. */
  readonly history: Readonly<Record<string, readonly StandingRunView[]>>;
  /** `undefined` before the local player has joined, when nothing is offered. */
  readonly access: StandingAccess | undefined;
  /** An agent's name by occupant key, for the one hired for a task. */
  readonly agentName: (agentId: string) => string | undefined;
  /** The coding agents a new task may be given to run on alone. */
  readonly agents: readonly BoardAgent[];
  readonly actions: RecurringTasksActions;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** How long a run took: `42 s`, `3 min`. */
function took(run: StandingRunView): string {
  const seconds = Math.max(Math.round((run.endedAt - run.startedAt) / 1000), 0);
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** A scheduled job's schedule: the board's choices, or any cron. */
function ScheduleFields({ choice, setChoice, disabled, reason }: { choice: ScheduleChoice; setChoice: (choice: ScheduleChoice) => void; disabled: boolean; reason: string }) {
  const cron = cronOfChoice(choice);
  const time = choice.kind === "daily" || choice.kind === "weekdays" ? choice.time : "09:00";
  return (
    <>
      <select
        aria-label="How often it runs"
        disabled={disabled}
        title={disabled ? reason : "How often it runs, on the runner's clock"}
        value={choice.kind}
        onChange={(event) => {
          const kind = event.target.value as ScheduleChoice["kind"];
          setChoice(kind === "hourly" ? { kind } : kind === "custom" ? { kind, cron: cron ?? "" } : { kind, time });
        }}
      >
        <option value="hourly">Every hour</option>
        <option value="daily">Every day at</option>
        <option value="weekdays">Weekdays at</option>
        <option value="custom">Cron</option>
      </select>
      {choice.kind === "daily" || choice.kind === "weekdays" ? (
        <input
          type="time"
          aria-label="At"
          disabled={disabled}
          value={choice.time}
          onChange={(event) => setChoice({ kind: choice.kind, time: event.target.value })}
        />
      ) : null}
      {choice.kind === "custom" ? (
        <input
          className="recurring__cron"
          type="text"
          aria-label="Five-field cron"
          placeholder="0 9 * * 1-5"
          disabled={disabled}
          value={choice.cron}
          onChange={(event) => setChoice({ kind: "custom", cron: event.target.value })}
        />
      ) : null}
    </>
  );
}

/** The CEO's say over how often a scheduled job runs. */
function CronControl({ task, disabled, reason, save }: { task: StandingTaskData; disabled: boolean; reason: string; save: (schedule: StandingSchedule) => void }) {
  const [choice, setChoice] = useState<ScheduleChoice>(() => scheduleChoice(task.cron));
  const cron = cronOfChoice(choice);
  return (
    <div className="recurring__control">
      <ScheduleFields choice={choice} setChoice={setChoice} disabled={disabled} reason={reason} />
      <button
        className="panel__button"
        type="button"
        disabled={disabled || cron === undefined || cron === task.cron}
        title={disabled ? reason : "Save the new schedule; one firing more often than every 5 minutes is refused"}
        onClick={(event) => {
          event.currentTarget.blur();
          if (cron !== undefined) {
            save({ cron });
          }
        }}
      >
        Save schedule
      </button>
    </div>
  );
}

/** The CEO's say over how often a pull request task checks. */
function IntervalControl({ task, disabled, reason, save }: { task: StandingTaskData; disabled: boolean; reason: string; save: (schedule: StandingSchedule) => void }) {
  const current = Math.round(task.intervalSeconds / 60);
  const [minutes, setMinutes] = useState(current);
  const offered = CHECK_MINUTES.includes(current) ? CHECK_MINUTES : [...CHECK_MINUTES, current].sort((a, b) => a - b);
  return (
    <div className="recurring__control">
      <select
        aria-label="How often it checks"
        disabled={disabled}
        title={disabled ? reason : "How often it looks for new pull requests"}
        value={minutes}
        onChange={(event) => setMinutes(Number(event.target.value))}
      >
        {offered.map((value) => (
          <option key={value} value={value}>
            {value === 60 ? "Every hour" : `Every ${value} min`}
          </option>
        ))}
      </select>
      <button
        className="panel__button"
        type="button"
        disabled={disabled || minutes === current}
        title={disabled ? reason : "Save how often it checks"}
        onClick={(event) => {
          event.currentTarget.blur();
          save({ intervalSeconds: minutes * 60 });
        }}
      >
        Save schedule
      </button>
    </div>
  );
}

/** One run: a line, and, opened, its result and log. */
function RunItem({ run }: { run: StandingRunView }) {
  const [open, setOpen] = useState(false);
  const outcome = isStandingOutcome(run.outcome) ? STANDING_OUTCOME_TEXT[run.outcome] : run.outcome;
  return (
    <li className="recurring__run">
      <button className="recurring__run-summary" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="recurring__run-time">{timeOf(run.endedAt)}</span>
        <span className={`recurring__outcome recurring__outcome--${run.outcome}`}>{outcome}</span>
        <span className="recurring__run-text">{run.summary}</span>
      </button>
      {open ? (
        <div className="recurring__run-detail">
          <p className="recurring__meta">
            {run.agent === "" ? "Looked at with no run" : `${run.agent}, ${took(run)}`} · {formatUsd(run.costUsd)}
            {run.url === "" ? null : (
              <>
                {" · "}
                <a href={run.url} target="_blank" rel="noreferrer noopener">
                  {run.commentId === undefined ? `PR #${run.pr?.number ?? ""} on GitHub` : "The review on GitHub"}
                </a>
              </>
            )}
          </p>
          {run.result === "" ? null : (
            <>
              <h4 className="recurring__label">Result</h4>
              <pre className="recurring__text">{run.result}</pre>
            </>
          )}
          <h4 className="recurring__label">Log</h4>
          <pre className="recurring__text recurring__log">{run.log === "" ? "Nothing was run, so there is no log." : run.log}</pre>
        </div>
      ) : null}
    </li>
  );
}

/** One task, opened: the CEO's controls, then its last runs. */
function TaskDetail({ task, runs, access, actions }: { task: StandingTaskData; runs: readonly StandingRunView[] | undefined; access: StandingAccess | undefined; actions: RecurringTasksActions }) {
  const [confirming, setConfirming] = useState(false);
  const disabled = access?.mayManage !== true;
  const reason = access?.reason ?? "";
  const save = (schedule: StandingSchedule) => actions.reschedule(task.id, schedule);
  return (
    <div className="recurring__detail">
      <div className="recurring__controls">
        {task.kind === STANDING_KIND.schedule ? (
          <CronControl task={task} disabled={disabled} reason={reason} save={save} />
        ) : (
          <IntervalControl task={task} disabled={disabled} reason={reason} save={save} />
        )}
        <button
          className={confirming ? "panel__button recurring__delete recurring__delete--confirm" : "panel__button recurring__delete"}
          type="button"
          disabled={disabled}
          title={disabled ? reason : "Delete the task; a run of it under way is stopped"}
          onClick={(event) => {
            event.currentTarget.blur();
            if (confirming) {
              actions.remove(task.id);
            }
            setConfirming(!confirming);
          }}
          onBlur={() => setConfirming(false)}
        >
          {confirming ? "Click again to delete" : "Delete"}
        </button>
      </div>
      {disabled && reason !== "" ? <p className="recurring__meta">{reason}</p> : null}
      <h3 className="recurring__label">Last runs</h3>
      {runs === undefined ? (
        <p className="board__empty">Loading its runs…</p>
      ) : runs.length === 0 ? (
        <p className="board__empty">No runs yet.</p>
      ) : (
        <ol className="recurring__runs">
          {runs.map((run) => (
            <RunItem run={run} key={run.id} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** The kinds a new task can be, in the order the form offers them. */
const NEW_KINDS: readonly StandingKind[] = [STANDING_KIND.schedule, STANDING_KIND.prSteward, STANDING_KIND.prReview];

/** The CEO's form for a new task: what it does, which agent runs it, and, for a scheduled job, the job and how often. */
function NewTaskForm({ access, agents, create }: { access: StandingAccess | undefined; agents: readonly BoardAgent[]; create: (task: StandingCreateMessage) => void }) {
  const [kind, setKind] = useState<StandingKind>(STANDING_KIND.schedule);
  const [instruction, setInstruction] = useState("");
  const [choice, setChoice] = useState<ScheduleChoice>({ kind: "weekdays", time: "09:00" });
  const [agentId, setAgentId] = useState("");
  const disabled = access?.mayManage !== true;
  const reason = access?.reason ?? "";
  const cron = cronOfChoice(choice);
  const ready = kind !== STANDING_KIND.schedule || (instruction.trim() !== "" && cron !== undefined);
  return (
    <form
      className="recurring__new"
      aria-label="New recurring task"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !ready) {
          return;
        }
        create({ kind, instruction: kind === STANDING_KIND.schedule ? instruction : "", cron: kind === STANDING_KIND.schedule ? (cron ?? "") : "", agentId });
        setInstruction("");
      }}
    >
      <h3 className="recurring__label">New recurring task</h3>
      <div className="recurring__control">
        <select aria-label="What it does" disabled={disabled} title={disabled ? reason : "What the task does"} value={kind} onChange={(event) => setKind(event.target.value as StandingKind)}>
          {NEW_KINDS.map((value) => (
            <option key={value} value={value}>
              {STANDING_KIND_TEXT[value]}
            </option>
          ))}
        </select>
        <select aria-label="Which agent" disabled={disabled} title={disabled ? reason : "The agent that runs it, alone"} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          <option value="">Any free agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.title === undefined || agent.title === "" ? agent.name : `${agent.name}, ${agent.title}`}
            </option>
          ))}
        </select>
      </div>
      {kind === STANDING_KIND.schedule ? (
        <>
          <input
            className="recurring__instruction"
            type="text"
            aria-label="What each run is to do"
            placeholder="Summarise what changed on main yesterday"
            maxLength={MAX_STANDING_INSTRUCTION_LENGTH}
            disabled={disabled}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
          <div className="recurring__control">
            <ScheduleFields choice={choice} setChoice={setChoice} disabled={disabled} reason={reason} />
          </div>
        </>
      ) : (
        <p className="recurring__meta">
          {kind === STANDING_KIND.prSteward
            ? "Reviews each new pull request once, resolves its conflicts, and merges it once every required check is green."
            : "Reviews each new pull request once, with a read-only comment."}{" "}
          The office holds one of these.
        </p>
      )}
      <div className="recurring__control">
        <button className="panel__button" type="submit" disabled={disabled || !ready} title={disabled ? reason : "Set the task up"}>
          Create
        </button>
        {disabled && reason !== "" ? <span className="recurring__meta">{reason}</span> : null}
      </div>
    </form>
  );
}

export function RecurringTasksPanel({ tasks, history, access, agentName, agents, actions }: RecurringTasksPanelProps) {
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const now = Date.now();
  const sorted = [...tasks].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const opened = sorted.find((task) => task.id === openId);
  const openedRunAt = opened?.lastRunAt;
  // The latest, so a new actions object on a repaint asks nothing again.
  const askHistory = useRef(actions.history);
  askHistory.current = actions.history;

  // Asked again whenever the opened task runs, so a run that ends while it is open shows.
  useEffect(() => {
    if (openId !== undefined) {
      askHistory.current(openId);
    }
  }, [openId, openedRunAt]);

  return (
    <section className="board recurring" aria-label="Recurring tasks">
      <header className="board__header">
        <h2 className="board__title">Recurring tasks</h2>
        <p className="board__status">{tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}</p>
      </header>
      {sorted.length === 0 ? (
        <p className="board__empty">
          No recurring tasks yet. Ask the AI Manager: “watch for new pull requests”, “every weekday at 9, summarise what changed yesterday”, or
          “hire someone to review, resolve conflicts and merge pull requests”.
        </p>
      ) : (
        <ul className="recurring__list">
          {sorted.map((task) => {
            const row = recurringRow(task, now, task.agentId === "" ? undefined : agentName(task.agentId));
            const open = task.id === openId;
            return (
              <li className={open ? "recurring__task recurring__task--open" : "recurring__task"} key={task.id}>
                <button className="recurring__summary" type="button" aria-expanded={open} onClick={() => setOpenId(open ? undefined : task.id)}>
                  <span className="recurring__name">{row.name}</span>
                  <span className={`recurring__status recurring__status--${row.tone}`}>{row.status}</span>
                  <span className="recurring__line">{row.schedule}</span>
                  <span className="recurring__line">{row.lastRun}</span>
                  {task.lastError === "" ? null : <span className="recurring__line recurring__line--error">{task.lastError}</span>}
                </button>
                {open ? <TaskDetail task={task} runs={history[task.id]} access={access} actions={actions} /> : null}
              </li>
            );
          })}
        </ul>
      )}
      <NewTaskForm access={access} agents={agents} create={actions.create} />
    </section>
  );
}
