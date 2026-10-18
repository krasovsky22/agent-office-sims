/**
 * Cron schedules for the office's scheduled standing tasks: the five-field
 * expression a task is defined by, when it next fires, and how it reads.
 *
 * The runner fires a scheduled task (`./standing.ts`) and the server checks
 * and describes one before it sends it, so both read the expression the same
 * way: here, once. A schedule is read on the runner's machine's own clock and
 * calendar, as `cron` reads one, since that is where it fires.
 *
 * Five fields, `minute hour day-of-month month day-of-week`, each `*`, a
 * number, a range `a-b`, a step `*\/n` or `a-b/n`, or a comma list of those;
 * day-of-week 0 to 7 with both 0 and 7 Sunday, and three-letter month and day
 * names. As in `cron`, when both day fields are restricted a day matching
 * either fires. Nothing else (`@daily`, `L`, `W`, seconds) is taken: a
 * schedule the office cannot say plainly is one the CEO cannot check.
 *
 * Each firing is a paid agent run, so a schedule that fires more often than
 * every {@link MIN_SCHEDULE_GAP_MINUTES} minutes is refused, as GitHub
 * Actions refuses one.
 */

/** Shortest gap between two firings a schedule may have. */
export const MIN_SCHEDULE_GAP_MINUTES = 5;

/** Longest expression taken; five fields of lists are far shorter. */
export const MAX_CRON_LENGTH = 64;

/** A parsed schedule: the values each field allows. */
export interface CronSchedule {
  /** As written, normalised to single spaces. */
  readonly expression: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 is Sunday; a 7 in the expression is read as 0. */
  readonly daysOfWeek: ReadonlySet<number>;
  /** Whether each day field was anything but `*`, which decides how the two combine. */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_WORDS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

interface FieldSpec {
  readonly min: number;
  readonly max: number;
  /** Names for the values from `min`, as `jan` is 1. */
  readonly names?: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 7, names: DAY_NAMES },
];

function value(raw: string, spec: FieldSpec): number | undefined {
  const named = spec.names?.indexOf(raw.toLowerCase()) ?? -1;
  if (named >= 0) {
    return named + spec.min;
  }
  if (!/^\d{1,2}$/.test(raw)) {
    return undefined;
  }
  const number = Number(raw);
  return number >= spec.min && number <= spec.max ? number : undefined;
}

/** One field's values, or `undefined` for one that is not a field. */
function field(raw: string, spec: FieldSpec): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : /^\d{1,2}$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) {
      return undefined;
    }
    let from: number | undefined;
    let to: number | undefined;
    if (range === "*") {
      from = spec.min;
      to = spec.max;
    } else {
      const [first = "", last] = range.split("-");
      from = value(first, spec);
      to = last === undefined ? (stepText === undefined ? from : spec.max) : value(last, spec);
    }
    if (from === undefined || to === undefined || from > to) {
      return undefined;
    }
    for (let at = from; at <= to; at += step) {
      values.add(at);
    }
  }
  return values;
}

/**
 * Reads a five-field cron expression.
 *
 * @returns the schedule, or `undefined` for anything that is not one, or one
 * that could never fire (the 31st of February).
 */
export function parseCron(raw: unknown): CronSchedule | undefined {
  if (typeof raw !== "string" || raw.length > MAX_CRON_LENGTH) {
    return undefined;
  }
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) {
    return undefined;
  }
  const sets: Set<number>[] = [];
  for (const [index, part] of parts.entries()) {
    const spec = FIELDS[index];
    const parsed = spec === undefined ? undefined : field(part, spec);
    if (parsed === undefined) {
      return undefined;
    }
    sets.push(parsed);
  }
  const [minutes, hours, daysOfMonth, months, rawDays] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  const daysOfWeek = new Set([...rawDays].map((day) => day % 7));
  const schedule: CronSchedule = {
    expression: parts.join(" "),
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: parts[2] !== "*",
    dayOfWeekRestricted: parts[4] !== "*",
  };
  return nextFire(schedule, new Date(2000, 0, 1)) === undefined ? undefined : schedule;
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const byMonth = schedule.daysOfMonth.has(date.getDate());
  const byWeek = schedule.daysOfWeek.has(date.getDay());
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) {
    return byMonth || byWeek;
  }
  return byMonth && byWeek;
}

/** Days searched for the next firing: past a leap year, so the 29th of February is found. */
const SEARCH_DAYS = 366 * 8;

/**
 * The first minute strictly after `after` the schedule fires, on the local
 * clock, or `undefined` when it never does.
 */
export function nextFire(schedule: CronSchedule, after: Date): Date | undefined {
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const hours = [...schedule.hours].sort((a, b) => a - b);
  const minutes = [...schedule.minutes].sort((a, b) => a - b);
  for (let searched = 0; searched < SEARCH_DAYS; searched += 1) {
    if (schedule.months.has(day.getMonth() + 1) && dayMatches(schedule, day)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
          // A clock change can skip or repeat an hour; only the minute itself matters.
          if (candidate.getTime() >= start.getTime() && candidate.getHours() === hour) {
            return candidate;
          }
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return undefined;
}

/**
 * The shortest gap, in minutes, between two firings within a day: the gap
 * between neighbouring minutes, and from an hour's last minute round to the
 * next hour's first when both hours fire.
 */
export function shortestGapMinutes(schedule: CronSchedule): number {
  const minutes = [...schedule.minutes].sort((a, b) => a - b);
  const hours = [...schedule.hours].sort((a, b) => a - b);
  let gap = Number.POSITIVE_INFINITY;
  for (let index = 1; index < minutes.length; index += 1) {
    gap = Math.min(gap, (minutes[index] ?? 0) - (minutes[index - 1] ?? 0));
  }
  const first = minutes[0] ?? 0;
  const last = minutes[minutes.length - 1] ?? 0;
  for (let index = 0; index < hours.length; index += 1) {
    const hour = hours[index] ?? 0;
    const next = hours[(index + 1) % hours.length] ?? 0;
    const hoursApart = (next - hour + 24) % 24 || 24;
    gap = Math.min(gap, hoursApart * 60 + first - last);
  }
  return gap;
}

/** Why a schedule may not be used, or `undefined` when it may. */
export function scheduleRefusal(raw: unknown): string | undefined {
  const schedule = parseCron(raw);
  if (schedule === undefined) {
    return "it is not a five-field cron schedule such as 0 9 * * 1-5";
  }
  if (shortestGapMinutes(schedule) < MIN_SCHEDULE_GAP_MINUTES) {
    return `it would fire more often than every ${MIN_SCHEDULE_GAP_MINUTES} minutes`;
  }
  return undefined;
}

function pad(number: number): string {
  return String(number).padStart(2, "0");
}

function only(set: ReadonlySet<number>): number | undefined {
  return set.size === 1 ? [...set][0] : undefined;
}

const WEEKDAYS = "1,2,3,4,5";

/**
 * A schedule in a few words, `every 30 min`, `weekdays 09:00`, `daily 17:30`
 * or `Mondays 09:00`, and its expression where no short form says it.
 */
export function describeCron(schedule: CronSchedule): string {
  const parts = schedule.expression.split(" ");
  const [minuteField = "", hourField = "", domField = "", monthField = ""] = parts;
  const everyDay = domField === "*" && monthField === "*";
  const step = /^\*\/(\d+)$/.exec(minuteField);
  if (step !== null && hourField === "*" && everyDay && !schedule.dayOfWeekRestricted) {
    return `every ${step[1]} min`;
  }
  const minute = only(schedule.minutes);
  if (minute !== undefined && hourField === "*" && everyDay && !schedule.dayOfWeekRestricted) {
    return minute === 0 ? "hourly" : `hourly at :${pad(minute)}`;
  }
  const hourStep = /^\*\/(\d+)$/.exec(hourField);
  if (minute !== undefined && hourStep !== null && everyDay && !schedule.dayOfWeekRestricted) {
    return `every ${hourStep[1]} h at :${pad(minute)}`;
  }
  const hour = only(schedule.hours);
  if (minute === undefined || hour === undefined || !everyDay) {
    return schedule.expression;
  }
  const time = `${pad(hour)}:${pad(minute)}`;
  if (!schedule.dayOfWeekRestricted) {
    return `daily ${time}`;
  }
  const days = [...schedule.daysOfWeek].sort((a, b) => a - b).join(",");
  if (days === WEEKDAYS) {
    return `weekdays ${time}`;
  }
  if (days === "0,6") {
    return `weekends ${time}`;
  }
  const day = only(schedule.daysOfWeek);
  if (day !== undefined) {
    return `${DAY_WORDS[day] ?? ""} ${time}`;
  }
  return schedule.expression;
}
