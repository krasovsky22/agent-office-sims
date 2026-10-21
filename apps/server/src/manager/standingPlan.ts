/**
 * The AI Manager and standing tasks: what the CEO's words about them mean,
 * how a plan about them is carried out, and how they read.
 *
 * The rule planner (`./rulePlanner.ts`) understands a handful of shapes, by
 * a strict grammar, as it does assignments:
 *
 * - "watch for new pull requests", "review new pull requests": the pull
 *   request watch, which reviews each new one once.
 * - "review, resolve conflicts and merge new pull requests", "merge pull
 *   requests once their checks pass": the pull request steward, which reviews
 *   each new one once, resolves its conflicts and merges it once every
 *   required check is green.
 * - "every weekday at 9, summarise what changed", "every 30 minutes check the
 *   open issues for anything urgent", "summarise open PRs every day at 17:30",
 *   "schedule a job on cron 0 9 * * 1-5 to …": a scheduled job, its schedule
 *   read into cron by {@link readSchedule} on the runner's clock.
 * - "pause / resume the pull request watch", "stop watching pull requests",
 *   "remove the morning summary", "check the PR watch now": the CEO's buttons,
 *   by name.
 * - "what are you watching?", "what's scheduled?": the list.
 * - "run the morning summary every day at 8", "check pull requests every 10
 *   minutes": a new schedule for a task, as the wall board's control sets.
 * - "hire someone to review, resolve conflicts and merge pull requests",
 *   "hire someone to summarise what changed every weekday at 9": a standing
 *   hire (`./hire.ts`), read by {@link readStandingHire}.
 *
 * A model's plan names the same actions (`./modelPlanner.ts`). Either way a
 * plan is carried out by {@link carryOutStanding}, through
 * `../agents/standingControl.ts` and its one gate with the CEO as the actor,
 * and whatever it names is resolved against the office as it is then. A
 * scheduled job runs unattended with the agents' permissions, so one is only
 * set up from the CEO's own message, its schedule and instruction read from
 * it by {@link readSchedule}: never from a board's issue or pull request
 * title a model read and took for an order. A new schedule is read from the
 * CEO's own message the same way, and the steward, which pushes and merges
 * unattended, only when the CEO's own message asks for merging pull requests.
 */

import {
  type OfficeActor,
  STANDING_ACTION,
  STANDING_KIND,
  STANDING_OUTCOME_TEXT,
  STANDING_STATUS_TEXT,
  type StandingOutcome,
  type StandingStatus,
  type StandingTaskAction,
  type StandingSchedule,
  isStandingOutcome,
  isStandingStatus,
  parseCron,
  scheduleRefusal,
  standingSpendText,
} from "@sim/shared";

import type { StandingControl } from "../agents/standingControl.js";
import type { PlannedStanding, StandingRole } from "./advisor.js";
import type { OfficeView, StandingTaskView } from "./officeView.js";

/** Words that mean the pull request watch when a task is named. */
const PR_WATCH = /\b(pull requests?|prs?|pull request watch|pr watch|reviews?|reviewer)\b/;

/** "watch for new pull requests", "review every new PR", "keep an eye on incoming pull requests". */
const WATCH =
  /^(?:start |keep |begin )?(?:watch(?:ing)?|review(?:ing)?|monitor(?:ing)?|keep an eye on)(?: out)?(?: for)?(?: (?:all|any|every|each|the))?(?: new| incoming| open)? (?:pull requests?|prs?)(?: (?:as they come in|that come in|when they open|that are opened))?$/;

/** What may open a request for the steward: "review, resolve conflicts and merge…", "merge pull requests once…". */
const STEWARD_LEAD = /^(?:start |keep |begin |please )?(?:watch|review|monitor|merge|steward|look after|take care of|handle|resolve|auto-?merge)/;

/** The steward's words: what sets it apart from the watch is that it merges. */
const MERGES = /\b(?:merg(?:e|es|ing|er)|auto-?merge|stewards?)\b/;

/** Pull requests, by any name. */
const PULLS = /\b(?:pull requests?|prs?)\b/;

/** Whether the CEO's own message asks for pull requests to be merged: the only thing that may set the steward up. */
export function asksToMerge(message: string): boolean {
  const text = message.toLowerCase().replace(/\s+/g, " ");
  return MERGES.test(text) && PULLS.test(text);
}

/** "run the morning summary every day at 8", "change the PR watch to every 10 minutes", "check pull requests every 10 minutes". */
const RESCHEDULE =
  /^(?:reschedule|change|move|set|switch|make|have|run|check) (.+?) (?:to )?(?:(?:run|check|look|fire|go) )?((?:every|each|daily|hourly|on cron)\b.*)$/;

/** "hire", "we need to hire", "let's recruit", and what is hired up to the words that say what for. */
const HIRE_LEAD =
  /^(?:(?:please|so|ok|okay) )?(?:(?:we|i) (?:need|want|would like|'d like) to |let'?s |go ahead and )?(?:hire|recruit|bring in) (.*?)(?: (?:to|that will|who will|that'll|who'll|that can|who can|for)\b|$)/;

/** "stop watching pull requests", "stop reviewing PRs". */
const STOP_WATCHING = /^(?:stop|quit|cancel|end) (?:watching|reviewing|monitoring)(?: for)?(?: (?:new|incoming))? (?:pull requests?|prs?)$/;

const TASK_VERBS: ReadonlyArray<readonly [RegExp, StandingTaskAction]> = [
  [/^(?:pause|suspend|hold) (.+)$/, STANDING_ACTION.pause],
  [/^(?:resume|unpause|restart|continue) (.+)$/, STANDING_ACTION.resume],
  [/^(?:remove|delete|cancel|stop|drop|end) (.+)$/, STANDING_ACTION.remove],
  // "now" is filler the planner has already dropped, so "run the morning summary" is enough.
  [/^(?:check|run) (.+?)(?: now)?$/, STANDING_ACTION.checkNow],
];

/** "what are you watching?", "what's scheduled?", "list the standing tasks". */
const LIST =
  /\b(?:what (?:are|is) (?:you|anyone|everyone) watching|watching anything|what'?s scheduled|what is scheduled|standing tasks?|scheduled (?:jobs?|tasks?)|recurring (?:jobs?|tasks?))\b/;

/** What may open a scheduled job's request ahead of its schedule. */
const SCHEDULE_LEAD = /^(?:(?:schedule|set up|create|add|start|make)(?: a| an)?(?: new)?(?: recurring| scheduled| standing| regular| repeating)?(?: job| task)?(?: that runs| to run| running)? )?/;

const DAY_WORDS: Readonly<Record<string, string>> = {
  day: "*",
  days: "*",
  daily: "*",
  morning: "*",
  evening: "*",
  night: "*",
  weekday: "1-5",
  weekdays: "1-5",
  "work day": "1-5",
  workday: "1-5",
  weekend: "0,6",
  weekends: "0,6",
  sunday: "0",
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
};

const DAY_PATTERN = "(day|days|morning|evening|night|weekdays?|work ?day|weekends?|(?:sun|mon|tues|wednes|thurs|fri|satur)days?)";
const TIME_PATTERN = "(?:at )?(noon|midnight|\\d{1,2}(?::\\d{2})?(?: ?[ap]\\.?m\\.?)?)";

/** One way to say a schedule, read into cron from what it matched. */
interface SchedulePhrase {
  readonly pattern: RegExp;
  readonly cron: (match: RegExpExecArray) => string | undefined;
}

/** `9`, `9:30`, `9am`, `5 pm`, `17:30`, `noon` into `[minute, hour]`. */
function readTime(raw: string | undefined): readonly [number, number] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const text = raw.replace(/\./g, "").trim();
  if (text === "noon") {
    return [0, 12];
  }
  if (text === "midnight") {
    return [0, 0];
  }
  const match = /^(\d{1,2})(?::(\d{2}))? ?([ap]m)?$/.exec(text);
  if (match === null) {
    return undefined;
  }
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (match[3] === "pm" && hour < 12) {
    hour += 12;
  }
  if (match[3] === "am" && hour === 12) {
    hour = 0;
  }
  return hour <= 23 && minute <= 59 ? [minute, hour] : undefined;
}

function days(word: string | undefined): string | undefined {
  if (word === undefined) {
    return undefined;
  }
  const singular = word.replace(/s$/, "").replace(/^work ?day$/, "workday");
  return DAY_WORDS[word] ?? DAY_WORDS[singular];
}

const PHRASES: readonly SchedulePhrase[] = [
  { pattern: /^(?:on )?cron ((?:\S+ ){4}\S+)/, cron: (match) => match[1] },
  { pattern: /^every (\d{1,2}) ?(?:minutes|mins|min|m)\b/, cron: (match) => `*/${match[1]} * * * *` },
  { pattern: /^every (?:1 |one )?minute\b/, cron: () => "* * * * *" },
  { pattern: /^(?:every|each) (\d{1,2}) ?(?:hours|hrs|h)\b/, cron: (match) => `0 */${match[1]} * * *` },
  { pattern: /^(?:every|each) (?:1 |one )?hour\b|^hourly\b/, cron: () => "0 * * * *" },
  {
    pattern: new RegExp(`^(?:every|each|on) ${DAY_PATTERN} ${TIME_PATTERN}`),
    cron: (match) => {
      const time = readTime(match[2]);
      const dow = days(match[1]);
      return time === undefined || dow === undefined ? undefined : `${time[0]} ${time[1]} * * ${dow}`;
    },
  },
  {
    pattern: new RegExp(`^(?:daily|every day|each day) ${TIME_PATTERN}`),
    cron: (match) => {
      const time = readTime(match[1]);
      return time === undefined ? undefined : `${time[0]} ${time[1]} * * *`;
    },
  },
  {
    pattern: new RegExp(`^${TIME_PATTERN} (?:every|each|on) ${DAY_PATTERN}`),
    cron: (match) => {
      const time = readTime(match[1]);
      const dow = days(match[2]);
      return time === undefined || dow === undefined ? undefined : `${time[0]} ${time[1]} * * ${dow}`;
    },
  },
];

/**
 * How often, said whole: "every 10 minutes", "every weekday at 9", "hourly".
 *
 * @returns its cron, and its minutes when it is every so many minutes or
 * hours, as a pull request task counts them; `undefined` for words that are
 * not one.
 */
export function readEvery(text: string): { readonly cron: string; readonly minutes: number | undefined } | undefined {
  const found = scheduleAtStart(text.toLowerCase().replace(/’/g, "'").trim());
  if (found === undefined || found.rest.replace(/[\s.!?]+/g, "") !== "") {
    return undefined;
  }
  const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(found.cron)?.[1];
  const hours = /^0 \*\/(\d+) \* \* \*$/.exec(found.cron)?.[1];
  const every = minutes !== undefined ? Number(minutes) : hours !== undefined ? Number(hours) * 60 : found.cron === "0 * * * *" ? 60 : undefined;
  return { cron: found.cron, minutes: every };
}

/** The schedule a message ends with, read whole: "… every 10 minutes", "… to every weekday at 9". */
export function readEveryIn(message: string): { readonly cron: string; readonly minutes: number | undefined } | undefined {
  const text = ` ${message.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim()}`;
  for (const lead of [" every ", " each ", " daily", " hourly", " on cron "]) {
    for (let at = text.indexOf(lead); at >= 0; at = text.indexOf(lead, at + 1)) {
      const every = readEvery(text.slice(at + 1));
      if (every !== undefined) {
        return every;
      }
    }
  }
  return undefined;
}

/** A schedule phrase at the start of `text`: its cron, and the words after it. */
function scheduleAtStart(text: string): { readonly cron: string; readonly rest: string } | undefined {
  for (const phrase of PHRASES) {
    const match = phrase.pattern.exec(text);
    const cron = match === null ? undefined : phrase.cron(match);
    if (match !== null && cron !== undefined) {
      return { cron, rest: text.slice(match[0].length) };
    }
  }
  return undefined;
}

/** What is left of an instruction once the joining words around it are gone. */
function instructionOf(text: string): string {
  return text
    .replace(/^[\s,:;.-]+/, "")
    .replace(/^(?:to|and|then|please|have (?:an agent|someone|a coding agent))\s+/, "")
    .replace(/[\s,:;-]+$/, "")
    .trim();
}

/**
 * A scheduled job in the CEO's words: a schedule at the start ("every
 * weekday at 9, …", "schedule a job every 30 minutes to …") or at the end
 * ("… every day at 17:30"), and what to do.
 *
 * @returns the job, or `undefined` for words with no schedule in them; a
 * schedule with nothing to do is returned with an empty instruction.
 */
export function readSchedule(message: string): { readonly cron: string; readonly instruction: string } | undefined {
  const original = message.replace(/\s+/g, " ").trim();
  // Lower case keeps every character where it was, so a match in it is a match in the original too.
  const text = original.toLowerCase().replace(/’/g, "'");
  const lead = SCHEDULE_LEAD.exec(text)?.[0] ?? "";
  const start = scheduleAtStart(text.slice(lead.length));
  if (start !== undefined) {
    return { cron: start.cron, instruction: instructionOf(original.slice(original.length - start.rest.length)) };
  }
  for (let at = text.indexOf(" every "); at > 0; at = text.indexOf(" every ", at + 1)) {
    const end = scheduleAtStart(text.slice(at + 1));
    if (end !== undefined && end.rest.replace(/[\s.!?]+/g, "") === "") {
      const head = original.slice(0, at);
      return { cron: end.cron, instruction: instructionOf(head.slice(SCHEDULE_LEAD.exec(head.toLowerCase())?.[0].length ?? 0)) };
    }
  }
  return undefined;
}

/**
 * A scheduled job a standing hire is for, read from the CEO's words once the
 * hire's own are gone: "hire someone to summarise what changed every weekday
 * at 9" is "summarise what changed", every weekday at 9.
 */
export function readHireSchedule(message: string): { readonly cron: string; readonly instruction: string } | undefined {
  const original = message.replace(/\s+/g, " ").trim();
  const lead = HIRE_LEAD.exec(original.toLowerCase().replace(/’/g, "'"));
  if (lead === null) {
    return undefined;
  }
  const rest = original.slice(lead[0].length).replace(/^[\s,:;.-]+/, "");
  return rest === "" ? undefined : readSchedule(rest);
}

/**
 * A standing hire in the CEO's words, and who they asked for: "hire someone
 * to review, resolve conflicts and merge pull requests" is the steward, "hire
 * a reviewer for new PRs" the watch, and "hire someone to summarise what
 * changed every weekday at 9" a scheduled job. `undefined` for any other
 * message, a hire for an issue among them.
 */
export function readStandingHire(message: string): { readonly role: StandingRole; readonly who: string } | undefined {
  const text = message.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();
  const lead = HIRE_LEAD.exec(text);
  if (lead === null || /#\s?\d|\bissues?\b|\btickets?\b/.test(text)) {
    return undefined;
  }
  const who = (lead[1] ?? "").trim();
  if (readHireSchedule(message)?.instruction) {
    return { role: "schedule", who };
  }
  if (!PULLS.test(text)) {
    return undefined;
  }
  if (MERGES.test(text)) {
    return { role: "pr-steward", who };
  }
  return /\b(?:review|reviews|reviewing|reviewer|watch|watching|watcher|wait for)\b/.test(text) ? { role: "pr-review", who } : undefined;
}

/** What a message asks about standing tasks, if it is about them at all. */
export type StandingInstruction =
  | { readonly kind: "plan"; readonly standing: readonly PlannedStanding[] }
  | { readonly kind: "list" }
  /** A schedule with nothing to do, or a schedule that could not be. */
  | { readonly kind: "unclear"; readonly reply: string };

/** The task a few words name: the pull request watch, an id, or the one whose name has them all. */
export function resolveStandingTask(words: string, view: OfficeView): StandingTaskView | undefined {
  const said = words.toLowerCase().replace(/^(?:the|our|my) /, "").replace(/ (?:task|job|watch)$/, "").trim();
  const byId = view.standing.find((task) => task.id === said);
  if (byId !== undefined) {
    return byId;
  }
  if (PR_WATCH.test(said)) {
    const watch = view.standing.find((task) => task.kind === STANDING_KIND.prReview || task.kind === STANDING_KIND.prSteward);
    if (watch !== undefined) {
      return watch;
    }
  }
  const telling = said.split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !["the", "and", "job", "task", "scheduled"].includes(word));
  const named = view.standing.filter((task) => task.name.toLowerCase() === said || (telling.length > 0 && telling.every((word) => task.name.toLowerCase().includes(word))));
  if (named.length === 1) {
    return named[0];
  }
  if (/^(?:scheduled|recurring) (?:job|task)$|^schedule$/.test(said) || said === "") {
    const schedules = view.standing.filter((task) => task.kind === STANDING_KIND.schedule);
    return schedules.length === 1 ? schedules[0] : undefined;
  }
  return undefined;
}

/**
 * What a message asks about standing tasks, by the grammar above; `undefined`
 * for a message that is not about them, which the rest of the planner reads.
 *
 * @param words the message as the planner reads it: lower case, its lead-in,
 * a closing "?" and filler gone.
 */
export function readStandingInstruction(message: string, words: string, view: OfficeView): StandingInstruction | undefined {
  // A pull request named by its number is a move on it, not a standing task.
  if (STEWARD_LEAD.test(words) && MERGES.test(words) && PULLS.test(words) && !/#\s?\d|\b\d+\b/.test(words)) {
    return { kind: "plan", standing: [{ action: "steward-pull-requests" }] };
  }
  const reschedule = RESCHEDULE.exec(words);
  const renamed = reschedule?.[1]?.replace(/ to$/, "");
  if (reschedule !== null && renamed !== undefined && resolveStandingTask(renamed, view) !== undefined) {
    return readEveryIn(message) === undefined
      ? { kind: "unclear", reply: "How often should it run? Say it like “every 10 minutes” or “every weekday at 9”." }
      : { kind: "plan", standing: [{ action: "reschedule", task: renamed }] };
  }
  if (WATCH.test(words)) {
    return { kind: "plan", standing: [{ action: "watch-pull-requests" }] };
  }
  if (STOP_WATCHING.test(words)) {
    return { kind: "plan", standing: [{ action: STANDING_ACTION.remove, task: "pull requests" }] };
  }
  for (const [pattern, action] of TASK_VERBS) {
    const match = pattern.exec(words);
    const named = match?.[1];
    if (named !== undefined && resolveStandingTask(named, view) !== undefined) {
      return { kind: "plan", standing: [{ action, task: named }] };
    }
  }
  if (LIST.test(words)) {
    return { kind: "list" };
  }
  const schedule = readSchedule(message);
  if (schedule === undefined) {
    return undefined;
  }
  const why = scheduleRefusal(schedule.cron);
  if (why !== undefined) {
    return { kind: "unclear", reply: `I can't schedule that: ${why}. Say it like “every weekday at 9, summarise what changed yesterday”.` };
  }
  if (schedule.instruction === "") {
    return { kind: "unclear", reply: "What should the job do each time? Say it like “every weekday at 9, summarise what changed yesterday”." };
  }
  return { kind: "plan", standing: [{ action: "schedule", cron: parseCron(schedule.cron)?.expression ?? schedule.cron, instruction: schedule.instruction }] };
}

/** One standing task in a line: `“Watch for new pull requests” (every 2 min) · active; last: reviewed PR #112; $0.20 of $2.00 today`. */
function describeStandingTask(task: StandingTaskView): string {
  const status = isStandingStatus(task.status) ? STANDING_STATUS_TEXT[task.status as StandingStatus] : task.status;
  const parts = [`“${task.name}” (${task.trigger}) · ${status}`];
  if (task.agent !== undefined) {
    parts.push(`${task.agent} was hired for it`);
  }
  if (task.runningOn !== undefined) {
    parts.push(`${task.runningOn} is on it now`);
  }
  if (task.lastOutcome !== undefined) {
    const outcome = isStandingOutcome(task.lastOutcome) ? STANDING_OUTCOME_TEXT[task.lastOutcome as StandingOutcome] : task.lastOutcome;
    parts.push(`last: ${outcome}${task.lastRunPr === undefined ? "" : ` PR #${task.lastRunPr}`}`);
  }
  if (task.queued > 0) {
    parts.push(`${task.queued} waiting for a free coding agent`);
  }
  parts.push(standingSpendText(task.spentTodayUsd, task.dailyUsd));
  if (task.lastError !== undefined) {
    parts.push(`last error: ${task.lastError}`);
  }
  return parts.join("; ");
}

/** The answer to "what are you watching?". */
export function standingSummary(view: OfficeView): string {
  if (view.standing.length === 0) {
    return "No standing tasks yet. Say “watch for new pull requests”, “review, resolve conflicts and merge new pull requests”, or “every weekday at 9, summarise what changed yesterday”.";
  }
  return ["Standing tasks:", ...view.standing.map((task) => `- ${describeStandingTask(task)}`)].join("\n");
}

export interface StandingContext {
  /** The CEO's message the plan answers. */
  readonly message: string;
  /** Absent when no runner is configured. */
  readonly control: Pick<StandingControl, "create" | "act" | "reschedule"> | undefined;
  /** The CEO the manager is acting for. */
  readonly actor: OfficeActor;
  readonly ceoName: string;
  /** The office as it stands now. */
  readonly view: OfficeView;
}

/** A task's new schedule from the CEO's own words, or why there is none: a schedule's cron, or a pull request task's minutes. */
function scheduleFor(kind: string, message: string): StandingSchedule | string {
  const every = readEveryIn(message);
  if (kind === STANDING_KIND.schedule) {
    if (every === undefined) {
      return "I only change a scheduled job's schedule to one you say yourself, like “every weekday at 9”.";
    }
    const why = scheduleRefusal(every.cron);
    return why === undefined ? { cron: parseCron(every.cron)?.expression ?? every.cron } : `I can't schedule that: ${why}.`;
  }
  return every?.minutes === undefined
    ? "A pull request task checks every so many minutes; say it yourself, like “every 10 minutes”."
    : { intervalSeconds: every.minutes * 60 };
}

/** Most standing actions one plan may take, so a runaway model cannot churn every task. */
const MAX_STANDING_PER_PLAN = 4;

/**
 * Carries out each standing action, in order.
 *
 * @returns one line per action saying what happened, for the reply.
 */
export function carryOutStanding(actions: readonly PlannedStanding[], context: StandingContext): string[] {
  const { control } = context;
  if (control === undefined) {
    return actions.length === 0 ? [] : ["✗ No agent runner is configured, so there is nobody to give a standing task to."];
  }
  const lines: string[] = [];
  let scheduled = false;
  for (const action of actions.slice(0, MAX_STANDING_PER_PLAN)) {
    switch (action.action) {
      case "watch-pull-requests":
      case "steward-pull-requests": {
        if (action.action === "steward-pull-requests" && !asksToMerge(context.message)) {
          lines.push("✗ I only set up the pull request steward when you ask yourself for pull requests to be merged, like “review, resolve conflicts and merge new pull requests”.");
          break;
        }
        const kind = action.action === "watch-pull-requests" ? STANDING_KIND.prReview : STANDING_KIND.prSteward;
        const result = control.create(context.actor, context.ceoName, { kind }, "");
        lines.push(result.ok ? result.text : `✗ ${result.text}`);
        break;
      }
      case "reschedule": {
        const task = resolveStandingTask(action.task, context.view);
        if (task === undefined) {
          lines.push(`✗ I can't find a standing task called “${action.task}”.`);
          break;
        }
        const schedule = scheduleFor(task.kind, context.message);
        if (typeof schedule === "string") {
          lines.push(`✗ ${schedule}`);
          break;
        }
        const result = control.reschedule(context.actor, context.ceoName, task.id, schedule);
        lines.push(result.ok ? result.text : `✗ ${result.text}`);
        break;
      }
      case "schedule": {
        if (scheduled) {
          break;
        }
        scheduled = true;
        const asked = readSchedule(context.message);
        if (asked === undefined || asked.instruction === "") {
          lines.push("✗ I only set up a scheduled job when you ask for one yourself, with what it should do in your own words, like “every weekday at 9, summarise what changed yesterday”.");
          break;
        }
        const cron = parseCron(asked.cron)?.expression ?? asked.cron;
        const request = { kind: STANDING_KIND.schedule, cron, instruction: asked.instruction };
        const result = control.create(context.actor, context.ceoName, request, "");
        lines.push(result.ok ? result.text : `✗ ${result.text}`);
        break;
      }
      default: {
        const task = resolveStandingTask(action.task, context.view);
        if (task === undefined) {
          lines.push(`✗ I can't find a standing task called “${action.task}”.`);
          break;
        }
        const result = control.act(context.actor, context.ceoName, action.action, task.id);
        lines.push(result.ok ? result.text : `✗ ${result.text}`);
      }
    }
  }
  if (actions.length > MAX_STANDING_PER_PLAN) {
    lines.push(`I stopped after ${MAX_STANDING_PER_PLAN} standing task changes; ask again for the rest.`);
  }
  return lines;
}
