/**
 * Renderer, scene, and the game loop.
 *
 * The loop is imperative and runs every frame: read input, predict the local
 * player, reconcile against the server, interpolate everyone else, draw. React
 * is mounted once, over the canvas, and never touched by the loop — it only
 * hears about things that change a few times a session.
 */

import {
  ANIMATION_STATE,
  CLIENT_MESSAGE,
  OFFICE_LAYOUT,
  type OfficeLayout,
  sanitizeName,
} from "@sim/shared";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

import { RoomConnection, type RemotePose } from "./net/room.js";
import { PlayerController } from "./player/controller.js";
import { Avatar } from "./scene/avatar.js";
import { buildOffice } from "./scene/office.js";
import { Hud, type ChatLogEntry, type HudSnapshot, createHudStore } from "./ui/Hud.js";

const DEFAULT_SERVER_URL = "ws://localhost:2567";

/**
 * Longest frame the simulation will integrate.
 *
 * A backgrounded tab resumes with a gap of seconds. Without this cap the first
 * frame back would ask the resolver for a single huge step, and a held key would
 * fling the player the length of the office.
 */
const MAX_FRAME_SECONDS = 0.1;

const BACKGROUND_COLOUR = 0x15151a;

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

function requireCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>("#scene");
  if (canvas === null) {
    throw new Error("index.html is missing the #scene canvas");
  }
  return canvas;
}

function requireHudMount(): HTMLElement {
  const mount = document.querySelector<HTMLElement>("#hud");
  if (mount === null) {
    throw new Error("index.html is missing the #hud container");
  }
  return mount;
}

function readServerUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL;
  return configured === undefined || configured === "" ? DEFAULT_SERVER_URL : configured;
}

/** An optional `?name=` lets two tabs be told apart at a glance. */
function readRequestedName(): string {
  return sanitizeName(new URLSearchParams(window.location.search).get("name"));
}

function createCamera(canvas: HTMLCanvasElement, layout: OfficeLayout): THREE.PerspectiveCamera {
  const span = Math.max(layout.floor.maxX - layout.floor.minX, layout.floor.maxZ - layout.floor.minZ);
  return new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, span * 4);
}

function start(): void {
  const canvas = requireCanvas();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND_COLOUR);
  buildOffice(scene, OFFICE_LAYOUT);

  const camera = createCamera(canvas, OFFICE_LAYOUT);
  const controller = new PlayerController(camera, canvas);
  controller.attach();

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

  const avatars = new Map<string, Avatar>();
  const remotePose: RemotePose = { x: 0, z: 0, yaw: 0, animation: ANIMATION_STATE.idle };
  let hud: HudSnapshot = hudStore.getSnapshot();

  const publishHud = (next: Partial<HudSnapshot>) => {
    hud = { ...hud, ...next };
    hudStore.publish(hud);
  };

  let nextChatId = 1;
  let noticeTimer: number | undefined;

  /** Shows a line to this player only, and takes it down again shortly. */
  const showNotice = (text: string) => {
    if (noticeTimer !== undefined) {
      window.clearTimeout(noticeTimer);
    }
    publishHud({ notice: text });
    noticeTimer = window.setTimeout(() => {
      noticeTimer = undefined;
      publishHud({ notice: undefined });
    }, NOTICE_DURATION_MS);
  };

  const appendChatLine = (entry: ChatLogEntry) => {
    publishHud({ chatLog: [...hud.chatLog, entry].slice(-CHAT_LOG_LIMIT) });
  };

  const room: RoomConnection = new RoomConnection({
    onStatusChanged: (status, detail) => {
      publishHud(detail === undefined ? { status } : { status, detail });
    },
    onLocalSpawn: (x, z, yaw) => {
      controller.teleport(x, z, yaw);
    },
    onOccupantsChanged: () => {
      const present = room.occupants();
      const ids = new Set<string>();

      for (const view of present) {
        ids.add(view.id);
        const existing = avatars.get(view.id);
        if (existing === undefined) {
          const avatar = new Avatar({
            name: view.name,
            isCeo: view.isCeo,
            isLocal: view.isLocal,
          });
          scene.add(avatar.group);
          avatars.set(view.id, avatar);
        } else {
          existing.setLabel(view.name, view.isCeo);
        }
      }

      for (const [id, avatar] of avatars) {
        if (!ids.has(id)) {
          avatar.dispose();
          avatars.delete(id);
        }
      }

      publishHud({
        roster: present.map((view) => ({
          id: view.id,
          name: view.name,
          isCeo: view.isCeo,
          isLocal: view.isLocal,
        })),
      });
    },

    // Expression events arrive for everyone, the local player included, so
    // there is one path from "somebody did a thing" to it being drawn. An
    // avatar can already be gone when an event lands — the state patch that
    // removed it may be decoded first — in which case there is nothing above
    // which to draw, and the chat log still records what was said.
    onEmote: (event) => {
      avatars.get(event.occupantId)?.showEmote(event.emote, performance.now());
    },

    onChat: (event) => {
      avatars.get(event.occupantId)?.showChat(event.text, performance.now());
      appendChatLine({
        id: nextChatId++,
        author: room.occupantName(event.occupantId) ?? "Someone",
        text: event.text,
        isLocal: event.occupantId === room.sessionId,
      });
    },

    onThrottled: (event) => {
      showNotice(
        event.command === CLIENT_MESSAGE.chat
          ? "Too many messages — that one was dropped."
          : "Too many emotes — that one was dropped.",
      );
    },
  });

  createRoot(requireHudMount()).render(
    createElement(Hud, {
      store: hudStore,
      actions: {
        sendEmote: (emote) => room.sendEmote(emote),
        sendChat: (text) => room.sendChat(text),
      },
    }),
  );

  let previousFrameMs = performance.now();

  const frame = (nowMs: number) => {
    const deltaSeconds = Math.min((nowMs - previousFrameMs) / 1000, MAX_FRAME_SECONDS);
    previousFrameMs = nowMs;

    controller.update(deltaSeconds);
    room.sendPose(controller.pose, nowMs);
    if (room.localServerPose.known) {
      controller.applyCorrection(
        room.localServerPose.x,
        room.localServerPose.z,
        deltaSeconds,
      );
    }

    const localId = room.sessionId;
    for (const [id, avatar] of avatars) {
      if (id === localId) {
        avatar.setPose(controller.pose.x, controller.pose.z, controller.pose.yaw);
      } else if (room.sampleRemote(id, nowMs, remotePose)) {
        avatar.setPose(remotePose.x, remotePose.z, remotePose.yaw);
      }
      // Overhead content is parented to the avatar, so it has already followed
      // the body; all that is left is retiring whatever has expired.
      avatar.updateExpressions(nowMs);
    }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);

  // Leave deliberately, so the other tabs see the avatar go within a tick or two
  // rather than waiting for the socket to time out.
  window.addEventListener("pagehide", () => {
    void room.leave();
  });

  void room.connect(readServerUrl(), readRequestedName()).catch(() => {
    // The status is already on the HUD; the empty office keeps rendering so the
    // failure is visible rather than a blank page.
  });
}

start();
