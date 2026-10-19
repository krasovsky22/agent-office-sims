/**
 * The menu a long press of `E` opens on the coding agent the player faces:
 * cancel its task, or fire it.
 *
 * What it offers is `agentMenu.ts`'s, from the server's own rule; a button
 * the server would refuse is drawn disabled with the reason under it. It
 * opens with the mouse released so the buttons can be clicked, and `E`,
 * `Esc` or stepping away closes it.
 */

import type { AgentAction } from "@sim/shared";

import type { AgentMenuView } from "../agentMenu.js";

export interface AgentMenuActions {
  readonly act: (agentId: string, action: AgentAction) => void;
}

export function AgentMenu({ menu, actions }: { menu: AgentMenuView; actions: AgentMenuActions }) {
  return (
    <div className="hud__panel agent-menu" role="menu" aria-label={`${menu.agentName}'s menu`}>
      <h2 className="hud__title">
        {menu.agentName}
        {menu.task === "" ? null : <span className="agent-menu__task"> · on {menu.task}</span>}
      </h2>
      {menu.options.map((option) => (
        <div key={option.action} className="agent-menu__option">
          <button
            type="button"
            role="menuitem"
            className={option.action === "fire" ? "panel__button agent-menu__button agent-menu__button--fire" : "panel__button agent-menu__button"}
            disabled={option.refusal !== undefined}
            onClick={() => actions.act(menu.agentId, option.action)}
          >
            {option.label}
          </button>
          {option.refusal === undefined ? null : <p className="hud__hint">{option.refusal}</p>}
        </div>
      ))}
      <p className="hud__hint">
        <span className="hud__keys">E</span> or <span className="hud__keys">Esc</span> to close
      </p>
    </div>
  );
}
