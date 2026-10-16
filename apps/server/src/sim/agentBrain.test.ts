/**
 * The brain is tested the way the room runs it: real schema state on the
 * shipped floor plan, the real intent queue and body stepped by a 20Hz tick,
 * a project board of real-shaped issues, and the work's real rules — with the clock faked, so a cycle that takes
 * twenty seconds of walking and working runs in milliseconds. The work
 * executor is scripted, so each test decides when, and how, the work ends.
 */

import {
  AGENT_ACTIVITY,
  ANIMATION_STATE,
  type AgentEmployee,
  type BoardIssue,
  EMPTY_BOARD_LISTS,
  type IssueWork,
  OFFICE_LAYOUT,
  OfficeState,
  type ProjectBoardSnapshot,
  TICK_INTERVAL_MS,
  type Vec2,
  WORK_ACTION,
  WORK_STATUS,
  type WorkCommand,
  applyWorkCommand,
  deskStand,
  projectBoardStand,
  releaseGoneWork,
  workKey,
} from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkHost } from "../rooms/workHandlers.js";
import { WORK_FAILURE, type WorkBrief, type WorkContext, type WorkExecutor, type WorkResult } from "../work/executor.js";
import { AgentBrain, BRAIN_POLL_MS, SETTLE_POLL_MS } from "./agentBrain.js";
import { AgentMotion } from "./agentMotion.js";
import { hireAgentEmployees } from "./agents.js";
import { HoldRegistry, type InteractionHost } from "./interaction.js";
import { type OccupantMotion } from "./movement.js";

/** The CEO, as the work's rules judge one; the brain's commands are the agents'. */
const CEO = { id: "session-ceo", kind: "human", isCeo: true, isOperator: false } as const;

/** One work call the scripted executor is holding open. */
interface Call {
  readonly brief: WorkBrief;
  readonly context: WorkContext;
  readonly signal: AbortSignal | undefined;
  readonly finish: (result: WorkResult) => void;
}

function scriptedExecutor(): { readonly executor: WorkExecutor; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    executor: {
      work: (brief, context, signal) =>
        new Promise<WorkResult>((finish) => {
          calls.push({ brief, context, signal, finish });
        }),
    },
  };
}

function success(artifact: string): WorkResult {
  return { ok: true, artifact, summary: "A deliverable", tokensUsed: 0, attempts: 1 };
}

function failure(message: string): WorkResult {
  return {
    ok: false,
    reason: WORK_FAILURE.budgetExhausted,
    message,
    tokensUsed: 0,
    attempts: 0,
    retryAt: undefined,
  };
}

interface Office {
  readonly state: OfficeState;
  readonly agents: AgentEmployee[];
  readonly brains: AgentBrain[];
  readonly calls: Call[];
  readonly ticks: () => number;
  /** Runs a command as the CEO. */
  readonly ceo: (command: WorkCommand) => void;
  /** The office's work on an issue, which must exist. */
  readonly work: (issueNumber: number) => IssueWork;
  /** Closes an issue on GitHub, as a fresh poll would report it. */
  readonly closeIssue: (issueNumber: number) => void;
  /** Stops the tick, as a closing room does. */
  readonly closeTick: () => void;
}

let logged: string[];

beforeEach(() => {
  vi.useFakeTimers();
  logged = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function issue(number: number): BoardIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: `What issue ${number} asks for.`,
    labels: [],
    assignees: [],
    pullRequests: [],
    closedAt: null,
  };
}

/** A fresh board with issues 1 to 5 open. */
function boardOf(open: readonly BoardIssue[], closed: readonly BoardIssue[] = []): ProjectBoardSnapshot {
  return {
    ...EMPTY_BOARD_LISTS,
    open,
    closed,
    counts: { open: open.length, inProgress: 0, pullRequests: 0 },
    repository: "acme/office",
    updatedAt: Date.now(),
    stale: false,
  };
}

/** A room's worth of agents with brains, a project board, and a running tick. */
function openOffice(agentCount = 1): Office {
  const state = new OfficeState();
  const agents = hireAgentEmployees(state.occupants, OFFICE_LAYOUT, agentCount);
  const interaction: InteractionHost = {
    layout: OFFICE_LAYOUT,
    occupants: state.occupants,
    motions: new Map<string, OccupantMotion>(),
    holds: new HoldRegistry(),
    lastUsedAt: new Map(),
  };
  const motion = new AgentMotion(interaction);
  let board = boardOf([1, 2, 3, 4, 5].map(issue));
  const work: WorkHost = { state, now: () => Date.now(), board: () => board };

  let now = 0;
  let ticks = 0;
  const tick = setInterval(() => {
    now += TICK_INTERVAL_MS;
    ticks += 1;
    motion.step(now);
  }, TICK_INTERVAL_MS);

  const { executor, calls } = scriptedExecutor();
  const host = { work, layout: OFFICE_LAYOUT, motion, executor, clockNow: () => now };
  const brains = agents.map((agent) => new AgentBrain(host, agent.id));
  brains.forEach((brain) => brain.start());

  return {
    state,
    agents,
    brains,
    calls,
    ticks: () => ticks,
    ceo: (command) => {
      const result = applyWorkCommand(command, {
        work: state.work,
        occupants: state.occupants,
        board,
        actor: CEO,
        now: Date.now(),
      });
      expect(result.ok, command.action).toBe(true);
    },
    work: (issueNumber) => {
      const entry = state.work.get(workKey(issueNumber));
      if (entry === undefined) {
        throw new Error(`no work on #${issueNumber}`);
      }
      return entry;
    },
    closeIssue: (issueNumber) => {
      board = boardOf(
        board.open.filter((candidate) => candidate.number !== issueNumber),
        [{ ...issue(issueNumber), body: "", closedAt: Date.now() }],
      );
      releaseGoneWork(state.work, board, []);
    },
    closeTick: () => clearInterval(tick),
  };
}

function agentAt(office: Office, index: number): AgentEmployee {
  const agent = office.agents[index];
  if (agent === undefined) {
    throw new Error(`no agent ${index}`);
  }
  return agent;
}

function assign(office: Office, issueNumber: number, agent: AgentEmployee): void {
  office.ceo({ action: WORK_ACTION.assign, payload: { issueNumber, assigneeId: agent.id } });
}

/** Lets the clock run, a tick at a time, until `ready` holds. */
async function until(ready: () => boolean, limitMs = 60_000): Promise<void> {
  for (let waited = 0; !ready(); waited += TICK_INTERVAL_MS) {
    if (waited > limitMs) {
      throw new Error("the office never got there");
    }
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
  }
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe("a full cycle", () => {
  it("claims, works at the desk, carries the work to the board, and goes home", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    const home = deskStand(OFFICE_LAYOUT, ada.deskId);
    const board = projectBoardStand(OFFICE_LAYOUT);
    if (home === undefined || board === undefined) {
      throw new Error("the layout has no desk or no board for Ada");
    }

    assign(office, 1, ada);
    await until(() => office.work(1).status === WORK_STATUS.in_progress);
    expect(ada.currentIssueNumber).toBe(1);

    // At the desk, seated and typing, with the work under way.
    await until(() => office.calls.length === 1);
    expect(ada.interactableId).not.toBe("");
    expect(ada.animation).toBe(ANIMATION_STATE.typing);
    expect(ada.activity).toBe(AGENT_ACTIVITY.working);
    expect(office.calls[0]?.brief).toEqual({ number: 1, title: "Issue 1", body: "What issue 1 asks for." });
    expect(office.calls[0]?.context).toEqual({ agentName: ada.name, jobTitle: ada.jobTitle });

    // However long the work takes, the body stays put.
    const seatedAt = { x: ada.x, z: ada.z };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(distance(ada, seatedAt)).toBe(0);
    expect(office.work(1).status).toBe(WORK_STATUS.in_progress);

    office.calls[0]?.finish(success("# Spec\nThe deliverable."));
    await until(() => office.work(1).outputArtifact !== "");
    // Written at the desk; handed in only at the board.
    expect(office.work(1).status).toBe(WORK_STATUS.in_progress);

    await until(() => ada.activity === AGENT_ACTIVITY.walking);
    await until(() => office.work(1).status === WORK_STATUS.review);
    expect(distance(ada, board)).toBeLessThan(0.2);
    expect(office.work(1).outputArtifact).toBe("# Spec\nThe deliverable.");
    expect(office.work(1).assigneeId).toBe(ada.id);
    expect(ada.currentIssueNumber).toBe(0);

    await until(() => distance(ada, home) < 0.2 && ada.activity === AGENT_ACTIVITY.idle);
    expect(ada.animation).toBe(ANIMATION_STATE.idle);
    expect(logged.filter((line) => line.includes("agent-work"))).toEqual([
      expect.stringContaining('"step":"claimed"'),
      expect.stringContaining('"step":"attached"'),
      expect.stringContaining('"step":"handed-in"'),
    ]);
  });

  it("only ever takes issues the CEO assigned to it", async () => {
    const office = openOffice(2);
    const bo = agentAt(office, 1);
    assign(office, 1, bo);

    await until(() => office.calls.length === 1);
    await vi.advanceTimersByTimeAsync(5 * BRAIN_POLL_MS);
    expect(office.calls).toHaveLength(1);
    expect(agentAt(office, 0).currentIssueNumber).toBe(0);
    expect(bo.currentIssueNumber).toBe(1);
    // The rest of the board stays the CEO's to hand out.
    expect(office.state.work.has(workKey(2))).toBe(false);
  });

  it("does rework sent back from review", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    assign(office, 1, ada);
    await until(() => office.calls.length === 1);
    office.calls[0]?.finish(success("First draft."));
    await until(() => office.work(1).status === WORK_STATUS.review);

    office.ceo({
      action: WORK_ACTION.moveStatus,
      payload: { issueNumber: 1, status: WORK_STATUS.in_progress },
    });
    await until(() => office.calls.length === 2);
    office.calls[1]?.finish(success("Second draft."));
    await until(() => office.work(1).status === WORK_STATUS.review);
    expect(office.work(1).outputArtifact).toBe("Second draft.");
  });
});

describe("every agent at once", () => {
  it("keeps the tick running at full rate while every agent waits on its work", async () => {
    const office = openOffice(4);
    office.agents.forEach((agent, index) => assign(office, index + 1, agent));
    await until(() => office.calls.length === 4);

    const before = office.ticks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(office.ticks() - before).toBe(10_000 / TICK_INTERVAL_MS);
    for (const agent of office.agents) {
      expect(agent.activity, agent.name).toBe(AGENT_ACTIVITY.working);
      expect(agent.animation, agent.name).toBe(ANIMATION_STATE.typing);
    }

    office.calls.forEach((call) => call.finish(success(`Done: ${call.brief.title}`)));
    await until(() =>
      [1, 2, 3, 4].every((n) => office.work(n).status === WORK_STATUS.review),
    );
    for (const [index, agent] of office.agents.entries()) {
      expect(office.work(index + 1).assigneeId).toBe(agent.id);
    }
  });

  it("never has two agents working one issue, even when it changes hands mid-work", async () => {
    const office = openOffice(2);
    const ada = agentAt(office, 0);
    const bo = agentAt(office, 1);
    assign(office, 1, ada);
    await until(() => office.calls.length === 1);

    assign(office, 1, bo);
    let both = false;
    const watch = setInterval(() => {
      both ||= ada.currentIssueNumber === 1 && bo.currentIssueNumber === 1;
    }, 10);

    // Ada finishes after the reassignment: her work is not Bo's issue's any more.
    office.calls[0]?.finish(success("Ada's draft."));
    await until(() => office.calls.length === 2);
    expect(office.calls[1]?.context.agentName).toBe(bo.name);
    expect(ada.currentIssueNumber).toBe(0);
    expect(office.work(1).outputArtifact).toBe("");

    office.calls[1]?.finish(success("Bo's draft."));
    await until(() => office.work(1).status === WORK_STATUS.review);
    clearInterval(watch);
    expect(both).toBe(false);
    expect(office.work(1).outputArtifact).toBe("Bo's draft.");
  });

  it("drops work in flight the moment its issue is reassigned, so the new owner starts at once", async () => {
    const office = openOffice(2);
    const ada = agentAt(office, 0);
    const bo = agentAt(office, 1);
    assign(office, 1, ada);
    await until(() => office.calls.length === 1);

    assign(office, 1, bo);
    // Ada's call never answers on its own; she still lets go of the issue.
    await vi.advanceTimersByTimeAsync(2 * SETTLE_POLL_MS);
    expect(office.calls[0]?.signal?.aborted).toBe(true);
    expect(ada.currentIssueNumber).toBe(0);
    expect(ada.activity).not.toBe(AGENT_ACTIVITY.working);

    await until(() => office.calls.length === 2);
    expect(office.calls[1]?.context.agentName).toBe(bo.name);
    expect(office.work(1).outputArtifact).toBe("");
    await until(() => ada.activity === AGENT_ACTIVITY.idle);

    office.calls[0]?.finish(success("Ada's draft, too late."));
    office.calls[1]?.finish(success("Bo's draft."));
    await until(() => office.work(1).status === WORK_STATUS.review);
    expect(office.work(1).outputArtifact).toBe("Bo's draft.");
  });

  it("drops work in flight when the CEO moves it back to assigned, then starts over", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    assign(office, 1, ada);
    await until(() => office.calls.length === 1);

    office.ceo({
      action: WORK_ACTION.moveStatus,
      payload: { issueNumber: 1, status: WORK_STATUS.assigned },
    });
    await vi.advanceTimersByTimeAsync(2 * SETTLE_POLL_MS);
    expect(office.calls[0]?.signal?.aborted).toBe(true);
    expect(ada.currentIssueNumber).toBe(0);
    expect(office.work(1).outputArtifact).toBe("");

    await until(() => office.calls.length === 2);
    expect(office.calls[1]?.signal?.aborted).toBe(false);
    office.calls[0]?.finish(success("Stale draft."));
    office.calls[1]?.finish(success("Fresh draft."));
    await until(() => office.work(1).status === WORK_STATUS.review);
    expect(office.work(1).outputArtifact).toBe("Fresh draft.");
  });
});

describe("GitHub closing the issue", () => {
  it("puts the work down mid-call and goes home, with nothing written to the closed issue", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    assign(office, 1, ada);
    await until(() => office.calls.length === 1);

    office.closeIssue(1);
    expect(office.state.work.has(workKey(1))).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * SETTLE_POLL_MS);
    expect(office.calls[0]?.signal?.aborted).toBe(true);
    expect(ada.currentIssueNumber).toBe(0);
    await until(() => ada.activity === AGENT_ACTIVITY.idle);

    office.calls[0]?.finish(success("Too late."));
    await vi.advanceTimersByTimeAsync(5 * BRAIN_POLL_MS);
    expect(office.state.work.size).toBe(0);
    expect(office.calls).toHaveLength(1);
  });
});

describe("a failed work call", () => {
  it("blocks the agent, keeps the work, says why, and recovers when the CEO retries", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    assign(office, 1, ada);
    await until(() => office.calls.length === 1);

    office.calls[0]?.finish(failure("agent call budget for today is spent"));
    await until(() => ada.activity === AGENT_ACTIVITY.blocked);

    const work = office.work(1);
    expect(work.status).toBe(WORK_STATUS.in_progress);
    expect(work.assigneeId).toBe(ada.id);
    expect(ada.currentIssueNumber).toBe(1);
    expect(work.note).toContain("agent call budget for today is spent");

    // Left alone, it stays blocked and makes no further call.
    await vi.advanceTimersByTimeAsync(10 * BRAIN_POLL_MS);
    expect(ada.activity).toBe(AGENT_ACTIVITY.blocked);
    expect(office.calls).toHaveLength(1);

    office.ceo({
      action: WORK_ACTION.moveStatus,
      payload: { issueNumber: 1, status: WORK_STATUS.assigned },
    });
    await until(() => office.calls.length === 2);
    office.calls[1]?.finish(success("Second attempt."));
    await until(() => office.work(1).status === WORK_STATUS.review);
    expect(ada.activity).not.toBe(AGENT_ACTIVITY.blocked);
  });

  it("frees a blocked agent whose issue the CEO gives to someone else", async () => {
    const office = openOffice(2);
    const ada = agentAt(office, 0);
    const bo = agentAt(office, 1);
    assign(office, 1, ada);
    await until(() => office.calls.length === 1);
    office.calls[0]?.finish(failure("no answer within 120s"));
    await until(() => ada.activity === AGENT_ACTIVITY.blocked);

    assign(office, 1, bo);
    await until(() => ada.activity === AGENT_ACTIVITY.idle && office.calls.length === 2);
    expect(ada.currentIssueNumber).toBe(0);
    expect(office.calls[1]?.context.agentName).toBe(bo.name);
  });

  it("survives a cycle that throws, and blocks on the issue rather than spinning", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    const brain = office.brains[0];
    assign(office, 1, ada);
    await until(() => office.calls.length === 1);

    // A broken executor: the contract says this never happens.
    office.calls[0]?.finish(undefined as unknown as WorkResult);
    await until(() => ada.activity === AGENT_ACTIVITY.blocked);
    expect(brain?.running).toBe(true);
    expect(office.work(1).note).toContain("Blocked:");

    office.ceo({
      action: WORK_ACTION.moveStatus,
      payload: { issueNumber: 1, status: WORK_STATUS.assigned },
    });
    await until(() => office.calls.length === 2);
    office.calls[1]?.finish(success("Fine this time."));
    await until(() => office.work(1).status === WORK_STATUS.review);
  });
});

describe("teardown", () => {
  it("abandons a cycle in flight with no timer left and nothing written after", async () => {
    const office = openOffice(2);
    office.agents.forEach((agent, index) => assign(office, index + 1, agent));
    await until(() => office.calls.length === 2);

    const work = office.state.work.toJSON();
    const staff = office.state.occupants.toJSON();
    const linesBefore = logged.length;

    office.brains.forEach((brain) => brain.stop());
    office.closeTick();
    expect(office.calls.every((call) => call.signal?.aborted === true)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // Work that resolves after the room has gone writes nothing.
    office.calls.forEach((call) => call.finish(success("Too late.")));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(office.state.work.toJSON()).toEqual(work);
    expect(office.state.occupants.toJSON()).toEqual(staff);
    expect(logged.length).toBe(linesBefore);
    expect(office.brains.every((brain) => !brain.running)).toBe(true);
  });

  it("tears down cleanly on the walk to the project board too", async () => {
    const office = openOffice();
    const ada = agentAt(office, 0);
    assign(office, 1, ada);
    await until(() => office.calls.length === 1);
    office.calls[0]?.finish(success("On its way."));
    await until(() => ada.activity === AGENT_ACTIVITY.walking);

    office.brains[0]?.stop();
    office.closeTick();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(office.work(1).status).toBe(WORK_STATUS.in_progress);
  });

  it("stops a brain whose agent has left the office", async () => {
    const office = openOffice();
    office.state.occupants.delete(agentAt(office, 0).id);
    await vi.advanceTimersByTimeAsync(2 * BRAIN_POLL_MS);
    expect(office.brains[0]?.running).toBe(false);
  });
});
