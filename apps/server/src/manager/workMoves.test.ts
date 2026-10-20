/**
 * Carrying out a plan's moves on work in hand against a real office: each
 * goes through the work's rules as the CEO, as the board's would, and every
 * refusal comes back with its reason and leaves the work as it was.
 */

import {
  type BoardIssue,
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  IssueWork,
  LiveAgent,
  OCCUPANT_KIND,
  OfficeState,
  PLAYER_ROLE,
  type PlayerRole,
  type ProjectBoardSnapshot,
  WORK_ACTION,
  WORK_STATUS,
  type WorkStatus,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import type { WorkChange } from "../rooms/workHandlers.js";
import type { PlannedWorkMove, WorkMoveKind } from "./advisor.js";
import { readOfficeView } from "./officeView.js";
import { MAX_MOVES_PER_PLAN, carryOutMoves } from "./workMoves.js";

function issue(number: number, title: string): BoardIssue {
  return { number, title, body: "", labels: [], assignees: [], pullRequests: [], closedAt: null };
}

const SNAPSHOT: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  repository: "o/r",
  updatedAt: 1,
  stale: false,
  open: [issue(10, "Fix the login redirect loop"), issue(39, "Night shift")],
  pullRequests: [{ number: 46, title: "Show live agents", labels: [], author: "crew", draft: false, checks: "unknown" }],
  counts: { open: 2, inProgress: 0, pullRequests: 1 },
};

const BO = "agent:runner/1";

function player(id: string, name: string, role: PlayerRole): HumanPlayer {
  const occupant = new HumanPlayer();
  occupant.id = id;
  occupant.name = name;
  occupant.kind = OCCUPANT_KIND.human;
  occupant.role = role;
  return occupant;
}

/** Dana the CEO, Eli an executive, the coding agent Bo, and Bo's work on #39 as `status`. */
function office(status: WorkStatus, note = "", assigneeId = BO) {
  const state = new OfficeState();
  const ceo = player("session-dana", "Dana", PLAYER_ROLE.ceo);
  const exec = player("session-eli", "Eli", PLAYER_ROLE.exec);
  const bo = new LiveAgent();
  bo.id = BO;
  bo.name = "Bo";
  bo.canTakeIssues = true;
  for (const occupant of [ceo, exec, bo]) {
    state.occupants.set(occupant.id, occupant);
  }
  const work = new IssueWork();
  work.issueNumber = 39;
  work.title = "Night shift";
  work.status = status;
  work.assigneeId = assigneeId;
  work.note = note;
  work.outputArtifact = status === WORK_STATUS.review ? "PR #50" : "";
  state.work.set(workKey(39), work);

  const changes: WorkChange[] = [];
  const run = (moves: readonly PlannedWorkMove[], actor = ceo) =>
    carryOutMoves(moves, {
      work: { state, now: () => 100, board: () => SNAPSHOT, observe: (change) => changes.push(change) },
      ceo: actor,
      view: readOfficeView({ state, project: SNAPSHOT, liveAgents: undefined }),
    });
  return { state, exec, changes, run, work: () => state.work.get(workKey(39)) };
}

const on39 = (move: WorkMoveKind, note = ""): PlannedWorkMove => ({ move, work: "#39", note });

describe("carryOutMoves", () => {
  it("approves work waiting for review", () => {
    const { run, work } = office(WORK_STATUS.review);
    expect(run([on39("approve")])).toEqual(["✓ #39 “Night shift”: approved; Bo's work on it is done."]);
    expect(work()?.status).toBe(WORK_STATUS.done);
  });

  it("sends a review back for rework with the CEO's note for the agent", () => {
    const { run, work, changes } = office(WORK_STATUS.review);
    expect(run([on39("send-back", "the empty case fails")])).toEqual([
      "✓ #39 “Night shift”: sent back to Bo for rework, with your note.",
    ]);
    expect(work()?.status).toBe(WORK_STATUS.in_progress);
    expect(changes.map((change) => change.command)).toEqual([
      { action: WORK_ACTION.moveStatus, payload: { issueNumber: 39, status: WORK_STATUS.in_progress, reworkNote: "the empty case fails" } },
    ]);
  });

  it("takes work not yet handed in back off its agent", () => {
    const { run, work } = office(WORK_STATUS.in_progress);
    expect(run([on39("take-back")])).toEqual(["✓ #39 “Night shift”: taken off Bo; it is free on the board."]);
    expect(work()).toBeUndefined();
  });

  it("starts stopped work again by giving it to the same agent, as the card's Start again does", () => {
    const { run, work, changes } = office(WORK_STATUS.in_progress, "Stopped: the runner timed out.");
    expect(run([on39("start-again")])).toEqual(["✓ #39 “Night shift”: Bo is starting it again from the top."]);
    expect(work()).toMatchObject({ status: WORK_STATUS.assigned, note: "" });
    expect(changes[0]?.command.action).toBe(WORK_ACTION.assign);
  });

  it("starts work in progress again from assigned", () => {
    const { run, work, changes } = office(WORK_STATUS.in_progress);
    expect(run([on39("start-again")])).toEqual(["✓ #39 “Night shift”: Bo is starting it again from the top."]);
    expect(work()?.status).toBe(WORK_STATUS.assigned);
    expect(changes[0]?.command.action).toBe(WORK_ACTION.moveStatus);
  });

  it.each<[WorkMoveKind, WorkStatus, string]>([
    ["approve", WORK_STATUS.in_progress, "it isn't waiting for your review"],
    ["send-back", WORK_STATUS.assigned, "it isn't waiting for your review"],
    ["take-back", WORK_STATUS.review, "it is waiting for your review; approve it or send it back instead"],
    ["take-back", WORK_STATUS.done, "it is finished, and finished work keeps who did it"],
    ["start-again", WORK_STATUS.assigned, "it hasn't started yet, so there is nothing to start again"],
    ["start-again", WORK_STATUS.review, "it is waiting for your review; send it back instead"],
    ["approve", WORK_STATUS.done, "it is finished, and finished work keeps who did it"],
  ])("refuses to %s work that is %s, and changes nothing", (move, status, reason) => {
    const { run, work, changes } = office(status);
    expect(run([on39(move)])).toEqual([`✗ #39 “Night shift”: ${reason}.`]);
    expect(work()?.status).toBe(status);
    expect(changes).toEqual([]);
  });

  it("refuses to send back a review whose agent has left", () => {
    const { run, work } = office(WORK_STATUS.review, "", "agent:runner/gone");
    expect(run([on39("send-back")])).toEqual([
      "✗ #39 “Night shift”: the agent who handed it in has left the office; take it back and hand it to someone else.",
    ]);
    expect(work()?.status).toBe(WORK_STATUS.review);
  });

  it("makes no move for someone who is not the CEO", () => {
    const { run, work, exec } = office(WORK_STATUS.review);
    expect(run([on39("approve")], exec)).toEqual(["✗ #39 “Night shift”: only the CEO can do that."]);
    expect(work()?.status).toBe(WORK_STATUS.review);
  });

  it("says why when the work named is not there to move", () => {
    const { run } = office(WORK_STATUS.review);
    expect(
      run([
        { move: "approve", work: "#10", note: "" },
        { move: "approve", work: "PR #46", note: "" },
        { move: "approve", work: "#99", note: "" },
      ]),
    ).toEqual([
      "✗ #10 “Fix the login redirect loop”: nobody is working it.",
      "✗ PR #46 “Show live agents”: the office's work is on issues, and a pull request has none to change.",
      "✗ #99: I can't find that on the project board.",
    ]);
  });

  it("stops after the most moves one plan may make", () => {
    const { run } = office(WORK_STATUS.review);
    const lines = run(Array.from({ length: MAX_MOVES_PER_PLAN + 1 }, () => on39("approve")));
    expect(lines).toHaveLength(MAX_MOVES_PER_PLAN + 1);
    expect(lines.at(-1)).toBe(`I stopped after ${MAX_MOVES_PER_PLAN} changes; ask again for the rest.`);
  });
});
