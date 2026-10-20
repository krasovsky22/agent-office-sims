/**
 * The list of every control, over the office: opened by itself on a first
 * visit (`main.ts` decides that), and by `H` at any time after.
 *
 * Always mounted, so `H` reaches it whether or not it is showing. Opening it
 * frees a captured mouse, which would otherwise swallow the click on its
 * close button.
 */

import { useEffect } from "react";

import { CONTROLS, HELP_KEY } from "../help.js";
import { isTypingTarget } from "../keys.js";

export function HelpOverlay({ open, toggle }: { open: boolean; toggle: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.code === HELP_KEY || (open && event.key === "Escape")) {
        event.preventDefault();
        toggle();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, toggle]);

  useEffect(() => {
    if (open && document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
  }, [open]);

  if (!open) {
    return null;
  }
  return (
    <div className="hud__help" role="dialog" aria-label="Controls">
      <div className="hud__panel">
        <h2 className="hud__title">Controls</h2>
        <dl className="hud__help-list">
          {CONTROLS.map(({ keys, action }) => (
            <div className="hud__help-row" key={keys}>
              <dt>
                <span className="hud__keys">{keys}</span>
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
        <p className="hud__hint">
          Walk in from the pavement through the lobby: signs over the doors name each room. The project board is on the
          open floor, and the AI Manager is in its office off it.
        </p>
        <button
          type="button"
          className="hud__send"
          onClick={(event) => {
            event.currentTarget.blur();
            toggle();
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
