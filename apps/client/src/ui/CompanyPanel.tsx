/**
 * The company's vital signs on the HUD, and the end state when it runs out of
 * cash.
 *
 * Both render a {@link CompanyReadout}, already reduced to the strings on
 * screen, so neither does arithmetic and both re-render only when one of those
 * strings changes. The numbers are the server's: every client shows the same
 * day, clock and balance because each is copied off the same patch.
 *
 * Morale turns red under the quitting line, with a warning that counts the bad
 * days, so an agent walking out is never a surprise; a firing's cost flashes
 * beside it as it lands.
 */

import type { CompanyReadout } from "../companyReadout.js";

export function CompanyPanel({
  readout,
  moraleHit,
}: {
  readout: CompanyReadout | undefined;
  moraleHit?: { readonly id: number; readonly text: string } | undefined;
}) {
  return (
    <div className="hud__panel">
      <h2 className="hud__title">Company</h2>
      {readout === undefined ? (
        <p className="hud__status">Opening the books…</p>
      ) : (
        <>
          <p className="company__clock">
            <span>{readout.day}</span>
            <span
              className={
                readout.bankrupt ? "company__time company__time--stopped" : "company__time"
              }
            >
              {readout.clock}
            </span>
          </p>
          <dl className="company__metrics">
            <dt>Cash</dt>
            <dd
              className={
                readout.bankrupt ? "company__value company__value--bad" : "company__value"
              }
            >
              {readout.cash}
            </dd>
            <dt>Morale</dt>
            <dd
              className={
                readout.moraleLow ? "company__value company__value--bad" : "company__value"
              }
            >
              {/* Keyed by the firing, so each one replays the fade from the start. */}
              {moraleHit === undefined ? null : (
                <span className="company__delta" key={moraleHit.id}>
                  {moraleHit.text}
                </span>
              )}
              {readout.morale}
            </dd>
            <dt>Productivity</dt>
            <dd className="company__value">{readout.productivity}</dd>
          </dl>
          {readout.moraleWarning === "" ? null : (
            <p className="company__warning" role="status">
              {readout.moraleWarning}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Shown over the office once the company is bankrupt.
 *
 * It takes no pointer events, so the office stays walkable behind it: the end
 * state stops the company, not the people in it.
 */
export function CompanyEndState({ readout }: { readout: CompanyReadout }) {
  return (
    <div className="company__end" role="status">
      <h2 className="company__endTitle">Out of cash</h2>
      <p className="company__endText">
        The company ran out of cash on {readout.day.toLowerCase()} and has folded. The clock
        has stopped.
      </p>
    </div>
  );
}
