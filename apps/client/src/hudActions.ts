/**
 * What the HUD's buttons and fields do: each sends its command to the office,
 * or tells the game loop to close a panel or stand the player up.
 *
 * Kept apart from `gameLoop.ts` so a new button is wired here, not in the loop;
 * the HUD never touches the socket itself, and the server decides what comes
 * of every command.
 */

import { parseRadioSource } from "@sim/shared";

import { helpSeen, markHelpSeen } from "./help.js";
import type { RoomConnection } from "./net/room.js";
import type { PendingIssueMoves } from "./pendingIssueMoves.js";
import { NOT_A_YOUTUBE_LINK, type RadioSettings, writeRadioSettings } from "./radio.js";
import type { HudActions, HudSnapshot } from "./ui/hudStore.js";

/** What the actions need of the game loop. */
export interface HudActionsHost {
  readonly room: RoomConnection;
  readonly publish: (next: Partial<HudSnapshot>) => void;
  /** The snapshot as last published. */
  readonly hud: () => HudSnapshot;
  readonly browserStorage: () => Storage | undefined;
  readonly serverUrl: () => string;
  /** Looks through the other camera, and keeps the choice for the next visit. */
  readonly toggleCamera: () => void;
  /** Opens an agent's terminal panel from the roster or a notification, wherever the player stands. */
  readonly answer: (agentId: string) => void;
  readonly issueMoves: Pick<PendingIssueMoves, "move">;
  /** The name asked for on the card or in Rename, kept in the browser only once the office gives it. */
  readonly askedFor: (name: string) => void;
  /** Closes the board's close-up or the conversation with the manager. */
  readonly closePanel: () => void;
  /** Closes an agent's terminal panel, however it was opened. */
  readonly closeTerminal: () => void;
  /** The agent whose profile was just saved, for an edit the limiter drops. */
  readonly savedProfile: (agentId: string) => void;
  /** The agent whose key pad in the standup panel was just pressed, for a key the limiter drops. */
  readonly pressedKey: (agentId: string) => void;
  /** The desk panel's Stand up button, taken by the next frame as `E` would be. */
  readonly standUp: () => void;
  readonly closeAgentMenu: () => void;
  /** Shows a line in the radio's panel, to this player only, and takes it down again. */
  readonly radioNotice: (text: string) => void;
}

export function hudActions(host: HudActionsHost): HudActions {
  const { room } = host;
  const setRadio = (change: Partial<RadioSettings>) => {
    const radioSettings = { ...host.hud().radioSettings, ...change };
    writeRadioSettings(host.browserStorage(), radioSettings);
    host.publish({ radioSettings });
  };
  return {
    sendEmote: (emote) => room.sendEmote(emote),
    sendChat: (text) => room.sendChat(text),
    toggleCamera: host.toggleCamera,
    toggleHelp: () => host.publish({ helpOpen: !host.hud().helpOpen }),
    answer: host.answer,
    rejoin: () => {
      // A refusal is already on the HUD, with the button still by it.
      void room.rejoin().catch(() => {});
    },
    join: (name) => {
      host.askedFor(name);
      // A first visit gets the controls once it is in, not over the name card.
      const firstVisit = !helpSeen(host.browserStorage());
      markHelpSeen(host.browserStorage());
      host.publish({ nameCard: undefined, helpOpen: host.hud().helpOpen || firstVisit });
      void room.connect(host.serverUrl(), name).catch(() => {
        // The status is already on the HUD; the empty office keeps rendering so the
        // failure is visible rather than a blank page.
      });
    },
    rename: (name) => {
      host.askedFor(name);
      room.sendRename(name);
    },
    projectBoard: {
      assign: (issueNumber, agentId) => room.sendWorkAssign(issueNumber, agentId),
      move: (issueNumber, status) => room.sendWorkMove(issueNumber, status),
      release: (issueNumber) => room.sendWorkRelease(issueNumber),
      setIssueState: (issueNumber, state) => host.issueMoves.move(issueNumber, state),
    },
    manager: {
      say: (text) => room.sendManagerSay(text),
      close: host.closePanel,
    },
    standing: {
      act: (action, taskId) => room.sendStanding(action, taskId),
      reschedule: (taskId, schedule) => room.sendStandingReschedule(taskId, schedule),
      history: (taskId) => room.requestStandingHistory(taskId),
      create: (task) => room.sendStandingCreate(task),
    },
    terminal: {
      screenOf: (agentId) => room.screenOf(agentId),
      prompt: (agentId, text) => room.sendAgentPrompt(agentId, text),
      key: (agentId, key) => room.sendAgentKey(agentId, key),
      resizeDesk: (cols, rows) => room.sendDeskTerminalSize(cols, rows),
      // Stands up too, so the panel closes rather than showing a computer that is off.
      turnOffDesk: () => {
        room.sendDeskTerminalOff();
        host.standUp();
      },
      close: host.closeTerminal,
    },
    profile: {
      save: (agentId, profile) => {
        host.savedProfile(agentId);
        return room.sendAgentProfile(agentId, profile);
      },
    },
    standUp: host.standUp,
    agentMenu: {
      act: (agentId, action) => {
        room.sendAgentAction(agentId, action);
        host.closeAgentMenu();
      },
    },
    radio: {
      tune: (source) => {
        if (parseRadioSource(source) === undefined) {
          host.radioNotice(NOT_A_YOUTUBE_LINK);
          return;
        }
        room.sendRadioTune(source);
      },
      setVolume: (volume) => setRadio({ volume, muted: false }),
      toggleMute: () => setRadio({ muted: !host.hud().radioSettings.muted }),
      close: host.closePanel,
    },
    standup: {
      start: () => room.sendStandupStart(),
      end: () => room.sendStandupEnd(),
      direct: (agentId, text) => room.sendStandupDirection(agentId, text),
      key: (agentId, key) => {
        host.pressedKey(agentId);
        return room.sendAgentKey(agentId, key);
      },
      screenOf: (agentId) => room.screenOf(agentId),
    },
  };
}
