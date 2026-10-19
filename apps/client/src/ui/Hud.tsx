/**
 * The 2D overlay.
 *
 * React's whole job in this prototype is this layer. The scene is an imperative
 * Three.js loop and stays that way: the loop runs every frame, while the HUD
 * re-renders only when the roster, the connection state or the chat log
 * actually changes. Driving the scene through React
 * would put a reconciler on the frame budget for no benefit.
 *
 * The store below is the seam between the two. The game loop pushes snapshots
 * into it; React subscribes. Chat and emotes travel the other way, through
 * {@link HudActions}, which the loop supplies — the HUD never touches the
 * socket itself. So do messages to the AI manager, whose conversation the loop
 * keeps in the snapshot whether or not its panel is open, counting the lines
 * nobody has read yet. A live agent's terminal is the one thing a panel reads
 * that is not in the snapshot: it changes too often, so the panel asks for it
 * through {@link HudActions} as it repaints. The runners' standing tasks are
 * listed under the agents for everyone, with the CEO's buttons for them.
 *
 * The standup is in the snapshot, and while one is on its panel is docked over
 * the foot of the office in every tab; the roster offers the CEO the button
 * that calls one.
 */

import {
  type AgentPromptEntry,
  EMOTES,
  type Emote,
  MANAGER_STATUS,
  MAX_CHAT_LENGTH,
  NO_STANDUP,
  type ManagerEntry,
  type ManagerStatus,
  OCCUPANT_KIND,
  type OccupantKind,
  type ProjectBoardSnapshot,
  type RunnerSpendTotal,
  STANDING_ACTION,
  type StandingTaskAction,
  type StandupData,
  type WorkData,
  isIssueAssignee,
  spendSummary,
} from "@sim/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { AgentProfileAccess } from "../agentProfileAccess.js";
import type { AgentPromptAccess } from "../agentPromptAccess.js";
import { NO_LINKS, terminalLinks } from "../agentTerminal.js";
import type { BoardAccess } from "../boardAccess.js";
import { type DeskPanelView, deskPrompts } from "../deskTerminalAccess.js";
import { EMOTE_APPEARANCE } from "../emotes.js";
import { isTypingTarget } from "../keys.js";
import type { ManagerAccess } from "../managerAccess.js";
import { MANAGER_STATUS_APPEARANCE } from "../managerStatus.js";
import type { IssueMove } from "../projectBoard.js";
import { type StandingAccess, type StandingTaskData, standingRow } from "../standingAccess.js";
import type { ConnectionStatus } from "../net/room.js";
import { CAMERA_MODE, type CameraMode } from "../player/cameraMode.js";
import type { StandupAccess } from "../standupAccess.js";
import { type AgentProfileActions, AgentProfileCard, type AgentProfileNotice } from "./AgentProfileCard.js";
import { type AgentPromptRefusal, type AgentTerminalActions, AgentTerminalPanel } from "./AgentTerminalPanel.js";
import { type ManagerPanelActions, ManagerPanel } from "./ManagerPanel.js";
import { type ProjectBoardActions, ProjectBoardPanel } from "./ProjectBoardPanel.js";
import { type StandupActions, StandupPanel } from "./StandupPanel.js";

import "./hud.css";

export interface RosterEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: OccupantKind;
  readonly isCeo: boolean;
  readonly isLocal: boolean;
  /** A live agent's status and task, `""` for anyone else. */
  readonly caption: string;
  /** Whether a live agent is stuck until a person acts. */
  readonly needsInput: boolean;
  /** The task's issue or pull request, `""` when not known. The server only passes `https:`. */
  readonly taskUrl: string;
  /** What the manager assigned a live agent next, `""` when nothing. Only `https:`. */
  readonly assignedUrl: string;
  /** Whether a live agent can be given issue work; `false` for anyone else. */
  readonly canTakeIssues: boolean;
  /** A live agent's title, `""` when it has none and for anyone else. */
  readonly title: string;
  /** A live agent's description, its system prompt with the title; `""` when none. */
  readonly description: string;
  /** Whether a live agent's profile can be edited from the office; `false` for anyone else. */
  readonly profileEditable: boolean;
  /** The AI manager's status; `undefined` for anyone else. */
  readonly managerStatus: ManagerStatus | undefined;
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
}

export interface HudSnapshot {
  readonly status: ConnectionStatus;
  readonly detail?: string;
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
  /** What the local player may do about the project board's work; absent until they are in the office. */
  readonly boardAccess?: BoardAccess | undefined;
  /** The agents' work on the project board's issues as last replicated, in no particular order. */
  readonly work: readonly WorkData[];
  /** Cards the local player dropped on Closed or Open that the board's snapshot does not show there yet. */
  readonly issueMoves: readonly IssueMove[];
  /** Why the local player's latest drop went back, if one did; shown on the board itself. */
  readonly boardNotice?: string | undefined;
  /** Whether the local player opened the conversation with `E` at the manager's desk. */
  readonly managerOpen: boolean;
  /** The conversation with the manager, oldest first, as the server relayed it. */
  readonly managerLog: readonly ManagerEntry[];
  /** Lines that arrived while the conversation was closed. */
  readonly managerUnread: number;
  /** What the local player may say to the manager; absent until they are in the office. */
  readonly managerAccess?: ManagerAccess | undefined;
  /** The live agent whose terminal the local player opened with `E` behind its chair, or `undefined`. */
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
}

/** What the standing tasks' buttons do; the server decides whether it happens. */
export interface StandingActions {
  readonly act: (action: StandingTaskAction, taskId: string) => void;
}

export interface HudActions {
  readonly sendEmote: (emote: Emote) => void;
  /** Called with the raw input text; the server sanitizes it. */
  readonly sendChat: (text: string) => void;
  /** Switches between first and third person, as `V` does. */
  readonly toggleCamera: () => void;
  readonly projectBoard: ProjectBoardActions;
  readonly manager: ManagerPanelActions;
  readonly terminal: AgentTerminalActions;
  /** Stands the local player up from their desk, which ends its session. */
  readonly standUp: () => void;
  readonly standing: StandingActions;
  readonly standup: StandupActions & { readonly start: () => void };
  readonly profile: AgentProfileActions;
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
  work: [],
  issueMoves: [],
  managerOpen: false,
  managerLog: [],
  agentPrompts: [],
  managerUnread: 0,
  standingTasks: [],
  standup: NO_STANDUP,
  cameraMode: CAMERA_MODE.thirdPerson,
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

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting to the office…",
  connected: "Connected",
  reconnecting: "Connection lost — reconnecting…",
  disconnected: "Disconnected",
  failed: "Could not reach the office server",
};

/** Digit to emote, from the one appearance table. */
const EMOTE_HOTKEYS = new Map<string, Emote>(
  EMOTES.map((emote) => [EMOTE_APPEARANCE[emote].hotkey, emote]),
);

/**
 * The chat input, and the shortcuts that reach it.
 *
 * Focus is the whole design here. The input is a real text field, so while it
 * holds focus the browser gives it the keystrokes and the player controller
 * declines them (see `keys.ts`) — which is what stops `D` from stepping right
 * while someone types "standup". Getting focus is `Enter`, giving it back is
 * `Enter` to send or `Escape` to abandon, and both end with the field blurred
 * so walking resumes without a click.
 *
 * `Enter` also releases the pointer lock. The lock swallows clicks, so a player
 * who is looking around has no way to reach the field with the mouse.
 */
function ChatComposer({ sendChat }: { sendChat: (text: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || isTypingTarget(event.target) || event.repeat) {
        return;
      }
      event.preventDefault();
      if (document.pointerLockElement !== null) {
        document.exitPointerLock();
      }
      inputRef.current?.focus();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const submit = () => {
    const text = draft.trim();
    setDraft("");
    inputRef.current?.blur();
    if (text !== "") {
      sendChat(text);
    }
  };

  return (
    <div className="hud__composer">
      <input
        ref={inputRef}
        className="hud__input"
        type="text"
        name="chat"
        value={draft}
        // The server truncates anyway; this stops the field from accepting
        // characters it already knows will be thrown away.
        maxLength={MAX_CHAT_LENGTH}
        placeholder="Say something…"
        aria-label="Chat message"
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft("");
            inputRef.current?.blur();
          }
        }}
      />
      <button
        className="hud__send"
        type="button"
        // Blurred on the way out: a button that keeps focus would answer the
        // next Enter or Space itself instead of leaving them to the game.
        onClick={(event) => {
          event.currentTarget.blur();
          submit();
        }}
      >
        Send
      </button>
    </div>
  );
}

/** The emote buttons, and the digit keys that do the same thing. */
function EmoteBar({ sendEmote }: { sendEmote: (emote: Emote) => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.repeat) {
        return;
      }
      const emote = EMOTE_HOTKEYS.get(event.key);
      if (emote !== undefined) {
        event.preventDefault();
        sendEmote(emote);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sendEmote]);

  return (
    <ul className="hud__emotes">
      {EMOTES.map((emote) => {
        const { glyph, caption, hotkey } = EMOTE_APPEARANCE[emote];
        return (
          <li key={emote}>
            <button
              className="hud__emote"
              type="button"
              title={`${caption} (${hotkey})`}
              onClick={(event) => {
                event.currentTarget.blur();
                sendEmote(emote);
              }}
            >
              <span className="hud__emoteGlyph" aria-hidden="true">
                {glyph}
              </span>
              <span className="hud__emoteCaption">{caption}</span>
              <span className="hud__emoteKey">{hotkey}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A live agent's task under its name, linked to the issue or pull request when
 * the orchestrator said which.
 *
 * Opened in a new tab, since following it from the office would otherwise take
 * the player out of it. The link is only ever `https:` — the server's parser
 * refuses anything else — so it cannot be a script URL.
 */
function AgentTask({ caption, url }: { caption: string; url: string }) {
  return (
    <span className="hud__task">
      {url.startsWith("https://") ? (
        <a href={url} target="_blank" rel="noopener noreferrer">
          {caption}
        </a>
      ) : (
        caption
      )}
    </span>
  );
}

/**
 * The chat scrollback.
 *
 * Every entry is a React text node, so a message containing angle brackets is
 * shown rather than interpreted — there is no path from a chat message to
 * markup. Layout is defended separately, in CSS: the panel is a fixed width
 * with its own scroll, and `overflow-wrap` breaks a long unspaced run instead
 * of letting it push the panel wider than the screen.
 */
function ChatLog({ entries }: { entries: readonly ChatLogEntry[] }) {
  const scrollRef = useRef<HTMLOListElement>(null);

  // Pinned to the newest line, which is where a conversation is.
  useEffect(() => {
    const list = scrollRef.current;
    if (list !== null) {
      list.scrollTop = list.scrollHeight;
    }
  }, [entries]);

  if (entries.length === 0) {
    return <p className="hud__status">Nothing said yet.</p>;
  }

  return (
    <ol className="hud__log" ref={scrollRef}>
      {entries.map((entry) => (
        <li className={entry.isSystem === true ? "hud__line hud__line--system" : "hud__line"} key={entry.id}>
          <span className={entry.isLocal ? "hud__author hud__author--you" : "hud__author"}>
            {entry.author}
          </span>
          <span className="hud__said">{entry.text}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What the status panel says about the furniture, when there is anything to say.
 *
 * A loaded kit says nothing: the office looking like an office is not news.
 */
const ASSET_TEXT: Partial<Record<AssetState, string>> = {
  greybox: "Grey-box mode — props are off.",
  failed: "Asset kit did not load; showing grey boxes.",
};

/** One player's line in the roster. */
function PersonRow({ entry }: { entry: RosterEntry }) {
  return (
    <li className="hud__occupant">
      <span className="hud__name">{entry.name}</span>
      {entry.isCeo ? <span className="hud__badge">CEO</span> : null}
      {entry.isLocal ? <span className="hud__you">you</span> : null}
    </li>
  );
}

/** The roster's say over the agents' profiles: who may edit them, why not, and what the edits do. */
export interface ProfileControls {
  readonly access: AgentProfileAccess | undefined;
  readonly notice: AgentProfileNotice | undefined;
  readonly actions: AgentProfileActions;
}

/**
 * One live coding agent's line: its name and title, whether it needs someone,
 * and its task linked to the issue or pull request. A runner's agent also has
 * a button that opens its profile under the line.
 */
function LiveAgentRow({ entry, profile }: { entry: RosterEntry; profile: ProfileControls }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="hud__occupant">
      <span className="hud__name">{entry.name}</span>
      <span className="hud__badge hud__badge--agent">{entry.title === "" ? "Agent" : entry.title}</span>
      {entry.needsInput ? <span className="hud__badge hud__badge--needs-you">Needs you</span> : null}
      {entry.profileEditable ? (
        <button
          className="hud__standing-button hud__profile-toggle"
          type="button"
          aria-expanded={open}
          onClick={(event) => {
            event.currentTarget.blur();
            setOpen(!open);
          }}
        >
          {open ? "Hide profile" : "Profile"}
        </button>
      ) : null}
      {entry.caption === "" ? null : <AgentTask caption={entry.caption} url={entry.taskUrl} />}
      {open && entry.profileEditable ? (
        <AgentProfileCard entry={entry} access={profile.access} notice={profile.notice} actions={profile.actions} />
      ) : null}
    </li>
  );
}

/** The AI manager's line: its name, its status, and whether it has said anything unread. */
function ManagerRow({ entry, unread }: { entry: RosterEntry; unread: number }) {
  const appearance = MANAGER_STATUS_APPEARANCE[entry.managerStatus ?? MANAGER_STATUS.idle];
  return (
    <li className="hud__occupant hud__occupant--manager">
      <span className="hud__name">{entry.name}</span>
      <span className="hud__activity" style={{ color: appearance.colour }}>
        {appearance.label}
      </span>
      <span className="hud__task">
        {unread > 0 ? `${unread} new — ` : ""}talk to it at its desk in its office
      </span>
    </li>
  );
}

/**
 * The runners' books, under the live agents: today's spend against the
 * budget, and once that is spent, that no new work will start. Real money,
 * so it is shown plainly in every tab and nowhere in the game's own economy.
 */
export function spendLine(spend: RunnerSpendTotal): { readonly text: string; readonly spent: boolean } {
  return {
    text: `Agents' spend: ${spendSummary(spend)}${spend.budgetSpent ? " — budget spent, no new starts" : ""}`,
    spent: spend.budgetSpent,
  };
}

function SpendLine({ spend }: { spend: RunnerSpendTotal }) {
  const { text, spent } = spendLine(spend);
  return (
    <p className={spent ? "hud__spend hud__spend--spent" : "hud__spend"} role="status">
      {text}
    </p>
  );
}

/**
 * One standing task's row: what it is, how it stands, and the CEO's buttons,
 * disabled with the reason for everyone else, since only the CEO's are taken.
 * Pause becomes Resume while it is paused.
 */
function StandingRowView({
  task,
  access,
  actions,
  now,
}: {
  task: StandingTaskData;
  access: StandingAccess | undefined;
  actions: StandingActions;
  now: number;
}) {
  const row = standingRow(task, now);
  const disabled = access?.mayManage !== true;
  const reason = access?.reason ?? "";
  const button = (label: string, action: StandingTaskAction) => (
    <button
      className="hud__standing-button"
      type="button"
      disabled={disabled}
      title={disabled ? reason : `${label}: ${task.name}`}
      onClick={(event) => {
        event.currentTarget.blur();
        actions.act(action, task.id);
      }}
    >
      {label}
    </button>
  );
  return (
    <li className={row.alert ? "hud__standing hud__standing--alert" : "hud__standing"}>
      <span className="hud__standing-title">{row.title}</span>
      {row.lines.map((line) => (
        <span className="hud__standing-line" key={line}>
          {line}
        </span>
      ))}
      <span className="hud__standing-buttons">
        {row.paused ? button("Resume", STANDING_ACTION.resume) : button("Pause", STANDING_ACTION.pause)}
        {button("Check now", STANDING_ACTION.checkNow)}
        {button("Remove", STANDING_ACTION.remove)}
      </span>
    </li>
  );
}

/** The standing tasks, under the agents' spend: shown to everyone, each with its buttons. */
function StandingTasks({
  tasks,
  access,
  actions,
}: {
  tasks: readonly StandingTaskData[];
  access: StandingAccess | undefined;
  actions: StandingActions;
}) {
  const now = Date.now();
  const sorted = [...tasks].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return (
    <>
      <h2 className="hud__title hud__title--group">Standing tasks ({tasks.length})</h2>
      <ul className="hud__roster">
        {sorted.map((task) => (
          <StandingRowView task={task} access={access} actions={actions} now={now} key={task.id} />
        ))}
      </ul>
    </>
  );
}

/**
 * The CEO's button that calls a standup, under the manager, whom the agents
 * gather around. Everyone else sees it disabled, and why.
 */
function StandupCall({ access, active, start }: { access: StandupAccess; active: boolean; start: () => void }) {
  return (
    <div className="hud__standup">
      <button
        className="panel__button"
        type="button"
        disabled={!access.mayRun || active}
        title={access.mayRun ? "Every agent gathers in the conference room and gives an update" : access.summary}
        onClick={(event) => {
          event.currentTarget.blur();
          start();
        }}
      >
        {active ? "Standup on" : "Call a standup"}
      </button>
      {access.mayRun ? null : <span className="hud__task">Only the CEO calls a standup</span>}
    </div>
  );
}

/**
 * Who is in the office: people first, then the manager and the live coding
 * agents under headings of their own, so the roster answers "who is a person
 * here?" as plainly as the floor does.
 */
function Roster({
  roster,
  boardAccess,
  managerUnread,
  runnerSpend,
  standingTasks,
  standingAccess,
  standingActions,
  standupCall,
  profile,
}: {
  roster: readonly RosterEntry[];
  boardAccess: BoardAccess | undefined;
  managerUnread: number;
  runnerSpend: RunnerSpendTotal | undefined;
  standingTasks: readonly StandingTaskData[];
  standingAccess: StandingAccess | undefined;
  standingActions: StandingActions;
  /** The standup button, or `undefined` before the local player is in the office. */
  standupCall: { readonly access: StandupAccess; readonly active: boolean; readonly start: () => void } | undefined;
  profile: ProfileControls;
}) {
  const { people, liveAgents, managers } = groupRoster(roster);
  return (
    <div className="hud__panel">
      <h2 className="hud__title">People ({people.length})</h2>
      {people.length === 0 ? (
        <p className="hud__status">Nobody here yet.</p>
      ) : (
        <ul className="hud__roster">
          {people.map((entry) => (
            <PersonRow entry={entry} key={entry.id} />
          ))}
        </ul>
      )}
      {managers.length === 0 ? null : (
        <>
          <h2 className="hud__title hud__title--group">Manager</h2>
          <ul className="hud__roster">
            {managers.map((entry) => (
              <ManagerRow entry={entry} unread={managerUnread} key={entry.id} />
            ))}
          </ul>
          {standupCall === undefined ? null : <StandupCall {...standupCall} />}
        </>
      )}
      {liveAgents.length === 0 ? null : (
        <>
          <h2 className="hud__title hud__title--group">Live agents ({liveAgents.length})</h2>
          <ul className="hud__roster">
            {liveAgents.map((entry) => (
              <LiveAgentRow entry={entry} profile={profile} key={entry.id} />
            ))}
          </ul>
        </>
      )}
      {runnerSpend === undefined || runnerSpend.runners === 0 ? null : <SpendLine spend={runnerSpend} />}
      {standingTasks.length === 0 ? null : <StandingTasks tasks={standingTasks} access={standingAccess} actions={standingActions} />}
      {boardAccess === undefined ? null : (
        <p
          className={boardAccess.readOnly ? "hud__role hud__role--readonly" : "hud__role"}
          role="note"
        >
          {boardAccess.summary}
        </p>
      )}
    </div>
  );
}

export function Hud({ store, actions }: { store: HudStore; actions: HudActions }) {
  const {
    status,
    detail,
    roster,
    chatLog,
    notice,
    prompt,
    assets,
    debug,
    projectBoard,
    boardCloseUp,
    boardAccess,
    work,
    issueMoves,
    boardNotice,
    managerOpen,
    managerLog,
    managerUnread,
    managerAccess,
    terminalAgentId,
    desk,
    runnerSpend,
    agentPrompts,
    agentPromptAccess,
    agentPromptRefusal,
    standingTasks,
    standingAccess,
    standup,
    standupAccess,
    standupNotice,
    agentProfileAccess,
    agentProfileNotice,
    cameraMode,
  } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const assetNote = ASSET_TEXT[assets];
  const terminalAgent = roster.find((entry) => entry.id === terminalAgentId);
  // The CEO runs a standup from its panel and from the manager's desk at once, so
  // the standup docks to one side rather than covering another close-up.
  const standupDocked = standup.active && (boardCloseUp || managerOpen || terminalAgentId !== undefined || desk !== undefined);
  const deskAgent = desk === undefined || desk.agentId === "" ? undefined : roster.find((entry) => entry.id === desk.agentId);

  return (
    <div className={standupDocked ? "hud hud--standup-docked" : "hud"}>
      {/* Always mounted, so hiding it is a transition rather than a cut. */}
      <div className={assets === "loading" ? "hud__loading" : "hud__loading hud__loading--done"}>
        <p className="hud__loading-text">Furnishing the office…</p>
      </div>

      <div className="hud__column">
        <Roster
          roster={roster}
          boardAccess={boardAccess}
          managerUnread={managerUnread}
          runnerSpend={runnerSpend}
          standingTasks={standingTasks}
          standingAccess={standingAccess}
          standingActions={actions.standing}
          standupCall={
            standupAccess === undefined ? undefined : { access: standupAccess, active: standup.active, start: actions.standup.start }
          }
          profile={{ access: agentProfileAccess, notice: agentProfileNotice, actions: actions.profile }}
        />

        <div className="hud__panel">
          <h2 className="hud__title">Status</h2>
          <p className={status === "failed" ? "hud__status hud__status--failed" : "hud__status"}>
            {STATUS_TEXT[status]}
            {detail === undefined ? "" : ` — ${detail}`}
          </p>
          {assetNote === undefined ? null : <p className="hud__status">{assetNote}</p>}
          <p className="hud__hint">
            <span className="hud__keys">W A S D</span> to walk,{" "}
            <span className="hud__keys">E</span> to use what you are standing by, drag to look
            around, <span className="hud__keys">Enter</span> to chat.
          </p>
          <p className="hud__hint hud__camera">
            <button
              type="button"
              className="hud__cameraToggle"
              onClick={(event) => {
                // Back to the office, so the next Space or Enter is not another click.
                event.currentTarget.blur();
                actions.toggleCamera();
              }}
            >
              {cameraMode === CAMERA_MODE.firstPerson ? "Third person" : "First person"}
            </button>
            <span>
              <span className="hud__keys">V</span> to switch
              {cameraMode === CAMERA_MODE.thirdPerson ? ", scroll to zoom" : ""}
            </span>
          </p>
          {debug === undefined ? null : (
            <p className="hud__hint">
              <span className="hud__keys">{debug.drawCalls}</span> draw calls ·{" "}
              <span className="hud__keys">{debug.props}</span> props
            </p>
          )}
        </div>
      </div>

      {boardCloseUp ? (
        <ProjectBoardPanel
          snapshot={projectBoard}
          work={work}
          agents={assignableAgents(roster)}
          access={boardAccess}
          moves={issueMoves}
          notice={boardNotice}
          actions={actions.projectBoard}
        />
      ) : null}

      {managerOpen ? (
        <ManagerPanel
          entries={managerLog}
          access={managerAccess}
          thinking={groupRoster(roster).managers.some((entry) => entry.managerStatus === MANAGER_STATUS.thinking)}
          actions={actions.manager}
        />
      ) : null}

      {terminalAgentId === undefined ? null : (
        <AgentTerminalPanel
          // A fresh panel per agent, so nothing painted for one is shown for another.
          key={terminalAgentId}
          agentId={terminalAgentId}
          agent={terminalAgent}
          links={terminalLinks(terminalAgentId, terminalAgent?.taskUrl ?? "", work, projectBoard)}
          prompts={agentPrompts.filter((entry) => entry.agentId === terminalAgentId)}
          access={agentPromptAccess}
          localId={roster.find((entry) => entry.isLocal)?.id}
          refusal={agentPromptRefusal}
          actions={actions.terminal}
        />
      )}

      {desk === undefined ? null : (
        <AgentTerminalPanel
          // A fresh panel per agent lent, so nothing painted for one is shown for the next.
          key={`desk:${desk.agentId}`}
          agentId={desk.agentId}
          agent={deskAgent}
          links={NO_LINKS}
          prompts={deskPrompts(agentPrompts, desk)}
          access={agentPromptAccess}
          localId={roster.find((entry) => entry.isLocal)?.id}
          refusal={agentPromptRefusal}
          actions={{ ...actions.terminal, close: actions.standUp }}
          desk={desk}
        />
      )}

      {standup.active ? (
        <StandupPanel
          standup={standup}
          roster={roster}
          access={standupAccess}
          refusal={agentPromptRefusal}
          notice={standupNotice}
          actions={actions.standup}
        />
      ) : null}

      <div className="hud__column hud__column--right">
        <div className="hud__panel hud__panel--chat">
          <h2 className="hud__title">Office chat</h2>
          <ChatLog entries={chatLog} />
          <ChatComposer sendChat={actions.sendChat} />
          <EmoteBar sendEmote={actions.sendEmote} />
          {notice === undefined ? null : <p className="hud__notice">{notice}</p>}
        </div>
      </div>

      {prompt === undefined ? null : (
        <div className={prompt.blocked ? "hud__prompt hud__prompt--blocked" : "hud__prompt"}>
          <span className="hud__keys">{prompt.keys}</span>
          <span>{prompt.label}</span>
        </div>
      )}
    </div>
  );
}
