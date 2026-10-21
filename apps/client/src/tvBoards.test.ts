/** The TV's boards: this week's sprint, today's runs and standup, and the office's status. */

import {
  type BoardIssue,
  EMPTY_BOARD_LISTS,
  LIVE_AGENT_STATUS,
  NO_STANDUP,
  type ProjectBoardSnapshot,
  WORK_STATUS,
  type WorkData,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import type { StandingTaskData } from "./standingAccess.js";
import { dailyBoard, sprintColumns, statusBoard } from "./tvBoards.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12);
const time = (epochMs: number) => `t${epochMs}`;
const names: Record<string, string> = { "agent-1": "Nadia" };
const nameOf = (id: string) => names[id];

function issue(number: number, extra: Partial<BoardIssue> = {}): BoardIssue {
  return { number, title: `Issue ${number}`, body: "", labels: [], assignees: [], pullRequests: [], closedAt: null, ...extra };
}

function work(issueNumber: number, status: WorkData["status"]): WorkData {
  return { issueNumber, title: "", status, assigneeId: "agent-1", outputArtifact: "", note: "", assignedAt: 0, updatedAt: 0 };
}

function snapshot(lists: Partial<ProjectBoardSnapshot>): ProjectBoardSnapshot {
  return { repository: "o/r", updatedAt: NOW, stale: false, ...EMPTY_BOARD_LISTS, ...lists };
}

const titles = (columns: ReturnType<typeof sprintColumns>) => columns.map((column) => [column.title, column.cards.map((card) => card.label)]);

describe("sprintColumns", () => {
  it("groups the week's issues into To do, In progress, In review and Done", () => {
    const board = snapshot({
      open: [issue(1, { updatedAt: NOW - DAY }), issue(2, { updatedAt: NOW - 30 * DAY }), issue(3, { updatedAt: NOW - 40 * DAY })],
      inProgress: [issue(4, { updatedAt: NOW - 2 * DAY, assignees: ["milo"] }), issue(5, { updatedAt: NOW - DAY, pullRequests: [50] })],
      closed: [issue(6, { closedAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY }), issue(7, { closedAt: NOW - 9 * DAY, updatedAt: NOW - 9 * DAY })],
    });
    // The office is on #3 now, however long ago it last changed on GitHub.
    const columns = sprintColumns(board, [work(3, WORK_STATUS.in_progress)], NOW, nameOf, time);
    expect(titles(columns)).toEqual([
      ["To do", ["#1"]],
      ["In progress", ["#3", "#4"]],
      ["In review", ["#5"]],
      ["Done", ["#6"]],
    ]);
    expect(columns[1]?.cards.map((card) => card.detail)).toEqual(["Nadia", "@milo"]);
    expect(columns[2]?.cards[0]?.detail).toBe("PR #50");
    expect(columns[3]?.cards[0]?.detail).toBe(`closed t${NOW - 3 * DAY}`);
  });

  it("puts work its agent has handed in for review in review, before any pull request shows", () => {
    const board = snapshot({ open: [issue(8, { updatedAt: NOW })] });
    expect(titles(sprintColumns(board, [work(8, WORK_STATUS.review)], NOW, nameOf, time))[2]).toEqual(["In review", ["#8"]]);
  });

  it("leaves out an issue GitHub gave no time for and nobody is working", () => {
    const board = snapshot({ open: [issue(9)] });
    expect(sprintColumns(board, [], NOW, nameOf, time).every((column) => column.cards.length === 0)).toBe(true);
  });
});

const TASK: StandingTaskData = {
  id: "t1",
  runnerId: "r1",
  kind: "schedule",
  name: "Nightly triage",
  status: "active",
  trigger: "every day at 09:00",
  cron: "0 9 * * *",
  intervalSeconds: 0,
  agentId: "",
  lastCheckAt: 0,
  nextCheckAt: 0,
  queued: 0,
  handledToday: 2,
  spentTodayUsd: 0.5,
  dailyUsd: 0,
  lastError: "",
  lastOutcome: "",
  lastRunAt: 0,
  lastRunPr: 0,
  runningAgentId: "",
};

describe("dailyBoard", () => {
  it("lists each recurring task's runs today, and says when one has not run today", () => {
    const board = dailyBoard(
      [TASK, { ...TASK, id: "t0", name: "Audit", handledToday: 1, lastRunAt: NOW - 60_000, lastRunPr: 12, lastOutcome: "merged" }],
      NO_STANDUP,
      NOW,
      nameOf,
      time,
    );
    expect(board.runs.map((card) => card.title)).toEqual(["Audit", "Nightly triage"]);
    expect(board.runs[0]?.detail).toMatch(new RegExp(`^1 run today · last at t${NOW - 60_000}: .* PR #12 · \\$0\\.50$`));
    expect(board.runs[1]?.detail).toBe("2 runs today · no run yet today · $0.50");
    expect(board.standupHeading).toBe("No standup held yet");
  });

  it("sums up the latest standup, an update a line, with its blockers", () => {
    const standup = {
      ...NO_STANDUP,
      calledBy: "Ada",
      startedAt: NOW - 3_600_000,
      endedAt: NOW - 3_000_000,
      updates: [
        { agentId: "a", agentName: "Nadia", workedOn: "The TV", blockers: "", needsYou: false, resolved: false, at: 0 },
        { agentId: "b", agentName: "Omar", workedOn: "Lifts", blockers: "Needs a key", needsYou: true, resolved: false, at: 0 },
      ],
    };
    const board = dailyBoard([], standup, NOW, nameOf, time);
    expect(board.standupHeading).toBe(`Last standup · t${NOW - 3_600_000} · called by Ada`);
    expect(board.standup.map((card) => [card.label, card.title, card.detail, card.tone])).toEqual([
      ["Nadia", "The TV", "No blockers", "good"],
      ["Omar", "Lifts", "Blocked: Needs a key", "bad"],
    ]);
  });
});

describe("statusBoard", () => {
  it("says whether the server, runners and GitHub are up, and each agent's state, task and spend", () => {
    const board = statusBoard(
      [
        { name: "Nadia", agentStatus: LIVE_AGENT_STATUS.working, caption: "#4 Lifts · Bash: pnpm test", agentSpentUsd: 1.25, fired: false },
        { name: "Ada", agentStatus: undefined, caption: "", agentSpentUsd: 0, fired: false },
      ],
      "connected",
      { runners: 1, spentUsd: 1.25, budgetUsd: 10, budgetSpent: false },
      snapshot({}),
      time,
    );
    expect(board.health.map((card) => [card.label, card.tone])).toEqual([
      ["Server", "good"],
      ["Runners", "good"],
      ["GitHub", "good"],
    ]);
    expect(board.health[1]?.title).toBe("1 runner connected");
    expect(board.agents).toEqual([{ label: "Nadia", title: "#4 Lifts · Bash: pnpm test", detail: "$1.25 today", tone: "pending" }]);
  });

  it("flags a lost connection, no runner, and a board GitHub has not filled", () => {
    const board = statusBoard([], "reconnecting", undefined, undefined, time);
    expect(board.health.map((card) => card.tone)).toEqual(["bad", "bad", "bad"]);
    expect(board.health[1]?.title).toBe("No agent runner connected");
  });
});
