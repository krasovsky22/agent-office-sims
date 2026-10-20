/**
 * The CEO's long-press `E` menu on a coding agent, against a real runner link
 * and the real work rules: only the CEO may cancel or fire, only a runner's
 * agent, and a cancel needs an issue in hand; a cancel throws the issue's work
 * away and tells the slot to discard the task, and a firing tells the runner
 * first, then does the same and walks the agent out.
 */

import type { Client } from "@colyseus/core";
import {
  AGENT_ACTION_REJECTION,
  type AgentActionRejectedEvent,
  CLIENT_MESSAGE,
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  LiveAgent,
  OfficeState,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  SERVER_MESSAGE,
  WORK_ACTION,
  actorOf,
  isRunnerSlotCommand,
  liveAgentKey,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { RunnerLink, runnerSlotAgentId } from "../agents/runnerLink.js";
import { RunnerWork } from "../agents/runnerWork.js";
import { registerAgentActionHandlers } from "./agentActionHandlers.js";
import { type WorkHost, applyAs } from "./workHandlers.js";

const REPO = "acme/office";
const AGENT = liveAgentKey(runnerSlotAgentId("box", "slot-1"));
const ORCHESTRATED = liveAgentKey("crewmate-33");

const BOARD: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  repository: REPO,
  updatedAt: 1,
  stale: false,
  open: [{ number: 39, title: "Night shift", body: "", labels: [], assignees: [], pullRequests: [], closedAt: null }],
  closed: [],
  counts: { open: 1, inProgress: 0, pullRequests: 0 },
};

function player(state: OfficeState, id: string, name: string, ceo: boolean): HumanPlayer {
  const occupant = new HumanPlayer();
  occupant.id = id;
  occupant.name = name;
  occupant.role = ceo ? PLAYER_ROLE.ceo : PLAYER_ROLE.exec;
  state.occupants.set(id, occupant);
  return occupant;
}

function agent(state: OfficeState, id: string, runner: boolean): LiveAgent {
  const occupant = new LiveAgent();
  occupant.id = id;
  occupant.name = runner ? "Maya" : "Crewmate";
  occupant.canTakeIssues = runner;
  occupant.profileEditable = runner;
  state.occupants.set(id, occupant);
  return occupant;
}

function setup() {
  let nextId = 1;
  const link = new RunnerLink({ repository: REPO, timeoutMs: 30_000, commandId: () => `command-${nextId++}` });
  const slots = [{ id: "slot-1", name: "Maya", title: "Software Developer", description: "", status: "idle" as const, issueNumber: undefined, activity: "", pr: undefined }];
  link.sync({ runnerId: "box", repo: REPO, acked: [], slots, events: [] });
  const state = new OfficeState();
  const dana = player(state, "dana", "Dana", true);
  player(state, "milo", "Milo", false);
  const maya = agent(state, AGENT, true);
  agent(state, ORCHESTRATED, false);
  const loop: { work?: RunnerWork } = {};
  const work: WorkHost = { state, now: () => 2, board: () => BOARD, observe: (change) => loop.work?.changed(change) };
  loop.work = new RunnerWork({ host: work, runner: link });

  const handlers = new Map<string, (client: Client, raw: unknown) => void>();
  const fired: string[] = [];
  const announced: string[] = [];
  const rejected: Array<{ to: string; event: AgentActionRejectedEvent }> = [];
  registerAgentActionHandlers(
    { onMessage: ((type: string, handler: (client: Client, raw: unknown) => void) => handlers.set(type, handler)) as never },
    { work, runner: link, fire: (id) => fired.push(id), announce: (text) => announced.push(text), allow: () => true },
  );
  const send = (sessionId: string, message: unknown) => {
    const client = {
      sessionId,
      send: (type: string, event: AgentActionRejectedEvent) => {
        expect(type).toBe(SERVER_MESSAGE.agentActionRejected);
        rejected.push({ to: sessionId, event });
      },
    } as unknown as Client;
    handlers.get(CLIENT_MESSAGE.agentAction)?.(client, message);
  };
  const assign = () => applyAs(work, actorOf(dana), { action: WORK_ACTION.assign, payload: { issueNumber: 39, assigneeId: AGENT } });
  /** The commands waiting for the runner, without their ids, then acked. */
  const commands = () => {
    const pending = link.pending("box").filter(isRunnerSlotCommand).map(({ id: _id, ...command }) => command);
    link.sync({ runnerId: "box", repo: REPO, acked: link.pending("box").map((command) => command.id), slots, events: [] });
    return pending;
  };
  return { state, maya, send, assign, commands, fired, announced, rejected };
}

describe("cancelling a coding agent's task and firing it", () => {
  it("refuses anyone but the CEO, an orchestrator's agent, and a cancel with no issue in hand, saying why", () => {
    const { send, assign, commands, rejected } = setup();
    send("dana", { agentId: AGENT, action: "cancel" });
    assign();
    commands();
    send("milo", { agentId: AGENT, action: "fire" });
    send("dana", { agentId: ORCHESTRATED, action: "fire" });
    send("dana", { agentId: liveAgentKey("nobody"), action: "cancel" });
    send("dana", { agentId: AGENT, action: "promote" });
    expect(rejected).toEqual([
      { to: "dana", event: { agentId: AGENT, action: "cancel", rejection: AGENT_ACTION_REJECTION.noTask } },
      { to: "milo", event: { agentId: AGENT, action: "fire", rejection: AGENT_ACTION_REJECTION.forbidden } },
      { to: "dana", event: { agentId: ORCHESTRATED, action: "fire", rejection: AGENT_ACTION_REJECTION.noAgent } },
      { to: "dana", event: { agentId: liveAgentKey("nobody"), action: "cancel", rejection: AGENT_ACTION_REJECTION.noAgent } },
    ]);
    expect(commands()).toEqual([]);
  });

  it("cancels the CEO's way: the issue's work goes, the slot discards the task, and the agent stays", () => {
    const { state, send, assign, commands, fired, announced, rejected } = setup();
    assign();
    commands();
    send("dana", { agentId: AGENT, action: "cancel" });
    expect(state.work.has(workKey(39))).toBe(false);
    expect(commands()).toEqual([{ kind: "stop", slotId: "slot-1", reason: "the CEO cancelled the task", issueNumber: 39, discard: true }]);
    expect(state.occupants.has(AGENT)).toBe(true);
    expect(fired).toEqual([]);
    expect(rejected).toEqual([]);
    expect(announced).toEqual(["Dana cancelled Maya's task #39; what it had done is thrown away."]);
  });

  it("fires the agent: the runner hears first, its work is cancelled, and the crew walks it out", () => {
    const { state, send, assign, commands, fired, announced, rejected } = setup();
    assign();
    commands();
    send("dana", { agentId: AGENT, action: "fire" });
    expect(commands()).toEqual([
      { kind: "fire", slotId: "slot-1", requestedBy: "Dana" },
      { kind: "stop", slotId: "slot-1", reason: "the CEO cancelled the task", issueNumber: 39, discard: true },
    ]);
    expect(state.work.has(workKey(39))).toBe(false);
    expect(fired).toEqual([AGENT]);
    expect(rejected).toEqual([]);
    expect(announced).toEqual(["Dana fired Maya, whose work on #39 was thrown away."]);
  });

  it("refuses to fire an agent already on its way out", () => {
    const { maya, send, commands, fired, rejected } = setup();
    maya.fired = true;
    send("dana", { agentId: AGENT, action: "fire" });
    expect(rejected.map(({ event }) => event.rejection)).toEqual([AGENT_ACTION_REJECTION.leaving]);
    expect(commands()).toEqual([]);
    expect(fired).toEqual([]);
  });
});
