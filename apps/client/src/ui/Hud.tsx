/**
 * The 2D overlay.
 *
 * React's whole job in this prototype is this layer. The scene is an imperative
 * Three.js loop and stays that way: the loop runs every frame, while the HUD
 * re-renders only when the roster, the connection state, or the chat log
 * actually changes. Driving the scene through React would put a reconciler on
 * the frame budget for no benefit.
 *
 * The store below is the seam between the two. The game loop pushes snapshots
 * into it; React subscribes. Chat and emotes travel the other way, through
 * {@link HudActions}, which the loop supplies — the HUD never touches the
 * socket itself.
 */

import { EMOTES, type Emote, MAX_CHAT_LENGTH } from "@sim/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { EMOTE_APPEARANCE } from "../emotes.js";
import { isTypingTarget } from "../keys.js";
import type { ConnectionStatus } from "../net/room.js";

import "./hud.css";

export interface RosterEntry {
  readonly id: string;
  readonly name: string;
  readonly isCeo: boolean;
  readonly isLocal: boolean;
}

/** One line in the chat scrollback. */
export interface ChatLogEntry {
  /** Arrival order. Chat has no server-side identity, so the client numbers it. */
  readonly id: number;
  readonly author: string;
  readonly text: string;
  readonly isLocal: boolean;
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
}

export interface HudActions {
  readonly sendEmote: (emote: Emote) => void;
  /** Called with the raw input text; the server sanitizes it. */
  readonly sendChat: (text: string) => void;
}

export interface HudStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => HudSnapshot;
  /** Replaces the snapshot and notifies React. */
  publish: (next: HudSnapshot) => void;
}

const INITIAL: HudSnapshot = { status: "connecting", roster: [], chatLog: [] };

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
        <li className="hud__line" key={entry.id}>
          <span className={entry.isLocal ? "hud__author hud__author--you" : "hud__author"}>
            {entry.author}
          </span>
          <span className="hud__said">{entry.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function Hud({ store, actions }: { store: HudStore; actions: HudActions }) {
  const { status, detail, roster, chatLog, notice } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  );

  return (
    <div className="hud">
      <div className="hud__column">
        <div className="hud__panel">
          <h2 className="hud__title">In the office ({roster.length})</h2>
          {roster.length === 0 ? (
            <p className="hud__status">Nobody here yet.</p>
          ) : (
            <ul className="hud__roster">
              {roster.map((entry) => (
                <li className="hud__occupant" key={entry.id}>
                  <span className="hud__name">{entry.name}</span>
                  {entry.isCeo ? <span className="hud__badge">CEO</span> : null}
                  {entry.isLocal ? <span className="hud__you">you</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="hud__panel">
          <h2 className="hud__title">Status</h2>
          <p className={status === "failed" ? "hud__status hud__status--failed" : "hud__status"}>
            {STATUS_TEXT[status]}
            {detail === undefined ? "" : ` — ${detail}`}
          </p>
          <p className="hud__hint">
            <span className="hud__keys">W A S D</span> to walk, drag to look around,{" "}
            <span className="hud__keys">Enter</span> to chat.
          </p>
        </div>
      </div>

      <div className="hud__column hud__column--right">
        <div className="hud__panel hud__panel--chat">
          <h2 className="hud__title">Office chat</h2>
          <ChatLog entries={chatLog} />
          <ChatComposer sendChat={actions.sendChat} />
          <EmoteBar sendEmote={actions.sendEmote} />
          {notice === undefined ? null : <p className="hud__notice">{notice}</p>}
        </div>
      </div>
    </div>
  );
}
