/**
 * The conversation with the AI manager, opened with `E` at its desk in its office.
 *
 * Everyone in the office may read it; only the CEO gets a composer that does
 * anything, and anyone else is told who can, from `managerAccess.ts`, which
 * asks the server's own rule. Lines are the server's: the CEO's message is not
 * drawn until the server has taken it and broadcast it back, so a refused
 * message never appears as though it had been heard, and what this tab shows
 * is what every other tab shows.
 *
 * The panel takes the keyboard while it has focus: it is marked as a keyboard
 * owner (see `keys.ts`), so walking, emotes and chat all decline keys while
 * the focus is inside it, and it pulls the focus to its composer when it opens. `Enter` sends, `Escape` closes, and closing hands the
 * keyboard back to walking. With the focus out in the office, `Esc` still
 * closes it, through the controller, and stepping away closes it too.
 *
 * Every string is a React text node, from text the server sanitized, so a line
 * holding markup is shown rather than interpreted; a reply's line breaks are
 * kept by CSS rather than by turning them into elements.
 */

import { MANAGER_ENTRY_KIND, MANAGER_NAME, MAX_MANAGER_MESSAGE_LENGTH, type ManagerEntry } from "@sim/shared";
import { useEffect, useRef, useState } from "react";

import { KEYBOARD_OWNER_ATTRIBUTE } from "../keys.js";
import type { ManagerAccess } from "../managerAccess.js";

import { MicButton } from "./MicButton.js";

export interface ManagerPanelActions {
  /** Called with the raw text; the server sanitizes it and decides whether to listen. */
  readonly say: (text: string) => void;
  /** Closes the panel; the caller unmounts it. */
  readonly close: () => void;
}

interface ManagerPanelProps {
  readonly entries: readonly ManagerEntry[];
  /** `undefined` before the local player has joined, when nothing is offered. */
  readonly access: ManagerAccess | undefined;
  readonly thinking: boolean;
  readonly actions: ManagerPanelActions;
}

const ENTRY_CLASS: Readonly<Record<ManagerEntry["kind"], string>> = {
  [MANAGER_ENTRY_KIND.instruction]: "manager__line manager__line--ceo",
  [MANAGER_ENTRY_KIND.reply]: "manager__line",
  [MANAGER_ENTRY_KIND.update]: "manager__line manager__line--update",
};

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ManagerPanel({ entries, access, thinking, actions }: ManagerPanelProps) {
  const rootRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const [draft, setDraft] = useState("");
  const mayInstruct = access?.mayInstruct === true;

  useEffect(() => {
    // The pointer lock swallows clicks and keys alike, and this panel needs both.
    if (document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
    (inputRef.current ?? rootRef.current)?.focus();
  }, []);

  // Pinned to the newest line, which is where a conversation is.
  useEffect(() => {
    const log = logRef.current;
    if (log !== null) {
      log.scrollTop = log.scrollHeight;
    }
  }, [entries, thinking]);

  const submit = () => {
    const text = draft.trim();
    if (text !== "") {
      actions.say(text);
      setDraft("");
    }
  };

  return (
    <section
      ref={rootRef}
      className="board manager"
      aria-label={`Conversation with the ${MANAGER_NAME}`}
      tabIndex={-1}
      {...{ [KEYBOARD_OWNER_ATTRIBUTE]: "" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          actions.close();
        }
      }}
    >
      <header className="board__header">
        <h2 className="board__title">
          {MANAGER_NAME}
        </h2>
        <button className="panel__button" type="button" onClick={actions.close}>
          Close
        </button>
      </header>

      {entries.length === 0 ? (
        <p className="board__empty">
          Nothing said yet. The {MANAGER_NAME} answers the CEO&apos;s questions about the agents and the project
          board&apos;s issues and pull requests, and hands the issues out when asked.
        </p>
      ) : (
        <ol className="manager__log" ref={logRef} aria-live="polite">
          {entries.map((entry) => (
            <li className={ENTRY_CLASS[entry.kind]} key={entry.id}>
              <span className="manager__meta">
                <span className="manager__author">{entry.authorName}</span>
                {entry.kind === MANAGER_ENTRY_KIND.update ? <span className="manager__tag">update</span> : null}
                <time className="manager__time">{timeOf(entry.at)}</time>
              </span>
              <span className="manager__text">{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
      {thinking ? <p className="manager__thinking">The {MANAGER_NAME} is thinking…</p> : null}

      {access === undefined ? null : (
        <p className={mayInstruct ? "hud__role" : "hud__role hud__role--readonly"} role="note">
          {access.summary}
        </p>
      )}
      {mayInstruct ? (
        <form
          className="hud__composer"
          aria-label={`Message the ${MANAGER_NAME}`}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            ref={inputRef}
            className="hud__input"
            type="text"
            name="manager-message"
            value={draft}
            maxLength={MAX_MANAGER_MESSAGE_LENGTH}
            placeholder="“What is everyone working on?” · “Put Ada on #12”"
            aria-label={`Message to the ${MANAGER_NAME}`}
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
          />
          <MicButton inputRef={inputRef} setDraft={setDraft} maxLength={MAX_MANAGER_MESSAGE_LENGTH} />
          <button className="hud__send" type="submit" disabled={draft.trim() === ""}>
            Send
          </button>
        </form>
      ) : null}

      <p className="board__hint">
        <span className="hud__keys">Enter</span> to send, <span className="hud__keys">Esc</span> to close.
      </p>
    </section>
  );
}
