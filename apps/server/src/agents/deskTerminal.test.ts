/**
 * The CEO's desk terminal against a real runner link: sitting at a computer
 * lends the CEO a free slot, the slot reporting the desk opens it, standing up
 * gives it back, and nobody but the CEO is lent one.
 */

import {
  DESK_TERMINAL_PHASE,
  HumanPlayer,
  IssueWork,
  OFFICE_LAYOUT,
  OfficeState,
  PLAYER_ROLE,
  type RunnerCommand,
  type RunnerSlotReport,
  WORK_STATUS,
  liveAgentKey,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { DeskTerminal } from "./deskTerminal.js";
import { LENT_TO_DESK_ACTIVITY, RunnerLink, runnerSlotAgentId } from "./runnerLink.js";

const REPO = "krasovsky22/agent-office-sims";
const SEAT = "seat-desk-north-1-1";
const CEO = "session-ceo";

const IDLE: RunnerSlotReport = { id: "slot-1", name: "Claude 1", title: "Software Developer", description: "", status: "idle", issueNumber: undefined, activity: "", pr: undefined };

function setup(options: { runner?: boolean } = {}) {
  let nextId = 1;
  const link = new RunnerLink({ repository: REPO, timeoutMs: 30_000, commandId: () => `command-${nextId++}` });
  const inbox = link.openEventInbox();
  const state = new OfficeState();
  const ceo = new HumanPlayer();
  ceo.id = CEO;
  ceo.name = "Dana";
  ceo.role = PLAYER_ROLE.ceo;
  state.occupants.set(CEO, ceo);
  const employee = new HumanPlayer();
  employee.id = "session-employee";
  employee.name = "Sam";
  employee.role = PLAYER_ROLE.exec;
  state.occupants.set(employee.id, employee);
  const desk = new DeskTerminal({ state, layout: OFFICE_LAYOUT, runner: options.runner === false ? undefined : link });
  /** One sync from the runner `box`; returns the commands waiting for it. */
  const sync = (slots: RunnerSlotReport[], events: Parameters<RunnerLink["sync"]>[0]["events"] = []): RunnerCommand[] => {
    const outcome = link.sync({ runnerId: "box", repo: REPO, acked: [], slots, events });
    desk.receive(inbox.drain());
    return outcome.kind === "accepted" ? [...outcome.commands] : [];
  };
  /** Acks everything waiting, as a runner does once it has carried it out. */
  const ack = (slots: RunnerSlotReport[]) => {
    const waiting = link.pending("box").map((command) => command.id);
    link.sync({ runnerId: "box", repo: REPO, acked: waiting, slots, events: [] });
  };
  return { link, state, ceo, employee, desk, sync, ack };
}

describe("DeskTerminal", () => {
  it("lends the CEO sitting at a computer the first free slot, and opens once the slot reports the desk", () => {
    const { link, state, ceo, desk, sync, ack } = setup();
    sync([IDLE, { ...IDLE, id: "slot-2", name: "Claude 2" }]);
    ceo.interactableId = SEAT;
    desk.step();
    expect(state.desk.toJSON()).toMatchObject({ seatId: SEAT, ownerId: CEO, agentId: "", phase: DESK_TERMINAL_PHASE.starting });
    const commands = sync([IDLE]);
    expect(commands).toEqual([{ id: "command-1", slotId: "slot-1", kind: "desk-open", seatId: SEAT, requestedBy: "Dana" }]);

    const lent: RunnerSlotReport = { ...IDLE, status: "needs-input", activity: "Waiting on a setup screen", desk: { seatId: SEAT } };
    ack([lent]);
    desk.step();
    expect(state.desk.toJSON()).toMatchObject({
      phase: DESK_TERMINAL_PHASE.open,
      agentId: liveAgentKey(runnerSlotAgentId("box", "slot-1")),
      needsInput: true,
      activity: "Waiting on a setup screen",
    });
    // On the floor it is free and takes no issues while it is lent, so nobody hands it work.
    expect(link.current()[0]).toMatchObject({ status: "idle", task: undefined, activity: LENT_TO_DESK_ACTIVITY, canTakeIssues: false });
    desk.step();
    expect(sync([lent])).toEqual([]);
  });

  it("gives the slot back the moment the CEO stands up, and lends a fresh one at the next sitting", () => {
    const { state, ceo, desk, sync, ack } = setup();
    sync([IDLE]);
    ceo.interactableId = SEAT;
    desk.step();
    const lent: RunnerSlotReport = { ...IDLE, desk: { seatId: SEAT } };
    ack([lent]);
    desk.step();
    ceo.interactableId = "";
    desk.step();
    expect(state.desk.toJSON()).toMatchObject({ seatId: "", ownerId: "", agentId: "", phase: DESK_TERMINAL_PHASE.off });
    expect(sync([lent])).toEqual([{ id: "command-2", slotId: "slot-1", kind: "desk-close", seatId: SEAT, reason: "the CEO stood up" }]);
    // Still reported until the runner has closed it: not closed twice.
    desk.step();
    expect(sync([lent]).filter((command) => command.kind === "desk-close")).toHaveLength(1);

    ack([IDLE]);
    ceo.interactableId = SEAT;
    desk.step();
    expect(sync([IDLE]).at(-1)).toMatchObject({ kind: "desk-open", slotId: "slot-1", seatId: SEAT });
  });

  it("gives the slot back when the CEO hands the role on", () => {
    const { state, ceo, desk, sync, ack } = setup();
    sync([IDLE]);
    ceo.interactableId = SEAT;
    desk.step();
    ack([{ ...IDLE, desk: { seatId: SEAT } }]);
    desk.step();
    ceo.role = PLAYER_ROLE.exec;
    desk.step();
    expect(state.desk.phase).toBe(DESK_TERMINAL_PHASE.off);
    expect(sync([{ ...IDLE, desk: { seatId: SEAT } }]).map((command) => command.kind)).toEqual(["desk-close"]);
  });

  it("lends nothing to anyone but the CEO", () => {
    const { state, employee, desk, sync } = setup();
    sync([IDLE]);
    employee.interactableId = SEAT;
    desk.step();
    expect(state.desk.phase).toBe(DESK_TERMINAL_PHASE.off);
    expect(sync([IDLE])).toEqual([]);
  });

  it("lends nothing at a seat with no computer, such as the AI Manager's", () => {
    const { state, ceo, desk } = setup();
    ceo.interactableId = "seat-desk-manager-1";
    desk.step();
    expect(state.desk.phase).toBe(DESK_TERMINAL_PHASE.off);
  });

  it("says no runner is connected, with or without a runner link", () => {
    for (const runner of [true, false]) {
      const { state, ceo, desk } = setup({ runner });
      ceo.interactableId = SEAT;
      desk.step();
      expect(state.desk.toJSON()).toMatchObject({ seatId: SEAT, phase: DESK_TERMINAL_PHASE.noRunner });
    }
  });

  it("waits while every slot is busy or has work coming, and lends one as soon as one is free", () => {
    const { state, ceo, desk, sync } = setup();
    const working: RunnerSlotReport = { ...IDLE, status: "working", issueNumber: 39 };
    const assigned = { ...IDLE, id: "slot-2", name: "Claude 2" };
    const work = new IssueWork();
    work.issueNumber = 40;
    work.status = WORK_STATUS.assigned;
    work.assigneeId = liveAgentKey(runnerSlotAgentId("box", "slot-2"));
    state.work.set(workKey(40), work);
    sync([working, assigned]);
    ceo.interactableId = SEAT;
    desk.step();
    expect(state.desk.phase).toBe(DESK_TERMINAL_PHASE.waiting);
    expect(sync([working, assigned])).toEqual([]);

    sync([IDLE, assigned]);
    desk.step();
    expect(state.desk.phase).toBe(DESK_TERMINAL_PHASE.starting);
    expect(sync([IDLE, assigned])).toEqual([expect.objectContaining({ kind: "desk-open", slotId: "slot-1" })]);
  });

  it("ends the session the runner ended, saying why, and lends no other this sitting", () => {
    const { state, ceo, desk, sync, ack } = setup();
    sync([IDLE]);
    ceo.interactableId = SEAT;
    desk.step();
    ack([{ ...IDLE, desk: { seatId: SEAT } }]);
    desk.step();
    sync([IDLE], [{ id: "event-1", kind: "desk-ended", slotId: "slot-1", seatId: SEAT, message: "Claude exited with code 1" }]);
    desk.step();
    expect(state.desk.toJSON()).toMatchObject({ seatId: SEAT, agentId: "", phase: DESK_TERMINAL_PHASE.ended, note: "Claude exited with code 1" });
    desk.step();
    expect(sync([IDLE])).toEqual([]);
  });

  it("ignores a desk event for another slot or desk", () => {
    const { state, ceo, desk, sync } = setup();
    sync([IDLE]);
    ceo.interactableId = SEAT;
    desk.step();
    sync([IDLE], [{ id: "event-1", kind: "desk-ended", slotId: "slot-2", seatId: SEAT, message: "no" }]);
    sync([IDLE], [{ id: "event-2", kind: "desk-ended", slotId: "slot-1", seatId: "seat-desk-north-2-1", message: "no" }]);
    desk.step();
    expect(state.desk.phase).toBe(DESK_TERMINAL_PHASE.starting);
  });

  it("closes, once, a slot reporting a desk nobody here sits at", () => {
    const { desk, sync } = setup();
    const stray: RunnerSlotReport = { ...IDLE, desk: { seatId: SEAT } };
    sync([stray]);
    desk.step();
    desk.step();
    expect(sync([stray])).toEqual([{ id: "command-1", slotId: "slot-1", kind: "desk-close", seatId: SEAT, reason: "nobody sits at that desk" }]);
  });
});
