/**
 * A working live agent's terminal at full size, opened with `E` behind its chair.
 *
 * The desk's monitor shows the same terminal, but a monitor is too small to
 * read from across the room. This panel paints the agent's terminal onto a 2D
 * canvas, its text scaled to fill it, its scrollback above its screen (`terminalView.ts`),
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
 * Around the terminal: the agent's name and title, what it is doing, and links to its
 * issue and pull requests, which open on GitHub in a new tab; a simulated
 * pull request, which is on no page, is named and not linked. `E` or `Esc`
 * closes the panel, and so does stepping away or the agent leaving the desk;
 * `gameLoop.ts` decides all of them.
 *
 * Below it, the prompts the CEO has had typed into this terminal, the same in
 * every tab ("Dana → Maya: …"), and the CEO's composer for another. The
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
 *
 * The standup panel shows an agent's terminal and key pad the same way, with
 * the key pad exported here and the canvas hook from `./terminalCanvas.ts`.
 *
 * The CEO sitting at a desk with a computer gets the same panel on the coding
 * agent lent to that desk (`deskTerminalAccess.ts`), opened by sitting down
 * rather than with `E`: it reads as the desk's computer, says why while there
 * is no terminal to prompt yet, takes its key pad's cue from the session
 * rather than the agent's body on the floor, and its close button stands the
 * CEO up, leaving the session running; its `Turn off` button ends it.
 */

import { AGENT_KEY_LABEL, type AgentKey, MAX_AGENT_PROMPT_LENGTH, type AgentPromptEntry } from "@sim/shared";
import { useEffect, useRef, useState } from "react";

import { type AgentPromptAccess, agentKeyOfKeyboard } from "../agentPromptAccess.js";
import type { TerminalLinks } from "../agentTerminal.js";
import type { DeskPanelView } from "../deskTerminalAccess.js";
import { KEYBOARD_OWNER_ATTRIBUTE } from "../keys.js";
import type { TerminalScreen } from "../net/screens.js";
import { terminalCells } from "../terminalView.js";
import type { RosterEntry } from "./hudStore.js";
import { MicButton } from "./MicButton.js";
import { useTerminalCanvas } from "./terminalCanvas.js";

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
  /** Says how many cells the desk's computer has room for, so its session's terminal is sized to fill it. */
  readonly resizeDesk: (cols: number, rows: number) => void;
  /** Turns this desk's computer off, ending its session alone, and stands the CEO up. */
  readonly turnOffDesk: (seatId: string) => void;
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
  /** Set when this is the CEO's own desk's computer, whose `close` stands the CEO up and leaves it on. */
  readonly desk?: DeskPanelView | undefined;
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

/**
 * The key pad for the choice screen an agent waits on: a button per key, and,
 * while it has the focus, the arrows, Enter and the digits from the keyboard.
 * `Esc` there hands the keyboard back to the office; the pad's own Esc button
 * is what cancels the screen.
 */
export function KeyPad({ name, press }: { readonly name: string; readonly press: (key: AgentKey) => void }) {
  return (
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
  );
}

/** How long the canvas's size holds still before the desk's terminal is sized to it, so a dragged window sends one size. */
const DESK_RESIZE_SETTLE_MS = 200;

/**
 * Sizes the desk session's terminal to the canvas as the panel opens and
 * whenever the canvas changes size, so the agent wraps its output to the
 * width the CEO reads it at rather than the runner's own, and again for each
 * agent lent to the desk, the server keeping only its sitting's. Only at the desk:
 * an issue's agent keeps the runner's size, which every tab shares.
 */
function useDeskTerminalSize(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  /** The desk's agent, `undefined` away from a desk; a newly lent one is told the size afresh. */
  deskAgentId: string | undefined,
  resizeDesk: AgentTerminalActions["resizeDesk"],
): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (deskAgentId === undefined || canvas === null) {
      return;
    }
    let sent = "";
    let timer = 0;
    const send = () => {
      const { cols, rows } = terminalCells(canvas.clientWidth, canvas.clientHeight);
      if (`${cols}x${rows}` !== sent) {
        sent = `${cols}x${rows}`;
        resizeDesk(cols, rows);
      }
    };
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(send, DESK_RESIZE_SETTLE_MS);
    });
    observer.observe(canvas);
    send();
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [canvasRef, deskAgentId, resizeDesk]);
}

/** What the panel says of the local player's access at their own desk's computer. */
const DESK_ACCESS = "You are the CEO: this desk's computer is a coding agent of your own. What you send is typed into it once it waits at its prompt; it runs on the runner's machine, and keeps running when you stand up, until you turn it off.";

export function AgentTerminalPanel({ agentId, agent, links, prompts, access, localId, refusal, actions, desk }: AgentTerminalPanelProps) {
  const { canvasRef, onWheel } = useTerminalCanvas(agentId, actions.screenOf);
  useDeskTerminalSize(canvasRef, desk?.agentId, actions.resizeDesk);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<Sending | undefined>(undefined);
  // Refusals up to this one are old news: from before the panel opened, or settled by a prompt typed since.
  const [seenRefusalId, setSeenRefusalId] = useState(refusal?.id ?? 0);
  const name = agent?.name ?? "Agent";
  // At a desk with no terminal yet, there is nothing to type to.
  const mayPrompt = access?.mayPrompt === true && desk?.agentId !== "";
  const needsInput = desk === undefined ? agent?.needsInput === true : desk.needsInput;
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
    <section className="board terminal" aria-label={desk === undefined ? `${name}'s terminal` : "Your desk's computer"}>
      <header className="board__header">
        <h2 className="board__title">
          {desk === undefined ? name : "Your desk's computer"}
          <span className="board__repo">
            {desk !== undefined ? (desk.agentId === "" ? "No agent yet" : name) : agent === undefined || agent.title === "" ? "Live agent" : agent.title}
          </span>
          {needsInput ? (
            <span className="hud__badge hud__badge--needs-you">Needs you</span>
          ) : desk?.agentId === "" ? null : (
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
          {desk === undefined ? "Close" : "Stand up"}
        </button>
        {desk === undefined ? null : (
          <button
            className="panel__button"
            type="button"
            onClick={(event) => {
              event.currentTarget.blur();
              actions.turnOffDesk(desk.seatId);
            }}
          >
            Turn off
          </button>
        )}
      </header>

      {desk === undefined || desk.message === "" ? null : (
        <p className="hud__notice" role="status">
          {desk.message}
        </p>
      )}

      <p className="terminal__facts">
        {desk !== undefined ? (
          desk.activity === "" ? null : <span className="terminal__caption">{desk.activity}</span>
        ) : agent === undefined || agent.caption === "" ? null : (
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

      {mayPrompt && needsInput ? <KeyPad name={name} press={press} /> : null}
      {myRefusal?.forKey === true ? (
        <p className="hud__notice" role="alert">
          {myRefusal.text}
        </p>
      ) : null}

      {access === undefined ? null : (
        <p className={mayPrompt ? "hud__role" : "hud__role hud__role--readonly"} role="note">
          {desk !== undefined && access.mayPrompt ? DESK_ACCESS : access.summary}
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
          rows={1}
          value={draft}
          maxLength={MAX_AGENT_PROMPT_LENGTH}
          placeholder={
            mayPrompt
              ? `Answer ${name}, or tell it what to do next`
              : desk?.agentId === ""
                ? "No coding agent at this desk yet"
                : "Only the CEO can prompt this agent"
          }
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
        <MicButton inputRef={inputRef} setDraft={setDraft} maxLength={MAX_AGENT_PROMPT_LENGTH} disabled={!mayPrompt} />
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
        {desk === undefined ? (
          <>
            <span className="hud__keys">E</span> or <span className="hud__keys">Esc</span> to close
          </>
        ) : (
          <>
            Step away with <span className="hud__keys">W A S D</span> or use Stand up and it keeps running; Turn off ends the session
          </>
        )}
        ; scroll the terminal
        or use <span className="hud__keys">PgUp</span> <span className="hud__keys">PgDn</span>, and{" "}
        <span className="hud__keys">End</span> to follow it live
        {mayPrompt && needsInput ? (
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
