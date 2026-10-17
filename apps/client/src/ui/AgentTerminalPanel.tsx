/**
 * A working live agent's terminal at full size, opened with `E` behind its chair.
 *
 * The desk's monitor shows the same terminal, but a monitor is too small to
 * read from across the room. This panel paints the agent's current frame onto
 * a 2D canvas with the monitor's own paint function, so the two cannot show
 * different things, and keeps painting as frames arrive. The terminal is
 * pixels only: none of its text goes into the DOM, where a frame's content
 * could be mistaken for the page's.
 *
 * Every tab paints from the frames it holds itself, which every client gets
 * alike, so the panel reads the same in all of them. A frame changes several
 * times a second, so it never goes through React: the canvas repaints itself
 * from the net layer whenever the frame's version moves on.
 *
 * Around the terminal: the agent's name, what it is doing, and links to its
 * issue and pull requests, which open on GitHub in a new tab. `E` or `Esc`
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
 */

import { MAX_AGENT_PROMPT_LENGTH, MAX_SCREEN_ROWS, type AgentPromptEntry } from "@sim/shared";
import { useEffect, useRef, useState } from "react";

import type { AgentPromptAccess } from "../agentPromptAccess.js";
import type { TerminalLinks } from "../agentTerminal.js";
import type { TerminalScreen } from "../net/screens.js";
import { SCREEN_PLACEHOLDER, paintScreen } from "../scene/agentScreen.js";
import type { RosterEntry } from "./Hud.js";

export interface AgentTerminalActions {
  /** The agent's terminal as of the latest frame, read on every repaint. */
  readonly screenOf: (agentId: string) => TerminalScreen | undefined;
  /**
   * Asks for a prompt to be typed into the agent's terminal; the server
   * sanitizes it and decides. Says whether it went out at all.
   */
  readonly prompt: (agentId: string, text: string) => boolean;
  /** Closes the panel; the caller unmounts it. */
  readonly close: () => void;
}

/** Why the local player's last prompt was not typed, numbered so the same words twice still count as news. */
export interface AgentPromptRefusal {
  readonly id: number;
  readonly agentId: string;
  readonly text: string;
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

/** The version painted while the canvas shows its placeholder. */
const PLACEHOLDER_VERSION = -1;

/**
 * Paints the agent's terminal onto the canvas whenever its frame or the
 * canvas's size has changed, at most once a display frame.
 *
 * The whole screen is painted, every row of it, at the canvas's own pixel
 * size so the glyphs stay sharp.
 */
function useTerminalCanvas(agentId: string, screenOf: AgentTerminalActions["screenOf"]) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas === null || ctx === null || ctx === undefined) {
      return;
    }
    let paintedVersion = Number.NaN;
    let request = 0;
    const paint = () => {
      request = requestAnimationFrame(paint);
      const scale = Math.min(window.devicePixelRatio, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * scale));
      const height = Math.max(1, Math.round(canvas.clientHeight * scale));
      const screen = screenOf(agentId);
      const version = screen?.version ?? PLACEHOLDER_VERSION;
      if (version === paintedVersion && width === canvas.width && height === canvas.height) {
        return;
      }
      canvas.width = width;
      canvas.height = height;
      paintedVersion = version;
      paintScreen(ctx, width, height, screen, SCREEN_PLACEHOLDER, MAX_SCREEN_ROWS);
    };
    paint();
    return () => cancelAnimationFrame(request);
  }, [agentId, screenOf]);

  return canvasRef;
}

export function AgentTerminalPanel({ agentId, agent, links, prompts, access, localId, refusal, actions }: AgentTerminalPanelProps) {
  const canvasRef = useTerminalCanvas(agentId, actions.screenOf);
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
    } else if (refusal !== undefined && refusal.agentId === agentId && refusal.id !== sending.refusalId) {
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
      </p>

      <canvas className="terminal__screen" ref={canvasRef} role="img" aria-label={`${name}'s terminal output`} />

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
      {myRefusal === undefined || sending !== undefined ? null : (
        <p className="hud__notice" role="alert">
          {myRefusal.text}
        </p>
      )}

      <p className="board__hint">
        <span className="hud__keys">E</span> or <span className="hud__keys">Esc</span> to close
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
