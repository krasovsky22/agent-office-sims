/**
 * The seam between the game loop and the HUD: the snapshot the loop publishes,
 * the actions it supplies, and the store React subscribes to.
 *
 * Kept apart from `./Hud.tsx` so a new field in the snapshot, the change
 * nearly every feature makes, does not edit the components that draw it.
 */

import {
  type AgentPromptEntry,
  DEFAULT_RADIO_STATION_ID,
  DEFAULT_TV_CHANNEL,
  type Emote,
  type LiftFloor,
  NO_STANDUP,
  type ManagerEntry,
  OCCUPANT_KIND,
  type ProjectBoardSnapshot,
  type RunnerSpendTotal,
  type StandingCreateMessage,
  type StandingRunView,
  type StandingSchedule,
  type StandingTaskAction,
  type StandupData,
  type WorkData,
  isIssueAssignee,
} from "@sim/shared";

import type { AgentMenuView } from "../agentMenu.js";
import type { AgentProfileAccess } from "../agentProfileAccess.js";
import type { AgentPromptAccess } from "../agentPromptAccess.js";
import type { BoardAccess } from "../boardAccess.js";
import type { DeskPanelView } from "../deskTerminalAccess.js";
import type { ManagerAccess } from "../managerAccess.js";
import type { IssueMove } from "../projectBoard.js";
import type { StandingAccess, StandingTaskData } from "../standingAccess.js";
import type { ConnectionStatus, OccupantHudFields } from "../net/room.js";
import { CAMERA_MODE, type CameraMode } from "../player/cameraMode.js";
import { DEFAULT_RADIO_SETTINGS, type RadioSettings, type RadioView } from "../radio.js";
import type { StandupAccess } from "../standupAccess.js";
import type { TvView } from "../tv.js";
import type { AgentMenuActions } from "./AgentMenu.js";
import type { AgentProfileActions, AgentProfileNotice } from "./AgentProfileCard.js";
import type { AgentPromptRefusal, AgentTerminalActions } from "./AgentTerminalPanel.js";
import type { ManagerPanelActions } from "./ManagerPanel.js";
import type { ProjectBoardActions } from "./ProjectBoardPanel.js";
import type { LiftActions } from "./LiftPanel.js";
import type { RadioActions } from "./RadioPanel.js";
import type { StandupActions } from "./StandupPanel.js";
import type { TvActions } from "./TvPanel.js";

/** One occupant on the roster: its {@link OccupantHudFields}, and what the HUD makes of them. */
export interface RosterEntry extends Readonly<OccupantHudFields> {
  readonly id: string;
  readonly isLocal: boolean;
  /** A live agent's status and task, `""` for anyone else. */
  readonly caption: string;
  /** Whether a live agent is stuck until a person acts. */
  readonly needsInput: boolean;
}

/**
 * The roster split into players, live coding agents and the AI manager, each
 * in arrival order.
 */
export function groupRoster(roster: readonly RosterEntry[]): {
  readonly people: readonly RosterEntry[];
  readonly liveAgents: readonly RosterEntry[];
  readonly managers: readonly RosterEntry[];
} {
  return {
    people: roster.filter((entry) => entry.kind === OCCUPANT_KIND.human),
    liveAgents: roster.filter((entry) => entry.kind === OCCUPANT_KIND.liveAgent),
    managers: roster.filter((entry) => entry.kind === OCCUPANT_KIND.manager),
  };
}

/**
 * Everyone an issue can be given to, by the server's own rule: the live agents
 * that can take issues.
 */
export function assignableAgents(roster: readonly RosterEntry[]): readonly RosterEntry[] {
  return roster.filter((entry) => isIssueAssignee(entry));
}

/** One line in the chat scrollback. */
export interface ChatLogEntry {
  /** Arrival order. Chat has no server-side identity, so the client numbers it. */
  readonly id: number;
  readonly author: string;
  readonly text: string;
  readonly isLocal: boolean;
  /** An announcement from the office itself rather than something a player said. */
  readonly isSystem?: boolean;
}

/**
 * How the prop asset kit ended up.
 *
 * `greybox` is the deliberate fallback — the flag is off — and `failed` is the
 * accidental one. Both leave a walkable grey office, and the HUD says which.
 */
export type AssetState = "loading" | "ready" | "greybox" | "failed";

/** What `?debug` puts on screen. Absent unless asked for. */
export interface DebugReadout {
  /** Draw calls the last frame issued, straight off the renderer. */
  readonly drawCalls: number;
  /** Props placed, to compare against the draw calls they cost. */
  readonly props: number;
}

/**
 * The proximity prompt: what the player can do from where they are standing.
 *
 * `blocked` is for a prompt the server would refuse — a chair somebody else is
 * already in. Shown rather than hidden, because a prompt that vanishes when a
 * colleague sits down reads as a bug, while "taken" reads as the office.
 */
export interface HudPrompt {
  readonly keys: string;
  readonly label: string;
  readonly blocked: boolean;
  /** What holding `E` does as well, at an agent the player faces; absent for nothing. */
  readonly hold?: string | undefined;
}

export interface HudSnapshot {
  readonly status: ConnectionStatus;
  /** Spelled out with `undefined`, as `notice` is, so a status without one clears the last. */
  readonly detail?: string | undefined;
  readonly roster: readonly RosterEntry[];
  readonly chatLog: readonly ChatLogEntry[];
  /**
   * A transient line about the player's own last action, if there is one.
   *
   * Spelled `string | undefined` rather than left bare so that the game loop
   * can clear it by publishing `undefined`, which `exactOptionalPropertyTypes`
   * would otherwise refuse.
   */
  readonly notice?: string | undefined;
  /** `undefined` when there is nothing in reach. */
  readonly prompt?: HudPrompt | undefined;
  readonly assets: AssetState;
  readonly debug?: DebugReadout;
  /** The project board's latest snapshot; absent until the server sends one. */
  readonly projectBoard?: ProjectBoardSnapshot;
  /** Whether the local player opened the board's close-up with `E` at its prompt. */
  readonly boardCloseUp: boolean;
  /** Whether the local player opened the recurring tasks board's close-up with `E` at its prompt. */
  readonly recurringOpen: boolean;
  /** The standing tasks' last runs the local player asked for, by task id, newest first. */
  readonly standingHistory: Readonly<Record<string, readonly StandingRunView[]>>;
  /** What the local player may do about the project board's work; absent until they are in the office. */
  readonly boardAccess?: BoardAccess | undefined;
  /** The agents' work on the project board's issues as last replicated, in no particular order. */
  readonly work: readonly WorkData[];
  /** Cards the local player dropped on Closed or Open that the board's snapshot does not show there yet. */
  readonly issueMoves: readonly IssueMove[];
  /** Why the local player's latest drop went back, if one did; shown on the board itself. */
  readonly boardNotice?: string | undefined;
  /** Whether the local player's refresh of the project board is waiting on GitHub. */
  readonly boardRefreshing: boolean;
  /** Whether the local player opened the conversation with `E` at the manager's desk. */
  readonly managerOpen: boolean;
  /** The conversation with the manager, oldest first, as the server relayed it. */
  readonly managerLog: readonly ManagerEntry[];
  /** Lines that arrived while the conversation was closed. */
  readonly managerUnread: number;
  /** What the local player may say to the manager; absent until they are in the office. */
  readonly managerAccess?: ManagerAccess | undefined;
  /** The live agent whose terminal the local player opened with `E` behind its chair or from the roster, or `undefined`. */
  readonly terminalAgentId?: string | undefined;
  /** The CEO's own desk's computer while the local player is the CEO sitting at one, or `undefined`. */
  readonly desk?: DeskPanelView | undefined;
  /** What the runners' real agents have spent today; absent, or no runners, until a runner reports. */
  readonly runnerSpend?: RunnerSpendTotal | undefined;
  /** The prompts typed into the coding agents' terminals, oldest first, as the server relayed them. */
  readonly agentPrompts: readonly AgentPromptEntry[];
  /** What the local player may type to a coding agent; absent until they are in the office. */
  readonly agentPromptAccess?: AgentPromptAccess | undefined;
  /** Why the local player's latest prompt was not typed, if one was not. */
  readonly agentPromptRefusal?: AgentPromptRefusal | undefined;
  /** The standup, on or the last one held, as last replicated. */
  readonly standup: StandupData;
  /** What the local player may do about the standup; absent until they are in the office. */
  readonly standupAccess?: StandupAccess | undefined;
  /** Why the local player's latest standup command was refused, if one was. */
  readonly standupNotice?: string | undefined;
  /** The runners' standing tasks as last replicated, in no particular order. */
  readonly standingTasks: readonly StandingTaskData[];
  /** What the local player may do about them; absent until they are in the office. */
  readonly standingAccess?: StandingAccess | undefined;
  /** What the local player may do about the agents' profiles; absent until they are in the office. */
  readonly agentProfileAccess?: AgentProfileAccess | undefined;
  /** Why the local player's latest edit to an agent's profile was not passed on, if one was not. */
  readonly agentProfileNotice?: AgentProfileNotice | undefined;
  /** Which camera the local player is looking through. */
  readonly cameraMode: CameraMode;
  /** The menu a long press of `E` opened on the agent the local player faces, or `undefined`. */
  readonly agentMenu?: AgentMenuView | undefined;
  /** The name the arrival card is prefilled with while it is up, before joining; `undefined` once the player entered. */
  readonly nameCard?: string | undefined;
  /** Whether the list of controls is over the office. */
  readonly helpOpen: boolean;
  /** Whether the local player opened the radio with `E` beside it. */
  readonly radioOpen: boolean;
  /** What the office radio plays, as last replicated. */
  readonly radio: RadioView;
  /** The local player's own volume and mute for it. */
  readonly radioSettings: RadioSettings;
  /** Why the local player's latest tune was not taken, or why this tab is not playing it. */
  readonly radioNotice?: string | undefined;
  /** Whether the local player opened the conference room's TV with `E` in front of it. */
  readonly tvOpen: boolean;
  /** What the TV shows, as last replicated. */
  readonly tv: TvView;
  /** The local player's own volume and mute for the TV, apart from the radio's. */
  readonly tvSettings: RadioSettings;
  /** Why the local player's latest change to the TV was not taken, or why this tab is not playing its video. */
  readonly tvNotice?: string | undefined;
  /** Which floor of the building the office is, from 1 at the street, and how many it has. */
  readonly floor: number;
  readonly floors: number;
  /** Whether the local player opened the lift's floors with `E` at its doors. */
  readonly liftOpen: boolean;
  /** The building's floors as the server last listed them; absent until the lift is called. */
  readonly liftFloors?: readonly LiftFloor[] | undefined;
  /** Why the lift would not take the local player, if it would not. */
  readonly liftNotice?: string | undefined;
  /** The floor the lift is taking the local player to, while it does. */
  readonly riding?: number | undefined;
}

/** What the standing tasks' buttons do; the server decides whether it happens. */
export interface StandingActions {
  readonly act: (action: StandingTaskAction, taskId: string) => void;
  /** A new schedule, from the recurring tasks board. */
  readonly reschedule: (taskId: string, schedule: StandingSchedule) => void;
  /** Asks for a task's last runs, which arrive in `standingHistory`. */
  readonly history: (taskId: string) => void;
  /** A new task, from the recurring tasks board's form. */
  readonly create: (task: StandingCreateMessage) => void;
}

export interface HudActions {
  readonly sendEmote: (emote: Emote) => void;
  /** Called with the raw input text; the server sanitizes it. */
  readonly sendChat: (text: string) => void;
  /** Switches between first and third person, as `V` does. */
  readonly toggleCamera: () => void;
  /** Opens or closes the list of controls, as `H` does. */
  readonly toggleHelp: () => void;
  /** Joins the office afresh, from a connection that has given up. */
  readonly rejoin: () => void;
  /** Enters the office under the name typed on the arrival card; the server sanitizes it and decides. */
  readonly join: (name: string) => void;
  /** Asks for a new name for the local player; the server sanitizes it and decides. */
  readonly rename: (name: string) => void;
  /** Opens an agent's terminal panel, wherever the local player stands. */
  readonly answer: (agentId: string) => void;
  readonly projectBoard: ProjectBoardActions;
  readonly manager: ManagerPanelActions;
  readonly terminal: AgentTerminalActions;
  /** Stands the local player up from their desk, which ends its session. */
  readonly standUp: () => void;
  readonly standing: StandingActions;
  readonly standup: StandupActions & { readonly start: () => void };
  readonly profile: AgentProfileActions;
  readonly agentMenu: AgentMenuActions;
  readonly radio: RadioActions;
  readonly tv: TvActions;
  readonly lift: LiftActions;
}

export interface HudStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HudSnapshot;
  /** Replaces the snapshot and notifies React. */
  publish: (next: HudSnapshot) => void;
}

const INITIAL: HudSnapshot = {
  status: "connecting",
  roster: [],
  chatLog: [],
  assets: "loading",
  boardCloseUp: false,
  recurringOpen: false,
  standingHistory: {},
  work: [],
  issueMoves: [],
  boardRefreshing: false,
  managerOpen: false,
  managerLog: [],
  agentPrompts: [],
  managerUnread: 0,
  standingTasks: [],
  standup: NO_STANDUP,
  cameraMode: CAMERA_MODE.thirdPerson,
  helpOpen: false,
  radioOpen: false,
  radio: { stationId: DEFAULT_RADIO_STATION_ID, videoId: "", listId: "", title: "", startedAt: 0, tunedBy: "" },
  radioSettings: DEFAULT_RADIO_SETTINGS,
  tvOpen: false,
  tv: { channel: DEFAULT_TV_CHANNEL, videoId: "", listId: "", title: "", startedAt: 0, changedBy: "" },
  tvSettings: DEFAULT_RADIO_SETTINGS,
  floor: 1,
  floors: 1,
  liftOpen: false,
};

export function createHudStore(): HudStore {
  let snapshot = INITIAL;
  const listeners = new Set<() => void>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return snapshot;
    },
    publish(next) {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
