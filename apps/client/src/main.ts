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
  INTERACT_RANGE,
  INTERACTION_KIND,
  type InteractableSpec,
  OFFICE_LAYOUT,
  type OfficeLayout,
  authorizeInteract,
  heldAnimationFor,
  interactableById,
  nearestInteractable,
  promptFor,
  sanitizeName,
} from "@sim/shared";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

import { RoomConnection, type RemotePose } from "./net/room.js";
import { PlayerController } from "./player/controller.js";
import { Avatar } from "./scene/avatar.js";
import { buildOffice } from "./scene/office.js";
import { Hud, type HudPrompt, type HudSnapshot, createHudStore } from "./ui/Hud.js";

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

/** The prompt shown while the player is sitting, so standing up is discoverable. */
const STAND_UP_PROMPT: HudPrompt = { keys: "W A S D", label: "Stand up", blocked: false };

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
  const { seatAnchors } = buildOffice(scene, OFFICE_LAYOUT);

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
  createRoot(requireHudMount()).render(createElement(Hud, { store: hudStore }));

  const avatars = new Map<string, Avatar>();
  const remotePose: RemotePose = { x: 0, z: 0, yaw: 0, animation: ANIMATION_STATE.idle };
  let hud: HudSnapshot = hudStore.getSnapshot();

  const publishHud = (next: Partial<HudSnapshot>) => {
    hud = { ...hud, ...next };
    hudStore.publish(hud);
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
  });

  let previousFrameMs = performance.now();

  // The prompt as last published, held as loose fields so the per-frame check
  // that nothing has changed costs no allocation.
  let promptKeys = "";
  let promptLabel = "";
  let promptBlocked = false;

  /**
   * Works out what the player can do from where they are standing, and tells
   * React only when the answer changes.
   *
   * The availability test is `authorizeInteract` — the same function the server
   * will run on the message this prompt invites — so the prompt is never an
   * offer the server is going to turn down.
   *
   * @returns the interactable `E` would use, or `undefined`.
   */
  const refreshPrompt = (engagedWith: string): InteractableSpec | undefined => {
    let prompt: HudPrompt | undefined;
    let target: InteractableSpec | undefined;

    if (engagedWith !== "") {
      const held = interactableById(OFFICE_LAYOUT, engagedWith);
      // Only a seat is worth a prompt: a coffee break ends on its own.
      prompt = held?.kind === INTERACTION_KIND.seat ? STAND_UP_PROMPT : undefined;
    } else {
      target = nearestInteractable(OFFICE_LAYOUT, controller.pose, INTERACT_RANGE);
      if (target !== undefined) {
        const decision = authorizeInteract(
          OFFICE_LAYOUT,
          {
            id: room.sessionId,
            x: controller.pose.x,
            z: controller.pose.z,
            interactableId: engagedWith,
          },
          target.id,
          INTERACT_RANGE,
          (interactableId) => room.holderOf(interactableId),
        );
        prompt = {
          keys: "E",
          label: decision.allowed ? promptFor(target) : `${promptFor(target)} — taken`,
          blocked: !decision.allowed,
        };
      }
    }

    const keys = prompt?.keys ?? "";
    const label = prompt?.label ?? "";
    const blocked = prompt?.blocked ?? false;
    if (keys !== promptKeys || label !== promptLabel || blocked !== promptBlocked) {
      promptKeys = keys;
      promptLabel = label;
      promptBlocked = blocked;
      publishHud({ prompt });
    }

    return target;
  };

  const frame = (nowMs: number) => {
    const deltaSeconds = Math.min((nowMs - previousFrameMs) / 1000, MAX_FRAME_SECONDS);
    previousFrameMs = nowMs;

    const localId = room.sessionId;
    const localView = room.viewOf(localId);
    const engagedWith = localView?.interactableId ?? "";

    // Before the controller moves: a hold the server granted or let lapse has to
    // be in effect for this frame's prediction, not the next one's.
    controller.setHold(interactableById(OFFICE_LAYOUT, engagedWith)?.anchor);
    controller.update(deltaSeconds);

    const locallyHeldWith = controller.held ? engagedWith : "";
    const target = refreshPrompt(locallyHeldWith);
    if (controller.takeReleaseRequest()) {
      room.sendRelease();
    }
    if (controller.takeInteractRequest() && target !== undefined) {
      room.sendInteract(target.id);
    }

    room.sendPose(controller.pose, nowMs);
    if (room.localServerPose.known && !controller.held) {
      controller.applyCorrection(
        room.localServerPose.x,
        room.localServerPose.z,
        deltaSeconds,
      );
    }

    for (const [id, avatar] of avatars) {
      const view = room.viewOf(id);
      const heldSpec =
        id === localId ? interactableById(OFFICE_LAYOUT, locallyHeldWith) : undefined;
      const animation =
        id === localId
          ? heldSpec
            ? heldAnimationFor(heldSpec)
            : controller.pose.animation
          : view?.animation ?? ANIMATION_STATE.idle;
      avatar.setAnimation(animation);

      // A sitter's place in the world comes from the desk it is parented to, so
      // it is the one case the loop does not pose.
      const seat =
        view === undefined
          ? undefined
          : seatAnchors.get(id === localId ? locallyHeldWith : view.interactableId);
      avatar.setSeat(seat, scene);
      if (seat !== undefined) {
        continue;
      }
      if (id === localId) {
        avatar.setPose(controller.pose.x, controller.pose.z, controller.pose.yaw);
      } else if (room.sampleRemote(id, nowMs, remotePose)) {
        avatar.setPose(remotePose.x, remotePose.z, remotePose.yaw);
      }
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
