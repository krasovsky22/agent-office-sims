/**
 * The page: the HUD's store, the room, the game loop, and React mounted once
 * over the canvas.
 *
 * Wiring only. The scene and the loop that draws it are `./gameLoop.ts`, the
 * HUD's own room handlers `./hudRoomEvents.ts` and its buttons
 * `./hudActions.ts`; what is left here is the state only the HUD keeps: the
 * chat log, the notices, the cards in flight and the name asked for.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { browserStorage, readServerUrl, requireHudMount } from "./browserEnv.js";
import { startGameLoop } from "./gameLoop.js";
import { hudActions } from "./hudActions.js";
import { hudRoomEvents } from "./hudRoomEvents.js";
import { PendingIssueMoves } from "./pendingIssueMoves.js";
import { keepAcceptedName, readPlayerName } from "./playerName.js";
import { readRadioSettings } from "./radio.js";
import { timedNotice } from "./timedNotice.js";
import { RoomConnection } from "./net/room.js";
import { Hud } from "./ui/Hud.js";
import { type ChatLogEntry, type HudSnapshot, createHudStore } from "./ui/hudStore.js";

/**
 * Chat lines kept in the HUD log.
 *
 * Scrollback, not history: the log is for catching up on what was said while
 * you were looking the other way, and a session that outlives this many lines
 * has nothing at the top worth keeping on the frame budget.
 */
const CHAT_LOG_LIMIT = 50;

/** How long a "you are going too fast" notice stays on the HUD. */
const NOTICE_DURATION_MS = 2500;

/** How long the board says why a dragged card went back: long enough to read a sentence about GitHub. */
const BOARD_NOTICE_DURATION_MS = 8000;

function start(): void {
  const hudStore = createHudStore();
  let hud: HudSnapshot = hudStore.getSnapshot();

  const publishHud = (next: Partial<HudSnapshot>) => {
    hud = { ...hud, ...next };
    hudStore.publish(hud);
  };
  publishHud({ radioSettings: readRadioSettings(browserStorage()) });

  let nextChatId = 1;
  // The agent whose key pad in the standup panel was last pressed, for a key the limiter dropped.
  let lastKeyAgentId = "";
  // The agent whose profile was last saved, for an edit the limiter dropped.
  let lastProfileAgentId = "";

  /** Shows a line to this player only, and takes it down again shortly. */
  const showNotice = timedNotice((notice) => publishHud({ notice }), NOTICE_DURATION_MS);
  /** Shows a line on the project board's close-up, to this player only, and takes it down again. */
  const showBoardNotice = timedNotice((boardNotice) => publishHud({ boardNotice }), BOARD_NOTICE_DURATION_MS);
  /** Shows a line in the standup panel, to this player only, and takes it down again shortly. */
  const showStandupNotice = timedNotice((standupNotice) => publishHud({ standupNotice }), NOTICE_DURATION_MS);
  const showRadioPanelNotice = timedNotice((radioNotice) => publishHud({ radioNotice }), BOARD_NOTICE_DURATION_MS);
  /** Shows a line about the radio in its panel, or as a notice while the panel is closed. */
  const showRadioNotice = (text: string) => (hud.radioOpen ? showRadioPanelNotice(text) : showNotice(text));

  const issueMoves = new PendingIssueMoves({
    publish: (moves) => publishHud({ issueMoves: moves }),
    notice: showBoardNotice,
    send: (issueNumber, state) => room.sendIssueState(issueNumber, state),
  });

  const appendChatLine = (entry: ChatLogEntry) => {
    publishHud({ chatLog: [...hud.chatLog, entry].slice(-CHAT_LOG_LIMIT) });
  };

  const loop = startGameLoop({
    publish: publishHud,
    hud: () => hud,
    notice: showNotice,
    radioNotice: showRadioNotice,
    room: () => room,
  });
  const scene = loop.events;

  // The name asked for on the card or in Rename, kept in the browser only once the office gives it.
  let askedName: string | undefined;

  const room: RoomConnection = new RoomConnection({
    ...hudRoomEvents({
      publish: publishHud,
      hud: () => hud,
      notice: showNotice,
      standupNotice: showStandupNotice,
      radioNotice: showRadioNotice,
      nameOf: (id) => room.occupantName(id),
      localId: () => room.sessionId,
      restrictLabel: () => room.agentRestrictLabel(),
      lastKeyAgentId: () => lastKeyAgentId,
      lastProfileAgentId: () => lastProfileAgentId,
    }),
    ...scene,

    onOccupantsChanged: () => {
      if (askedName !== undefined && keepAcceptedName(browserStorage(), askedName, room.occupantName(room.sessionId))) {
        askedName = undefined;
      }
      scene.onOccupantsChanged();
    },

    onChat: (event) => {
      scene.onChat(event);
      appendChatLine({
        id: nextChatId++,
        author: room.occupantName(event.occupantId) ?? "Someone",
        text: event.text,
        isLocal: event.occupantId === room.sessionId,
      });
    },

    onIssueStateResult: (event) => {
      issueMoves.answered(event);
    },

    // Announced in the chat log, where everyone in the office is already
    // looking, rather than only in the roster badge that silently moves.
    onCeoChanged: (event) => {
      const isLocal = event.ceoId === room.sessionId;
      appendChatLine({
        id: nextChatId++,
        author: "Office",
        text: `${isLocal ? "You are" : `${room.occupantName(event.ceoId) ?? "Someone"} is`} now the CEO.`,
        isLocal: false,
        isSystem: true,
      });
      if (isLocal) {
        showNotice("The CEO left — you are now the CEO and hand out the project board's work.");
      }
    },

    onProjectBoard: (snapshot) => {
      issueMoves.snapshot(snapshot);
      scene.onProjectBoard(snapshot);
    },
  });

  createRoot(requireHudMount()).render(
    createElement(Hud, {
      store: hudStore,
      actions: hudActions({
        room,
        publish: publishHud,
        hud: () => hud,
        browserStorage,
        serverUrl: readServerUrl,
        toggleCamera: loop.toggleCamera,
        answer: loop.answer,
        issueMoves,
        askedFor: (name) => {
          askedName = name;
        },
        closePanel: loop.closePanel,
        closeTerminal: loop.closeTerminal,
        savedProfile: (agentId) => {
          lastProfileAgentId = agentId;
        },
        pressedKey: (agentId) => {
          lastKeyAgentId = agentId;
        },
        standUp: loop.standUp,
        closeAgentMenu: loop.closeAgentMenu,
        radioNotice: showRadioNotice,
      }),
    }),
  );

  // Leave deliberately, so the other tabs see the avatar go within a tick or two
  // rather than waiting for the socket to time out.
  window.addEventListener("pagehide", () => {
    void room.leave();
  });

  // Joined from the arrival card, once the player has said who they are.
  publishHud({ nameCard: readPlayerName(window.location.search, browserStorage()) });
}

start();
