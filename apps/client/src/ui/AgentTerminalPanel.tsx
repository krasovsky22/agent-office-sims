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
 * Read-only for now. The composer at the bottom is where prompting the agent
 * will go, and is disabled until it can.
 */

import { MAX_SCREEN_ROWS } from "@sim/shared";
import { useEffect, useRef } from "react";

import type { TerminalLinks } from "../agentTerminal.js";
import type { TerminalScreen } from "../net/screens.js";
import { SCREEN_PLACEHOLDER, paintScreen } from "../scene/agentScreen.js";
import type { RosterEntry } from "./Hud.js";

export interface AgentTerminalActions {
  /** The agent's terminal as of the latest frame, read on every repaint. */
  readonly screenOf: (agentId: string) => TerminalScreen | undefined;
  /** Closes the panel; the caller unmounts it. */
  readonly close: () => void;
}

interface AgentTerminalPanelProps {
  readonly agentId: string;
  /** `undefined` for an agent the roster has not caught up with. */
  readonly agent: RosterEntry | undefined;
  readonly links: TerminalLinks;
  readonly actions: AgentTerminalActions;
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

export function AgentTerminalPanel({ agentId, agent, links, actions }: AgentTerminalPanelProps) {
  const canvasRef = useTerminalCanvas(agentId, actions.screenOf);
  const name = agent?.name ?? "Agent";

  // The pointer lock swallows clicks, so a player who walked up while looking
  // around could not reach the links. Closing does not take the lock back: a
  // click on the canvas does that, as it always has.
  useEffect(() => {
    if (document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
  }, []);

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

      <form className="hud__composer" aria-label={`Prompt ${name}`} onSubmit={(event) => event.preventDefault()}>
        <input
          className="hud__input"
          type="text"
          name="agent-prompt"
          placeholder="Prompting an agent from the office is not available yet"
          aria-label={`Prompt to ${name}`}
          disabled
        />
        <button className="hud__send" type="submit" disabled>
          Send
        </button>
      </form>

      <p className="board__hint">
        <span className="hud__keys">E</span> or <span className="hud__keys">Esc</span> to close.
      </p>
    </section>
  );
}
