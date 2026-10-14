/**
 * The board's wording, which both the wall board and the close-up panel show:
 * which column a snapshot's items land in, what each row says about itself,
 * and how the status line tells fresh from stale.
 */

import { EMPTY_BOARD_LISTS, type ProjectBoardSnapshot } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { boardColumns, boardStatus } from "./projectBoard.js";

const time = (epochMs: number) => `t${epochMs}`;

const SNAPSHOT: ProjectBoardSnapshot = {
  repository: "krasovsky22/agent-office-sims",
  updatedAt: 1000,
  stale: false,
  ...EMPTY_BOARD_LISTS,
  open: [{ number: 31, title: "Desk screens face away", assignees: [], pullRequests: [], closedAt: null }],
  inProgress: [{ number: 32, title: "Lobby board", assignees: ["milo"], pullRequests: [40], closedAt: null }],
  closed: [{ number: 2, title: "Floor plan", assignees: [], pullRequests: [], closedAt: 500 }],
  pullRequests: [{ number: 40, title: "Add the board", author: "milo", draft: true, checks: "failing" }],
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
    expect(columns[1]?.rows[0]).toEqual({
      key: "issue-32",
      label: "#32",
      title: "Lobby board",
      detail: "@milo · PR #40",
      tone: "plain",
    });
  });

  it("dates a closed issue", () => {
    expect(columns[2]?.rows[0]?.detail).toBe("closed t500");
  });

  it("shows a pull request's author, draft flag and checks", () => {
    expect(columns[3]?.rows[0]).toMatchObject({ detail: "@milo · draft · checks failing", tone: "bad" });
  });

  it("says nothing about checks it does not know", () => {
    const unknown = boardColumns(
      { ...SNAPSHOT, pullRequests: [{ number: 41, title: "x", author: "dana", draft: false, checks: "unknown" }] },
      time,
    );
    expect(unknown[3]?.rows[0]?.detail).toBe("@dana");
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
