/**
 * The page's entry: the renderer, camera and player controller, the HUD
 * mounted over the canvas, and the room's events only the HUD hears of.
 *
 * React is mounted once, over the canvas, and never touched by the frame loop
 * in `./officeLoop.ts`; it only hears about things that change a few times a
 * session.
 */

import { OFFICE_LAYOUT, type OfficeLayout } from "@sim/shared";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

import { browserStorage, readServerUrl, requireCanvas, requireHudMount } from "./browserEnv.js";
import { hudActions } from "./hudActions.js";
import { hudRoomEvents } from "./hudRoomEvents.js";
import { startOfficeLoop } from "./officeLoop.js";
import { PendingIssueMoves } from "./pendingIssueMoves.js";
import { readPlayerName } from "./playerName.js";
import { timedNotice } from "./timedNotice.js";
import { type CameraMode, otherCameraMode, readCameraMode, writeCameraMode } from "./player/cameraMode.js";
import { PlayerController } from "./player/controller.js";
import { streetReach } from "./scene/street.js";
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

function createCamera(canvas: HTMLCanvasElement, layout: OfficeLayout): THREE.PerspectiveCamera {
  const span = Math.max(layout.floor.maxX - layout.floor.minX, layout.floor.maxZ - layout.floor.minZ);
  // Far enough to take in the skyline out of the street windows, too.
  const far = Math.max(span * 4, streetReach(layout) + span);
  return new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, far);
}

function start(): void {
  const canvas = requireCanvas();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // One directional light casts, the floor receives, and nothing else
  // participates — see the notes in `scene/office.ts` and `scene/lighting.ts`.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const camera = createCamera(canvas, OFFICE_LAYOUT);
  const controller = new PlayerController(camera, canvas);
  controller.attach();
  controller.setCameraMode(readCameraMode(browserStorage()));

  const resize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener("resize", resize);

  const hudStore = createHudStore();
  let hud: HudSnapshot = hudStore.getSnapshot();

  const publishHud = (next: Partial<HudSnapshot>) => {
    hud = { ...hud, ...next };
    hudStore.publish(hud);
  };
  publishHud({ cameraMode: controller.mode });

  /** Looks through the other camera, and keeps the choice for the next visit. */
  const toggleCameraMode = () => {
    const mode: CameraMode = otherCameraMode(controller.mode);
    controller.setCameraMode(mode);
    writeCameraMode(browserStorage(), mode);
    publishHud({ cameraMode: mode });
  };

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

  const issueMoves = new PendingIssueMoves({
    publish: (moves) => publishHud({ issueMoves: moves }),
    notice: showBoardNotice,
    send: (issueNumber, state) => room.sendIssueState(issueNumber, state),
  });

  const appendChatLine = (entry: ChatLogEntry) => {
    publishHud({ chatLog: [...hud.chatLog, entry].slice(-CHAT_LOG_LIMIT) });
  };

  const loop = startOfficeLoop({
    renderer,
    camera,
    controller,
    publish: publishHud,
    hud: () => hud,
    notice: showNotice,
    toggleCamera: toggleCameraMode,
    hudEvents: {
      ...hudRoomEvents({
        publish: publishHud,
        hud: () => hud,
        notice: showNotice,
        standupNotice: showStandupNotice,
        nameOf: (id) => room.occupantName(id),
        localId: () => room.sessionId,
        restrictLabel: () => room.agentRestrictLabel(),
        lastKeyAgentId: () => lastKeyAgentId,
        lastProfileAgentId: () => lastProfileAgentId,
      }),

      onChat: (event) => {
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
      },
    },
  });
  const { room } = loop;

  createRoot(requireHudMount()).render(
    createElement(Hud, {
      store: hudStore,
      actions: hudActions({
        room,
        publish: publishHud,
        hud: () => hud,
        browserStorage,
        serverUrl: readServerUrl,
        toggleCamera: toggleCameraMode,
        answer: loop.answer,
        issueMoves,
        askedFor: loop.askedFor,
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
