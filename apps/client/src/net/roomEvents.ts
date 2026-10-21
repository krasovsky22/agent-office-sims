/**
 * What the connection in `./room.ts` tells its caller, and the server events it
 * passes straight on.
 *
 * Expression, the board's snapshot, the conversations and every rejection
 * arrive as events rather than state, so there is nothing to diff: the server
 * has already validated and sanitized each one, and the connection's job is
 * only to hand it to the caller. A new event is one line in the table below.
 */

import type { BrainstormData, BrainstormRejectedEvent } from "@sim/shared";
import {
  type AgentActionRejectedEvent,
  type AgentProfileRejectedEvent,
  type AgentPromptEntry,
  type AgentPromptHistoryEvent,
  type AgentPromptRejectedEvent,
  type BoardRefreshResultEvent,
  type CeoChangedEvent,
  type ChatEvent,
  type EmoteEvent,
  type IssueStateResultEvent,
  type JumpEvent,
  type LiftFloorsEvent,
  type LiftRejectedEvent,
  type ManagerEntry,
  type ManagerHistoryEvent,
  type ManagerRejectedEvent,
  type NameRejectedEvent,
  type ProjectBoardSnapshot,
  type RadioRejectedEvent,
  type RunnerSpendTotal,
  SERVER_MESSAGE,
  type ServerMessageType,
  type StandingHistoryEvent,
  type StandingRejectedEvent,
  type StandupData,
  type StandupRejectedEvent,
  type ThrottledEvent,
  type TvRejectedEvent,
  type WorkData,
  type WorkRejectedEvent,
} from "@sim/shared";
import type { Room } from "colyseus.js";

import type { StandingTaskData } from "../standingAccess.js";
import type { ConnectionStatus } from "./room.js";

export interface RoomConnectionEvents {
  /** An occupant arrived, left, was renamed, became CEO, or an agent changed status. */
  onOccupantsChanged?: () => void;
  onStatusChanged?: (status: ConnectionStatus, detail?: string) => void;
  /** The local player's starting pose, as the server assigned it. */
  onLocalSpawn?: (x: number, z: number, yaw: number) => void;
  /** An occupant emoted. Fired for the local player too, via the server. */
  onEmote?: (event: EmoteEvent) => void;
  /** Another occupant jumped; the local player's own jump is not echoed back. */
  onJump?: (event: JumpEvent) => void;
  /** An occupant said something. Fired for the local player too. */
  onChat?: (event: ChatEvent) => void;
  /** The local client's own emote or chat was dropped by the rate limiter. */
  onThrottled?: (event: ThrottledEvent) => void;
  /** The project board's snapshot, on joining and whenever the server's feed replaces it. */
  onProjectBoard?: (snapshot: ProjectBoardSnapshot) => void;
  /** The server fetched the board, or refused to yet, for the local client's own Refresh. */
  onBoardRefreshResult?: (event: BoardRefreshResultEvent) => void;
  /** The in-game clock moved on a minute, which is several times a second. */
  onClockChanged?: (minuteOfDay: number) => void;
  /** What the runners' real agents have spent today, or their budgets, changed. */
  onSpendChanged?: (spend: RunnerSpendTotal) => void;
  /** The office refused one of the local client's own work commands. */
  onWorkRejected?: (event: WorkRejectedEvent) => void;
  /** GitHub answered, or the office refused, one of the local client's own drops on Closed or Open. */
  onIssueStateResult?: (event: IssueStateResultEvent) => void;
  /** The CEO left and the role passed to someone else. */
  onCeoChanged?: (event: CeoChangedEvent) => void;
  /** All the agents' work, after any of it is added, changed or removed. */
  onWorkChanged?: (work: readonly WorkData[]) => void;
  /** The conversation with the manager so far, on joining and on every reconnection. */
  onManagerHistory?: (entries: readonly ManagerEntry[]) => void;
  /** One new line in that conversation, from the CEO or the manager. */
  onManagerEntry?: (entry: ManagerEntry) => void;
  /** The manager did not take one of the local client's own messages. */
  onManagerRejected?: (event: ManagerRejectedEvent) => void;
  /** The prompts typed into the coding agents' terminals lately, on joining. */
  onAgentPromptHistory?: (entries: readonly AgentPromptEntry[]) => void;
  /** A prompt was typed into a coding agent's terminal, the local player's own included. */
  onAgentPrompted?: (entry: AgentPromptEntry) => void;
  /** One of the local client's own prompts was not typed, or keys not pressed, and why. */
  onAgentPromptRejected?: (event: AgentPromptRejectedEvent) => void;
  /** One of the local client's own edits to an agent's profile was not passed on, and why. */
  onAgentProfileRejected?: (event: AgentProfileRejectedEvent) => void;
  /** The name the local player asked for, on joining or renaming, is someone else's in the office. */
  onNameRejected?: (event: NameRejectedEvent) => void;
  /** The local client's own cancel or firing was not carried out, and why. */
  onAgentActionRejected?: (event: AgentActionRejectedEvent) => void;
  /** The runners' standing tasks, after any of them is added, changed or removed. */
  onStandingChanged?: (tasks: readonly StandingTaskData[]) => void;
  /** The office did nothing about one of the local client's standing task buttons. */
  onStandingRejected?: (event: StandingRejectedEvent) => void;
  /** A standing task's last runs, which the local client asked for from the wall board. */
  onStandingHistory?: (event: StandingHistoryEvent) => void;
  /** The standup, after any of it changed: called, an update given, a direction's fate, ended. */
  onStandupChanged?: (standup: StandupData) => void;
  /** The office refused one of the local client's own standup commands. */
  onStandupRejected?: (event: StandupRejectedEvent) => void;
  /** The office's brainstorm tickets, after any of them changed: a write-up in, a meeting, a conversion. */
  onBrainstormsChanged?: (brainstorms: readonly BrainstormData[]) => void;
  /** The office refused one of the local client's own brainstorm commands. */
  onBrainstormRejected?: (event: BrainstormRejectedEvent) => void;
  /** The radio did not take the local client's own tune, and kept playing. */
  onRadioRejected?: (event: RadioRejectedEvent) => void;
  /** The TV did not take the local client's own change, and kept showing what it had. */
  onTvRejected?: (event: TvRejectedEvent) => void;
  /** Which floor of how many the office is, as the state first says and whenever the lift changes it. */
  onFloorChanged?: (floor: number, floors: number) => void;
  /** The building's floors, which the local client asked for at a lift. */
  onLiftFloors?: (event: LiftFloorsEvent) => void;
  /** The lift would not take the local client, who stays where they are. */
  onLiftRejected?: (event: LiftRejectedEvent) => void;
  /** The lift is taking the local client to another floor; the floor left is cleared away as it goes. */
  onRide?: (floor: number) => void;
}

/** The server events handed to the caller whole, by the handler each one goes to. */
const FORWARDED = {
  [SERVER_MESSAGE.emote]: "onEmote",
  [SERVER_MESSAGE.jump]: "onJump",
  [SERVER_MESSAGE.chat]: "onChat",
  [SERVER_MESSAGE.throttled]: "onThrottled",
  [SERVER_MESSAGE.projectBoard]: "onProjectBoard",
  [SERVER_MESSAGE.boardRefreshResult]: "onBoardRefreshResult",
  [SERVER_MESSAGE.workRejected]: "onWorkRejected",
  [SERVER_MESSAGE.issueStateResult]: "onIssueStateResult",
  [SERVER_MESSAGE.ceoChanged]: "onCeoChanged",
  [SERVER_MESSAGE.managerEntry]: "onManagerEntry",
  [SERVER_MESSAGE.managerRejected]: "onManagerRejected",
  [SERVER_MESSAGE.agentPrompted]: "onAgentPrompted",
  [SERVER_MESSAGE.agentPromptRejected]: "onAgentPromptRejected",
  [SERVER_MESSAGE.agentProfileRejected]: "onAgentProfileRejected",
  [SERVER_MESSAGE.nameRejected]: "onNameRejected",
  [SERVER_MESSAGE.agentActionRejected]: "onAgentActionRejected",
  [SERVER_MESSAGE.standingRejected]: "onStandingRejected",
  [SERVER_MESSAGE.standingHistory]: "onStandingHistory",
  [SERVER_MESSAGE.standupRejected]: "onStandupRejected",
  [SERVER_MESSAGE.brainstormRejected]: "onBrainstormRejected",
  [SERVER_MESSAGE.radioRejected]: "onRadioRejected",
  [SERVER_MESSAGE.tvRejected]: "onTvRejected",
  [SERVER_MESSAGE.liftFloors]: "onLiftFloors",
  [SERVER_MESSAGE.liftRejected]: "onLiftRejected",
} as const satisfies Partial<Record<ServerMessageType, keyof RoomConnectionEvents>>;

/** Passes every event-borne message on to the caller's handler for it, looked up as each one arrives. */
export function forwardServerEvents(room: Room, events: RoomConnectionEvents): void {
  for (const [type, handler] of Object.entries(FORWARDED)) {
    room.onMessage(type, (event: unknown) => {
      (events[handler] as ((event: unknown) => void) | undefined)?.(event);
    });
  }

  // Each history arrives wrapped, and is handed on as its lines alone.
  room.onMessage<ManagerHistoryEvent>(SERVER_MESSAGE.managerHistory, (event) => {
    events.onManagerHistory?.(event.entries);
  });
  room.onMessage<AgentPromptHistoryEvent>(SERVER_MESSAGE.agentPromptHistory, (event) => {
    events.onAgentPromptHistory?.(event.entries);
  });
}
