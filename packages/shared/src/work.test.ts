/**
 * The work rules against the real schema: who may do what to an issue's work,
 * which moves are legal, what an agent's own steps require, and when GitHub's
 * word takes work off an agent.
 */

import { Encoder, MapSchema, Reflection } from "@colyseus/schema";
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
  AiManager,
  HumanPlayer,
  IssueWork,
  LiveAgent,
  type Occupant,
  OfficeState,
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
  isAgentRestricted,
  isIssueAssignee,
  mayActOnWork,
  mayAssignWork,
  releaseGoneWork,
  releaseWorkOf,
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
    const agent = new LiveAgent();
    agent.id = id;
    agent.name = id;
    agent.canTakeIssues = true;
    occupants.set(id, agent);
  }
  const manager = new AiManager();
  manager.id = "manager:ai";
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

  it("gives work only to an agent in the office that can take issues", () => {
    const at = office();
    for (const id of [CEO_ID, "manager:ai", "agent-99"]) {
      expect(run(at, assign(1, id))).toEqual({ ok: false, rejection: WORK_REJECTION.unknownAssignee });
    }
    expect(at.work.size).toBe(0);
    expect(run(at, assign(1, "agent-1"), CEO_ID, T0 + 5).ok).toBe(true);
    expect(at.work.get(workKey(1))).toMatchObject({
      issueNumber: 1,
      title: "Issue 1",
      status: WORK_STATUS.assigned,
      assigneeId: "agent-1",
      assignedAt: T0 + 5,
      updatedAt: T0 + 5,
    });
    expect(describeWorkProblems(at.work)).toEqual([]);
  });

  it("hands work to another agent without losing how far it got", () => {
    const at = office();
    const work = workAt(at, 1, WORK_STATUS.in_progress);
    work.note = "Blocked: CI is red";
    expect(run(at, assign(1, "agent-2"), CEO_ID, T0 + 5).ok).toBe(true);
    expect(work).toMatchObject({ status: WORK_STATUS.in_progress, assigneeId: "agent-2", note: "", updatedAt: T0 + 5 });
    expect(describeWorkProblems(at.work)).toEqual([]);
  });

  it("keeps a 255-byte title off the wire, where the schema would send it with length 0", () => {
    const at = office();
    const title = `${"word ".repeat(50)}tails`;
    at.board = snapshot({ open: [issue(1, title)] });
    expect(run(at, assign(1, "agent-1")).ok).toBe(true);

    const state = new OfficeState();
    at.work.forEach((work, key) => state.work.set(key, work));
    const encoder = new Encoder(state);
    const decoder = Reflection.decode<OfficeState>(Reflection.encode(encoder));
    decoder.decode(encoder.encodeAll());

    const sent = decoder.state.work.get(workKey(1));
    expect(sent).toMatchObject({ status: WORK_STATUS.assigned, assigneeId: "agent-1" });
    expect(sent?.title.endsWith("…")).toBe(true);
    expect(title.startsWith(sent?.title.slice(0, -1) ?? "")).toBe(true);
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

  it("releases work not yet handed in, and refuses to release a review in hand", () => {
    const at = office();
    workAt(at, 1, WORK_STATUS.assigned);
    workAt(at, 2, WORK_STATUS.in_progress);
    workAt(at, 3, WORK_STATUS.review);
    const release = (issueNumber: number): WorkCommand => ({ action: WORK_ACTION.release, payload: { issueNumber } });
    expect(run(at, release(1), EXEC_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(run(at, release(1)).ok).toBe(true);
    expect(at.work.has(workKey(1))).toBe(false);
    expect(run(at, release(2)).ok).toBe(true);
    expect(at.work.has(workKey(2))).toBe(false);
    expect(run(at, release(3))).toEqual({ ok: false, rejection: WORK_REJECTION.illegalTransition });
    expect(run(at, release(4))).toEqual({ ok: false, rejection: WORK_REJECTION.noWork });
  });

  it("cancels the CEO's way any work short of done, a review in hand included", () => {
    const at = office();
    workAt(at, 1, WORK_STATUS.assigned);
    workAt(at, 2, WORK_STATUS.in_progress);
    workAt(at, 3, WORK_STATUS.review);
    workAt(at, 4, WORK_STATUS.done);
    const cancel = (issueNumber: number): WorkCommand => ({ action: WORK_ACTION.cancel, payload: { issueNumber } });
    expect(run(at, cancel(1), EXEC_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(run(at, cancel(1), "agent-1")).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    for (const issueNumber of [1, 2, 3]) {
      expect(run(at, cancel(issueNumber)).ok).toBe(true);
      expect(at.work.has(workKey(issueNumber))).toBe(false);
    }
    expect(run(at, cancel(4))).toEqual({ ok: false, rejection: WORK_REJECTION.illegalTransition });
    expect(run(at, cancel(5))).toEqual({ ok: false, rejection: WORK_REJECTION.noWork });
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
      { action: WORK_ACTION.release },
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
    expect(describeWorkProblems(at.work)).toEqual([]);
    expect(releaseGoneWork(at.work, board, []).map((work) => work.issueNumber)).toEqual([1]);
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
    expect(releaseGoneWork(at.work, cut, [])).toEqual([]);
    expect(releaseGoneWork(at.work, snapshot(), []).map((work) => work.issueNumber)).toEqual([7]);
  });

  it("finds an open issue in either open list", () => {
    const board = snapshot();
    expect(openBoardIssue(board, 1)?.number).toBe(1);
    expect(openBoardIssue(board, 4)?.number).toBe(4);
    expect(openBoardIssue(board, 9)).toBeUndefined();
    expect(openBoardIssue(undefined, 1)).toBeUndefined();
  });
});

/** Puts a live coding agent on the floor, as the crew would. */
function liveAgent(at: Office, id: string, canTakeIssues: boolean): LiveAgent {
  const agent = new LiveAgent();
  agent.id = id;
  agent.name = id;
  agent.canTakeIssues = canTakeIssues;
  at.occupants.set(id, agent);
  return agent;
}

describe("a live agent", () => {
  const LIVE_ID = "agent:runner-1/slot-1";
  const claim: WorkCommand = { action: WORK_ACTION.claim, payload: { issueNumber: 1 } };
  const attach: WorkCommand = { action: WORK_ACTION.attachOutput, payload: { issueNumber: 1, artifact: "PR #40" } };
  const handIn: WorkCommand = { action: WORK_ACTION.handIn, payload: { issueNumber: 1 } };
  const note: WorkCommand = { action: WORK_ACTION.note, payload: { issueNumber: 1, text: "Blocked: CI is red" } };

  it("is an assignee only when it can take issues", () => {
    const at = office();
    const able = liveAgent(at, LIVE_ID, true);
    const unable = liveAgent(at, "agent:reporter", false);
    expect(isIssueAssignee(able)).toBe(true);
    expect(isIssueAssignee(actorOf(able))).toBe(true);
    expect(isIssueAssignee(unable)).toBe(false);
    expect(isIssueAssignee(actorOf(unable))).toBe(false);
  });

  it("can be given an issue, and claims, attaches, notes and hands in its own work", () => {
    const at = office();
    liveAgent(at, LIVE_ID, true);
    expect(run(at, assign(1, LIVE_ID)).ok).toBe(true);
    expect(at.work.get(workKey(1))).toMatchObject({ status: WORK_STATUS.assigned, assigneeId: LIVE_ID });

    expect(run(at, claim, "agent-1")).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(run(at, claim, LIVE_ID).ok).toBe(true);
    expect(run(at, note, LIVE_ID).ok).toBe(true);
    expect(at.work.get(workKey(1))?.note).toBe("Blocked: CI is red");
    expect(run(at, attach, LIVE_ID).ok).toBe(true);
    expect(run(at, handIn, LIVE_ID).ok).toBe(true);
    expect(at.work.get(workKey(1))).toMatchObject({ status: WORK_STATUS.review, outputArtifact: "PR #40", note: "" });
    expect(run(at, move(1, WORK_STATUS.done), LIVE_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(describeWorkProblems(at.work)).toEqual([]);
  });

  it("drops the note saying why it stopped once it claims the work again", () => {
    const at = office();
    liveAgent(at, LIVE_ID, true);
    const fresh = workAt(at, 1, WORK_STATUS.assigned, LIVE_ID);
    const stopped: WorkCommand = { action: WORK_ACTION.note, payload: { issueNumber: 1, text: "Stopped: the CEO asked for a fresh start" } };
    expect(run(at, stopped, LIVE_ID).ok).toBe(true);
    expect(fresh.note).toBe("Stopped: the CEO asked for a fresh start");
    expect(run(at, claim, LIVE_ID).ok).toBe(true);
    expect(fresh).toMatchObject({ status: WORK_STATUS.in_progress, note: "" });
  });

  it("that cannot take issues is neither given one nor allowed to act on one", () => {
    const at = office();
    liveAgent(at, LIVE_ID, false);
    expect(run(at, assign(1, LIVE_ID))).toEqual({ ok: false, rejection: WORK_REJECTION.unknownAssignee });
    expect(at.work.size).toBe(0);

    const held = workAt(at, 1, WORK_STATUS.assigned, LIVE_ID);
    for (const command of [claim, note]) {
      expect(run(at, command, LIVE_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    }
    held.status = WORK_STATUS.in_progress;
    for (const command of [attach, handIn]) {
      expect(run(at, command, LIVE_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    }
    expect(held).toMatchObject({ status: WORK_STATUS.in_progress, outputArtifact: "", note: "" });
  });

  it("ships its review when the issue closes, while everything else follows the old rule", () => {
    const at = office();
    liveAgent(at, LIVE_ID, true);
    const shippedReview = workAt(at, 1, WORK_STATUS.review, LIVE_ID);
    shippedReview.outputArtifact = "PR #40";
    shippedReview.note = "Waiting on CI";
    workAt(at, 2, WORK_STATUS.in_progress, LIVE_ID);
    workAt(at, 3, WORK_STATUS.review, "agent-1");
    workAt(at, 4, WORK_STATUS.done, LIVE_ID);
    const closedAt = T0 + 50;
    const board = snapshot({
      open: [],
      inProgress: [],
      closed: [1, 2, 3, 4].map((number) => ({ ...issue(number), closedAt })),
    });

    const shipped: IssueWork[] = [];
    const released = releaseGoneWork(at.work, board, shipped);
    expect(shipped).toEqual([shippedReview]);
    expect(shippedReview).toMatchObject({
      status: WORK_STATUS.done,
      assigneeId: LIVE_ID,
      outputArtifact: "PR #40",
      note: "",
      updatedAt: closedAt,
    });
    expect(released.map((work) => work.issueNumber).sort()).toEqual([2, 3]);
    expect([...at.work.keys()].sort()).toEqual(["1", "4"]);
    expect(describeWorkProblems(at.work)).toEqual([]);
  });

  it("still ships its review when it left the office before the issue closed", () => {
    const at = office();
    liveAgent(at, LIVE_ID, true);
    const review = workAt(at, 1, WORK_STATUS.review, LIVE_ID);
    review.outputArtifact = "PR #40";
    releaseWorkOf(LIVE_ID, at.work);
    at.occupants.delete(LIVE_ID);

    const shipped: IssueWork[] = [];
    const board = snapshot({ open: [], inProgress: [], closed: [{ ...issue(1), closedAt: T0 + 50 }] });
    expect(releaseGoneWork(at.work, board, shipped)).toEqual([]);
    expect(shipped).toEqual([review]);
    expect(at.work.get(workKey(1))).toMatchObject({ status: WORK_STATUS.done, assigneeId: LIVE_ID, outputArtifact: "PR #40" });
  });

  it("releases its review like anyone's when the issue only vanished from the board", () => {
    const at = office();
    liveAgent(at, LIVE_ID, true);
    workAt(at, 7, WORK_STATUS.review, LIVE_ID);
    const shipped: IssueWork[] = [];
    expect(releaseGoneWork(at.work, snapshot(), shipped).map((work) => work.issueNumber)).toEqual([7]);
    expect(shipped).toEqual([]);
  });

  it("puts down unfinished work when it leaves, and keeps a handed-in review with its deliverable", () => {
    const at = office();
    liveAgent(at, LIVE_ID, true);
    workAt(at, 1, WORK_STATUS.assigned, LIVE_ID);
    workAt(at, 2, WORK_STATUS.in_progress, LIVE_ID);
    const review = workAt(at, 3, WORK_STATUS.review, LIVE_ID);
    review.outputArtifact = "PR #41";
    workAt(at, 4, WORK_STATUS.in_progress, "agent-1");

    expect(releaseWorkOf(LIVE_ID, at.work)).toEqual([1, 2]);
    at.occupants.delete(LIVE_ID);
    expect([...at.work.keys()].sort()).toEqual(["3", "4"]);
    expect(review).toMatchObject({ status: WORK_STATUS.review, assigneeId: LIVE_ID, outputArtifact: "PR #41" });

    const ceo = at.occupants.get(CEO_ID);
    if (ceo === undefined) {
      throw new Error("missing fixture");
    }
    expect(workMoves(review, actorOf(ceo), (id) => at.occupants.has(id))).toEqual([
      { action: WORK_ACTION.moveStatus, to: WORK_STATUS.done },
      { action: WORK_ACTION.release },
    ]);
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

describe("work for a real coding agent", () => {
  function gated(at: Office, command: WorkCommand, actorId = CEO_ID, restrictLabel = "agent-restricted"): WorkCommandResult {
    const actor = at.occupants.get(actorId);
    if (actor === undefined) {
      throw new Error(`${actorId} is not in the office`);
    }
    return applyWorkCommand(command, {
      work: at.work,
      occupants: at.occupants,
      board: at.board,
      actor: actorOf(actor),
      now: T0 + 1,
      restrictLabel,
    });
  }

  function labelled(number: number, ...names: string[]): BoardIssue {
    return { ...issue(number), labels: names.map((name) => ({ name, color: "" })) };
  }

  it("takes the CEO, and only the CEO, to assign", () => {
    const at = office();
    at.board = snapshot({ open: [labelled(1, "client")] });
    expect(gated(at, assign(1, "agent-1"), EXEC_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(gated(at, assign(1, "agent-1")).ok).toBe(true);
  });

  it("refuses an issue carrying the restriction label, whatever its case, to hand out or hand on", () => {
    const at = office();
    at.board = snapshot({ open: [labelled(1, "client", "Agent-Restricted"), labelled(2)], inProgress: [] });
    expect(gated(at, assign(1, "agent-1"))).toEqual({ ok: false, rejection: WORK_REJECTION.restricted });
    expect(at.work.size).toBe(0);
    expect(gated(at, assign(2, "agent-1")).ok).toBe(true);
    // The label put on since: it may not go to another agent.
    at.board = snapshot({ open: [labelled(2, "agent-restricted")], inProgress: [] });
    expect(gated(at, assign(2, "agent-2"))).toEqual({ ok: false, rejection: WORK_REJECTION.restricted });
    expect(at.work.get(workKey(2))?.assigneeId).toBe("agent-1");
    // Off the board's listing, it cannot be checked, and is not said to carry the label.
    at.board = snapshot({ open: [], inProgress: [] });
    expect(gated(at, assign(2, "agent-2"))).toEqual({ ok: false, rejection: WORK_REJECTION.unknownIssue });
    expect(at.work.get(workKey(2))?.assigneeId).toBe("agent-1");
    // An office with no restriction label takes any open issue.
    at.board = snapshot({ open: [labelled(1, "agent-restricted")], inProgress: [] });
    expect(gated(at, assign(1, "agent-1"), CEO_ID, "").ok).toBe(true);
    expect(isAgentRestricted(labelled(5, "agent-restricted"), "")).toBe(false);
    expect(isAgentRestricted(labelled(5), "agent-restricted")).toBe(false);
    expect(isAgentRestricted(labelled(5, "AGENT-RESTRICTED"), "agent-restricted")).toBe(true);
  });

  it("takes the CEO, and only the CEO, to send a review back or start work again", () => {
    const at = office();
    workAt(at, 1, WORK_STATUS.review);
    workAt(at, 2, WORK_STATUS.in_progress);
    expect(gated(at, move(1, WORK_STATUS.in_progress), EXEC_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(gated(at, move(2, WORK_STATUS.assigned), EXEC_ID)).toEqual({ ok: false, rejection: WORK_REJECTION.forbidden });
    expect(gated(at, move(1, WORK_STATUS.in_progress)).ok).toBe(true);
    expect(gated(at, move(2, WORK_STATUS.assigned)).ok).toBe(true);
  });
});
