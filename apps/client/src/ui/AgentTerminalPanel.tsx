/**
 * A working live agent's terminal at full size, opened with `E` behind its chair.
 *
 * The desk's monitor shows the same terminal, but a monitor is too small to
 * read from across the room. This panel paints the agent's terminal onto a 2D
 * canvas in small text, its scrollback above its screen (`terminalView.ts`),
 * and keeps painting as frames arrive. The mouse wheel or a trackpad scrolls
 * it back, as do `PageUp` and `PageDown`, and `Home` and `End` outside the
 * prompt box; at the bottom it follows the agent live. The terminal is
 * pixels only: none of its text goes into the DOM, where a frame's content
 * could be mistaken for the page's.
 *
 * Every tab paints from the frames it holds itself, which every client gets
 * alike, so the panel reads the same in all of them. A frame changes several
 * times a second, so it never goes through React: the canvas repaints itself
 * from the net layer whenever the frame's version moves on.
 *
 * Around the terminal: the agent's name, what it is doing, and links to its
 * issue and pull requests, which open on GitHub in a new tab; a simulated
 * pull request, which is on no page, is named and not linked. `E` or `Esc`
 * closes the panel, and so does stepping away or the agent leaving the desk;
 * `main.ts` decides all of them.
 *
 * Below it, the prompts the CEO has had typed into this terminal, the same in
 * every tab ("Dana → Claude 1: …"), and the CEO's composer for another. The
 * composer is enabled only for whoever the server would take a prompt from,
 * from `agentPromptAccess.ts`; anyone else is told why. A prompt is not shown
 * until the server says the runner typed it, and stays in the composer until
 * then: one the agent was too busy for is still there to send again, with the
 * reason beside it. `Enter` sends, `Shift+Enter` starts a new line, and `Esc`
 * gives the keyboard back to the office, where a second `Esc` closes the panel.
 *
 * While the agent needs a person, the CEO also gets a key pad: a choice
 * screen (a permission, a setup or trust screen) takes keys, not a prompt, so
 * its buttons press up, down, a number, Enter or Esc on the agent's screen,
 * one key each. With the pad focused, the arrows, Enter and the digits are
 * pressed on the agent's screen too; `Esc` there gives the keyboard back to the
 * office, as in the prompt box, so cancelling the screen is the pad's own Esc
 * button, never a slip of the key that closes the panel. The terminal shows
 * what each key did; a key that was not pressed says why under the pad.
 */

import { AGENT_KEY_LABEL, type AgentKey, MAX_AGENT_PROMPT_LENGTH, MAX_SCREEN_ROWS, type AgentPromptEntry } from "@sim/shared";
import { useEffect, useRef, useState } from "react";

import { type AgentPromptAccess, agentKeyOfKeyboard } from "../agentPromptAccess.js";
import type { TerminalLinks } from "../agentTerminal.js";
import { KEYBOARD_OWNER_ATTRIBUTE, isTypingTarget } from "../keys.js";
import type { TerminalScreen } from "../net/screens.js";
import { SCREEN_PLACEHOLDER, paintScreen } from "../scene/agentScreen.js";
import { TERMINAL_FONT_PX, paintTerminal, wheelRows } from "../terminalView.js";
import type { RosterEntry } from "./Hud.js";

export interface AgentTerminalActions {
  /** The agent's terminal as of the latest frame, read on every repaint. */
  readonly screenOf: (agentId: string) => TerminalScreen | undefined;
  /**
   * Asks for a prompt to be typed into the agent's terminal; the server
   * sanitizes it and decides. Says whether it went out at all.
   */
  readonly prompt: (agentId: string, text: string) => boolean;
  /** Asks for a key to be pressed on the choice screen the agent waits on; says whether it went out at all. */
  readonly key: (agentId: string, key: AgentKey) => boolean;
  /** Closes the panel; the caller unmounts it. */
  readonly close: () => void;
}

/** Why the local player's last prompt was not typed, numbered so the same words twice still count as news. */
export interface AgentPromptRefusal {
  readonly id: number;
  readonly agentId: string;
  readonly text: string;
  /** It was about a key, not a prompt: it settles no prompt on its way. */
  readonly forKey?: boolean;
}

interface AgentTerminalPanelProps {
  readonly agentId: string;
  /** `undefined` for an agent the roster has not caught up with. */
  readonly agent: RosterEntry | undefined;
  readonly links: TerminalLinks;
  /** The prompts typed into this agent's terminal, oldest first. */
  readonly prompts: readonly AgentPromptEntry[];
  /** `undefined` before the local player has joined, when nothing is offered. */
  readonly access: AgentPromptAccess | undefined;
  /** The local player's occupant id, to tell their own prompt typed. */
  readonly localId: string | undefined;
  /** The latest of the local player's prompts that was not typed, for any agent. */
  readonly refusal: AgentPromptRefusal | undefined;
  readonly actions: AgentTerminalActions;
}

/**
 * How long a sent prompt holds the composer before it is given up on here.
 * Past the server's own wait for the runner, which answers first.
 */
const SEND_TIMEOUT_MS = 40_000;

/** A prompt on its way, and where things stood when it went. */
interface Sending {
  /** The newest entry for this agent when it was sent; only a later one can be it. */
  readonly afterEntryId: number;
  /** The refusal showing when it was sent; only a different one is about it. */
  readonly refusalId: number;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The key pad's buttons, in order, with what each reads as. */
const PAD_KEYS: ReadonlyArray<readonly [AgentKey, string]> = [
  ["up", "↑"],
  ["down", "↓"],
  ["1", "1"],
  ["2", "2"],
  ["3", "3"],
  ["enter", "Enter · confirm"],
  ["escape", "Esc · cancel"],
];

/** The version painted while the canvas shows its placeholder. */
const PLACEHOLDER_VERSION = -1;

/** Where the CEO has scrolled the terminal to. */
interface TerminalScroll {
  /**
   * The first row shown, counted as the screen's `historyAdded` counts, so
   * new rows arriving under it do not move it; `undefined` follows the agent
   * live. A trackpad scrolls by parts of a row, which add up here.
   */
  top: number | undefined;
  /** {@link top} at the newest rows, as last painted. */
  bottom: number;
  /** The screen's `historyAdded` when last painted, which starts again when the scrollback is emptied. */
  added: number;
  /** Rows the canvas had room for when last painted, which a page scrolls by. */
  pageRows: number;
  lineHeightPx: number;
}

/**
 * Paints the agent's terminal onto the canvas whenever its frame, the
 * canvas's size or the scroll has changed, at most once a display frame, at
 * the canvas's own pixel size so the glyphs stay sharp.
 *
 * @returns the canvas's ref, and a function that scrolls the terminal back by
 * a number of rows, or to the newest for `-Infinity`.
 */
function useTerminalCanvas(agentId: string, screenOf: AgentTerminalActions["screenOf"]) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<TerminalScroll>({
    top: undefined,
    bottom: 0,
    added: 0,
    pageRows: 1,
    lineHeightPx: TERMINAL_FONT_PX,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas === null || ctx === null || ctx === undefined) {
      return;
    }
    const scroll = scrollRef.current;
    scroll.top = undefined;
    scroll.added = screenOf(agentId)?.historyAdded ?? 0;
    let paintedVersion = Number.NaN;
    let paintedTop: number | undefined = Number.NaN;
    let request = 0;
    const paint = () => {
      request = requestAnimationFrame(paint);
      const scale = Math.min(window.devicePixelRatio, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * scale));
      const height = Math.max(1, Math.round(canvas.clientHeight * scale));
      const screen = screenOf(agentId);
      // The rows are counted afresh once the scrollback is emptied, so the row scrolled to is gone.
      const added = screen?.historyAdded ?? 0;
      if (added < scroll.added) {
        scroll.top = undefined;
      }
      scroll.added = added;
      const version = screen?.version ?? PLACEHOLDER_VERSION;
      if (version === paintedVersion && scroll.top === paintedTop && width === canvas.width && height === canvas.height) {
        return;
      }
      canvas.width = width;
      canvas.height = height;
      paintedVersion = version;
      if (screen === undefined) {
        paintScreen(ctx, width, height, undefined, SCREEN_PLACEHOLDER, MAX_SCREEN_ROWS);
      } else {
        const layout = paintTerminal(ctx, width, height, scale, screen, scroll.top);
        scroll.top = layout.top;
        scroll.bottom = layout.bottom;
        scroll.pageRows = layout.visibleRows;
        scroll.lineHeightPx = layout.lineHeightPx;
      }
      paintedTop = scroll.top;
    };
    paint();
    return () => cancelAnimationFrame(request);
  }, [agentId, screenOf]);

  // Painting holds the scroll to what there is, so this need not.
  const scrollBack = (rows: number) => {
    const scroll = scrollRef.current;
    const top = (scroll.top ?? scroll.bottom) - rows;
    scroll.top = top >= scroll.bottom ? undefined : top;
  };

  // The keys a terminal scrolls with, from anywhere in the panel; `Home` and
  // `End` only outside the prompt box, where they move the caret.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const scroll = scrollRef.current;
      const page = Math.max(1, scroll.pageRows - 1);
      const typing = isTypingTarget(event.target);
      let rows: number | undefined;
      if (event.key === "PageUp") {
        rows = page;
      } else if (event.key === "PageDown") {
        rows = -page;
      } else if (event.key === "Home" && !typing) {
        rows = Number.POSITIVE_INFINITY;
      } else if (event.key === "End" && !typing) {
        rows = Number.NEGATIVE_INFINITY;
      }
      if (rows !== undefined) {
        event.preventDefault();
        scrollBack(rows);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onWheel = (event: { deltaY: number; deltaMode: number }) => {
    const scroll = scrollRef.current;
    scrollBack(wheelRows(event.deltaY, event.deltaMode, scroll.lineHeightPx, scroll.pageRows));
  };

  return { canvasRef, onWheel };
}

export function AgentTerminalPanel({ agentId, agent, links, prompts, access, localId, refusal, actions }: AgentTerminalPanelProps) {
  const { canvasRef, onWheel } = useTerminalCanvas(agentId, actions.screenOf);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<Sending | undefined>(undefined);
  // Refusals up to this one are old news: from before the panel opened, or settled by a prompt typed since.
  const [seenRefusalId, setSeenRefusalId] = useState(refusal?.id ?? 0);
  const name = agent?.name ?? "Agent";
  const mayPrompt = access?.mayPrompt === true;
  const latestEntryId = prompts.at(-1)?.id ?? 0;
  const myRefusal = refusal !== undefined && refusal.agentId === agentId && refusal.id > seenRefusalId ? refusal : undefined;

  // The pointer lock swallows clicks, so a player who walked up while looking
  // around could not reach the links. Closing does not take the lock back: a
  // click on the canvas does that, as it always has.
  useEffect(() => {
    if (document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
  }, []);

  // Settled by the server's answer: typed, and the composer is cleared; or not,
  // and what was written stays to send again.
  useEffect(() => {
    if (sending === undefined) {
      return;
    }
    if (prompts.some((entry) => entry.id > sending.afterEntryId && entry.agentId === agentId && entry.authorId === localId)) {
      setDraft("");
      setSending(undefined);
      setSeenRefusalId(refusal?.id ?? 0);
    } else if (refusal !== undefined && refusal.agentId === agentId && refusal.id !== sending.refusalId && refusal.forKey !== true) {
      setSending(undefined);
    }
  }, [prompts, refusal, sending, localId, agentId]);

  useEffect(() => {
    if (sending === undefined) {
      return;
    }
    const timer = window.setTimeout(() => setSending(undefined), SEND_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [sending]);

  // Pinned to the newest prompt.
  useEffect(() => {
    const log = logRef.current;
    if (log !== null) {
      log.scrollTop = log.scrollHeight;
    }
  }, [latestEntryId]);

  const press = (key: AgentKey) => {
    if (mayPrompt && actions.key(agentId, key)) {
      // What was said about the last key is old news once another is on its way.
      if (refusal?.forKey === true) {
        setSeenRefusalId(refusal.id);
      }
    }
  };

  const submit = () => {
    const text = draft.trim();
    if (text === "" || sending !== undefined || !mayPrompt) {
      return;
    }
    if (actions.prompt(agentId, text)) {
      setSending({ afterEntryId: latestEntryId, refusalId: refusal?.id ?? 0 });
    }
  };

  return (
    <section className="board terminal" aria-label={`${name}'s terminal`}>
      <header className="board__header">
        <h2 className="board__title">
          {name}
          <span className="board__repo">Live agent</span>
          {agent?.needsInput === true ? (
            <span className="hud__badge hud__badge--needs-you">Needs you</span>
          ) : (
            <span className="hud__badge hud__badge--agent">Working</span>
          )}
        </h2>
        <button
          className="panel__button"
          type="button"
          onClick={(event) => {
            event.currentTarget.blur();
            actions.close();
          }}
        >
          Close
        </button>
      </header>

      <p className="terminal__facts">
        {agent === undefined || agent.caption === "" ? null : (
          <span className="terminal__caption">{agent.caption}</span>
        )}
        {links.issue === undefined ? null : (
          <a className="board__link" href={links.issue.href} target="_blank" rel="noopener noreferrer">
            Issue {links.issue.label}
          </a>
        )}
        {links.pullRequests.map((link) => (
          <a className="board__link" href={link.href} target="_blank" rel="noopener noreferrer" key={link.href}>
            {link.label}
          </a>
        ))}
        {links.simulatedPullRequest ? <span className="terminal__caption">Simulated pull request, nothing on GitHub</span> : null}
      </p>

      <canvas
        className="terminal__screen"
        ref={canvasRef}
        role="img"
        aria-label={`${name}'s terminal output; scroll to read back`}
        onWheel={onWheel}
      />

      {prompts.length === 0 ? null : (
        <ol className="manager__log terminal__prompts" ref={logRef} aria-label={`Prompts typed to ${name}`}>
          {prompts.map((entry) => (
            <li className="manager__line manager__line--ceo" key={entry.id}>
              <span className="manager__meta">
                <span className="manager__author">
                  {entry.authorName} → {entry.agentName}
                </span>
                <time className="manager__time">{timeOf(entry.at)}</time>
              </span>
              <span className="manager__text">{entry.text}</span>
            </li>
          ))}
        </ol>
      )}

      {mayPrompt && agent?.needsInput === true ? (
        <div
          className="terminal__keys"
          role="group"
          aria-label={`Answer ${name}'s screen with keys`}
          tabIndex={0}
          {...{ [KEYBOARD_OWNER_ATTRIBUTE]: "" }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Back to the office, where Esc closes the panel; the Esc button cancels the screen.
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            const key = agentKeyOfKeyboard(event.key);
            if (key !== undefined && !event.altKey && !event.ctrlKey && !event.metaKey) {
              // Not a click on whichever button has the focus: the key is the agent's.
              event.preventDefault();
              press(key);
            }
          }}
        >
          <span className="terminal__keys-label">Answer its screen:</span>
          {PAD_KEYS.map(([key, text]) => (
            <button
              className="hud__send terminal__key"
              type="button"
              key={key}
              aria-label={`Press ${AGENT_KEY_LABEL[key]}`}
              onClick={() => press(key)}
            >
              {text}
            </button>
          ))}
        </div>
      ) : null}
      {myRefusal?.forKey === true ? (
        <p className="hud__notice" role="alert">
          {myRefusal.text}
        </p>
      ) : null}

      {access === undefined ? null : (
        <p className={mayPrompt ? "hud__role" : "hud__role hud__role--readonly"} role="note">
          {access.summary}
        </p>
      )}
      <form
        className="hud__composer"
        aria-label={`Prompt ${name}`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={inputRef}
          className="hud__input terminal__prompt"
          name="agent-prompt"
          rows={2}
          value={draft}
          maxLength={MAX_AGENT_PROMPT_LENGTH}
          placeholder={mayPrompt ? `Answer ${name}, or tell it what to do next` : "Only the CEO can prompt this agent"}
          aria-label={`Prompt to ${name}`}
          autoComplete="off"
          disabled={!mayPrompt}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              // Back to the office, where Esc closes the panel.
              event.preventDefault();
              inputRef.current?.blur();
            }
          }}
        />
        <button className="hud__send" type="submit" disabled={!mayPrompt || draft.trim() === "" || sending !== undefined}>
          {sending === undefined ? "Send" : "Sending…"}
        </button>
      </form>
      {myRefusal === undefined || myRefusal.forKey === true || sending !== undefined ? null : (
        <p className="hud__notice" role="alert">
          {myRefusal.text}
        </p>
      )}

      <p className="board__hint">
        <span className="hud__keys">E</span> or <span className="hud__keys">Esc</span> to close; scroll the terminal
        or use <span className="hud__keys">PgUp</span> <span className="hud__keys">PgDn</span>, and{" "}
        <span className="hud__keys">End</span> to follow it live
        {mayPrompt && agent?.needsInput === true ? (
          <>
            ; click the key pad to answer its screen with <span className="hud__keys">↑</span>{" "}
            <span className="hud__keys">↓</span>, <span className="hud__keys">1</span>–<span className="hud__keys">9</span> and{" "}
            <span className="hud__keys">Enter</span>
          </>
        ) : null}
        {mayPrompt ? (
          <>
            ; in the prompt box <span className="hud__keys">Enter</span> sends,{" "}
            <span className="hud__keys">Shift+Enter</span> starts a new line, and{" "}
            <span className="hud__keys">Esc</span> returns to the office.
          </>
        ) : (
          "."
        )}
      </p>
    </section>
  );
}
