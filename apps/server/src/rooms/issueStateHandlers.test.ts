/**
 * Closing and reopening issues from the board: who is let through to GitHub,
 * what the sender is told for each outcome, and that one card cannot be sent
 * twice at once.
 */

import {
  type BoardIssue,
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  ISSUE_STATE_REJECTION,
  type IssueState,
  type IssueStateRejection,
  type IssueStateResultEvent,
  OfficeState,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  SERVER_MESSAGE,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { type IssueStateClient, type IssueStates, changeIssueState } from "./issueStateHandlers.js";

function issue(number: number, closedAt: number | null = null): BoardIssue {
  return { number, title: `Issue ${number}`, body: "", labels: [], assignees: [], pullRequests: [], closedAt };
}

const board: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  open: [issue(1)],
  closed: [issue(3, 1_000)],
  counts: { open: 1, inProgress: 0, pullRequests: 0 },
  repository: "acme/office",
  updatedAt: 1_000,
  stale: false,
};

function office(): OfficeState {
  const state = new OfficeState();
  for (const [id, role] of [
    ["ceo", PLAYER_ROLE.ceo],
    ["exec", PLAYER_ROLE.exec],
  ] as const) {
    const player = new HumanPlayer();
    player.id = id;
    player.name = id;
    player.role = role;
    state.occupants.set(id, player);
  }
  return state;
}

function tab(sessionId: string): IssueStateClient & { heard: IssueStateResultEvent[] } {
  const heard: IssueStateResultEvent[] = [];
  return {
    sessionId,
    heard,
    send: ((type: string, message: IssueStateResultEvent) => {
      if (type === SERVER_MESSAGE.issueStateResult) {
        heard.push(message);
      }
    }) as IssueStateClient["send"],
  };
}

/** A runner link stand-in: connected, and answering each change with `outcome`. */
function runner(
  outcome: () => Promise<IssueStateRejection | undefined> = async () => undefined,
  connected = true,
): IssueStates & { calls: [number, IssueState, string][] } {
  const calls: [number, IssueState, string][] = [];
  return {
    calls,
    canChangeIssues: () => connected,
    changeIssueState: (issueNumber, state, requestedBy) => {
      calls.push([issueNumber, state, requestedBy]);
      return outcome();
    },
  };
}

describe("changeIssueState", () => {
  it("closes an open issue for the CEO and says so", async () => {
    const issues = runner();
    const ceo = tab("ceo");
    await changeIssueState({ state: office(), board: () => board, issues }, new Set(), ceo, {
      issueNumber: 1,
      state: "closed",
    });
    expect(issues.calls).toEqual([[1, "closed", "ceo"]]);
    expect(ceo.heard).toEqual([{ issueNumber: 1, state: "closed" }]);
  });

  it("reopens a closed issue", async () => {
    const issues = runner();
    await changeIssueState({ state: office(), board: () => board, issues }, new Set(), tab("ceo"), {
      issueNumber: 3,
      state: "open",
    });
    expect(issues.calls).toEqual([[3, "open", "ceo"]]);
  });

  it("never asks GitHub for anyone but the CEO", async () => {
    const issues = runner();
    const exec = tab("exec");
    await changeIssueState({ state: office(), board: () => board, issues }, new Set(), exec, {
      issueNumber: 1,
      state: "closed",
    });
    expect(issues.calls).toEqual([]);
    expect(exec.heard).toEqual([{ issueNumber: 1, state: "closed", rejection: ISSUE_STATE_REJECTION.forbidden }]);
  });

  it("says no runner can make the change when none is configured or none that can is connected", async () => {
    for (const issues of [undefined, runner(undefined, false)]) {
      const ceo = tab("ceo");
      await changeIssueState({ state: office(), board: () => board, issues }, new Set(), ceo, {
        issueNumber: 1,
        state: "closed",
      });
      expect(ceo.heard[0]?.rejection).toBe(ISSUE_STATE_REJECTION.unavailable);
    }
  });

  it("refuses an issue already in that state without asking GitHub", async () => {
    const issues = runner();
    const ceo = tab("ceo");
    await changeIssueState({ state: office(), board: () => board, issues }, new Set(), ceo, {
      issueNumber: 3,
      state: "closed",
    });
    expect(issues.calls).toEqual([]);
    expect(ceo.heard[0]?.rejection).toBe(ISSUE_STATE_REJECTION.unknownIssue);
  });

  it("passes on what the runner said came of it", async () => {
    const refusedTab = tab("ceo");
    await changeIssueState(
      { state: office(), board: () => board, issues: runner(async () => ISSUE_STATE_REJECTION.refused) },
      new Set(),
      refusedTab,
      { issueNumber: 1, state: "closed" },
    );
    expect(refusedTab.heard[0]?.rejection).toBe(ISSUE_STATE_REJECTION.refused);

    const brokenTab = tab("ceo");
    await changeIssueState(
      { state: office(), board: () => board, issues: runner(() => Promise.reject(new Error("link broke"))) },
      new Set(),
      brokenTab,
      { issueNumber: 1, state: "closed" },
    );
    expect(brokenTab.heard[0]?.rejection).toBe(ISSUE_STATE_REJECTION.unreachable);
  });

  it("refuses a second change to a card while the first is out, and takes one after", async () => {
    let finish: (() => void) | undefined;
    const issues = runner(
      () =>
        new Promise<IssueStateRejection | undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const host = { state: office(), board: () => board, issues };
    const pending = new Set<number>();
    const ceo = tab("ceo");

    const first = changeIssueState(host, pending, ceo, { issueNumber: 1, state: "closed" });
    await changeIssueState(host, pending, ceo, { issueNumber: 1, state: "closed" });
    expect(ceo.heard).toEqual([{ issueNumber: 1, state: "closed", rejection: ISSUE_STATE_REJECTION.busy }]);

    finish?.();
    await first;
    expect(pending.size).toBe(0);
    expect(issues.calls).toHaveLength(1);
  });

  it("ignores a payload that does not parse and a sender who is not in the office", async () => {
    const issues = runner();
    const stranger = tab("nobody");
    const host = { state: office(), board: () => board, issues };
    await expect(changeIssueState(host, new Set(), tab("ceo"), { issueNumber: 1, state: "merged" })).resolves.toBeUndefined();
    await expect(changeIssueState(host, new Set(), stranger, { issueNumber: 1, state: "closed" })).resolves.toBeUndefined();
    expect(issues.calls).toEqual([]);
  });
});
