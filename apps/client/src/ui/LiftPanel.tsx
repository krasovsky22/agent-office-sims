/**
 * The lift's floor list, opened with `E` at a lift's doors: each floor of the
 * building, whose office it is and who is there, and a button to ride to it.
 *
 * Like the radio's panel it takes the keyboard while it has focus (see
 * `keys.ts`), so `Escape` closes it rather than walking the player off. What
 * the buttons do is ask: the server decides, and the ride itself is the
 * connection's.
 */

import type { LiftFloor } from "@sim/shared";
import { useEffect, useRef } from "react";

import { KEYBOARD_OWNER_ATTRIBUTE } from "../keys.js";
import { floorLabel, headcount } from "../lift.js";

export interface LiftActions {
  readonly ride: (floor: number) => void;
  /** Closes the panel; the caller unmounts it. */
  readonly close: () => void;
}

interface LiftPanelProps {
  /** The floors as the server last listed them; `undefined` until it has. */
  readonly floors: readonly LiftFloor[] | undefined;
  /** The floor the player is on. */
  readonly current: number;
  readonly notice: string | undefined;
  readonly actions: LiftActions;
}

export function LiftPanel({ floors, current, notice, actions }: LiftPanelProps) {
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // The pointer lock swallows clicks and keys alike, and this panel needs both.
    if (document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
    rootRef.current?.focus();
  }, []);

  return (
    <section
      ref={rootRef}
      className="board lift"
      aria-label="Lift"
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
        <h2 className="board__title">Lift</h2>
        <button className="panel__button" type="button" onClick={actions.close}>
          Close
        </button>
      </header>

      {floors === undefined ? (
        <p className="board__hint">Calling the lift…</p>
      ) : (
        <ol className="lift__floors" aria-label="Floors">
          {floors.map((floor) => (
            <li key={floor.floor} className="lift__floor">
              <span className="lift__name">{floorLabel(floor.floor, floor.repository)}</span>
              <span className="lift__people">{headcount(floor.people)}</span>
              {floor.floor === current ? (
                <span className="lift__here">You are here</span>
              ) : (
                <button className="panel__button" type="button" onClick={() => actions.ride(floor.floor)}>
                  Go
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {notice === undefined ? null : (
        <p className="hud__notice" role="alert">
          {notice}
        </p>
      )}

      <p className="board__hint">
        Each floor is one repository's office, with its own board. <span className="hud__keys">Esc</span> to close.
      </p>
    </section>
  );
}
