/**
 * What the conference room's TV boards say: the daily board, this week's
 * sprint board and the status board, worked out from what the HUD already
 * holds, so every tab paints the same board from the same state.
 *
 * Only words and grouping live here; `scene/tvScreen.ts` paints them. The
 * tickets channel is the project board itself, worded by `./projectBoard.ts`.
 */

import {
  LIVE_AGENT_STATUS,
  type BoardIssue,
  type ProjectBoardSnapshot,
  type RunnerSpendTotal,
  type StandupData,
  WORK_STATUS,
  type WorkData,
  formatUsd,
  isStandingOutcome,
  STANDING_OUTCOME_TEXT,
} from "@sim/shared";

import type { ConnectionStatus } from "./net/room.js";
import { type BoardTone, type TimeFormatter, withOfficeWork } from "./projectBoard.js";
import type { StandingTaskData } from "./standingAccess.js";
import { recurringRow } from "./standingAccess.js";
import { spendLine } from "./ui/spend.js";
import { statusLine } from "./ui/status.js";

/** One line on a TV board: a short label, the line itself, and what colours its detail. */
export interface TvCard {
  readonly label: string;
  readonly title: string;
  readonly detail: string;
  readonly tone: BoardTone;
}

export interface TvColumn {
  readonly title: string;
  readonly cards: readonly TvCard[];
}

/** How far back the sprint board looks. */
export const SPRINT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function issueCard(issue: BoardIssue, detail: string, tone: BoardTone = "plain"): TvCard {
  return { label: `#${issue.number}`, title: issue.title, detail, tone };
}

function whoOn(issue: BoardIssue, work: WorkData | undefined, agentName: (id: string) => string | undefined): string {
  const agent = work === undefined ? undefined : agentName(work.assigneeId);
  return [...(agent === undefined ? [] : [agent]), ...issue.assignees.map((login) => `@${login}`)].join(" · ");
}

/**
 * This week's work, as a sprint board groups it: the issues opened, worked on
 * or closed in the last {@link SPRINT_DAYS} days, in To do, In progress, In
 * review and Done. An issue the office is working right now counts however
 * long ago it last changed on GitHub; one in review has a pull request open
 * for it, or its agent's work is in review.
 *
 * shortcut: the snapshot carries at most `MAX_BOARD_ITEMS` issues a column and
 * only the last `MAX_CLOSED_ISSUES` closed ones, so a very busy week shows its
 * latest; upgrade by having the feed fetch the week's closed issues if Done
 * comes up short.
 */
export function sprintColumns(
  snapshot: ProjectBoardSnapshot,
  work: readonly WorkData[],
  now: number,
  agentName: (id: string) => string | undefined,
  formatDate: TimeFormatter,
): TvColumn[] {
  const since = now - SPRINT_DAYS * DAY_MS;
  const board = withOfficeWork(snapshot, work);
  const working = new Map(work.filter((entry) => entry.status !== WORK_STATUS.done).map((entry) => [entry.issueNumber, entry]));
  const thisWeek = (issue: BoardIssue) => (issue.updatedAt ?? 0) >= since || working.has(issue.number);

  const active = board.inProgress.filter(thisWeek);
  const inReview = (issue: BoardIssue) => issue.pullRequests.length > 0 || working.get(issue.number)?.status === WORK_STATUS.review;
  const prs = (issue: BoardIssue) => issue.pullRequests.map((number) => `PR #${number}`).join(" · ");
  return [
    { title: "To do", cards: board.open.filter(thisWeek).map((issue) => issueCard(issue, "")) },
    {
      title: "In progress",
      cards: active
        .filter((issue) => !inReview(issue))
        .map((issue) => issueCard(issue, whoOn(issue, working.get(issue.number), agentName), "pending")),
    },
    {
      title: "In review",
      cards: active.filter(inReview).map((issue) => {
        const who = whoOn(issue, working.get(issue.number), agentName);
        return issueCard(issue, [prs(issue), who].filter((part) => part !== "").join(" · "), "pending");
      }),
    },
    {
      title: "Done",
      cards: board.closed
        .filter((issue) => issue.closedAt !== null && issue.closedAt >= since)
        .map((issue) => issueCard(issue, `closed ${formatDate(issue.closedAt ?? now)}`, "good")),
    },
  ];
}

/** Whether two epoch-millisecond times fall on the same local day. */
function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** The daily board: today's runs of the recurring tasks, and the latest standup. */
export interface DailyBoard {
  readonly runs: readonly TvCard[];
  /** `Standup at 09:30 · called by Ada`, or why there is none. */
  readonly standupHeading: string;
  readonly standup: readonly TvCard[];
}

export function dailyBoard(
  tasks: readonly StandingTaskData[],
  standup: StandupData,
  now: number,
  agentName: (id: string) => string | undefined,
  formatTime: TimeFormatter,
): DailyBoard {
  const runs = [...tasks]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((task): TvCard => {
      const row = recurringRow(task, now, task.agentId === "" ? undefined : agentName(task.agentId));
      const ranToday = task.lastRunAt !== 0 && sameDay(task.lastRunAt, now);
      const outcome = isStandingOutcome(task.lastOutcome) ? STANDING_OUTCOME_TEXT[task.lastOutcome] : task.lastOutcome;
      const last = ranToday ? `last at ${formatTime(task.lastRunAt)}: ${outcome}${task.lastRunPr === 0 ? "" : ` PR #${task.lastRunPr}`}` : "no run yet today";
      const runsToday = `${task.handledToday} ${task.handledToday === 1 ? "run" : "runs"} today`;
      return {
        label: row.status,
        title: task.name,
        detail: `${runsToday} · ${last} · ${formatUsd(task.spentTodayUsd)}`,
        tone: row.tone,
      };
    });

  if (standup.startedAt === 0) {
    return { runs, standupHeading: "No standup held yet", standup: [] };
  }
  const when = sameDay(standup.startedAt, now) ? formatTime(standup.startedAt) : new Date(standup.startedAt).toLocaleString();
  const heading = `${standup.active ? "Standup now" : "Last standup"} · ${when}${standup.calledBy === "" ? "" : ` · called by ${standup.calledBy}`}`;
  return {
    runs,
    standupHeading: heading,
    standup: standup.updates.map((update) => ({
      label: update.agentName,
      title: update.workedOn === "" ? "No update" : update.workedOn,
      detail: update.blockers === "" ? "No blockers" : `Blocked: ${update.blockers}`,
      tone: update.blockers === "" ? "good" : update.needsYou && !update.resolved ? "bad" : "pending",
    })),
  };
}

/** One live agent on the status board, as the roster has it. */
export interface StatusAgent {
  readonly name: string;
  readonly agentStatus: string | undefined;
  /** Its status and task in words, the roster's own caption. */
  readonly caption: string;
  readonly agentSpentUsd: number;
  readonly fired: boolean;
}

const AGENT_TONE: Readonly<Record<string, BoardTone>> = {
  [LIVE_AGENT_STATUS.working]: "pending",
  [LIVE_AGENT_STATUS.needsInput]: "bad",
  [LIVE_AGENT_STATUS.idle]: "plain",
};

/** The status board: whether the office is up, then each live agent. */
export interface StatusBoard {
  readonly health: readonly TvCard[];
  readonly agents: readonly TvCard[];
}

export function statusBoard(
  agents: readonly StatusAgent[],
  connection: ConnectionStatus,
  spend: RunnerSpendTotal | undefined,
): StatusBoard {
  const runners = spend?.runners ?? 0;
  const books = spend === undefined || runners === 0 ? undefined : spendLine(spend);
  return {
    health: [
      { label: "Server", title: statusLine(connection, undefined), detail: "", tone: connection === "connected" ? "good" : "bad" },
      {
        label: "Runners",
        title: runners === 0 ? "No agent runner connected" : `${runners} ${runners === 1 ? "runner" : "runners"} connected`,
        detail: books?.text ?? "",
        tone: runners === 0 ? "bad" : books?.spent === true ? "bad" : "good",
      },
    ],
    agents: agents
      .filter((agent) => agent.agentStatus !== undefined)
      .map((agent) => ({
        label: agent.name,
        title: agent.caption,
        detail: `${formatUsd(agent.agentSpentUsd)} today`,
        tone: agent.fired ? "plain" : (AGENT_TONE[agent.agentStatus ?? ""] ?? "plain"),
      })),
  };
}
