/**
 * Everything the client sends the office, as one method per message.
 *
 * Kept apart from `./room.ts`, which owns the socket and the state it
 * replicates: every new command lands here instead of in the file every
 * feature edits. Each one goes nowhere while no room is attached; the server
 * decides what comes of it, and its answer arrives as state or an event.
 */

import {
  type AgentAction,
  type AgentActionMessage,
  type AgentKey,
  type AgentKeyMessage,
  type AgentProfile,
  type AgentProfileMessage,
  type AgentPromptMessage,
  ANIMATION_STATE,
  type BoardRefreshMessage,
  type ChatMessage,
  CLIENT_MESSAGE,
  type DeskTerminalOffMessage,
  type DeskTerminalSizeMessage,
  type Emote,
  type EmoteMessage,
  type InteractMessage,
  type IssueState,
  type IssueStateMessage,
  type LiftRideMessage,
  type ManagerSayMessage,
  type OfficeState,
  POSE_SEND_INTERVAL_MS,
  type PoseMessage,
  type RenameMessage,
  type RadioTuneMessage,
  type TvChannel,
  type ReportedAnimation,
  STANDING_ACTION,
  type StandingClientMessage,
  type StandingCreateMessage,
  type StandingRescheduleMessage,
  type StandingSchedule,
  type StandingTaskAction,
  type StandingTaskMessage,
  type StandupDirectMessage,
  type WorkAssignMessage,
  type WorkMoveMessage,
  type WorkReleaseMessage,
  type WorkStatus,
} from "@sim/shared";
import type { Room } from "colyseus.js";

/** The local pose as reported to the server: only states a client may claim. */
export interface ReportedPose {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly animation: ReportedAnimation;
}

/** The message each standing task button sends. */
const STANDING_MESSAGES: Readonly<Record<StandingTaskAction, StandingClientMessage>> = {
  [STANDING_ACTION.pause]: CLIENT_MESSAGE.standingPause,
  [STANDING_ACTION.resume]: CLIENT_MESSAGE.standingResume,
  [STANDING_ACTION.remove]: CLIENT_MESSAGE.standingRemove,
  [STANDING_ACTION.checkNow]: CLIENT_MESSAGE.standingCheckNow,
};

export abstract class RoomCommands {
  protected room: Room<OfficeState> | undefined;

  private lastSentAt = Number.NEGATIVE_INFINITY;
  private readonly lastSent = {
    x: Number.NaN,
    z: Number.NaN,
    yaw: Number.NaN,
    animation: ANIMATION_STATE.idle as ReportedAnimation,
  };

  /** Asks to use an interactable. The server decides; there is no reply. */
  public sendInteract(target: string): void {
    this.room?.send(CLIENT_MESSAGE.interact, { target } satisfies InteractMessage);
  }

  /** Asks to be let go of whatever the local player is engaged with. */
  public sendRelease(): void {
    this.room?.send(CLIENT_MESSAGE.release, {});
  }

  /** Gives an issue to an agent. Like every work command, the state patch is the reply. */
  public sendWorkAssign(issueNumber: number, assigneeId: string): void {
    this.room?.send(CLIENT_MESSAGE.workAssign, { issueNumber, assigneeId } satisfies WorkAssignMessage);
  }

  /** Takes an issue back off the agent it was given to. */
  public sendWorkRelease(issueNumber: number): void {
    this.room?.send(CLIENT_MESSAGE.workRelease, { issueNumber } satisfies WorkReleaseMessage);
  }

  /** Moves an issue's work a step: approve it, send it back, have it tried again. */
  public sendWorkMove(issueNumber: number, status: WorkStatus): void {
    this.room?.send(CLIENT_MESSAGE.workMove, { issueNumber, status } satisfies WorkMoveMessage);
  }

  /** Closes or reopens an issue on GitHub; the answer comes as an `issue:state-result`. */
  public sendIssueState(issueNumber: number, state: IssueState): void {
    this.room?.send(CLIENT_MESSAGE.issueState, { issueNumber, state } satisfies IssueStateMessage);
  }

  /**
   * Reports the local pose, at most once per {@link POSE_SEND_INTERVAL_MS}.
   *
   * A pose identical to the last one sent is skipped: a player standing still
   * has nothing to report, and the server already shows them idle.
   */
  public sendPose(pose: ReportedPose, nowMs: number): void {
    const room = this.room;
    if (room === undefined || nowMs - this.lastSentAt < POSE_SEND_INTERVAL_MS) {
      return;
    }
    if (
      pose.x === this.lastSent.x &&
      pose.z === this.lastSent.z &&
      pose.yaw === this.lastSent.yaw &&
      pose.animation === this.lastSent.animation
    ) {
      return;
    }

    this.lastSent.x = pose.x;
    this.lastSent.z = pose.z;
    this.lastSent.yaw = pose.yaw;
    this.lastSent.animation = pose.animation;
    this.lastSentAt = nowMs;
    room.send(CLIENT_MESSAGE.pose, {
      x: pose.x,
      z: pose.z,
      yaw: pose.yaw,
      animation: pose.animation,
    } satisfies PoseMessage);
  }

  /**
   * Fires an emote.
   *
   * Nothing is drawn locally in response: the emote is drawn when the server
   * broadcasts it back, which is the same path every other client sees. An
   * emote the server rate-limited away therefore does not appear above the
   * sender's own head either, which is the honest thing to show.
   */
  public sendEmote(emote: Emote): void {
    this.room?.send(CLIENT_MESSAGE.emote, { emote } satisfies EmoteMessage);
  }

  /** Tells the others the local player jumped; the local avatar has already left the floor. */
  public sendJump(): void {
    this.room?.send(CLIENT_MESSAGE.jump);
  }

  /** Tells the AI manager something. The conversation broadcast is the reply. */
  public sendManagerSay(text: string): void {
    this.room?.send(CLIENT_MESSAGE.managerSay, { text } satisfies ManagerSayMessage);
  }

  /**
   * Asks for a prompt to be typed into a coding agent's terminal. The
   * broadcast of it typed is the reply, or a rejection to this client alone.
   *
   * @returns whether it went out at all.
   */
  public sendAgentPrompt(agentId: string, text: string): boolean {
    if (this.room === undefined) {
      return false;
    }
    this.room.send(CLIENT_MESSAGE.agentPrompt, { agentId, text } satisfies AgentPromptMessage);
    return true;
  }

  /**
   * Asks for a key to be pressed on the choice screen a coding agent waits
   * on. Its terminal is the reply, or a rejection to this client alone.
   *
   * @returns whether it went out at all.
   */
  public sendAgentKey(agentId: string, key: AgentKey): boolean {
    if (this.room === undefined) {
      return false;
    }
    this.room.send(CLIENT_MESSAGE.agentKey, { agentId, key } satisfies AgentKeyMessage);
    return true;
  }

  /** Says how many cells the CEO's desk terminal panel has room for, which its session's terminal is sized to. */
  public sendDeskTerminalSize(cols: number, rows: number): void {
    this.room?.send(CLIENT_MESSAGE.deskTerminalSize, { cols, rows } satisfies DeskTerminalSizeMessage);
  }

  /** Turns one of the CEO's desks' computers off, ending that desk's session alone. */
  public sendDeskTerminalOff(seatId: string): void {
    this.room?.send(CLIENT_MESSAGE.deskTerminalOff, { seatId } satisfies DeskTerminalOffMessage);
  }

  /**
   * Asks for a coding agent's profile to be edited. The state patch, once its
   * runner has it, is the reply, or a rejection to this client alone.
   *
   * @returns whether it went out at all.
   */
  public sendAgentProfile(agentId: string, profile: AgentProfile): boolean {
    if (this.room === undefined) {
      return false;
    }
    this.room.send(CLIENT_MESSAGE.agentProfile, { agentId, ...profile } satisfies AgentProfileMessage);
    return true;
  }

  /** Cancels a coding agent's task, or fires it. The state patch is the reply, or a rejection to this client alone. */
  public sendAgentAction(agentId: string, action: AgentAction): void {
    this.room?.send(CLIENT_MESSAGE.agentAction, { agentId, action } satisfies AgentActionMessage);
  }

  /** Pauses, resumes, removes or checks a standing task. The state patch is the reply, or a rejection to this client alone. */
  public sendStanding(action: StandingTaskAction, taskId: string): void {
    this.room?.send(STANDING_MESSAGES[action], { taskId } satisfies StandingTaskMessage);
  }

  /** Changes how often a standing task runs, from the wall board. The state patch is the reply, or a rejection to this client alone. */
  public sendStandingReschedule(taskId: string, schedule: StandingSchedule): void {
    this.room?.send(CLIENT_MESSAGE.standingReschedule, { taskId, schedule } satisfies StandingRescheduleMessage);
  }

  /** Sets a new standing task up, from the wall board's form. The state patch is the reply, or a rejection to this client alone. */
  public sendStandingCreate(task: StandingCreateMessage): void {
    this.room?.send(CLIENT_MESSAGE.standingCreate, task);
  }

  /** Asks for a standing task's last runs, for the wall board; they come back to this client alone. */
  public requestStandingHistory(taskId: string): void {
    this.room?.send(CLIENT_MESSAGE.standingHistory, { taskId } satisfies StandingTaskMessage);
  }

  /** Calls a standup. The standup in the next patch is the reply, or a rejection to this client alone. */
  public sendStandupStart(): void {
    this.room?.send(CLIENT_MESSAGE.standupStart, {});
  }

  /** Ends the standup. */
  public sendStandupEnd(): void {
    this.room?.send(CLIENT_MESSAGE.standupEnd, {});
  }

  /**
   * Gives one agent at the standup, or every one for `STANDUP_EVERYONE`, a
   * direction; its record in the standup says what came of it.
   *
   * @returns whether it went out at all.
   */
  public sendStandupDirection(agentId: string, text: string): boolean {
    if (this.room === undefined) {
      return false;
    }
    this.room.send(CLIENT_MESSAGE.standupDirect, { agentId, text } satisfies StandupDirectMessage);
    return true;
  }

  /** Asks for a new display name. The state patch is the reply, or a rejection to this client alone. */
  public sendRename(name: string): void {
    this.room?.send(CLIENT_MESSAGE.rename, { name } satisfies RenameMessage);
  }

  /** Asks for the building's floors, from beside a lift; they come back to this client alone. */
  public sendLiftFloors(): void {
    this.room?.send(CLIENT_MESSAGE.liftFloors, {});
  }

  /** Rides the lift to a floor; the reply is a seat there, which the connection takes, or a rejection. */
  public sendLiftRide(floor: number): void {
    this.room?.send(CLIENT_MESSAGE.liftRide, { floor } satisfies LiftRideMessage);
  }

  /** Tunes the office radio to a station id or a raw link; the next patch is the reply, or a rejection to this client alone. */
  public sendRadioTune(source: string): void {
    this.room?.send(CLIENT_MESSAGE.radioTune, { source } satisfies Record<keyof RadioTuneMessage, string>);
  }

  /**
   * Switches the conference room's TV, with a raw link for its YouTube
   * channel; the next patch is the reply, or a rejection to this client alone.
   */
  public sendTvTune(channel: TvChannel, link?: string): void {
    this.room?.send(CLIENT_MESSAGE.tvTune, link === undefined ? { channel } : { channel, link });
  }

  /**
   * Has the server fetch the project board from GitHub now; it answers this
   * client alone once done or refused.
   *
   * @returns whether it went out at all.
   */
  public sendBoardRefresh(): boolean {
    if (this.room === undefined) {
      return false;
    }
    this.room.send(CLIENT_MESSAGE.boardRefresh, {} satisfies BoardRefreshMessage);
    return true;
  }

  /** Says something out loud. Echoed back by the server, like an emote. */
  public sendChat(text: string): void {
    this.room?.send(CLIENT_MESSAGE.chat, { text } satisfies ChatMessage);
  }
}
