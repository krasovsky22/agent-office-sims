/**
 * The Colyseus connection, and the translation from replicated state to what the
 * renderer draws.
 *
 * Remote occupants are **interpolated, not snapped**. Poses arrive 20 times a
 * second, which is well under the frame rate, so drawing each remote avatar at
 * the newest pose received would step it forward in visible jumps and stutter
 * whenever a packet arrived late. Instead every pose is kept in a short
 * per-occupant buffer and each avatar is rendered
 * {@link INTERPOLATION_DELAY_MS} behind the present, between the two samples
 * that straddle that moment. The cost is a fixed fraction of a second of
 * staleness; the gain is that remote movement looks continuous.
 *
 * The local player is not interpolated — it is predicted, by the controller —
 * so its authoritative pose is exposed separately for reconciliation.
 *
 * Expression — emotes, chat — does not come through state at all. It arrives as
 * server events and is handed straight to the caller, including the local
 * player's own: everything renders on the path the server published it on, so
 * what you see above your own head is what everyone else sees above it. The
 * project board's GitHub snapshot arrives the same way, whole, on joining and on
 * every change. The clock that lights the office does not: it is state, and is
 * read off each patch.
 *
 * A dropped socket is reconnected rather than given up on. The server holds a
 * dropped player's place, and with it their role, for
 * {@link RECONNECT_GRACE_SECONDS}; reconnecting inside that window resumes the
 * same session, so a CEO whose wifi blinks is still the CEO afterwards. A
 * session the server no longer knows — it restarted, as every deploy does — is
 * joined afresh under the same name instead, and anything else ends in a status
 * the HUD offers to {@link RoomConnection.rejoin} from.
 *
 * The agents' work on the project board's issues is state too, and is handed
 * on as a fresh plain copy whenever any of it changes, so the panel re-renders
 * from a value rather than holding a schema object that mutates under it. So
 * are the runners' standing tasks, for the roster, and the standup.
 *
 * The conversation with the AI manager is not: like chat it arrives as events —
 * the lines so far on joining, then each new one — and the manager's own badge
 * is read off its occupant. The prompts the CEO typed into the coding agents'
 * terminals arrive the same way.
 *
 * Nor are the live agents' terminal screens, which change several times a
 * second. Each is kept here, whole, by occupant (`./screens.ts`), and read by
 * the game loop when it is time to repaint one; nothing is notified.
 */

import {
  type AgentPromptEntry,
  type AgentPromptHistoryEvent,
  type AgentKey,
  type AgentKeyMessage,
  type DeskTerminalSizeMessage,
  type AgentProfile,
  type AgentAction,
  type AgentActionMessage,
  type AgentActionRejectedEvent,
  type AgentProfileMessage,
  type AgentProfileRejectedEvent,
  type AgentPromptMessage,
  type AgentPromptRejectedEvent,
  ANIMATION_STATE,
  type AnimationState,
  type CeoChangedEvent,
  type ChatEvent,
  type ChatMessage,
  CLIENT_MESSAGE,
  type DeskTerminal,
  type Emote,
  type EmoteEvent,
  type EmoteMessage,
  type JumpEvent,
  INTERPOLATION_DELAY_MS,
  NO_STANDUP,
  type InteractMessage,
  type IssueState,
  type IssueStateMessage,
  type IssueStateResultEvent,
  type IssueWork,
  type LiveAgentStatus,
  type ManagerEntry,
  type ManagerHistoryEvent,
  type ManagerRejectedEvent,
  type ManagerSayMessage,
  type ManagerStatus,
  type NameRejectedEvent,
  OFFICE_ROOM_NAME,
  type Occupant,
  type OccupantKind,
  type OfficeState,
  POSE_BUFFER_SIZE,
  POSE_SEND_INTERVAL_MS,
  type PoseMessage,
  type ProjectBoardSnapshot,
  RECONNECT_GRACE_SECONDS,
  type RenameMessage,
  type ReportedAnimation,
  type RunnerSpendTotal,
  SERVER_MESSAGE,
  STANDING_ACTION,
  type StandingClientMessage,
  type StandingCreateMessage,
  type StandingHistoryEvent,
  type StandingRejectedEvent,
  type StandingRescheduleMessage,
  type StandingSchedule,
  type StandingTaskAction,
  type StandingTaskMessage,
  type ScreenFramesEvent,
  type Standup,
  type StandupData,
  type StandupDirectMessage,
  type StandupRejectedEvent,
  type ThrottledEvent,
  type WorkAssignMessage,
  type WorkData,
  type WorkMoveMessage,
  type WorkRejectedEvent,
  type WorkReleaseMessage,
  type WorkStatus,
  isAiManager,
  isCeo,
  isLiveAgent,
  normalizeYaw,
  shortestYawDelta,
} from "@sim/shared";
import { Client, ErrorCode, MatchMakeError, type Room, getStateCallbacks } from "colyseus.js";

import { type StandingTaskData, copyStandingTask } from "../standingAccess.js";
import { type TerminalScreen, applyScreenFrame } from "./screens.js";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "full"
  | "failed";

/** Pause between reconnection attempts while the server's grace period lasts. */
const RECONNECT_RETRY_MS = 1000;

/** One pose as received, stamped with local arrival time. */
interface PoseSample {
  t: number;
  x: number;
  z: number;
  yaw: number;
  animation: AnimationState;
}

/**
 * What the HUD and the avatar layer need to know about an occupant.
 *
 * Mutated in place as patches arrive rather than replaced, so the game loop can
 * read one every frame without allocating. Only the fields the HUD renders
 * trigger an `onOccupantsChanged`; `interactableId` and `animation` change far
 * too often for that and are read from the loop instead.
 */
export interface OccupantView {
  readonly id: string;
  name: string;
  kind: OccupantKind;
  isCeo: boolean;
  readonly isLocal: boolean;
  /** Interactable this occupant is engaged with, or `""` when free. */
  interactableId: string;
  /** As replicated, so a seated agent can be drawn typing rather than just sitting. */
  animation: AnimationState;
  /** Sips left in the coffee in hand, `0` for no cup; each drop is a sip. */
  coffeeSips: number;
  /** A live coding agent's status, or `undefined` for anyone else. */
  agentStatus: LiveAgentStatus | undefined;
  /** A live agent's task title and link, `""` when it has none. */
  taskTitle: string;
  taskUrl: string;
  /** What a live agent is doing, or waits on while it needs input; `""` when unknown. */
  agentActivity: string;
  /** What the manager has assigned a live agent next, `""` when nothing. */
  assignedTitle: string;
  assignedUrl: string;
  /** Whether a live agent can be given issue work; `false` for anyone else. */
  canTakeIssues: boolean;
  /** A live agent's title, `""` when it has none and for anyone else. */
  agentTitle: string;
  /** A live agent's description, its system prompt with the title; `""` when none. */
  agentDescription: string;
  /** Whether the CEO can edit a live agent's profile from the office; `false` for anyone else. */
  profileEditable: boolean;
  /** Whether a live agent was fired and is walking out; `false` for anyone else. */
  fired: boolean;
  /** The issue whose sticky note a live agent has in hand, `0` when none and for anyone else. */
  carriedIssue: number;
  /** The AI manager's status, or `undefined` for anyone else. */
  managerStatus: ManagerStatus | undefined;
}

/** The local pose as reported to the server: only states a client may claim. */
export interface ReportedPose {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly animation: ReportedAnimation;
}

/** A pose written by {@link RoomConnection.sampleRemote}. */
export interface RemotePose {
  x: number;
  z: number;
  yaw: number;
  animation: AnimationState;
}

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
}

/** The message each standing task button sends. */
const STANDING_MESSAGES: Readonly<Record<StandingTaskAction, StandingClientMessage>> = {
  [STANDING_ACTION.pause]: CLIENT_MESSAGE.standingPause,
  [STANDING_ACTION.resume]: CLIENT_MESSAGE.standingResume,
  [STANDING_ACTION.remove]: CLIENT_MESSAGE.standingRemove,
  [STANDING_ACTION.checkNow]: CLIENT_MESSAGE.standingCheckNow,
};

/** The runners' books as the state replicates them, back as one total. */
export function runnerSpendOf(state: Pick<OfficeState, "spendRunners" | "spentUsd" | "budgeted" | "budgetUsd" | "budgetSpent">): RunnerSpendTotal {
  return {
    runners: state.spendRunners,
    spentUsd: state.spentUsd,
    budgetUsd: state.budgeted ? state.budgetUsd : undefined,
    budgetSpent: state.budgetSpent,
  };
}

export class RoomConnection {
  /** Authoritative pose of the local player, for reconciliation. */
  public readonly localServerPose = { x: 0, z: 0, yaw: 0, known: false };

  private client: Client | undefined;
  /** The name first asked for, which a fresh join after a lost session asks for again. */
  private name = "";
  private room: Room<OfficeState> | undefined;
  /** Set while a join is in flight, so a second click on Rejoin cannot seat the player twice. */
  private joining = false;
  /** Set by {@link leave}, so a deliberate exit is never reconnected. */
  private leaving = false;
  private readonly views = new Map<string, OccupantView>();
  private readonly buffers = new Map<string, PoseSample[]>();
  private readonly screens = new Map<string, TerminalScreen>();

  private workQueued = false;
  private standingQueued = false;
  private standupQueued = false;

  private lastSentAt = Number.NEGATIVE_INFINITY;
  private readonly lastSent = {
    x: Number.NaN,
    z: Number.NaN,
    yaw: Number.NaN,
    animation: ANIMATION_STATE.idle as ReportedAnimation,
  };

  public constructor(private readonly events: RoomConnectionEvents = {}) {}

  public get sessionId(): string {
    return this.room?.sessionId ?? "";
  }

  public async connect(serverUrl: string, name: string): Promise<void> {
    this.client = new Client(serverUrl);
    this.name = name;
    await this.join();
  }

  /** The player's own Rejoin, which overrides an earlier {@link leave}. */
  public async rejoin(): Promise<void> {
    this.leaving = false;
    await this.join();
  }

  /** Joins the office afresh, as a new session; does nothing while one is attached or on its way, or after a leave. */
  private async join(): Promise<void> {
    const client = this.client;
    if (client === undefined || this.room !== undefined || this.joining || this.leaving) {
      return;
    }
    this.joining = true;
    this.events.onStatusChanged?.("connecting");
    try {
      const room = await client.join<OfficeState>(OFFICE_ROOM_NAME, { name: this.name });
      if (this.leaving) {
        void room.leave();
        return;
      }
      this.attach(room);
    } catch (error) {
      if (isOfficeFull(error)) {
        this.events.onStatusChanged?.("full");
      } else {
        this.events.onStatusChanged?.("failed", describeError(error));
      }
      throw error;
    } finally {
      this.joining = false;
    }
  }

  public async leave(): Promise<void> {
    this.leaving = true;
    await this.room?.leave();
    this.room = undefined;
    this.views.clear();
    this.buffers.clear();
    this.screens.clear();
  }

  /** Every occupant currently in the room, in arrival order. */
  public occupants(): OccupantView[] {
    return [...this.views.values()];
  }

  /**
   * The display name of one occupant, for attributing an event to them.
   *
   * `undefined` when the occupant is unknown, which an event can outrun: a
   * message broadcast as its sender disconnects may be decoded after the state
   * patch that removed them.
   */
  public occupantName(id: string): string | undefined {
    return this.views.get(id)?.name;
  }

  /** One occupant, for a game loop that must not allocate. */
  public viewOf(id: string): OccupantView | undefined {
    return this.views.get(id);
  }

  /**
   * A live agent's terminal, as of the latest frame, or `undefined` before the
   * first. Changed in place as frames arrive; its `version` says when.
   */
  public screenOf(id: string): TerminalScreen | undefined {
    return this.screens.get(id);
  }

  /**
   * The occupant holding an interactable, or `undefined` if it is free.
   *
   * Read from replicated state, which makes it the server's answer as of the
   * last patch. Good enough to grey out a prompt; the server decides for real.
   */
  public holderOf(interactableId: string): string | undefined {
    for (const view of this.views.values()) {
      if (view.interactableId === interactableId) {
        return view.id;
      }
    }
    return undefined;
  }

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

  /**
   * The CEO's desk terminal as of the last patch, or `undefined` before the
   * state arrives. Read in place by the game loop, which must not allocate.
   */
  public desk(): DeskTerminal | undefined {
    return this.room?.state.desk;
  }

  /** The label that keeps an issue from the live coding agents; `""` before the state arrives. */
  public agentRestrictLabel(): string {
    return this.room?.state.agentRestrictLabel ?? "";
  }

  /** Whether a connected runner can close and reopen issues on GitHub; `false` before the state arrives. */
  public issuesWritable(): boolean {
    return this.room?.state.issuesWritable ?? false;
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

  /** Says something out loud. Echoed back by the server, like an emote. */
  public sendChat(text: string): void {
    this.room?.send(CLIENT_MESSAGE.chat, { text } satisfies ChatMessage);
  }

  /**
   * Interpolates a remote occupant's pose for the current frame.
   *
   * @param nowMs the frame's timestamp, from the same clock the samples use.
   * @returns whether `out` was written; `false` means nothing has arrived yet.
   */
  public sampleRemote(id: string, nowMs: number, out: RemotePose): boolean {
    const buffer = this.buffers.get(id);
    if (buffer === undefined || buffer.length === 0) {
      return false;
    }

    const renderTime = nowMs - INTERPOLATION_DELAY_MS;
    const oldest = buffer[0];
    const newest = buffer[buffer.length - 1];
    if (oldest === undefined || newest === undefined) {
      return false;
    }

    // Outside the buffered window there is nothing to interpolate between, so
    // hold the nearest sample rather than extrapolating into a guess.
    if (renderTime <= oldest.t) {
      copySample(oldest, out);
      return true;
    }
    if (renderTime >= newest.t) {
      copySample(newest, out);
      return true;
    }

    for (let i = buffer.length - 1; i > 0; i -= 1) {
      const after = buffer[i];
      const before = buffer[i - 1];
      if (after === undefined || before === undefined || before.t > renderTime) {
        continue;
      }
      const span = after.t - before.t;
      const alpha = span <= 0 ? 1 : (renderTime - before.t) / span;
      out.x = before.x + (after.x - before.x) * alpha;
      out.z = before.z + (after.z - before.z) * alpha;
      out.yaw = normalizeYaw(before.yaw + shortestYawDelta(before.yaw, after.yaw) * alpha);
      out.animation = after.animation;
      return true;
    }

    copySample(newest, out);
    return true;
  }

  private attach(room: Room<OfficeState>): void {
    this.room = room;
    this.bind(room);
    this.events.onStatusChanged?.("connected");
  }

  /**
   * Tries to resume a dropped session until the server's grace period ends,
   * or the server says it no longer has it, then joins afresh.
   *
   * Runs on its own async path, between frames; the game loop keeps drawing
   * the office it last knew, and nothing is sent until a room is attached
   * again.
   */
  private async reconnect(token: string): Promise<void> {
    const client = this.client;
    if (client === undefined) {
      return;
    }
    this.events.onStatusChanged?.("reconnecting");
    const deadline = Date.now() + RECONNECT_GRACE_SECONDS * 1000;
    while (!this.leaving && Date.now() < deadline) {
      try {
        const room = await client.reconnect<OfficeState>(token);
        if (this.leaving) {
          void room.leave();
          return;
        }
        this.attach(room);
        return;
      } catch (error) {
        if (isSessionGone(error)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_RETRY_MS));
      }
    }
    await this.join().catch(() => {
      // The status is already on the HUD, and Rejoin with it.
    });
  }

  private bind(room: Room<OfficeState>): void {
    const $ = getStateCallbacks(room);

    $(room.state).occupants.onAdd((occupant, sessionId) => {
      const isLocal = sessionId === room.sessionId;
      const view: OccupantView = {
        id: sessionId,
        name: occupant.name,
        kind: occupant.kind,
        isCeo: isCeo(occupant),
        isLocal,
        interactableId: occupant.interactableId,
        animation: occupant.animation,
        coffeeSips: occupant.coffeeSips,
        agentStatus: isLiveAgent(occupant) ? occupant.status : undefined,
        taskTitle: isLiveAgent(occupant) ? occupant.taskTitle : "",
        taskUrl: isLiveAgent(occupant) ? occupant.taskUrl : "",
        agentActivity: isLiveAgent(occupant) ? occupant.activity : "",
        assignedTitle: isLiveAgent(occupant) ? occupant.assignedTitle : "",
        assignedUrl: isLiveAgent(occupant) ? occupant.assignedUrl : "",
        canTakeIssues: isLiveAgent(occupant) && occupant.canTakeIssues,
        agentTitle: isLiveAgent(occupant) ? occupant.title : "",
        agentDescription: isLiveAgent(occupant) ? occupant.description : "",
        profileEditable: isLiveAgent(occupant) && occupant.profileEditable,
        fired: isLiveAgent(occupant) && occupant.fired,
        carriedIssue: isLiveAgent(occupant) ? occupant.carriedIssue : 0,
        managerStatus: isAiManager(occupant) ? occupant.status : undefined,
      };
      this.views.set(sessionId, view);

      if (isLocal) {
        this.readLocalPose(occupant);
        this.events.onLocalSpawn?.(occupant.x, occupant.z, occupant.yaw);
      } else {
        this.buffers.set(sessionId, [sampleOf(occupant)]);
      }

      $(occupant).onChange(() => {
        this.handleOccupantChange(sessionId, occupant, isLocal, view);
      });

      this.events.onOccupantsChanged?.();
    });

    // Replicated like the occupants, so every client lights the office by the
    // same clock; `listen` fires for the value the first patch carries too.
    $(room.state).listen("minuteOfDay", (minuteOfDay) => {
      this.events.onClockChanged?.(minuteOfDay);
    });

    // What the board offers is worked out with the roster, and a runner that
    // can change issues coming or going changes it.
    $(room.state).listen("issuesWritable", () => {
      this.events.onOccupantsChanged?.();
    });

    // Five fields, one total: whichever of them a patch carries, the HUD hears the whole of it.
    const spendChanged = (): void => {
      this.events.onSpendChanged?.(runnerSpendOf(room.state));
    };
    for (const field of ["spendRunners", "spentUsd", "budgeted", "budgetUsd", "budgetSpent"] as const) {
      $(room.state).listen(field, spendChanged);
    }

    $(room.state).occupants.onRemove((_occupant, sessionId) => {
      this.views.delete(sessionId);
      this.buffers.delete(sessionId);
      this.screens.delete(sessionId);
      this.events.onOccupantsChanged?.();
    });

    $(room.state).work.onAdd((work) => {
      $(work).onChange(() => this.queueWork(room));
      this.queueWork(room);
    });
    $(room.state).work.onRemove(() => this.queueWork(room));

    $(room.state).standing.onAdd((task) => {
      $(task).onChange(() => this.queueStanding(room));
      this.queueStanding(room);
    });
    $(room.state).standing.onRemove(() => this.queueStanding(room));

    // Every part of the standup, down to one direction's fate, comes out as one
    // fresh copy. Bound once the standup itself has arrived: the first patch
    // may not have decoded it yet, and Colyseus' callbacks cannot reach a
    // collection inside a schema that is not there.
    $(room.state).listen("standup", (instance) => {
      const standup = $(instance);
      standup.onChange(() => this.queueStandup(room));
      standup.order.onAdd(() => this.queueStandup(room));
      standup.order.onRemove(() => this.queueStandup(room));
      standup.updates.onAdd((update) => {
        $(update).onChange(() => this.queueStandup(room));
        this.queueStandup(room);
      });
      standup.updates.onRemove(() => this.queueStandup(room));
      standup.directions.onAdd((direction) => {
        $(direction).onChange(() => this.queueStandup(room));
        this.queueStandup(room);
      });
      standup.directions.onRemove(() => this.queueStandup(room));
      this.queueStandup(room);
    });

    // Expression arrives as events rather than state, so there is nothing to
    // diff here: the server has already validated and sanitized each one, and
    // the handler's job is only to pass it on.
    room.onMessage<EmoteEvent>(SERVER_MESSAGE.emote, (event) => {
      this.events.onEmote?.(event);
    });

    room.onMessage<JumpEvent>(SERVER_MESSAGE.jump, (event) => {
      this.events.onJump?.(event);
    });

    room.onMessage<ChatEvent>(SERVER_MESSAGE.chat, (event) => {
      this.events.onChat?.(event);
    });

    room.onMessage<ThrottledEvent>(SERVER_MESSAGE.throttled, (event) => {
      this.events.onThrottled?.(event);
    });

    room.onMessage<ProjectBoardSnapshot>(SERVER_MESSAGE.projectBoard, (snapshot) => {
      this.events.onProjectBoard?.(snapshot);
    });

    room.onMessage<WorkRejectedEvent>(SERVER_MESSAGE.workRejected, (event) => {
      this.events.onWorkRejected?.(event);
    });

    room.onMessage<IssueStateResultEvent>(SERVER_MESSAGE.issueStateResult, (event) => {
      this.events.onIssueStateResult?.(event);
    });

    room.onMessage<CeoChangedEvent>(SERVER_MESSAGE.ceoChanged, (event) => {
      this.events.onCeoChanged?.(event);
    });

    room.onMessage<ManagerHistoryEvent>(SERVER_MESSAGE.managerHistory, (event) => {
      this.events.onManagerHistory?.(event.entries);
    });

    room.onMessage<ManagerEntry>(SERVER_MESSAGE.managerEntry, (entry) => {
      this.events.onManagerEntry?.(entry);
    });

    room.onMessage<ManagerRejectedEvent>(SERVER_MESSAGE.managerRejected, (event) => {
      this.events.onManagerRejected?.(event);
    });

    room.onMessage<AgentPromptHistoryEvent>(SERVER_MESSAGE.agentPromptHistory, (event) => {
      this.events.onAgentPromptHistory?.(event.entries);
    });

    room.onMessage<AgentPromptEntry>(SERVER_MESSAGE.agentPrompted, (entry) => {
      this.events.onAgentPrompted?.(entry);
    });

    room.onMessage<AgentPromptRejectedEvent>(SERVER_MESSAGE.agentPromptRejected, (event) => {
      this.events.onAgentPromptRejected?.(event);
    });

    room.onMessage<AgentProfileRejectedEvent>(SERVER_MESSAGE.agentProfileRejected, (event) => {
      this.events.onAgentProfileRejected?.(event);
    });

    room.onMessage<NameRejectedEvent>(SERVER_MESSAGE.nameRejected, (event) => {
      this.events.onNameRejected?.(event);
    });

    room.onMessage<AgentActionRejectedEvent>(SERVER_MESSAGE.agentActionRejected, (event) => {
      this.events.onAgentActionRejected?.(event);
    });

    room.onMessage<StandingRejectedEvent>(SERVER_MESSAGE.standingRejected, (event) => {
      this.events.onStandingRejected?.(event);
    });

    room.onMessage<StandingHistoryEvent>(SERVER_MESSAGE.standingHistory, (event) => {
      this.events.onStandingHistory?.(event);
    });

    room.onMessage<StandupRejectedEvent>(SERVER_MESSAGE.standupRejected, (event) => {
      this.events.onStandupRejected?.(event);
    });

    // Several times a second, so kept rather than passed on: the game loop
    // reads a screen when it is due a repaint.
    room.onMessage<ScreenFramesEvent>(SERVER_MESSAGE.screens, (event) => {
      for (const { occupantId, frame } of event.screens) {
        this.screens.set(occupantId, applyScreenFrame(this.screens.get(occupantId), frame));
      }
    });

    room.onError((code, message) => {
      this.events.onStatusChanged?.("failed", message ?? `error ${code}`);
    });

    room.onLeave(() => {
      // A room this connection has already moved on from has nothing to clear.
      if (this.room !== room && this.room !== undefined) {
        return;
      }
      this.views.clear();
      this.buffers.clear();
      this.screens.clear();
      this.events.onOccupantsChanged?.();
      this.events.onWorkChanged?.([]);
      this.events.onStandingChanged?.([]);
      this.events.onStandupChanged?.(NO_STANDUP);
      this.room = undefined;
      if (this.leaving) {
        this.events.onStatusChanged?.("disconnected");
        return;
      }
      // Even a clean close is reconnected from: the server never sends one
      // player away, so it is shutting down, and its successor needs joining.
      // Rebuilt from the full state the server sends on reconnection, which
      // re-adds every occupant through the handlers above.
      void this.reconnect(room.reconnectionToken);
    });
  }

  private handleOccupantChange(
    sessionId: string,
    occupant: Occupant,
    isLocal: boolean,
    view: OccupantView,
  ): void {
    const ceo = isCeo(occupant);
    const agent = isLiveAgent(occupant) ? occupant : undefined;
    const agentStatus = agent?.status;
    const taskTitle = agent?.taskTitle ?? "";
    const taskUrl = agent?.taskUrl ?? "";
    const agentActivity = agent?.activity ?? "";
    const assignedTitle = agent?.assignedTitle ?? "";
    const assignedUrl = agent?.assignedUrl ?? "";
    const canTakeIssues = agent?.canTakeIssues ?? false;
    const agentTitle = agent?.title ?? "";
    const agentDescription = agent?.description ?? "";
    const profileEditable = agent?.profileEditable ?? false;
    const fired = agent?.fired ?? false;
    const carriedIssue = agent?.carriedIssue ?? 0;
    const managerStatus = isAiManager(occupant) ? occupant.status : undefined;
    if (isLocal) {
      // A later rejoin asks for the name the player has now, not the one they arrived with.
      this.name = occupant.name;
    }
    if (
      view.name !== occupant.name ||
      view.isCeo !== ceo ||
      view.kind !== occupant.kind ||
      view.agentStatus !== agentStatus ||
      view.taskTitle !== taskTitle ||
      view.taskUrl !== taskUrl ||
      view.agentActivity !== agentActivity ||
      view.assignedTitle !== assignedTitle ||
      view.assignedUrl !== assignedUrl ||
      view.canTakeIssues !== canTakeIssues ||
      view.agentTitle !== agentTitle ||
      view.agentDescription !== agentDescription ||
      view.profileEditable !== profileEditable ||
      view.fired !== fired ||
      view.carriedIssue !== carriedIssue ||
      view.managerStatus !== managerStatus
    ) {
      view.name = occupant.name;
      view.kind = occupant.kind;
      view.isCeo = ceo;
      view.agentStatus = agentStatus;
      view.taskTitle = taskTitle;
      view.taskUrl = taskUrl;
      view.agentActivity = agentActivity;
      view.assignedTitle = assignedTitle;
      view.assignedUrl = assignedUrl;
      view.canTakeIssues = canTakeIssues;
      view.agentTitle = agentTitle;
      view.agentDescription = agentDescription;
      view.profileEditable = profileEditable;
      view.fired = fired;
      view.carriedIssue = carriedIssue;
      view.managerStatus = managerStatus;
      this.events.onOccupantsChanged?.();
    }

    // Deliberately outside that notification: these change as often as
    // someone sits down, and the HUD has no business re-rendering for them.
    view.interactableId = occupant.interactableId;
    view.animation = occupant.animation;
    view.coffeeSips = occupant.coffeeSips;

    if (isLocal) {
      this.readLocalPose(occupant);
      return;
    }

    const buffer = this.buffers.get(sessionId);
    if (buffer === undefined) {
      return;
    }
    const sample = sampleOf(occupant);
    const previous = buffer[buffer.length - 1];
    if (previous !== undefined && previous.t === sample.t) {
      // Two changes decoded in the same frame describe one moment in time.
      buffer[buffer.length - 1] = sample;
      return;
    }
    buffer.push(sample);
    if (buffer.length > POSE_BUFFER_SIZE) {
      buffer.shift();
    }
  }

  /**
   * Publishes the work once per patch, however much of it the patch touched.
   *
   * One patch can carry a change to every issue's work — a join decodes all of
   * it at once — and copying it per field would hand React a burst of
   * intermediate states nobody will see.
   */
  private queueWork(room: Room<OfficeState>): void {
    if (this.workQueued) {
      return;
    }
    this.workQueued = true;
    queueMicrotask(() => {
      this.workQueued = false;
      if (this.room !== room) {
        return;
      }
      this.events.onWorkChanged?.([...room.state.work.values()].map(copyWork));
    });
  }

  /** Publishes the standing tasks once per patch, as {@link queueWork} does the work. */
  private queueStanding(room: Room<OfficeState>): void {
    if (this.standingQueued) {
      return;
    }
    this.standingQueued = true;
    queueMicrotask(() => {
      this.standingQueued = false;
      if (this.room !== room) {
        return;
      }
      this.events.onStandingChanged?.([...room.state.standing.values()].map(copyStandingTask));
    });
  }

  /** Publishes the standup once per patch, however much of it the patch touched, as {@link queueWork} does the work. */
  private queueStandup(room: Room<OfficeState>): void {
    if (this.standupQueued) {
      return;
    }
    this.standupQueued = true;
    queueMicrotask(() => {
      this.standupQueued = false;
      if (this.room !== room) {
        return;
      }
      this.events.onStandupChanged?.(copyStandup(room.state.standup));
    });
  }

  private readLocalPose(occupant: Occupant): void {
    this.localServerPose.x = occupant.x;
    this.localServerPose.z = occupant.z;
    this.localServerPose.yaw = occupant.yaw;
    this.localServerPose.known = true;
  }
}

/** The server opens one office and lets clients only join it, so a join it cannot seat means the office is full. */
export function isOfficeFull(error: unknown): boolean {
  return error instanceof MatchMakeError && error.code === ErrorCode.MATCHMAKE_INVALID_CRITERIA;
}

/**
 * Whether the server answered a reconnection with "no such session", which no
 * retry will change: its room is gone, as after a restart, or the seat expired.
 */
export function isSessionGone(error: unknown): boolean {
  return (
    error instanceof MatchMakeError &&
    (error.code === ErrorCode.MATCHMAKE_INVALID_ROOM_ID || error.code === ErrorCode.MATCHMAKE_EXPIRED)
  );
}

/**
 * Turns whatever the socket threw into something worth putting on screen.
 *
 * A refused WebSocket rejects with a bare `Event`, whose default string form is
 * `[object ProgressEvent]` — true, and useless to the reader.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  if (typeof Event !== "undefined" && error instanceof Event) {
    return "the server refused the connection";
  }
  const described = String(error);
  return described === "" || described.startsWith("[object ") ? "unknown error" : described;
}

function copyWork(work: IssueWork): WorkData {
  return {
    issueNumber: work.issueNumber,
    title: work.title,
    status: work.status,
    assigneeId: work.assigneeId,
    outputArtifact: work.outputArtifact,
    note: work.note,
    assignedAt: work.assignedAt,
    updatedAt: work.updatedAt,
  };
}

/** A plain copy of the replicated standup. */
export function copyStandup(standup: Standup): StandupData {
  return {
    active: standup.active,
    calledBy: standup.calledBy,
    startedAt: standup.startedAt,
    endedAt: standup.endedAt,
    order: standup.order.toArray(),
    speakerId: standup.speakerId,
    updates: standup.updates.map((update) => ({
      agentId: update.agentId,
      agentName: update.agentName,
      workedOn: update.workedOn,
      blockers: update.blockers,
      needsYou: update.needsYou,
      resolved: update.resolved,
      at: update.at,
    })),
    directions: standup.directions.map((direction) => ({
      id: direction.id,
      agentId: direction.agentId,
      agentName: direction.agentName,
      authorName: direction.authorName,
      text: direction.text,
      everyone: direction.everyone,
      status: direction.status,
      reason: direction.reason,
      at: direction.at,
    })),
  };
}

function sampleOf(occupant: Occupant): PoseSample {
  return {
    t: performance.now(),
    x: occupant.x,
    z: occupant.z,
    yaw: occupant.yaw,
    animation: occupant.animation,
  };
}

function copySample(sample: PoseSample, out: RemotePose): void {
  out.x = sample.x;
  out.z = sample.z;
  out.yaw = sample.yaw;
  out.animation = sample.animation;
}
