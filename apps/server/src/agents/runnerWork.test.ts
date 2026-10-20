/**
 * The loop between the office's work and a runner's agents, against a real
 * runner link and the real work rules: what the CEO does becomes the slot's
 * commands, and what the runner reports becomes the agent's own moves.
 */

import {
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  LiveAgent,
  OCCUPANT_KIND,
  OfficeState,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  type RunnerCommand,
  type RunnerEvent,
  type RunnerWorkEvent,
  type RunnerSync,
  isRunnerSlotCommand,
  WORK_ACTION,
  WORK_REJECTION,
  WORK_STATUS,
  type WorkCommand,
  actorOf,
  liveAgentKey,
  releaseGoneWork,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { type WorkHost, applyAs } from "../rooms/workHandlers.js";
import { RunnerLink, runnerSlotAgentId, runnerSlotOf } from "./runnerLink.js";
import { RunnerWork, isRunnerCommands, pullRequestArtifact, reworkPrompt } from "./runnerWork.js";

const REPO = "krasovsky22/agent-office-sims";
const CEO = "session-ceo";
const SLOT_1 = liveAgentKey(runnerSlotAgentId("box", "slot-1"));
const SLOT_2 = liveAgentKey(runnerSlotAgentId("box", "slot-2"));
const PR = { number: 95, title: "Night shift", url: `https://github.com/${REPO}/pull/95` };

function board(open: ProjectBoardSnapshot["open"], closed: ProjectBoardSnapshot["closed"] = []): ProjectBoardSnapshot {
  return {
    ...EMPTY_BOARD_LISTS,
    repository: REPO,
    updatedAt: 1,
    stale: false,
    open,
    closed,
    counts: { open: open.length, inProgress: 0, pullRequests: 0 },
  };
}

function issue(number: number, ...labels: string[]) {
  return {
    number,
    title: number === 39 ? "Night shift" : `Issue ${number}`,
    body: "",
    labels: labels.map((name) => ({ name, color: "" })),
    assignees: [],
    pullRequests: [],
    closedAt: null,
  };
}

function setup() {
  let nextId = 1;
  const link = new RunnerLink({ repository: REPO, timeoutMs: 30_000, commandId: () => `command-${nextId++}` });
  const state = new OfficeState();
  state.agentRestrictLabel = "agent-restricted";
  const ceo = new HumanPlayer();
  ceo.id = CEO;
  ceo.name = "Dana";
  ceo.role = PLAYER_ROLE.ceo;
  state.occupants.set(CEO, ceo);
  for (const [id, name] of [
    [SLOT_1, "Mock 1"],
    [SLOT_2, "Mock 2"],
  ] as const) {
    const agent = new LiveAgent();
    agent.id = id;
    agent.name = name;
    agent.kind = OCCUPANT_KIND.liveAgent;
    agent.canTakeIssues = true;
    state.occupants.set(id, agent);
  }
  let snapshot = board([issue(39, "client"), issue(40), issue(41, "agent-restricted")]);
  const loop: { work?: RunnerWork } = {};
  const host: WorkHost = {
    state,
    now: () => 2,
    board: () => snapshot,
    observe: (change) => loop.work?.changed(change),
  };
  const announced: string[] = [];
  const runnerWork = new RunnerWork({ host, runner: link, announce: (text) => announced.push(text) });
  loop.work = runnerWork;
  const syncSlots = (holding: Partial<Record<"slot-1" | "slot-2", number>> = {}, events: RunnerEvent[] = [], acked: string[] = []) => {
    const body: RunnerSync = {
      runnerId: "box",
      repo: REPO,
      acked,
      slots: (["slot-1", "slot-2"] as const).map((id) => ({
        id,
        name: id === "slot-1" ? "Mock 1" : "Mock 2",
        title: "Software Developer",
        description: "",
        status: holding[id] === undefined ? "idle" : "working",
        issueNumber: holding[id],
        activity: "",
        pr: undefined,
      })),
      events,
    };
    const outcome = link.sync(body);
    return outcome.kind === "accepted" ? outcome.commands : [];
  };
  syncSlots();
  const ceoDoes = (command: WorkCommand) => applyAs(host, actorOf(ceo), command);
  return {
    link,
    state,
    host,
    runnerWork,
    announced,
    syncSlots,
    ceoDoes,
    setBoard: (next: ProjectBoardSnapshot) => {
      snapshot = next;
    },
    /** The commands waiting for the runner, without their ids. */
    pending: () => link.pending("box").filter(isRunnerSlotCommand).map(({ id: _id, ...command }) => command),
    ack: () => syncSlots({}, [], link.pending("box").map((command: RunnerCommand) => command.id)),
  };
}

function event(kind: RunnerWorkEvent["kind"], issueNumber: number, extra: Partial<RunnerWorkEvent> = {}): RunnerWorkEvent {
  return { id: `event-${kind}-${issueNumber}-${Math.random()}`, kind, slotId: "slot-1", issueNumber, pr: undefined, message: "", ...extra };
}

const assign = (issueNumber: number, assigneeId = SLOT_1): WorkCommand => ({
  action: WORK_ACTION.assign,
  payload: { issueNumber, assigneeId },
});

describe("RunnerWork outward: the CEO's word to the slots", () => {
  it("starts the slot an issue is given to, as the CEO who gave it", () => {
    const { ceoDoes, pending } = setup();
    expect(ceoDoes(assign(39)).ok).toBe(true);
    expect(pending()).toEqual([
      {
        kind: "start",
        slotId: "slot-1",
        issueNumber: 39,
        title: "Night shift",
        url: `https://github.com/${REPO}/issues/39`,
        note: "",
        requestedBy: "Dana",
      },
    ]);
  });

  it("refuses, and sends nothing, for a restricted issue", () => {
    const { ceoDoes, pending } = setup();
    expect(ceoDoes(assign(41))).toEqual({ ok: false, rejection: WORK_REJECTION.restricted });
    expect(pending()).toEqual([]);
  });

  it("stops the slot that had the work and starts the one it went to", () => {
    const { ceoDoes, pending, ack } = setup();
    ceoDoes(assign(39));
    ack();
    ceoDoes(assign(39, SLOT_2));
    expect(pending().map((command) => [command.kind, command.slotId])).toEqual([
      ["stop", "slot-1"],
      ["start", "slot-2"],
    ]);
    expect(pending()[0]).toMatchObject({ reason: "#39 went to Mock 2", issueNumber: 39 });
  });

  it("stops the slot when the CEO takes the work back, even before the runner has its start", () => {
    const { ceoDoes, pending } = setup();
    ceoDoes(assign(39));
    ceoDoes({ action: WORK_ACTION.release, payload: { issueNumber: 39 } });
    expect(pending()).toEqual([
      expect.objectContaining({ kind: "start", issueNumber: 39 }),
      { kind: "stop", slotId: "slot-1", reason: "the CEO took the work back", issueNumber: 39 },
    ]);
  });

  it("has the slot discard the task the CEO cancelled, a review in hand included", () => {
    const { ceoDoes, state, syncSlots, pending, ack, runnerWork } = setup();
    ceoDoes(assign(39));
    ack();
    syncSlots({ "slot-1": 39 });
    runnerWork.receive(
      [event("started", 39), event("pr-opened", 39, { pr: PR })].map((item) => ({ runnerId: "box", event: item })),
    );
    expect(state.work.get(workKey(39))?.status).toBe(WORK_STATUS.review);
    expect(ceoDoes({ action: WORK_ACTION.cancel, payload: { issueNumber: 39 } }).ok).toBe(true);
    expect(state.work.has(workKey(39))).toBe(false);
    expect(pending()).toEqual([
      { kind: "stop", slotId: "slot-1", reason: "the CEO cancelled the task", issueNumber: 39, discard: true },
    ]);
  });

  it("sends a review back as a rework prompt to the slot holding it, or a start with the same words when it is not", () => {
    const { ceoDoes, state, syncSlots, pending, ack, runnerWork } = setup();
    ceoDoes(assign(39));
    ack();
    syncSlots({ "slot-1": 39 }, [event("started", 39), event("pr-opened", 39, { pr: PR })]);
    runnerWork.receive(
      [event("started", 39), event("pr-opened", 39, { pr: PR })].map((item) => ({ runnerId: "box", event: item })),
    );
    expect(state.work.get(workKey(39))?.status).toBe(WORK_STATUS.review);

    ceoDoes({ action: WORK_ACTION.moveStatus, payload: { issueNumber: 39, status: WORK_STATUS.in_progress } });
    expect(pending()).toEqual([{ kind: "prompt", slotId: "slot-1", text: reworkPrompt(39), requestedBy: "Dana" }]);
    ack();

    // The runner restarted and no longer holds it: the same words start it again.
    syncSlots({});
    runnerWork.receive([{ runnerId: "box", event: event("pr-opened", 39, { pr: PR }) }]);
    ceoDoes({ action: WORK_ACTION.moveStatus, payload: { issueNumber: 39, status: WORK_STATUS.in_progress } });
    expect(pending()).toEqual([expect.objectContaining({ kind: "start", issueNumber: 39, note: reworkPrompt(39) })]);
  });

  it("starts work sent back to assigned again from the top, and stops it once approved", () => {
    const { ceoDoes, state, pending, ack, runnerWork } = setup();
    ceoDoes(assign(39));
    ack();
    runnerWork.receive([{ runnerId: "box", event: event("started", 39) }]);
    ceoDoes({ action: WORK_ACTION.moveStatus, payload: { issueNumber: 39, status: WORK_STATUS.assigned } });
    expect(pending().map((command) => command.kind)).toEqual(["stop", "start"]);
    ack();

    runnerWork.receive(
      [event("started", 39), event("pr-opened", 39, { pr: PR })].map((item) => ({ runnerId: "box", event: item })),
    );
    expect(state.work.get(workKey(39))?.status).toBe(WORK_STATUS.review);
    ceoDoes({ action: WORK_ACTION.moveStatus, payload: { issueNumber: 39, status: WORK_STATUS.done } });
    expect(pending()).toEqual([{ kind: "stop", slotId: "slot-1", reason: "the work is done", issueNumber: 39 }]);
  });

  it("starts stopped work again from the top when the CEO gives it to the same agent, whatever its status", () => {
    const { ceoDoes, state, pending, ack, runnerWork } = setup();
    ceoDoes(assign(39));
    ack();
    runnerWork.receive([{ runnerId: "box", event: event("failed", 39, { message: "Over budget", refusal: "budget" }) }]);
    expect(ceoDoes(assign(39)).ok).toBe(true);
    expect(pending().map((command) => command.kind)).toEqual(["stop", "start"]);
    expect(state.work.get(workKey(39))?.note).toBe("");
    ack();

    runnerWork.receive(
      [event("started", 39), event("failed", 39, { message: "Timed out after 60 minutes" })].map((item) => ({ runnerId: "box", event: item })),
    );
    expect(ceoDoes(assign(39)).ok).toBe(true);
    expect(pending().map((command) => command.kind)).toEqual(["stop", "start"]);
    expect(state.work.get(workKey(39))?.status).toBe(WORK_STATUS.assigned);
    ack();

    // Work that is going needs no restart.
    runnerWork.receive([{ runnerId: "box", event: event("started", 39) }]);
    expect(ceoDoes(assign(39)).ok).toBe(true);
    expect(pending()).toEqual([]);
  });

  it("stops a slot whose work GitHub finished, shipped or closed", () => {
    const { ceoDoes, state, pending, ack, runnerWork, setBoard } = setup();
    ceoDoes(assign(39));
    ceoDoes(assign(40, SLOT_2));
    ack();
    runnerWork.receive(
      [event("started", 39), event("pr-opened", 39, { pr: PR })].map((item) => ({ runnerId: "box", event: item })),
    );
    const closed = board([], [
      { ...issue(39, "client"), closedAt: 3 },
      { ...issue(40), closedAt: 3 },
    ]);
    setBoard(closed);
    const shipped: never[] = [];
    const released = releaseGoneWork(state.work, closed, shipped);
    for (const work of [...released, ...shipped]) {
      runnerWork.ended(work, "closed");
    }
    expect(state.work.get(workKey(39))?.status).toBe(WORK_STATUS.done);
    expect(pending().map((command) => [command.kind, command.slotId])).toEqual([
      ["stop", "slot-2"],
      ["stop", "slot-1"],
    ]);
  });

  it("says on the work, as its agent, when the runner cannot take a start", () => {
    const { state, link, host } = setup();
    const offline = new RunnerWork({
      host,
      runner: {
        enqueue: () => undefined,
        withdraw: () => false,
        slotIssue: () => undefined,
        heldIssues: () => [],
        issueUrl: (number) => link.issueUrl(number),
      },
    });
    const observe = (change: Parameters<NonNullable<WorkHost["observe"]>>[0]) => offline.changed(change);
    const result = applyAs({ ...host, observe }, actorOf(state.occupants.get(CEO) ?? new HumanPlayer()), assign(39));
    expect(result.ok).toBe(true);
    expect(state.work.get(workKey(39))?.note).toMatch(/My runner could not take this/);
  });
});

describe("RunnerWork.reconcile", () => {
  it("stops, once, a slot holding an issue the office has no work of its own on", () => {
    const { ceoDoes, syncSlots, pending, ack, runnerWork } = setup();
    ceoDoes(assign(39));
    ack();
    // The room was opened afresh: slot-2 still holds #40 from before; slot-1 holds #39, its own.
    syncSlots({ "slot-1": 39, "slot-2": 40 });
    runnerWork.reconcile();
    runnerWork.reconcile();
    expect(pending()).toEqual([
      { kind: "stop", slotId: "slot-2", reason: "the office has no work for it on this issue", issueNumber: 40 },
    ]);
  });

  it("still has a slot discard the task the CEO cancelled when the cancel's own stop never reached it", () => {
    const { ceoDoes, link, syncSlots, pending, ack, runnerWork } = setup();
    ceoDoes(assign(39));
    ack();
    syncSlots({ "slot-1": 39 });
    ceoDoes({ action: WORK_ACTION.cancel, payload: { issueNumber: 39 } });
    // Lost on the way, as to a runner that was offline.
    for (const command of link.pending("box")) {
      link.withdraw("box", command.id);
    }
    syncSlots({ "slot-1": 39 });
    runnerWork.reconcile();
    expect(pending()).toEqual([
      { kind: "stop", slotId: "slot-1", reason: "the CEO cancelled the task", issueNumber: 39, discard: true },
    ]);
  });

  it("stops a slot still holding work that was approved, and again if it takes the issue up later", () => {
    const { ceoDoes, state, syncSlots, pending, ack, runnerWork } = setup();
    ceoDoes(assign(39));
    ack();
    runnerWork.receive(
      [event("started", 39), event("pr-opened", 39, { pr: PR })].map((item) => ({ runnerId: "box", event: item })),
    );
    ceoDoes({ action: WORK_ACTION.moveStatus, payload: { issueNumber: 39, status: WORK_STATUS.done } });
    ack();
    expect(state.work.get(workKey(39))?.status).toBe(WORK_STATUS.done);
    syncSlots({ "slot-1": 39 });
    runnerWork.reconcile();
    expect(pending().map((command) => command.kind)).toEqual(["stop"]);
    ack();
    syncSlots({});
    runnerWork.reconcile();
    syncSlots({ "slot-1": 39 });
    runnerWork.reconcile();
    expect(pending().map((command) => command.kind)).toEqual(["stop"]);
  });
});

describe("RunnerWork inward: the runner's events as the agent's moves", () => {
  it("claims on started, hands the pull request in on pr-opened, and notes a failure", () => {
    const { ceoDoes, state, runnerWork } = setup();
    ceoDoes(assign(39));
    ceoDoes(assign(40, SLOT_2));
    runnerWork.receive([{ runnerId: "box", event: event("started", 39) }]);
    expect(state.work.get(workKey(39))?.status).toBe(WORK_STATUS.in_progress);

    runnerWork.receive([{ runnerId: "box", event: event("pr-opened", 39, { pr: PR }) }]);
    const work = state.work.get(workKey(39));
    expect(work?.status).toBe(WORK_STATUS.review);
    expect(work?.outputArtifact).toBe(`PR #95: Night shift, https://github.com/${REPO}/pull/95`);

    runnerWork.receive([
      { runnerId: "box", event: event("failed", 40, { slotId: "slot-2", message: "#40 is labelled agent-restricted on GitHub" }) },
    ]);
    expect(state.work.get(workKey(40))?.note).toBe("#40 is labelled agent-restricted on GitHub");
  });

  it("has the AI Manager explain a start the runner refused because its budget is spent, and only that kind of failure", () => {
    const { ceoDoes, state, runnerWork, announced } = setup();
    ceoDoes(assign(39));
    const reason =
      "The runner's daily budget of $5.00 is spent ($5.10 today), so it starts no new work until midnight on its machine";
    runnerWork.receive([{ runnerId: "box", event: event("failed", 39, { message: reason, refusal: "budget" }) }]);
    expect(state.work.get(workKey(39))?.note).toBe(reason);
    expect(announced).toEqual([
      "Mock 1 couldn't start on #39 “Night shift”: the runner's daily budget of $5.00 is spent ($5.10 today), " +
        "so it starts no new work until midnight on its machine. Nothing started, so nothing more was spent. " +
        "To try again once the runner's RUNNER_DAILY_BUDGET_USD is raised or its day turns over, press Start again on its card.",
    ]);

    runnerWork.receive([{ runnerId: "box", event: event("failed", 39, { message: "Timed out after 60 minutes" }) }]);
    expect(announced).toHaveLength(1);
  });

  it("marks work stopped when its agent exits without a pull request, and not once it handed one in", () => {
    const { ceoDoes, state, runnerWork } = setup();
    ceoDoes(assign(39));
    ceoDoes(assign(40, SLOT_2));
    runnerWork.receive(
      [event("started", 39), event("finished", 39, { message: "Claude Code exited with code 0" })].map((item) => ({ runnerId: "box", event: item })),
    );
    expect(state.work.get(workKey(39))?.note).toBe("The agent exited without opening a pull request.");

    runnerWork.receive(
      [event("started", 40), event("pr-opened", 40, { pr: PR }), event("finished", 40)].map((item) => ({
        runnerId: "box",
        event: { ...item, slotId: "slot-2" },
      })),
    );
    expect(state.work.get(workKey(40))?.status).toBe(WORK_STATUS.review);
    expect(state.work.get(workKey(40))?.note).toBe("");
  });

  it("changes nothing for an event about work the slot does not hold, or a slot not on the floor", () => {
    const { ceoDoes, state, runnerWork } = setup();
    ceoDoes(assign(39, SLOT_2));
    runnerWork.receive([
      { runnerId: "box", event: event("started", 39) },
      { runnerId: "elsewhere", event: event("started", 39) },
      { runnerId: "box", event: event("failed", 77, { message: "nothing here" }) },
    ]);
    expect(state.work.get(workKey(39))?.status).toBe(WORK_STATUS.assigned);
  });

  it("hands a simulated pull request in as one, with no number and no link", () => {
    const { ceoDoes, state, runnerWork } = setup();
    ceoDoes(assign(39));
    runnerWork.receive([{ runnerId: "box", event: event("started", 39) }]);
    runnerWork.receive([
      { runnerId: "box", event: event("pr-opened", 39, { pr: { number: 1_000_039, title: "[mock] Night shift", url: "", simulated: true } }) },
    ]);
    const work = state.work.get(workKey(39));
    expect(work?.status).toBe(WORK_STATUS.review);
    expect(work?.outputArtifact).toBe("Simulated pull request, nothing on GitHub: [mock] Night shift");
  });

  it("writes a pull request without a title as its number and link", () => {
    expect(pullRequestArtifact({ number: 7, title: "", url: `https://github.com/${REPO}/pull/7` })).toBe(
      `PR #7: https://github.com/${REPO}/pull/7`,
    );
  });
});

describe("runnerSlotOf", () => {
  it("reads the runner and slot back out of a slot's agent id, and nothing out of any other", () => {
    expect(runnerSlotOf(runnerSlotAgentId("box", "slot-1"))).toEqual({ runnerId: "box", slotId: "slot-1" });
    expect(runnerSlotOf("crewmate-7")).toBeUndefined();
    expect(runnerSlotOf("runner:box")).toBeUndefined();
    expect(runnerSlotOf("runner::slot-1")).toBeUndefined();
  });

  it("takes the link as the room's command channel, and not a client's lookalike", () => {
    expect(isRunnerCommands(new RunnerLink({ repository: REPO, timeoutMs: 1000 }))).toBe(true);
    expect(isRunnerCommands({ enqueue: "nope" })).toBe(false);
  });
});
