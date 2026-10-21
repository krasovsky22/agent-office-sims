/**
 * Everything an office room builds around the agent runners, built in one place.
 *
 * The runners' link, the work rules' host, the CEO's prompts and standing
 * tasks, the standup and the desk terminal all reach into one another, and
 * each brings handlers the room registers. Wired here rather than in
 * `OfficeRoom.onCreate`, so a new runner feature adds to this file instead of
 * the room every feature edits; the room keeps the tick that steps them.
 *
 * A room given no runner still gets the work rules, the prompts, the standup
 * and the desk terminal: each of them is told there is no runner and refuses,
 * or does without, on its own.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  OFFICE_LAYOUT,
  type OfficeState,
  type ProjectBoardSnapshot,
  SERVER_MESSAGE,
  type ScreenFramesEvent,
  type ThrottledEvent,
  parseDeskTerminalOffMessage,
  parseDeskTerminalSizeMessage,
} from "@sim/shared";

import { AgentPrompts } from "../agents/agentPrompts.js";
import { DeskTerminal } from "../agents/deskTerminal.js";
import type { RunnerEventInbox, RunnerSpendSource } from "../agents/runnerLink.js";
import { RunnerWork } from "../agents/runnerWork.js";
import type { ScreenSource } from "../agents/screens.js";
import { StandingAnnouncer } from "../agents/standingAnnouncer.js";
import { StandingControl } from "../agents/standingControl.js";
import type { StandingMirror } from "../agents/standingMirror.js";
import { AgentMessages } from "../manager/agentMessages.js";
import { recordOfficeEvent } from "../sim/events.js";
import type { LiveAgentCrew } from "../sim/liveAgents.js";
import { StandupMeeting } from "../sim/standup.js";
import type { OfficeRoomOptions } from "./OfficeRoom.js";
import { registerAgentActionHandlers } from "./agentActionHandlers.js";
import { registerAgentProfileHandlers } from "./agentProfileHandlers.js";
import { registerAgentPromptHandlers } from "./agentPromptHandlers.js";
import { type IssueStates, registerIssueStateHandler } from "./issueStateHandlers.js";
import { registerStandingHandlers } from "./standingHandlers.js";
import { registerStandupHandlers } from "./standupHandlers.js";
import { type WorkHost, registerWorkHandlers } from "./workHandlers.js";

/** What the wiring needs from the room beyond the room itself. */
export interface RunnerWiringHost {
  readonly services: Partial<OfficeRoomOptions>;
  /** The bodies of the live coding agents, which the standup gathers and a firing walks out. */
  readonly crew: LiveAgentCrew;
  /** The project board as of now, for the work rules; `undefined` in a room given no feed. */
  readonly board: () => ProjectBoardSnapshot | undefined;
  /** Charges one message against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client, command: ThrottledEvent["command"]) => boolean;
  /** Says something out loud on an occupant's behalf. */
  readonly say: (occupantId: string, text: string) => void;
  /** Tells the office something in the AI Manager's voice, if the room has one. */
  readonly announce: (text: string) => void;
}

/** What the room's tick, joins and manager read off the wiring. */
export interface RunnerWiring {
  readonly workHost: WorkHost;
  /** This room's share of the runners' events, drained by the tick. */
  readonly runnerEvents: RunnerEventInbox | undefined;
  /** The runners' side of the work; unset in a room given no runner. */
  readonly runnerWork: RunnerWork | undefined;
  /** Read every tick into the state's books; unset in a room given no runner. */
  readonly runnerSpend: RunnerSpendSource | undefined;
  readonly issueStates: IssueStates | undefined;
  /** The runner slots' terminal screens, sent whole to each joining client. */
  readonly screens: ScreenSource | undefined;
  /** The runners' standing tasks, copied into the state when they change; unset in a room given no runner. */
  readonly standing: StandingMirror | undefined;
  /** The CEO's say over the standing tasks, for the roster's buttons and the manager alike. */
  readonly standingControl: StandingControl | undefined;
  readonly standingAnnouncer: StandingAnnouncer | undefined;
  /** The CEO's prompts to the runners' agents. */
  readonly agentPrompts: AgentPrompts;
  /** The CEO's words the AI Manager passes to the runners' agents. */
  readonly agentMessages: AgentMessages;
  readonly standup: StandupMeeting;
  readonly deskTerminal: DeskTerminal;
  /** Lets go of the runners when the room closes. */
  readonly dispose: () => void;
}

export function wireRunners(
  room: Pick<Room<OfficeState>, "state" | "onMessage" | "broadcast" | "clients" | "clock" | "roomId">,
  host: RunnerWiringHost,
): RunnerWiring {
  const { services } = host;
  const { state } = room;
  const runnerEvents = services.runnerEvents?.openEventInbox();
  const screens = services.screens;
  // Called from the screens route as each batch is accepted, between ticks.
  const stopRelayingScreens = screens?.onScreens((event) => {
    room.broadcast(SERVER_MESSAGE.screens, event satisfies ScreenFramesEvent);
  });

  // `Date.now()` rather than the room's clock, because a work timestamp is read
  // as a wall-clock date, not as an offset from this room's start.
  const workHost: WorkHost = {
    state,
    now: () => Date.now(),
    board: host.board,
    observe: (change) => {
      runnerWork?.changed(change);
    },
  };
  const runnerCommands = services.runnerCommands;
  const runnerWork =
    runnerCommands === undefined
      ? undefined
      : new RunnerWork({ host: workHost, runner: runnerCommands, log: recordOfficeEvent, announce: host.announce });
  registerWorkHandlers(room, workHost);
  const issueStates = services.issueStates;
  registerIssueStateHandler(room, { state, board: host.board, issues: issueStates });

  const standing = runnerCommands === undefined ? undefined : services.standing;
  let standingControl: StandingControl | undefined;
  let standingAnnouncer: StandingAnnouncer | undefined;
  if (standing !== undefined && runnerCommands !== undefined) {
    standingControl = new StandingControl({ directory: standing, commands: runnerCommands });
    // GitHub answers an issue's link for a pull request's number by going to the pull request.
    const pullUrl = (number: number): string => runnerCommands.issueUrl(number).replace(/\/issues\/(\d+)$/, "/pull/$1");
    standingAnnouncer = new StandingAnnouncer({
      pullUrl,
      taskName: (taskId) => standing.standingTasks().find((record) => record.report.id === taskId)?.report.name,
      taskKind: (taskId) => standing.standingTasks().find((record) => record.report.id === taskId)?.report.kind,
      occupantName: (occupantId) => state.occupants.get(occupantId)?.name,
      announce: host.announce,
      refused: (taskId) => standing.refused(taskId),
    });
    registerStandingHandlers(room, {
      state,
      control: standingControl,
      allow: host.allow,
      // Links built here, on the board's repository, never taken from a runner.
      history: (taskId) =>
        standing.standingRuns(taskId).map((run) => ({
          ...run,
          url: run.pr === undefined ? "" : `${pullUrl(run.pr.number)}${run.commentId === undefined ? "" : `#issuecomment-${run.commentId}`}`,
        })),
    });
  }

  const agentPrompts = new AgentPrompts({
    state,
    runner: runnerCommands,
    now: () => Date.now(),
    refuse: (sessionId, event) => {
      room.clients.getById(sessionId)?.send(SERVER_MESSAGE.agentPromptRejected, event);
    },
    publish: (entry) => {
      room.broadcast(SERVER_MESSAGE.agentPrompted, entry);
    },
    log: recordOfficeEvent,
    directed: (commandId, outcome) => {
      standup.settle(commandId, outcome);
      agentMessages.settle(commandId, outcome);
    },
  });
  const agentMessages = new AgentMessages({ state, prompts: runnerCommands === undefined ? undefined : agentPrompts, report: host.announce });
  registerAgentPromptHandlers(room, {
    state,
    prompts: agentPrompts,
    allow: (client) => host.allow(client, CLIENT_MESSAGE.agentPrompt),
    allowKey: (client) => host.allow(client, CLIENT_MESSAGE.agentKey),
  });
  registerAgentProfileHandlers(room, {
    state,
    runner: runnerCommands,
    allow: (client) => host.allow(client, CLIENT_MESSAGE.agentProfile),
    log: recordOfficeEvent,
  });
  registerAgentActionHandlers(room, {
    work: workHost,
    runner: runnerCommands,
    fire: (agentId) => {
      host.crew.fire(agentId, room.clock.currentTime);
    },
    announce: host.announce,
    allow: (client) => host.allow(client, CLIENT_MESSAGE.agentAction),
    log: recordOfficeEvent,
  });

  const runnerStandup = services.runnerStandup;
  const standup = new StandupMeeting({
    state,
    layout: OFFICE_LAYOUT,
    crew: host.crew,
    now: () => Date.now(),
    clock: () => room.clock.currentTime,
    prompts: runnerCommands === undefined ? undefined : agentPrompts,
    say: host.say,
    report: host.announce,
    hold: (on) => runnerStandup?.holdForStandup(room.roomId, on),
    log: recordOfficeEvent,
  });
  registerStandupHandlers(room, {
    state,
    standup,
    allowCall: (client) => host.allow(client, CLIENT_MESSAGE.standupStart),
    allowDirection: (client) => host.allow(client, CLIENT_MESSAGE.standupDirect),
  });

  const deskTerminal = new DeskTerminal({ state, layout: OFFICE_LAYOUT, runner: runnerCommands, log: recordOfficeEvent });
  room.onMessage(CLIENT_MESSAGE.deskTerminalSize, (client, raw: unknown) => {
    // Kept, not acted on: the tick's step sends a changed size at most once.
    const size = parseDeskTerminalSizeMessage(raw);
    if (size !== undefined) {
      deskTerminal.resize(client.sessionId, size.cols, size.rows);
    }
  });
  room.onMessage(CLIENT_MESSAGE.deskTerminalOff, (client, raw: unknown) => {
    const off = parseDeskTerminalOffMessage(raw);
    if (off !== undefined) {
      deskTerminal.turnOff(client.sessionId, off.seatId);
    }
  });

  return {
    workHost,
    runnerEvents,
    runnerWork,
    runnerSpend: services.runnerSpend,
    issueStates,
    screens,
    standing,
    standingControl,
    standingAnnouncer,
    agentPrompts,
    agentMessages,
    standup,
    deskTerminal,
    dispose: () => {
      runnerEvents?.close();
      stopRelayingScreens?.();
      deskTerminal.dispose();
      // A room closing mid-standup must not leave the runners' agents paused.
      runnerStandup?.holdForStandup(room.roomId, false);
    },
  };
}
