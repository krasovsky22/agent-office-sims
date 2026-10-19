/**
 * The standup, docked over the foot of the office while one is on, the same
 * in every tab.
 *
 * Everything it shows is the replicated standup (`StandupData`): who called
 * it, the agents in the order they speak, what each said it has worked on and
 * what holds it up, and the CEO's directions with what came of each. Nothing
 * here decides anything: the server runs the meeting, and the panel is a
 * view of it with the CEO's controls.
 *
 * The CEO resolves a blocker as at the agent's desk: its terminal opens here,
 * with the key pad for the choice screen it waits on, and the direction box
 * answers a question it asked. A direction goes to one agent or to everyone;
 * the server types it into a coding agent's terminal at once if it waits at
 * its prompt, or keeps it for when it next does after the standup, and its
 * record here says which. `End standup` sends everyone back to work.
 * Everyone else sees the same panel with the controls disabled, and why.
 */

import {
  type AgentKey,
  MAX_AGENT_PROMPT_LENGTH,
  STANDUP_EVERYONE,
  type StandupData,
  type StandupUpdateData,
  agentLabel,
} from "@sim/shared";
import { useEffect, useRef, useState } from "react";

import type { TerminalScreen } from "../net/screens.js";
import { type StandupAccess, directionStatusText, standupPhaseText } from "../standupAccess.js";
import { type AgentPromptRefusal, KeyPad, useTerminalCanvas } from "./AgentTerminalPanel.js";
import type { RosterEntry } from "./Hud.js";

export interface StandupActions {
  readonly end: () => void;
  /** Gives one agent, or everyone for `STANDUP_EVERYONE`, a direction; says whether it went out at all. */
  readonly direct: (agentId: string, text: string) => boolean;
  /** Presses a key on the choice screen an agent waits on; says whether it went out at all. */
  readonly key: (agentId: string, key: AgentKey) => boolean;
  /** An agent's terminal as of the latest frame. */
  readonly screenOf: (agentId: string) => TerminalScreen | undefined;
}

interface StandupPanelProps {
  readonly standup: StandupData;
  readonly roster: readonly RosterEntry[];
  /** `undefined` before the local player has joined, when nothing is offered. */
  readonly access: StandupAccess | undefined;
  /** Why the local player's latest key was not pressed, if one was not. */
  readonly refusal: AgentPromptRefusal | undefined;
  /** Why the local player's latest standup command was refused, if one was. */
  readonly notice: string | undefined;
  readonly actions: StandupActions;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** An agent's terminal, small, read off the frames this tab holds. */
function StandupTerminal({ agentId, name, screenOf }: { agentId: string; name: string; screenOf: StandupActions["screenOf"] }) {
  const { canvasRef, onWheel } = useTerminalCanvas(agentId, screenOf);
  return (
    <canvas
      className="terminal__screen standup__screen"
      ref={canvasRef}
      role="img"
      aria-label={`${name}'s terminal output; scroll to read back`}
      onWheel={onWheel}
    />
  );
}

/** What one agent said, or where it is in the turn order. */
function UpdateText({ update, speaking }: { update: StandupUpdateData | undefined; speaking: boolean }) {
  if (update === undefined) {
    return <p className="standup__said standup__said--waiting">{speaking ? "Speaking…" : "Waiting for its turn."}</p>;
  }
  return (
    <>
      <p className="standup__said">{update.workedOn}</p>
      <p className={update.blockers === "" ? "standup__said" : "standup__blocker"}>
        {update.blockers === "" ? "No blockers." : `Blocker: ${update.blockers}`}
        {update.resolved ? <span className="standup__resolved"> — resolved</span> : null}
      </p>
    </>
  );
}

export function StandupPanel({ standup, roster, access, refusal, notice, actions }: StandupPanelProps) {
  const [watching, setWatching] = useState<string | undefined>(undefined);
  const [target, setTarget] = useState<string>(STANDUP_EVERYONE);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const directionsRef = useRef<HTMLOListElement>(null);
  const mayRun = access?.mayRun === true;
  const nameOf = (id: string) => roster.find((entry) => entry.id === id)?.name;
  const agents = standup.order.flatMap((id) => {
    const entry = roster.find((candidate) => candidate.id === id);
    return entry === undefined ? [] : [entry];
  });
  const latestDirection = standup.directions.at(-1)?.id ?? 0;

  // The pointer lock swallows clicks, so the CEO could not reach the controls.
  useEffect(() => {
    if (mayRun && document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
  }, [mayRun]);

  // An agent that left takes its terminal and its place as a target with it.
  useEffect(() => {
    if (watching !== undefined && !agents.some((agent) => agent.id === watching)) {
      setWatching(undefined);
    }
    if (target !== STANDUP_EVERYONE && !agents.some((agent) => agent.id === target)) {
      setTarget(STANDUP_EVERYONE);
    }
  }, [agents, watching, target]);

  // Pinned to the newest direction.
  useEffect(() => {
    const list = directionsRef.current;
    if (list !== null) {
      list.scrollTop = list.scrollHeight;
    }
  }, [latestDirection]);

  const submit = () => {
    const text = draft.trim();
    if (text === "" || !mayRun) {
      return;
    }
    if (actions.direct(target, text)) {
      setDraft("");
    }
  };

  return (
    <section className="board standup" aria-label="Standup">
      <header className="board__header">
        <h2 className="board__title">
          Standup
          <span className="board__repo">
            called by {standup.calledBy} · {standupPhaseText(standup, nameOf)}
          </span>
        </h2>
        <button
          className="panel__button"
          type="button"
          disabled={!mayRun}
          title={mayRun ? "Everyone goes back to work" : access?.summary}
          onClick={(event) => {
            event.currentTarget.blur();
            actions.end();
          }}
        >
          End standup
        </button>
      </header>

      <ol className="standup__agents" aria-label="Updates, in turn">
        {agents.length === 0 ? <li className="board__empty">Nobody is at the standup.</li> : null}
        {agents.map((agent) => {
          const update = standup.updates.find((candidate) => candidate.agentId === agent.id);
          const speaking = standup.speakerId === agent.id;
          const open = watching === agent.id;
          return (
            <li className={speaking ? "standup__agent standup__agent--speaking" : "standup__agent"} key={agent.id}>
              <div className="standup__who">
                <span className="hud__name">{agent.name}</span>
                {agent.title === "" ? null : <span className="standup__title">{agent.title}</span>}
                {speaking ? <span className="hud__badge hud__badge--agent">Speaking</span> : null}
                {agent.needsInput ? <span className="hud__badge hud__badge--needs-you">Needs you</span> : null}
                {agent.canTakeIssues ? (
                  <button
                    className="panel__button standup__watch"
                    type="button"
                    aria-expanded={open}
                    onClick={(event) => {
                      event.currentTarget.blur();
                      setWatching(open ? undefined : agent.id);
                    }}
                  >
                    {open ? "Hide terminal" : "Terminal"}
                  </button>
                ) : null}
              </div>
              <UpdateText update={update} speaking={speaking} />
              {open ? (
                <>
                  <StandupTerminal agentId={agent.id} name={agent.name} screenOf={actions.screenOf} />
                  {mayRun && agent.needsInput ? <KeyPad name={agent.name} press={(key) => actions.key(agent.id, key)} /> : null}
                  {refusal?.forKey === true && refusal.agentId === agent.id ? (
                    <p className="hud__notice" role="alert">
                      {refusal.text}
                    </p>
                  ) : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ol>

      {standup.directions.length === 0 ? null : (
        <ol className="manager__log standup__directions" ref={directionsRef} aria-label="Directions">
          {standup.directions.map((direction) => (
            <li className="manager__line manager__line--ceo" key={direction.id}>
              <span className="manager__meta">
                <span className="manager__author">
                  {direction.authorName} → {direction.agentName}
                  {direction.everyone ? " (everyone)" : ""}
                </span>
                <span className="manager__tag">{directionStatusText(direction)}</span>
                <time className="manager__time">{timeOf(direction.at)}</time>
              </span>
              <span className="manager__text">{direction.text}</span>
            </li>
          ))}
        </ol>
      )}

      {access === undefined ? null : (
        <p className={mayRun ? "hud__role" : "hud__role hud__role--readonly"} role="note">
          {access.summary}
        </p>
      )}
      <form
        className="hud__composer standup__composer"
        aria-label="Give a direction"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <select
          className="hud__input standup__target"
          aria-label="Who the direction is for"
          value={target}
          disabled={!mayRun}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value={STANDUP_EVERYONE}>Everyone</option>
          {agents.map((agent) => (
            <option value={agent.id} key={agent.id}>
              {agentLabel(agent.name, agent.title)}
            </option>
          ))}
        </select>
        <textarea
          ref={inputRef}
          className="hud__input terminal__prompt"
          name="standup-direction"
          rows={2}
          value={draft}
          maxLength={MAX_AGENT_PROMPT_LENGTH}
          placeholder={mayRun ? "Answer a blocker, or tell them what to do next" : "Only the CEO gives directions"}
          aria-label="Direction"
          autoComplete="off"
          disabled={!mayRun}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            } else if (event.key === "Escape") {
              // Back to the office.
              event.preventDefault();
              inputRef.current?.blur();
            }
          }}
        />
        <button className="hud__send" type="submit" disabled={!mayRun || draft.trim() === ""}>
          Send
        </button>
      </form>
      {notice === undefined ? null : (
        <p className="hud__notice" role="alert">
          {notice}
        </p>
      )}
    </section>
  );
}
