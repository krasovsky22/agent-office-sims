/**
 * The AI Manager and standing tasks: what the CEO's words about them mean,
 * how a plan about them is carried out, and how they read.
 *
 * The rule planner (`./rulePlanner.ts`) understands a handful of shapes, by
 * a strict grammar, as it does assignments:
 *
 * - "watch for new pull requests", "review new pull requests": the pull
 *   request watch, which reviews each new one once.
 * - "every weekday at 9, summarise what changed", "every 30 minutes check the
 *   open issues for anything urgent", "summarise open PRs every day at 17:30",
 *   "schedule a job on cron 0 9 * * 1-5 to …": a scheduled job, its schedule
 *   read into cron by {@link readSchedule} on the runner's clock.
 * - "pause / resume the pull request watch", "stop watching pull requests",
 *   "remove the morning summary", "check the PR watch now": the CEO's buttons,
 *   by name.
 * - "what are you watching?", "what's scheduled?": the list.
 *
 * A model's plan names the same actions (`./modelPlanner.ts`). Either way a
 * plan is carried out by {@link carryOutStanding}, through
 * `../agents/standingControl.ts` and its one gate with the CEO as the actor,
 * and whatever it names is resolved against the office as it is then. A
 * scheduled job runs unattended with the agents' permissions, so one is only
 * set up from the CEO's own message, its schedule and instruction read from
 * it by {@link readSchedule}: never from a board's issue or pull request
 * title a model read and took for an order.
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
  formatUsd,
  isStandingOutcome,
  isStandingStatus,
  parseCron,
  scheduleRefusal,
} from "@sim/shared";

import type { StandingControl } from "../agents/standingControl.js";
import type { PlannedStanding } from "./advisor.js";
import type { OfficeView, StandingTaskView } from "./officeView.js";

/** Words that mean the pull request watch when a task is named. */
const PR_WATCH = /\b(pull requests?|prs?|pull request watch|pr watch|reviews?|reviewer)\b/;

/** "watch for new pull requests", "review every new PR", "keep an eye on incoming pull requests". */
const WATCH =
  /^(?:start |keep |begin )?(?:watch(?:ing)?|review(?:ing)?|monitor(?:ing)?|keep an eye on)(?: out)?(?: for)?(?: (?:all|any|every|each|the))?(?: new| incoming| open)? (?:pull requests?|prs?)(?: (?:as they come in|that come in|when they open|that are opened))?$/;

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
    const watch = view.standing.find((task) => task.kind === STANDING_KIND.prReview);
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
  return { kind: "plan", standing: [{ action: "schedule", cron: parseCron(schedule.cron)?.expression ?? schedule.cron, instruction: schedule.instruction, name: "" }] };
}

/** One standing task in a line: `“Watch for new pull requests” (every 2 min) · active; last: reviewed PR #112; $0.20 of $2.00 today`. */
export function describeStandingTask(task: StandingTaskView): string {
  const status = isStandingStatus(task.status) ? STANDING_STATUS_TEXT[task.status as StandingStatus] : task.status;
  const parts = [`“${task.name}” (${task.trigger}) · ${status}`];
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
  parts.push(`${formatUsd(task.spentTodayUsd)} of ${formatUsd(task.dailyUsd)} today`);
  if (task.lastError !== undefined) {
    parts.push(`last error: ${task.lastError}`);
  }
  return parts.join("; ");
}

/** The answer to "what are you watching?". */
export function standingSummary(view: OfficeView): string {
  if (view.standing.length === 0) {
    return "No standing tasks yet. Say “watch for new pull requests”, or “every weekday at 9, summarise what changed yesterday”.";
  }
  return ["Standing tasks:", ...view.standing.map((task) => `- ${describeStandingTask(task)}`)].join("\n");
}

export interface StandingContext {
  /** The CEO's message the plan answers. */
  readonly message: string;
  /** Absent when no runner is configured. */
  readonly control: Pick<StandingControl, "create" | "act"> | undefined;
  /** The CEO the manager is acting for. */
  readonly actor: OfficeActor;
  readonly ceoName: string;
  /** The office as it stands now. */
  readonly view: OfficeView;
}

/** Most standing actions one plan may take, so a runaway model cannot churn every task. */
export const MAX_STANDING_PER_PLAN = 4;

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
  for (const action of actions.slice(0, MAX_STANDING_PER_PLAN)) {
    switch (action.action) {
      case "watch-pull-requests": {
        const result = control.create(context.actor, context.ceoName, { kind: STANDING_KIND.prReview }, "");
        lines.push(result.ok ? result.text : `✗ ${result.text}`);
        break;
      }
      case "schedule": {
        const asked = readSchedule(context.message);
        if (asked === undefined || asked.instruction === "") {
          lines.push("✗ I only set up a scheduled job when you ask for one yourself, with what it should do in your own words, like “every weekday at 9, summarise what changed yesterday”.");
          break;
        }
        const cron = parseCron(asked.cron)?.expression ?? asked.cron;
        const request = { kind: STANDING_KIND.schedule, cron, instruction: asked.instruction, ...(action.name === "" ? {} : { name: action.name }) };
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
