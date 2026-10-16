/**
 * The work rules against the real schema: who may do what to an issue's work,
 * which moves are legal, what an agent's own steps require, which issue an
 * agent picks up next, and when GitHub's word takes work off an agent.
 */

import { MapSchema } from "@colyseus/schema";
import { describe, expect, it } from "vitest";

import { MAX_WORK_NOTE_LENGTH } from "./constants.js";
import { parseWorkAssignMessage, parseWorkMoveMessage, parseWorkReleaseMessage } from "./messages.js";
import {
  type BoardIssue,
  EMPTY_BOARD_LISTS,
  type ProjectBoardSnapshot,
  isIssueGone,
  openBoardIssue,
} from "./projectBoard.js";
import {
  AgentEmployee,
  AiManager,
  HumanPlayer,
  IssueWork,
  type Occupant,
  PLAYER_ROLE,
  WORK_STATUS,
  type WorkStatus,
  workKey,
} from "./state.js";
import {
  WORK_ACTION,
  WORK_REJECTION,
  type WorkCommand,
  type WorkCommandResult,
  actorOf,
  applyWorkCommand,
  describeWorkProblems,
  mayActOnWork,
  mayAssignWork,
  releaseGoneWork,
  workForAgent,
  workMoves,
} from "./work.js";

const T0 = 1_700_000_000_000;
const CEO_ID = "session-ceo";
const EXEC_ID = "session-exec";

function issue(number: number, title = `Issue ${number}`): BoardIssue {
  return { number, title, body: `Body of ${number}`, labels: [], assignees: [], pullRequests: [], closedAt: null };
}

function snapshot(lists: Partial<ProjectBoardSnapshot> = {}): ProjectBoardSnapshot {
  const open = lists.open ?? [issue(1), issue(2), issue(3)];
  const inProgress = lists.inProgress ?? [issue(4)];
  return {
    ...EMPTY_BOARD_LISTS,
    repository: "acme/office",
    updatedAt: T0,
    stale: false,
    ...lists,
    open,
    inProgress,
    counts: lists.counts ?? { open: open.length, inProgress: inProgress.length, pullRequests: 0 },
  };
}

interface Office {
  readonly work: MapSchema<IssueWork>;
  readonly occupants: MapSchema<Occupant>;
  board: ProjectBoardSnapshot | undefined;
}

function office(): Office {
  const occupants = new MapSchema<Occupant>();
  for (const [id, role] of [
    [CEO_ID, PLAYER_ROLE.ceo],
    [EXEC_ID, PLAYER_ROLE.exec],
  ] as const) {
    const player = new HumanPlayer();
    player.id = id;
    player.name = id;
    player.role = role;
    occupants.set(id, player);
  }
  for (const id of ["agent-1", "agent-2"]) {
    const agent = new AgentEmployee();
    agent.id = id;
    agent.name = id;
    occupants.set(id, agent);
  }
  const manager = new AiManager();
  manager.id = "manager:firstmate";
  occupants.set(manager.id, manager);
  return { work: new MapSchema<IssueWork>(), occupants, board: snapshot() };
}

function run(at: Office, command: WorkCommand, actorId = CEO_ID, now = T0 + 1): WorkCommandResult {
  const actor = at.occupants.get(actorId);
  if (actor === undefined) {
    throw new Error(`${actorId} is not in the office`);
  }
  return applyWorkCommand(command, { work: at.work, occupants: at.occupants, board: at.board, actor: actorOf(actor), now });
}

function assign(issueNumber: number, assigneeId: string): WorkCommand {
  return { action: WORK_ACTION.assign, payload: { issueNumber, assigneeId } };
}

function move(issueNumber: number, status: WorkStatus): WorkCommand {
  return { action: WORK_ACTION.moveStatus, payload: { issueNumber, status } };
}

/** Puts work straight into a status, as the steps before it would have. */
function workAt(at: Office, issueNumber: number, status: WorkStatus, assigneeId = "agent-1"): IssueWork {
  const work = new IssueWork();
  work.issueNumber = issueNumber;
  work.title = `Issue ${issueNumber}`;
  work.status = status;
  work.assigneeId = assigneeId;
  work.assignedAt = T0;
  work.updatedAt = T0;
  at.work.set(workKey(issueNumber), work);
  return work;
}

describe("assigning an issue", () => {
  it("gives an open issue to an agent, copying its title", () => {
    const at = office();
    const result = run(at, assign(4, "agent-1"));
    expect(result.ok).toBe(true);
    const work = at.work.get(workKey(4));
    expect(work).toMatchObject({
      issueNumber: 4,
      title: "Issue 4",
      status: WORK_STATUS.assigned,
      assigneeId: "agent-1",
      assignedAt: T0 + 1,
    });
    expect(describeWorkProblems(at.work)).toEqual([]);
  });

  it("is the CEO's alone", () => {
    const at = office();
    expect(run(at, assign(1, "agent-1"), EXEC_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(run(at, assign(1, "agent-1"), "agent-1")).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(at.work.size).toBe(0);
  });

  it("refuses an issue the board does not show as open", () => {
    const at = office();
    at.board = snapshot({ closed: [{ ...issue(9), closedAt: T0 }] });
    for (const number of [9, 99]) {
      expect(run(at, assign(number, "agent-1"))).toEqual({ ok: false, rejection: WORK_REJECTION.unknownIssue });
    }
    at.board = undefined;
    expect(run(at, assign(1, "agent-1"))).toEqual({ ok: false, rejection: WORK_REJECTION.unknownIssue });
    expect(at.work.size).toBe(0);
  });

  it("only gives work to agent employees", () => {
    const at = office();
    for (const id of [CEO_ID, "manager:firstmate", "agent-99"]) {
      expect(run(at, assign(1, id))).toEqual({ ok: false, rejection: WORK_REJECTION.unknownAssignee });
    }
    expect(at.work.size).toBe(0);
  });

  it("hands work in hand to someone else without losing its progress", () => {
    const at = office();
    const work = workAt(at, 2, WORK_STATUS.in_progress);
    work.note = "Blocked: no answer";
    expect(run(at, assign(2, "agent-2")).ok).toBe(true);
    expect(work).toMatchObject({ status: WORK_STATUS.in_progress, assigneeId: "agent-2", note: "" });
  });

  it("does not reassign finished work", () => {
    const at = office();
    workAt(at, 2, WORK_STATUS.done);
    expect(run(at, assign(2, "agent-2"))).toEqual({ ok: false, rejection: WORK_REJECTION.illegalTransition });
    expect(at.work.get(workKey(2))?.assigneeId).toBe("agent-1");
  });
});

describe("moving and releasing work", () => {
  it("walks the work forward and back one step at a time", () => {
    const at = office();
    const work = workAt(at, 1, WORK_STATUS.review);
    work.outputArtifact = "done it";
    expect(run(at, move(1, WORK_STATUS.assigned))).toEqual({ ok: false, rejection: WORK_REJECTION.illegalTransition });
    expect(run(at, move(1, WORK_STATUS.in_progress)).ok).toBe(true);
    expect(run(at, move(1, WORK_STATUS.assigned)).ok).toBe(true);
    expect(run(at, move(1, WORK_STATUS.in_progress)).ok).toBe(true);
    expect(run(at, move(1, WORK_STATUS.review)).ok).toBe(true);
    expect(run(at, move(1, WORK_STATUS.done)).ok).toBe(true);
    expect(run(at, move(1, WORK_STATUS.review))).toEqual({ ok: false, rejection: WORK_REJECTION.illegalTransition });
  });

  it("clears a stuck agent's note when the CEO moves the work on", () => {
    const at = office();
    const work = workAt(at, 1, WORK_STATUS.in_progress);
    work.note = "Blocked: the model timed out";
    expect(run(at, move(1, WORK_STATUS.assigned)).ok).toBe(true);
    expect(work.note).toBe("");
  });

  it("releases work nobody has started, and refuses to release work in hand", () => {
    const at = office();
    workAt(at, 1, WORK_STATUS.assigned);
    workAt(at, 2, WORK_STATUS.in_progress);
    const release = (issueNumber: number): WorkCommand => ({ action: WORK_ACTION.release, payload: { issueNumber } });
    expect(run(at, release(1), EXEC_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(run(at, release(1)).ok).toBe(true);
    expect(at.work.has(workKey(1))).toBe(false);
    expect(run(at, release(2))).toEqual({ ok: false, rejection: WORK_REJECTION.illegalTransition });
    expect(run(at, release(3))).toEqual({ ok: false, rejection: WORK_REJECTION.noWork });
  });

  it("releases a review whose agent has left instead of sending it back to them", () => {
    const at = office();
    workAt(at, 1, WORK_STATUS.review, "agent-gone");
    expect(run(at, move(1, WORK_STATUS.in_progress))).toEqual({ ok: false, rejection: WORK_REJECTION.illegalTransition });
    const ceo = at.occupants.get(CEO_ID);
    const work = at.work.get(workKey(1));
    if (ceo === undefined || work === undefined) {
      throw new Error("missing fixture");
    }
    expect(workMoves(work, actorOf(ceo), (id) => at.occupants.has(id))).toEqual([
      { action: WORK_ACTION.moveStatus, to: WORK_STATUS.done },
      { action: WORK_ACTION.release },
    ]);
    expect(run(at, { action: WORK_ACTION.release, payload: { issueNumber: 1 } }).ok).toBe(true);
  });

  it("offers an executive no moves, and the CEO the legal ones", () => {
    const at = office();
    const work = workAt(at, 1, WORK_STATUS.in_progress);
    const ceo = at.occupants.get(CEO_ID);
    const exec = at.occupants.get(EXEC_ID);
    if (ceo === undefined || exec === undefined) {
      throw new Error("missing fixture");
    }
    const present = (id: string) => at.occupants.has(id);
    expect(workMoves(work, actorOf(exec), present)).toEqual([]);
    expect(workMoves(work, actorOf(ceo), present)).toEqual([
      { action: WORK_ACTION.moveStatus, to: WORK_STATUS.assigned },
      { action: WORK_ACTION.moveStatus, to: WORK_STATUS.review },
    ]);
    expect(mayAssignWork(actorOf(ceo))).toBe(true);
    expect(mayAssignWork(actorOf(exec))).toBe(false);
  });
});

describe("an agent's own steps", () => {
  it("claims, attaches and hands in only its own work, in order", () => {
    const at = office();
    workAt(at, 1, WORK_STATUS.assigned);
    const claim: WorkCommand = { action: WORK_ACTION.claim, payload: { issueNumber: 1 } };
    const handIn: WorkCommand = { action: WORK_ACTION.handIn, payload: { issueNumber: 1 } };
    const attach: WorkCommand = { action: WORK_ACTION.attachOutput, payload: { issueNumber: 1, artifact: "the work" } };

    expect(run(at, claim, "agent-2")).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(run(at, claim, CEO_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(run(at, attach, "agent-1")).toEqual({ ok: false, rejection: WORK_REJECTION.illegalTransition });
    expect(run(at, claim, "agent-1").ok).toBe(true);
    expect(run(at, handIn, "agent-1")).toEqual({ ok: false, rejection: WORK_REJECTION.missingArtifact });
    expect(
      run(at, { action: WORK_ACTION.attachOutput, payload: { issueNumber: 1, artifact: "  " } }, "agent-1"),
    ).toEqual({ ok: false, rejection: WORK_REJECTION.missingArtifact });
    expect(run(at, attach, "agent-1").ok).toBe(true);
    expect(run(at, handIn, "agent-1").ok).toBe(true);
    expect(at.work.get(workKey(1))).toMatchObject({ status: WORK_STATUS.review, outputArtifact: "the work" });
    // Approving is not the agent's.
    expect(run(at, move(1, WORK_STATUS.done), "agent-1")).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
  });

  it("says why it is stuck in one sanitized line", () => {
    const at = office();
    const work = workAt(at, 1, WORK_STATUS.in_progress);
    const text = `Blocked:\n${"x".repeat(MAX_WORK_NOTE_LENGTH * 2)}`;
    expect(run(at, { action: WORK_ACTION.note, payload: { issueNumber: 1, text } }, "agent-1").ok).toBe(true);
    expect(work.note.startsWith("Blocked: x")).toBe(true);
    expect(work.note.length).toBe(MAX_WORK_NOTE_LENGTH);
  });
});

describe("mayActOnWork", () => {
  it("never treats a player as the assignee, CEO included", () => {
    const at = office();
    const work = workAt(at, 1, WORK_STATUS.assigned, CEO_ID);
    const ceo = at.occupants.get(CEO_ID);
    if (ceo === undefined) {
      throw new Error("missing fixture");
    }
    expect(mayActOnWork({ actor: actorOf(ceo), action: WORK_ACTION.claim, work })).toBe(false);
  });
});

describe("workForAgent", () => {
  it("picks the longest-waiting work given to this agent and nobody else is holding", () => {
    const at = office();
    const newer = workAt(at, 1, WORK_STATUS.assigned);
    newer.assignedAt = T0 + 10;
    const older = workAt(at, 5, WORK_STATUS.in_progress);
    older.assignedAt = T0;
    workAt(at, 2, WORK_STATUS.review);
    workAt(at, 3, WORK_STATUS.assigned, "agent-2");
    const pick = () => workForAgent(at.work.values(), at.occupants.values(), "agent-1");
    expect(pick()?.issueNumber).toBe(5);

    const other = at.occupants.get("agent-2");
    if (other instanceof AgentEmployee) {
      other.currentIssueNumber = 5;
    }
    expect(pick()?.issueNumber).toBe(1);
  });
});

describe("releaseGoneWork", () => {
  it("releases unfinished work on an issue GitHub closed, and keeps finished work", () => {
    const at = office();
    workAt(at, 1, WORK_STATUS.in_progress);
    workAt(at, 2, WORK_STATUS.done);
    workAt(at, 3, WORK_STATUS.review);
    const board = snapshot({
      open: [issue(3, "Renamed")],
      inProgress: [],
      closed: [
        { ...issue(1), closedAt: T0 },
        { ...issue(2), closedAt: T0 },
      ],
    });
    expect(releaseGoneWork(at.work, board).map((work) => work.issueNumber)).toEqual([1]);
    expect([...at.work.keys()].sort()).toEqual(["2", "3"]);
    expect(at.work.get(workKey(3))?.title).toBe("Renamed");
  });

  it("takes an issue missing from a complete board as gone, but not from a cut or stale one", () => {
    const at = office();
    workAt(at, 7, WORK_STATUS.assigned);
    const cut = snapshot({ counts: { open: 50, inProgress: 1, pullRequests: 0 } });
    expect(isIssueGone(cut, 7)).toBe(false);
    expect(isIssueGone({ ...snapshot(), stale: true }, 7)).toBe(false);
    expect(isIssueGone({ ...snapshot(), updatedAt: null }, 7)).toBe(false);
    expect(releaseGoneWork(at.work, cut)).toEqual([]);
    expect(releaseGoneWork(at.work, snapshot()).map((work) => work.issueNumber)).toEqual([7]);
  });

  it("finds an open issue in either open list", () => {
    const board = snapshot();
    expect(openBoardIssue(board, 1)?.number).toBe(1);
    expect(openBoardIssue(board, 4)?.number).toBe(4);
    expect(openBoardIssue(board, 9)).toBeUndefined();
    expect(openBoardIssue(undefined, 1)).toBeUndefined();
  });
});

describe("work command parsers", () => {
  it("accepts a positive issue number and rejects anything else", () => {
    expect(parseWorkAssignMessage({ issueNumber: 12, assigneeId: "agent-1" })).toEqual({
      issueNumber: 12,
      assigneeId: "agent-1",
    });
    expect(parseWorkReleaseMessage({ issueNumber: 12 })).toEqual({ issueNumber: 12 });
    expect(parseWorkMoveMessage({ issueNumber: 12, status: WORK_STATUS.done })).toEqual({
      issueNumber: 12,
      status: WORK_STATUS.done,
    });
    for (const issueNumber of [0, -1, 1.5, "12", Number.NaN, 2 ** 40]) {
      expect(parseWorkReleaseMessage({ issueNumber })).toBeUndefined();
    }
    expect(parseWorkAssignMessage({ issueNumber: 12, assigneeId: "" })).toBeUndefined();
    expect(parseWorkMoveMessage({ issueNumber: 12, status: "backlog" })).toBeUndefined();
    expect(parseWorkMoveMessage(null)).toBeUndefined();
  });
});
