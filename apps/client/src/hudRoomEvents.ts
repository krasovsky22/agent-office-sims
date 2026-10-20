/**
 * The room's events that only the HUD hears of: the connection's status, the
 * conversations with the manager and the agents, the runners' spend and
 * standing tasks with their last runs, the standup, and every refusal of this
 * player's own commands, each said where the command came from.
 *
 * Kept apart from `officeLoop.ts`, whose handlers move the scene, so a new
 * refusal or a new log is added here.
 */

import type { AgentPromptEntry, ManagerEntry } from "@sim/shared";

import { agentActionRejectionText } from "./agentMenu.js";
import { agentProfileRejectionText } from "./agentProfileAccess.js";
import { agentKeyRejectionText, agentPromptRejectionText } from "./agentPromptAccess.js";
import { rejectionText } from "./boardAccess.js";
import { managerRejectionText } from "./managerAccess.js";
import type { RoomConnectionEvents } from "./net/roomEvents.js";
import { nameRejectionText } from "./playerName.js";
import { standingRejectionText } from "./standingAccess.js";
import { standupRejectionText } from "./standupAccess.js";
import { THROTTLED_PLACE, throttledNotice } from "./throttledNotice.js";
import type { HudSnapshot } from "./ui/hudStore.js";

/**
 * Lines of the conversation with the manager kept on the client: the server
 * keeps fewer than this, so it is only ever a guard against a runaway session.
 */
const MANAGER_LOG_LIMIT = 200;

/** Prompts typed into the agents' terminals kept on the client; the server hands a joiner fewer. */
const AGENT_PROMPT_LIMIT = 100;

/** What the handlers need of the game loop. */
export interface HudRoomEventsHost {
  readonly publish: (next: Partial<HudSnapshot>) => void;
  /** The snapshot as last published. */
  readonly hud: () => HudSnapshot;
  /** Shows a line to this player only, and takes it down again shortly. */
  readonly notice: (text: string) => void;
  /** Shows a line in the standup panel, to this player only, and takes it down again shortly. */
  readonly standupNotice: (text: string) => void;
  /** An occupant's display name, `undefined` once they are gone. */
  readonly nameOf: (id: string) => string | undefined;
  /** The local player's session id. */
  readonly localId: () => string;
  /** The label that keeps an issue from the live coding agents. */
  readonly restrictLabel: () => string;
  /** The agent whose key pad in the standup panel was last pressed, for a key the limiter dropped. */
  readonly lastKeyAgentId: () => string;
  /** The agent whose profile was last saved, for an edit the limiter dropped. */
  readonly lastProfileAgentId: () => string;
}

export function hudRoomEvents(host: HudRoomEventsHost): RoomConnectionEvents {
  let nextRefusalId = 1;
  // The agent whose terminal panel is open: the one watched at its screen, or the one lent to the CEO's desk.
  const openTerminalAgentId = (): string | undefined => {
    const { terminalAgentId, desk } = host.hud();
    return terminalAgentId ?? (desk === undefined || desk.agentId === "" ? undefined : desk.agentId);
  };

  return {
    onStatusChanged: (status, detail) => {
      host.publish({ status, detail });
    },

    onThrottled: (event) => {
      const { place, text } = throttledNotice(event.command);
      switch (place) {
        case THROTTLED_PLACE.prompt:
          host.publish({ agentPromptRefusal: { id: nextRefusalId++, agentId: openTerminalAgentId() ?? "", text } });
          return;
        case THROTTLED_PLACE.key:
          host.publish({
            agentPromptRefusal: { id: nextRefusalId++, agentId: openTerminalAgentId() ?? host.lastKeyAgentId(), text, forKey: true },
          });
          return;
        case THROTTLED_PLACE.profile:
          host.publish({ agentProfileNotice: { id: nextRefusalId++, agentId: host.lastProfileAgentId(), text } });
          return;
        case THROTTLED_PLACE.standup:
          host.standupNotice(text);
          return;
        case THROTTLED_PLACE.notice:
          host.notice(text);
          return;
      }
    },

    onWorkRejected: (event) => {
      host.notice(rejectionText(event.rejection, host.restrictLabel()));
    },

    onSpendChanged: (runnerSpend) => {
      host.publish({ runnerSpend });
    },

    onStandingChanged: (standingTasks) => {
      host.publish({ standingTasks });
    },

    onStandingRejected: (event) => {
      host.notice(event.reason ?? standingRejectionText(event.rejection));
    },

    onStandingHistory: (event) => {
      host.publish({ standingHistory: { ...host.hud().standingHistory, [event.taskId]: event.runs } });
    },

    // Handed over whole on every join, a reconnection included, so it replaces
    // what this tab had rather than adding to it.
    onManagerHistory: (entries) => {
      host.publish({ managerLog: entries.slice(-MANAGER_LOG_LIMIT), managerUnread: 0 });
    },

    onManagerEntry: (entry) => {
      const hud = host.hud();
      if (hud.managerLog.some((line) => line.id === entry.id)) {
        return;
      }
      const managerLog: readonly ManagerEntry[] = [...hud.managerLog, entry].slice(-MANAGER_LOG_LIMIT);
      host.publish({ managerLog, managerUnread: hud.managerOpen ? 0 : hud.managerUnread + 1 });
    },

    onManagerRejected: (event) => {
      host.notice(managerRejectionText(event.rejection));
    },

    // Handed over on every join, a reconnection included, so it replaces what this tab had.
    onAgentPromptHistory: (entries) => {
      host.publish({ agentPrompts: entries.slice(-AGENT_PROMPT_LIMIT) });
    },

    onAgentPrompted: (entry) => {
      const hud = host.hud();
      if (hud.agentPrompts.some((known) => known.id === entry.id)) {
        return;
      }
      const agentPrompts: readonly AgentPromptEntry[] = [...hud.agentPrompts, entry].slice(-AGENT_PROMPT_LIMIT);
      host.publish({ agentPrompts });
    },

    // Shown in the agent's terminal panel, and as a notice for a panel already closed.
    onAgentPromptRejected: (event) => {
      const agentName = host.nameOf(event.agentId) ?? "The agent";
      const text =
        event.key === undefined
          ? agentPromptRejectionText(event.rejection, agentName)
          : agentKeyRejectionText(event.rejection, agentName, event.key);
      host.publish({ agentPromptRefusal: { id: nextRefusalId++, agentId: event.agentId, text, forKey: event.key !== undefined } });
      // The standup panel says it under the agent's key pad, as the terminal panel does.
      if (openTerminalAgentId() !== event.agentId && !host.hud().standup.active) {
        host.notice(text);
      }
    },

    onAgentActionRejected: (event) => {
      host.notice(
        agentActionRejectionText(event.rejection, host.nameOf(event.agentId) ?? "The agent", host.hud().roster.find((entry) => entry.isCeo)?.name),
      );
    },

    // On the agent's profile card, where the edit was saved from.
    onAgentProfileRejected: (event) => {
      const text = agentProfileRejectionText(event, host.nameOf(event.agentId) ?? "The agent");
      host.publish({ agentProfileNotice: { id: nextRefusalId++, agentId: event.agentId, text } });
    },

    onNameRejected: (event) => {
      host.notice(nameRejectionText(event, host.nameOf(host.localId())));
    },

    onStandupChanged: (standup) => {
      host.publish({ standup });
    },

    // In the standup panel while one is on, where the command came from; as a notice otherwise.
    onStandupRejected: (event) => {
      const text = standupRejectionText(event);
      if (host.hud().standup.active) {
        host.standupNotice(text);
      } else {
        host.notice(text);
      }
    },
  };
}
