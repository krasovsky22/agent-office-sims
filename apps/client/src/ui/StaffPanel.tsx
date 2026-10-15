/**
 * Hiring and firing, for the CEO; the payroll and the desks left, for everyone.
 *
 * Everything shown comes from a {@link StaffReadout} and the roster's agents,
 * both already reduced to what is on screen. The controls only send a request:
 * the server decides, and a refusal comes back as a notice with its reason, so
 * a button here is never the authority on whether a hire happens.
 *
 * Firing takes two clicks, the second on a button that only appears after the
 * first, because it costs the whole office morale and cannot be undone.
 */

import { useState } from "react";

import type { StaffReadout } from "../staffing.js";
import { formatCash } from "../companyReadout.js";
import type { RosterEntry } from "./Hud.js";

/** Blurred after a click, so Enter or Space goes back to the game, not the button. */
function blurAnd(action: () => void) {
  return (event: { currentTarget: HTMLButtonElement }) => {
    event.currentTarget.blur();
    action();
  };
}

function StaffRow({ agent, fire }: { agent: RosterEntry; fire: (agentId: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="staff__row">
      <span className="hud__name">{agent.name}</span>
      <span className="hud__title-of">{agent.jobTitle}</span>
      <span className="staff__salary">{formatCash(agent.salary)}/day</span>
      {confirming ? (
        <span className="staff__confirm">
          <button
            className="staff__button staff__button--danger"
            type="button"
            onClick={blurAnd(() => {
              setConfirming(false);
              fire(agent.id);
            })}
          >
            Let go
          </button>
          <button
            className="staff__button"
            type="button"
            onClick={blurAnd(() => setConfirming(false))}
          >
            Keep
          </button>
        </span>
      ) : (
        <button
          className="staff__button"
          type="button"
          title="Costs the whole office morale; their unfinished work goes back to the backlog"
          onClick={blurAnd(() => setConfirming(true))}
        >
          Fire
        </button>
      )}
    </li>
  );
}

export function StaffPanel({
  staff,
  agents,
  hire,
  fire,
}: {
  staff: StaffReadout;
  agents: readonly RosterEntry[];
  hire: (candidateId: string) => void;
  fire: (agentId: string) => void;
}) {
  // Folded away until asked for: eight jobs is a long list to keep over the office.
  const [hiring, setHiring] = useState(false);
  return (
    <div className="hud__panel staff">
      <h2 className="hud__title">Staff</h2>
      <p className="staff__summary">
        <span>{staff.desks}</span>
        <span>Payroll {staff.payroll}</span>
      </p>
      {!staff.canManage ? (
        <p className="hud__hint">Only the CEO hires and fires.</p>
      ) : (
        <>
          {agents.length === 0 ? null : (
            <ul className="staff__list">
              {agents.map((agent) => (
                <StaffRow agent={agent} fire={fire} key={agent.id} />
              ))}
            </ul>
          )}
          {staff.full ? (
            <p className="hud__hint">Every agent desk is taken: fire someone to make room.</p>
          ) : (
            <button
              className="staff__button staff__toggle"
              type="button"
              aria-expanded={hiring}
              onClick={blurAnd(() => setHiring(!hiring))}
            >
              {hiring ? "Close the hiring list" : "Hire someone…"}
            </button>
          )}
          {!hiring || staff.full ? null : (
            <ul className="staff__list">
              {staff.candidates.map((candidate) => (
                <li className="staff__row staff__row--candidate" key={candidate.id}>
                  <span className="staff__job">
                    <span className="hud__name">{candidate.jobTitle}</span>
                    <span className="staff__salary">
                      {candidate.salary} · {candidate.fee}
                    </span>
                  </span>
                  <button
                    className="staff__button"
                    type="button"
                    onClick={blurAnd(() => hire(candidate.id))}
                  >
                    Hire
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
