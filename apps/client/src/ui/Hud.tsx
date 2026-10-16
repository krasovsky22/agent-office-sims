/**
 * The 2D overlay.
 *
 * React's whole job in this prototype is this layer. The scene is an imperative
 * Three.js loop and stays that way: the loop runs every frame, while the HUD
 * re-renders only when the roster, the connection state, the chat log, or what
 * the company readout shows actually changes. Driving the scene through React
 * would put a reconciler on the frame budget for no benefit.
 *
 * The store below is the seam between the two. The game loop pushes snapshots
 * into it; React subscribes. Chat and emotes travel the other way, through
 * {@link HudActions}, which the loop supplies — the HUD never touches the
 * socket itself. So do messages to the AI manager, whose conversation the loop
 * keeps in the snapshot whether or not its panel is open, counting the lines
 * nobody has read yet.
 */

import {
  type AgentActivity,
  EMOTES,
  type Emote,
  MANAGER_STATUS,
  MAX_CHAT_LENGTH,
  type ManagerEntry,
  type ManagerStatus,
  OCCUPANT_KIND,
  type OccupantKind,
  type ProjectBoardSnapshot,
  type WorkData,
  isIssueAssignee,
} from "@sim/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { BoardAccess } from "../boardAccess.js";
import type { CompanyReadout } from "../companyReadout.js";
import type { ManagerAccess } from "../managerAccess.js";
import type { OperatorAccess } from "../operatorAccess.js";
import type { StaffReadout } from "../staffing.js";
import {
  AGENT_ACTIVITY_APPEARANCE,
  MANAGER_STATUS_APPEARANCE,
  SIMULATED_LABEL,
  isSimulated,
} from "../agentActivity.js";
import { EMOTE_APPEARANCE } from "../emotes.js";
import { isTypingTarget } from "../keys.js";
import type { ConnectionStatus } from "../net/room.js";
import { CompanyEndState, CompanyPanel } from "./CompanyPanel.js";
import { type ManagerPanelActions, ManagerPanel } from "./ManagerPanel.js";
import { type ProjectBoardActions, ProjectBoardPanel } from "./ProjectBoardPanel.js";
import { StaffPanel } from "./StaffPanel.js";

import "./hud.css";

export interface RosterEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: OccupantKind;
  readonly isCeo: boolean;
  /** Whether a player has verified as operator; `false` for anyone else. */
  readonly isOperator: boolean;
  /** An agent's job title; `""` for a player. */
  readonly jobTitle: string;
  /** An agent's activity; `undefined` for a player. */
  readonly activity: AgentActivity | undefined;
  /** An agent's daily salary; `0` for a player. */
  readonly salary: number;
  readonly isLocal: boolean;
  /** A live agent's status and task, `""` for anyone else. */
  readonly caption: string;
  /** The task's issue or pull request, `""` when not known. The server only passes `https:`. */
  readonly taskUrl: string;
  /** What the manager assigned a live agent next, `""` when nothing. Only `https:`. */
  readonly assignedUrl: string;
  /** Whether a live agent can be given issue work; `false` for anyone else. */
  readonly canTakeIssues: boolean;
  /** The AI manager's status; `undefined` for anyone else. */
  readonly managerStatus: ManagerStatus | undefined;
}

/**
 * The roster split into players, agent employees, live coding agents and the
 * AI manager, each in arrival order.
 */
export function groupRoster(roster: readonly RosterEntry[]): {
  readonly people: readonly RosterEntry[];
  readonly agents: readonly RosterEntry[];
  readonly liveAgents: readonly RosterEntry[];
  readonly managers: readonly RosterEntry[];
} {
  return {
    people: roster.filter((entry) => entry.kind === OCCUPANT_KIND.human),
    agents: roster.filter((entry) => entry.kind === OCCUPANT_KIND.agent),
    liveAgents: roster.filter((entry) => entry.kind === OCCUPANT_KIND.liveAgent),
    managers: roster.filter((entry) => entry.kind === OCCUPANT_KIND.manager),
  };
}

/**
 * Everyone an issue can be given to, by the server's own rule: the agent
 * employees, and the live agents that can take issues.
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
  /** The company's numbers as shown; absent until the first patch carries them. */
  readonly company?: CompanyReadout;
  /** What the local player may do about the project board's work; absent until they are in the office. */
  readonly boardAccess?: BoardAccess | undefined;
  /** The agents' work on the project board's issues as last replicated, in no particular order. */
  readonly work: readonly WorkData[];
  /** The payroll, the desks, and whether the local player may hire; absent until they are in. */
  readonly staff?: StaffReadout | undefined;
  /**
   * The morale a firing just cost, shown beside the metric until the next one.
   * `id` changes with each firing so the same drop twice still animates.
   */
  readonly moraleHit?: { readonly id: number; readonly text: string } | undefined;
  /** Whether the local player opened the conversation with `E` at the manager's desk. */
  readonly managerOpen: boolean;
  /** The conversation with the manager, oldest first, as the server relayed it. */
  readonly managerLog: readonly ManagerEntry[];
  /** Lines that arrived while the conversation was closed. */
  readonly managerUnread: number;
  /** What the local player may say to the manager; absent until they are in the office. */
  readonly managerAccess?: ManagerAccess | undefined;
  /** What the local player may send the live coding agents; absent with no operator passphrase. */
  readonly operatorAccess?: OperatorAccess | undefined;
}

export interface HudActions {
  readonly sendEmote: (emote: Emote) => void;
  /** Called with the raw input text; the server sanitizes it. */
  readonly sendChat: (text: string) => void;
  readonly projectBoard: ProjectBoardActions;
  /** Asks the server to hire for a candidate job; it decides. */
  readonly hire: (candidateId: string) => void;
  /** Asks the server to let an agent go; it decides. */
  readonly fire: (agentId: string) => void;
  readonly manager: ManagerPanelActions;
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
  managerOpen: false,
  managerLog: [],
  managerUnread: 0,
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
      {entry.isOperator ? <span className="hud__badge hud__badge--operator">Operator</span> : null}
      {entry.isLocal ? <span className="hud__you">you</span> : null}
    </li>
  );
}

/**
 * One agent's line: its name and title, the simulated tag its nameplate also
 * carries when it is simulated, and the same activity its badge shows.
 */
function AgentRow({ entry }: { entry: RosterEntry }) {
  const appearance =
    entry.activity === undefined ? undefined : AGENT_ACTIVITY_APPEARANCE[entry.activity];
  const simulated = isSimulated(entry.kind);
  return (
    <li
      className={`hud__occupant hud__occupant--agent${simulated ? " hud__occupant--simulated" : ""}`}
    >
      <span className="hud__name">{entry.name}</span>
      <span className="hud__title-of">{entry.jobTitle}</span>
      {simulated ? <span className="hud__simulated">{SIMULATED_LABEL}</span> : null}
      {appearance === undefined ? null : (
        <span className="hud__activity" style={{ color: appearance.colour }}>
          {appearance.label}
        </span>
      )}
    </li>
  );
}

/** One live coding agent's line: its name, and its task linked to the issue or pull request. */
function LiveAgentRow({ entry }: { entry: RosterEntry }) {
  return (
    <li className="hud__occupant">
      <span className="hud__name">{entry.name}</span>
      <span className="hud__badge hud__badge--agent">Agent</span>
      {entry.caption === "" ? null : <AgentTask caption={entry.caption} url={entry.taskUrl} />}
    </li>
  );
}

/** The AI manager's line: its name and title, its status, and whether it has said anything unread. */
function ManagerRow({ entry, unread }: { entry: RosterEntry; unread: number }) {
  const appearance = MANAGER_STATUS_APPEARANCE[entry.managerStatus ?? MANAGER_STATUS.idle];
  return (
    <li className="hud__occupant hud__occupant--manager">
      <span className="hud__name">{entry.name}</span>
      <span className="hud__title-of hud__title-of--manager">{entry.jobTitle}</span>
      <span className="hud__activity" style={{ color: appearance.colour }}>
        {appearance.label}
      </span>
      <span className="hud__task">
        {unread > 0 ? `${unread} new — ` : ""}talk to it at its desk in the lobby
      </span>
    </li>
  );
}

/**
 * Who is in the office: people first, then the manager, the agent employees and
 * the live coding agents under headings of their own, so the roster answers
 * "who is a person here?" as plainly as the floor does.
 */
function Roster({
  roster,
  boardAccess,
  managerUnread,
}: {
  roster: readonly RosterEntry[];
  boardAccess: BoardAccess | undefined;
  managerUnread: number;
}) {
  const { people, agents, liveAgents, managers } = groupRoster(roster);
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
        </>
      )}
      {agents.length === 0 ? null : (
        <>
          <h2 className="hud__title hud__title--group">Agents ({agents.length})</h2>
          <ul className="hud__roster">
            {agents.map((entry) => (
              <AgentRow entry={entry} key={entry.id} />
            ))}
          </ul>
        </>
      )}
      {liveAgents.length === 0 ? null : (
        <>
          <h2 className="hud__title hud__title--group">Live agents ({liveAgents.length})</h2>
          <ul className="hud__roster">
            {liveAgents.map((entry) => (
              <LiveAgentRow entry={entry} key={entry.id} />
            ))}
          </ul>
        </>
      )}
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
    company,
    boardAccess,
    work,
    staff,
    moraleHit,
    managerOpen,
    managerLog,
    managerUnread,
    managerAccess,
    operatorAccess,
  } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const assetNote = ASSET_TEXT[assets];

  return (
    <div className="hud">
      {/* Always mounted, so hiding it is a transition rather than a cut. */}
      <div className={assets === "loading" ? "hud__loading" : "hud__loading hud__loading--done"}>
        <p className="hud__loading-text">Furnishing the office…</p>
      </div>

      <div className="hud__column">
        <CompanyPanel readout={company} moraleHit={moraleHit} />

        <Roster roster={roster} boardAccess={boardAccess} managerUnread={managerUnread} />

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
          actions={actions.projectBoard}
        />
      ) : null}

      {company?.bankrupt === true ? <CompanyEndState readout={company} /> : null}
      {managerOpen ? (
        <ManagerPanel
          entries={managerLog}
          access={managerAccess}
          operator={operatorAccess}
          thinking={groupRoster(roster).managers.some((entry) => entry.managerStatus === MANAGER_STATUS.thinking)}
          actions={actions.manager}
        />
      ) : null}

      <div className="hud__column hud__column--right">
        {staff === undefined ? null : (
          <StaffPanel
            staff={staff}
            agents={groupRoster(roster).agents}
            hire={actions.hire}
            fire={actions.fire}
          />
        )}

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
