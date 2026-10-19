/**
 * The live coding agents: what an orchestrator reports about one, and where in
 * the office one may sit.
 *
 * A report arrives over HTTP from a process nobody in the office controls, so
 * it gets the same treatment a client message does — {@link parseLiveAgentReport}
 * proves the shape and sanitises every string before the server keeps any of it.
 * The server is the only reader, but the shape is the contract an orchestrator
 * is written against, and the label rules below are read by the client too, so
 * both live here.
 *
 * Which chairs an agent may take is world data like everything else in the
 * floor plan: it is derived from the layout rather than listed, so a desk added
 * to the open floor is a desk an agent can work at.
 */

import {
  type InteractableSpec,
  INTERACTION_KIND,
  OPEN_FLOOR_ROOM_ID,
  type OfficeLayout,
  interactables,
  roomAt,
} from "./layout.js";
import { sanitizeName, sanitizeTitle } from "./messages.js";
import { LIVE_AGENT_STATUS, type LiveAgentStatus, isLiveAgentOnTask } from "./state.js";

const LIVE_AGENT_KEY_PREFIX = "agent:";

/**
 * The occupant key a live agent is stored under.
 *
 * Prefixed so it can never collide with a session id — Colyseus mints those
 * from an alphabet without a colon — and so the holds registry, which is
 * keyed the same way, cannot confuse an agent with a player. Work keeps that key as its assignee after the agent has
 * left, which is how {@link isLiveAgentKey} still tells whose it was.
 */
export function liveAgentKey(id: string): string {
  return `${LIVE_AGENT_KEY_PREFIX}${id}`;
}

/** Whether an occupant key, present or long gone, is a live agent's. */
export function isLiveAgentKey(key: string): boolean {
  return key.startsWith(LIVE_AGENT_KEY_PREFIX);
}

/** What an orchestrator may report: one of the live states, or that the agent has gone. */
export const LIVE_AGENT_REPORT_STATUS = {
  ...LIVE_AGENT_STATUS,
  stopped: "stopped",
} as const;

export type LiveAgentReportStatus =
  (typeof LIVE_AGENT_REPORT_STATUS)[keyof typeof LIVE_AGENT_REPORT_STATUS];

/** The task a working agent has picked up. */
export interface LiveAgentTask {
  /** Sanitised to one line. Never empty. */
  readonly title: string;
  /** An `https:` issue or pull request URL, or `""` when the orchestrator did not say. */
  readonly url: string;
}

/**
 * One report about one agent.
 *
 * Every report is also a heartbeat: an agent the server has not heard about for
 * the configured interval is taken off the floor, so an orchestrator keeps one
 * in the office by repeating its current status.
 */
export interface LiveAgentReport {
  readonly id: string;
  /** Shown on the nameplate. Falls back to the id when the report names nobody. */
  readonly name: string;
  readonly status: LiveAgentReportStatus;
  /** Only ever present on a report of an agent on a task; any other status carries none. */
  readonly task: LiveAgentTask | undefined;
}

/**
 * What an agent id may look like.
 *
 * Narrow on purpose: the id becomes part of an occupant key, and an orchestrator
 * already names its agents with something like this.
 */
const LIVE_AGENT_ID = /^[A-Za-z0-9._-]{1,48}$/;

/** Longer than any issue or pull request URL, short enough to bound a report. */
export const MAX_TASK_URL_LENGTH = 300;

const REPORT_STATUSES: ReadonlySet<string> = new Set(Object.values(LIVE_AGENT_REPORT_STATUS));

function isReportStatus(value: unknown): value is LiveAgentReportStatus {
  return typeof value === "string" && REPORT_STATUSES.has(value);
}

/**
 * Validates a task URL, which the HUD renders as a link.
 *
 * Only `https:`, because a link is the one place report text is not inert: a
 * `javascript:` URL would run in whoever clicked it.
 *
 * @returns the URL as given, `""` for an absent one, or `undefined` for one that
 * is present and unacceptable.
 */
export function parseTaskUrl(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return "";
  }
  if (typeof raw !== "string" || raw.length > MAX_TASK_URL_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  return url.protocol === "https:" ? url.href : undefined;
}

/**
 * Validates a raw report.
 *
 * A `working` or `needs-input` report may omit its task or send it as `null` —
 * an orchestrator that knows an agent is busy but not on what still gets it a
 * seat. A task on any other status is ignored rather than rejected, since an
 * idle agent has nothing to show for one.
 *
 * @returns the report, or `undefined` if the payload is not one.
 */
export function parseLiveAgentReport(raw: unknown): LiveAgentReport | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as Record<string, unknown>;
  const { id, status } = candidate;
  if (typeof id !== "string" || !LIVE_AGENT_ID.test(id) || !isReportStatus(status)) {
    return undefined;
  }

  let task: LiveAgentTask | undefined;
  const rawTask = candidate["task"];
  const onTask = status !== LIVE_AGENT_REPORT_STATUS.stopped && isLiveAgentOnTask(status);
  if (onTask && rawTask !== undefined && rawTask !== null) {
    if (typeof rawTask !== "object") {
      return undefined;
    }
    const { title: rawTitle, url: rawUrl } = rawTask as Record<string, unknown>;
    const title = sanitizeTitle(rawTitle);
    const url = parseTaskUrl(rawUrl);
    if (title === "" || url === undefined) {
      return undefined;
    }
    task = { title, url };
  }

  const name = sanitizeName(candidate["name"]);
  return { id, name: name === "" ? sanitizeName(id) : name, status, task };
}

/** `owner/name/issues/12` or `owner/name/pull/12`, on GitHub. */
const GITHUB_ITEM_PATH = /^\/[^/]+\/[^/]+\/(issues|pull)\/(\d+)(?:[/?#]|$)/;

/**
 * A short handle for a task's link: `#33` for an issue, `PR #40` for a pull
 * request, `""` for anything else.
 *
 * A nameplate floats over a head across the office and has room for a title,
 * not a URL, so this is what stands in for the link there.
 */
export function taskReference(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.hostname !== "github.com") {
    return "";
  }
  const match = GITHUB_ITEM_PATH.exec(parsed.pathname);
  if (match === null) {
    return "";
  }
  return match[1] === "pull" ? `PR #${match[2] ?? ""}` : `#${match[2] ?? ""}`;
}

/**
 * What a slot lent to the CEO's desk does on the floor, instead of its
 * session's activity; the one activity an idle agent's line shows, since the
 * agent is taken though it holds no task.
 */
export const LENT_TO_DESK_ACTIVITY = "At the CEO's desk";

/**
 * The line under a live agent's name: what it is doing, as briefly as it reads.
 *
 * A working agent's task, then what it is doing about it; an agent that needs
 * input says so first, with what it is waiting on, since that is the one thing
 * on the line someone has to act on.
 */
export function describeLiveAgentTask(status: LiveAgentStatus, title: string, url: string, activity = ""): string {
  if (!isLiveAgentOnTask(status)) {
    return activity === LENT_TO_DESK_ACTIVITY ? activity : "idle";
  }
  const reference = taskReference(url);
  if (status === LIVE_AGENT_STATUS.needsInput) {
    const on = reference === "" ? title : reference;
    return `Needs you${on === "" ? "" : ` on ${on}`}${activity === "" ? "" : `: ${activity}`}`;
  }
  const task = [reference, title].filter((part) => part !== "").join(" ");
  const parts = [task, activity].filter((part) => part !== "");
  return parts.length === 0 ? "working" : parts.join(" · ");
}

const seatCache = new WeakMap<OfficeLayout, readonly InteractableSpec[]>();

/**
 * The chairs a working agent may take: every workstation seat on the open floor.
 *
 * Not the CEO's desk and not the meeting table — an agent at work sits where
 * the players do. Derived from the layout and cached per layout, as
 * the interactables themselves are.
 */
export function liveAgentSeats(layout: OfficeLayout): readonly InteractableSpec[] {
  const cached = seatCache.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  const seats = interactables(layout).filter(
    (spec) => spec.kind === INTERACTION_KIND.seat && roomAt(layout, spec.anchor)?.id === OPEN_FLOOR_ROOM_ID,
  );
  seatCache.set(layout, seats);
  return seats;
}
