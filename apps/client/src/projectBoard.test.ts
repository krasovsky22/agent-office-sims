/**
 * The board's wording, which both the wall board and the close-up panel show:
 * which column a snapshot's items land in, what each row says about itself,
 * how the close-up's search and label filters narrow it, and how the status
 * line tells fresh from stale.
 */

import { type BoardIssue, EMPTY_BOARD_LISTS, type ProjectBoardSnapshot, WORK_ACTION, WORK_STATUS, type WorkData } from "@sim/shared";
import { describe, expect, it } from "vitest";

import {
  type BoardAgent,
  NO_BOARD_FILTER,
  boardColumns,
  boardDrop,
  boardIssue,
  boardLabels,
  boardStatus,
  filterBoardColumns,
  githubItemUrl,
  hasIssueMoveLanded,
  isFiltering,
  labelColours,
  workBadge,
  workMoveLabel,
  withIssueMoves,
} from "./projectBoard.js";

const time = (epochMs: number) => `t${epochMs}`;

const WAVE_1 = { name: "wave-1", color: "#0e8a16" };
const WAVE_2 = { name: "wave-2", color: "#fbca04" };
const WAVE_10 = { name: "wave-10", color: "" };
const CLIENT = { name: "client", color: "#1d76db" };

const SNAPSHOT: ProjectBoardSnapshot = {
  repository: "krasovsky22/agent-office-sims",
  updatedAt: 1000,
  stale: false,
  ...EMPTY_BOARD_LISTS,
  open: [
    {
      number: 31,
      title: "Desk screens face away",
      body: "They should face the chair.",
      labels: [WAVE_2, CLIENT],
      assignees: [],
      pullRequests: [],
      closedAt: null,
    },
  ],
  inProgress: [
    { number: 32, title: "Project board", body: "", labels: [WAVE_1], assignees: ["milo"], pullRequests: [40], closedAt: null },
  ],
  closed: [{ number: 2, title: "Floor plan", body: "", labels: [WAVE_10], assignees: [], pullRequests: [], closedAt: 500 }],
  pullRequests: [
    { number: 40, title: "Add the board", labels: [CLIENT, WAVE_1], author: "milo", draft: true, checks: "failing" },
  ],
  counts: { open: 5, inProgress: 1, pullRequests: 1 },
};

describe("boardColumns", () => {
  const columns = boardColumns(SNAPSHOT, time);

  it("lays out the four columns in the order work moves through them", () => {
    expect(columns.map((column) => column.key)).toEqual(["open", "inProgress", "closed", "pullRequests"]);
  });

  it("reports GitHub's totals, not just the rows the snapshot carries", () => {
    expect(columns[0]?.total).toBe(5);
    expect(columns[0]?.rows).toHaveLength(1);
  });

  it("names who is on an in-progress issue and the pull request working it", () => {
    expect(columns[1]?.rows[0]).toMatchObject({
      key: "issue-32",
      label: "#32",
      title: "Project board",
      detail: "@milo · PR #40",
      tone: "plain",
    });
  });

  it("carries each card's labels, issue and pull request alike", () => {
    expect(columns[0]?.rows[0]?.labels).toEqual([WAVE_2, CLIENT]);
    expect(columns[3]?.rows[0]?.labels).toEqual([CLIENT, WAVE_1]);
  });

  it("dates a closed issue", () => {
    expect(columns[2]?.rows[0]?.detail).toBe("closed t500");
  });

  it("shows a pull request's author, draft flag and checks", () => {
    expect(columns[3]?.rows[0]).toMatchObject({ detail: "@milo · draft · checks failing", tone: "bad" });
  });

  it("says nothing about checks it does not know", () => {
    const unknown = boardColumns(
      {
        ...SNAPSHOT,
        pullRequests: [{ number: 41, title: "x", labels: [], author: "dana", draft: false, checks: "unknown" }],
      },
      time,
    );
    expect(unknown[3]?.rows[0]?.detail).toBe("@dana");
  });
});

describe("filterBoardColumns", () => {
  const columns = boardColumns(SNAPSHOT, time);
  const keys = (filtered: ReturnType<typeof filterBoardColumns>) =>
    filtered.flatMap((column) => column.rows.map((row) => row.key));
  const filter = (query: string, ...labels: string[]) => ({ query, labels: new Set(labels) });

  it("lets everything through when nothing is asked for", () => {
    expect(isFiltering(NO_BOARD_FILTER)).toBe(false);
    expect(isFiltering(filter("   "))).toBe(false);
    expect(keys(filterBoardColumns(columns, NO_BOARD_FILTER))).toEqual(["issue-31", "issue-32", "issue-2", "pull-40"]);
  });

  it("searches titles, ignoring case", () => {
    expect(keys(filterBoardColumns(columns, filter("BOARD")))).toEqual(["issue-32", "pull-40"]);
  });

  it("searches numbers, labels, assignees and authors too", () => {
    expect(keys(filterBoardColumns(columns, filter("#31")))).toEqual(["issue-31"]);
    expect(keys(filterBoardColumns(columns, filter("wave-2")))).toEqual(["issue-31"]);
    expect(keys(filterBoardColumns(columns, filter("@milo")))).toEqual(["issue-32", "pull-40"]);
  });

  it("needs every word of the query, in any order", () => {
    expect(keys(filterBoardColumns(columns, filter("board add")))).toEqual(["pull-40"]);
    expect(keys(filterBoardColumns(columns, filter("board nowhere")))).toEqual([]);
  });

  it("needs every selected label, so a second label narrows", () => {
    expect(keys(filterBoardColumns(columns, filter("", "wave-1")))).toEqual(["issue-32", "pull-40"]);
    expect(keys(filterBoardColumns(columns, filter("", "wave-1", "client")))).toEqual(["pull-40"]);
  });

  it("combines a search with a label filter", () => {
    expect(keys(filterBoardColumns(columns, filter("project", "wave-1")))).toEqual(["issue-32"]);
  });

  it("keeps every column and its GitHub total, so an empty match still reads as a column", () => {
    const filtered = filterBoardColumns(columns, filter("", "wave-2"));
    expect(filtered.map((column) => [column.key, column.total, column.rows.length])).toEqual([
      ["open", 5, 1],
      ["inProgress", 1, 0],
      ["closed", 1, 0],
      ["pullRequests", 1, 0],
    ]);
  });
});

describe("boardLabels", () => {
  it("lists each label once, numbers sorted as numbers", () => {
    expect(boardLabels(SNAPSHOT).map((label) => label.name)).toEqual(["client", "wave-1", "wave-2", "wave-10"]);
  });

  it("keeps a selected label no card carries any more, so it can be turned off", () => {
    expect(boardLabels(SNAPSHOT, new Set(["wave-3", "client"])).map((label) => label.name)).toEqual([
      "client",
      "wave-1",
      "wave-2",
      "wave-3",
      "wave-10",
    ]);
  });
});

describe("labelColours", () => {
  it("puts dark text on a light label and light text on a dark one", () => {
    expect(labelColours(WAVE_2)).toEqual({ fill: "#fbca04", text: "#000000" });
    expect(labelColours({ name: "epic", color: "#3e1d6b" })).toEqual({ fill: "#3e1d6b", text: "#ffffff" });
  });

  it("gives a label with no usable colour a neutral fill", () => {
    expect(labelColours(WAVE_10).fill).toMatch(/^#[0-9a-f]{6}$/);
    expect(labelColours({ name: "x", color: "red" }).fill).toBe(labelColours(WAVE_10).fill);
  });
});

describe("boardStatus", () => {
  it("waits before the first snapshot arrives", () => {
    expect(boardStatus(undefined, time)).toEqual({ text: "Waiting for GitHub…", stale: false });
  });

  it("shows when a fresh snapshot was fetched", () => {
    expect(boardStatus(SNAPSHOT, time)).toEqual({ text: "Updated t1000", stale: false });
  });

  it("marks a stale snapshot as stale, keeping its time", () => {
    expect(boardStatus({ ...SNAPSHOT, stale: true }, time)).toEqual({
      text: "Stale — last updated t1000",
      stale: true,
    });
  });

  it("marks a board that has never had an answer as stale", () => {
    expect(boardStatus({ ...SNAPSHOT, updatedAt: null, stale: true }, time).stale).toBe(true);
  });
});

describe("githubItemUrl", () => {
  it("links issues and pull requests to their pages on GitHub", () => {
    const [open, , , pulls] = boardColumns(SNAPSHOT, time);
    expect(open?.rows[0]?.url).toBe("https://github.com/krasovsky22/agent-office-sims/issues/31");
    expect(pulls?.rows[0]?.url).toBe("https://github.com/krasovsky22/agent-office-sims/pull/40");
  });

  it("builds no link from a repository name that is not owner/name", () => {
    for (const repository of ["", "evil.com", "a/b/c", "//evil.com/x", "a/b?x", "a/b#x", "a b/c"]) {
      expect(githubItemUrl(repository, "issues", 1)).toBeNull();
    }
    expect(boardColumns({ ...SNAPSHOT, repository: "../x" }, time)[0]?.rows[0]?.url).toBeNull();
  });

  it("builds no link from a number that is not a positive integer", () => {
    expect(githubItemUrl("a/b", "pull", 0)).toBeNull();
    expect(githubItemUrl("a/b", "pull", 1.5)).toBeNull();
  });
});

describe("the office's work on an issue", () => {
  const ada: BoardAgent = { id: "agent-1", name: "Ada Byrne" };
  const work: WorkData = {
    issueNumber: 31,
    title: "Desk screens face away",
    status: WORK_STATUS.in_progress,
    assigneeId: ada.id,
    outputArtifact: "",
    note: "",
    assignedAt: 1,
    updatedAt: 1,
  };

  it("says who has it and how far they have got", () => {
    expect(workBadge(work, [ada])).toEqual({ text: "Ada Byrne · In progress", tone: "plain" });
    expect(workBadge({ ...work, status: WORK_STATUS.review }, [ada])).toEqual({
      text: "Ada Byrne · Waiting for review",
      tone: "pending",
    });
    expect(workBadge({ ...work, status: WORK_STATUS.done }, [ada]).tone).toBe("good");
    expect(workBadge(work, []).text).toBe("Left the office · In progress");
  });

  it("names each move for what it does to the work", () => {
    const review = { ...work, status: WORK_STATUS.review };
    expect(workMoveLabel({ action: WORK_ACTION.moveStatus, to: WORK_STATUS.done }, review)).toBe("Approve");
    expect(workMoveLabel({ action: WORK_ACTION.moveStatus, to: WORK_STATUS.in_progress }, review)).toBe(
      "Send back for rework",
    );
    expect(workMoveLabel({ action: WORK_ACTION.moveStatus, to: WORK_STATUS.assigned }, work)).toBe(
      "Have them start again",
    );
    expect(workMoveLabel({ action: WORK_ACTION.release }, work)).toBe("Unassign");
  });

  it("finds an issue in any column, and carries its number on its card", () => {
    expect(boardIssue(SNAPSHOT, 2)?.title).toBe("Floor plan");
    expect(boardIssue(SNAPSHOT, 99)).toBeUndefined();
    const [open, , , pulls] = boardColumns(SNAPSHOT, time);
    expect(open?.rows[0]?.issueNumber).toBe(31);
    expect(pulls?.rows[0]?.issueNumber).toBeNull();
  });
});

describe("boardDrop", () => {
  const ceo = { mayChangeState: true, mayAssign: true, hasWork: false };

  it("closes an open or in-progress issue dropped on Closed, and reopens a closed one dropped on Open", () => {
    expect(boardDrop("open", "closed", ceo)).toEqual({ kind: "state", state: "closed" });
    expect(boardDrop("inProgress", "closed", ceo)).toEqual({ kind: "state", state: "closed" });
    expect(boardDrop("closed", "open", ceo)).toEqual({ kind: "state", state: "open" });
  });

  it("asks who to give an open issue to when it is dropped on In progress", () => {
    expect(boardDrop("open", "inProgress", ceo)).toEqual({ kind: "assign" });
    expect(boardDrop("open", "inProgress", { ...ceo, hasWork: true })).toBeUndefined();
    expect(boardDrop("open", "inProgress", { ...ceo, mayAssign: false })).toBeUndefined();
  });

  it("takes nothing onto or from the pull requests, onto its own column, or anywhere else", () => {
    expect(boardDrop("open", "pullRequests", ceo)).toBeUndefined();
    expect(boardDrop("pullRequests", "closed", ceo)).toBeUndefined();
    expect(boardDrop("closed", "closed", ceo)).toBeUndefined();
    expect(boardDrop("closed", "inProgress", ceo)).toBeUndefined();
    expect(boardDrop("inProgress", "open", ceo)).toBeUndefined();
  });

  it("offers no state change to someone who may not make one", () => {
    const executive = { mayChangeState: false, mayAssign: false, hasWork: false };
    expect(boardDrop("open", "closed", executive)).toBeUndefined();
    expect(boardDrop("closed", "open", executive)).toBeUndefined();
    expect(boardDrop("open", "closed", { ...ceo, mayChangeState: false })).toBeUndefined();
  });
});

describe("withIssueMoves", () => {
  const issue = (number: number, extra: Partial<BoardIssue> = {}): BoardIssue => ({
    number,
    title: `Issue ${number}`,
    body: "",
    labels: [],
    assignees: [],
    pullRequests: [],
    closedAt: null,
    ...extra,
  });
  const board: ProjectBoardSnapshot = {
    ...EMPTY_BOARD_LISTS,
    repository: "acme/office",
    updatedAt: 1,
    stale: false,
    open: [issue(1), issue(5)],
    inProgress: [issue(2, { assignees: ["dana"] })],
    closed: [issue(3, { closedAt: 100 }), issue(4, { closedAt: 50, assignees: ["milo"] })],
    counts: { open: 2, inProgress: 1, pullRequests: 0 },
  };

  it("shows a closed card at the top of Closed and out of its column", () => {
    const moved = withIssueMoves(board, [{ issueNumber: 1, state: "closed" }], 900);
    expect(moved.open.map((entry) => entry.number)).toEqual([5]);
    expect(moved.closed[0]).toEqual(issue(1, { closedAt: 900 }));
    expect(moved.counts.open).toBe(1);

    const fromInProgress = withIssueMoves(board, [{ issueNumber: 2, state: "closed" }], 900);
    expect(fromInProgress.inProgress).toEqual([]);
    expect(fromInProgress.counts.inProgress).toBe(0);
  });

  it("puts a reopened card back among the open issues in number order, in progress if GitHub has someone on it", () => {
    const moved = withIssueMoves(board, [{ issueNumber: 3, state: "open" }], 900);
    expect(moved.open.map((entry) => entry.number)).toEqual([1, 3, 5]);
    expect(moved.open[1]?.closedAt).toBeNull();
    expect(moved.closed.map((entry) => entry.number)).toEqual([4]);
    expect(moved.counts.open).toBe(3);

    const assigned = withIssueMoves(board, [{ issueNumber: 4, state: "open" }], 900);
    expect(assigned.inProgress.map((entry) => entry.number)).toEqual([2, 4]);
  });

  it("changes nothing for a move the snapshot already reflects", () => {
    expect(withIssueMoves(board, [{ issueNumber: 3, state: "closed" }], 900)).toBe(board);
    expect(withIssueMoves(board, [{ issueNumber: 1, state: "open" }], 900)).toBe(board);
  });

  it("lands a settled move on a snapshot showing the issue where it was dropped", () => {
    const stale = { ...board, stale: true };
    expect(hasIssueMoveLanded(stale, { issueNumber: 3, state: "closed" }, 900)).toBe(true);
    expect(hasIssueMoveLanded(stale, { issueNumber: 1, state: "open" }, 900)).toBe(true);
    expect(hasIssueMoveLanded(stale, { issueNumber: 2, state: "open" }, 900)).toBe(true);
  });

  it("holds a settled move against a snapshot fetched before it, or a stale one", () => {
    const close = { issueNumber: 1, state: "closed" } as const;
    expect(hasIssueMoveLanded({ ...board, updatedAt: 800 }, close, 900)).toBe(false);
    expect(hasIssueMoveLanded({ ...board, updatedAt: 950, stale: true }, close, 900)).toBe(false);
    expect(hasIssueMoveLanded({ ...board, updatedAt: null }, close, 900)).toBe(false);
  });

  it("takes a fresh snapshot fetched after the move as GitHub's word, wherever it shows the issue", () => {
    expect(hasIssueMoveLanded({ ...board, updatedAt: 950 }, { issueNumber: 1, state: "closed" }, 900)).toBe(true);
  });
});
