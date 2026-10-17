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
  CEO_CHANGE,
  CLIENT_MESSAGE,
  INTERACT_RANGE,
  INTERACTION_KIND,
  type InteractableSpec,
  LIVE_AGENT_STATUS,
  MANAGER_INTERACTABLE_ID,
  type ManagerEntry,
  OFFICE_LAYOUT,
  OFFICE_PROPS,
  type OfficeLayout,
  PROJECT_BOARD_ID,
  STARTING_MINUTE_OF_DAY,
  authorizeInteract,
  describeLiveAgentTask,
  heldAnimationFor,
  interactableById,
  nearestInteractable,
  promptFor,
  sanitizeName,
  taskReference,
} from "@sim/shared";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

import { boardAccessFor, rejectionText } from "./boardAccess.js";
import { DayClock } from "./dayClock.js";
import { managerAccessFor, managerRejectionText } from "./managerAccess.js";
import { operatorAccessFor, operatorRejectionText } from "./operatorAccess.js";
import { type OccupantView, RoomConnection, type RemotePose } from "./net/room.js";
import { resolveServerUrl } from "./net/serverUrl.js";
import { PlayerController } from "./player/controller.js";
import { AgentScreens } from "./scene/agentScreen.js";
import { Avatar } from "./scene/avatar.js";
import { type AvatarModel, loadAvatarModel } from "./scene/avatarModel.js";
import { buildWallBoard } from "./scene/wallBoard.js";
import { buildLighting } from "./scene/lighting.js";
import { buildOffice } from "./scene/office.js";
import { loadPropKit, screenFaceOf, screenMaterialOf } from "./scene/propKit.js";
import { buildProps } from "./scene/props.js";
import {
  Hud,
  type ChatLogEntry,
  type HudPrompt,
  type HudSnapshot,
  createHudStore,
} from "./ui/Hud.js";

/**
 * Longest frame the simulation will integrate.
 *
 * A backgrounded tab resumes with a gap of seconds. Without this cap the first
 * frame back would ask the resolver for a single huge step, and a held key would
 * fling the player the length of the office.
 */
const MAX_FRAME_SECONDS = 0.1;

/**
 * Chat lines kept in the HUD log.
 *
 * Scrollback, not history: the log is for catching up on what was said while
 * you were looking the other way, and a session that outlives this many lines
 * has nothing at the top worth keeping on the frame budget.
 */
const CHAT_LOG_LIMIT = 50;

/**
 * Lines of the conversation with the manager kept on the client: the server
 * keeps fewer than this, so it is only ever a guard against a runaway session.
 */
const MANAGER_LOG_LIMIT = 200;

/** How long a "you are going too fast" notice stays on the HUD. */
const NOTICE_DURATION_MS = 2500;

/** How often the `?debug` readout is refreshed. Off the frame path otherwise. */
const DEBUG_INTERVAL_MS = 500;

/** What the prompt reads while the player is reading a wall board up close. */
const CLOSE_BOARD_LABEL = "Close the board";

/** What it reads while the player is talking to the manager. */
const CLOSE_CONVERSATION_LABEL = "Close the conversation";

/** What it reads while the player is watching a live agent's terminal. */
const CLOSE_TERMINAL_LABEL = "Close the terminal";

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

/**
 * The server URL baked in at build time. A production build cannot get here
 * without one — `vite.config.ts` refuses to build — so the fallback only ever
 * serves `pnpm dev`.
 */
function readServerUrl(): string {
  return resolveServerUrl(import.meta.env.VITE_SERVER_URL);
}

/** An optional `?name=` lets two tabs be told apart at a glance. */
function readRequestedName(): string {
  return sanitizeName(new URLSearchParams(window.location.search).get("name"));
}

/**
 * Whether to draw the asset kit's furniture or stay on the grey boxes.
 *
 * `?props=off` turns it off for one tab and `VITE_PROPS=off` for a whole build,
 * which is what makes the grey-box path something you can actually look at rather
 * than dead code. Either way the office is the same shape and walkable — a failed
 * load lands in the same place, see {@link furnish}.
 */
function readPropsEnabled(): boolean {
  const requested =
    new URLSearchParams(window.location.search).get("props") ?? import.meta.env.VITE_PROPS;
  return requested !== "off";
}

/** Whether `?debug` asked for the draw-call readout. */
function readDebugEnabled(): boolean {
  return new URLSearchParams(window.location.search).has("debug");
}

/**
 * The second line of a live agent's nameplate and roster entry, with what the
 * manager has assigned it next; `""` for anyone else.
 */
function captionOf(view: OccupantView): string {
  if (view.agentStatus === undefined) {
    return "";
  }
  const task = describeLiveAgentTask(view.agentStatus, view.taskTitle, view.taskUrl, view.agentActivity);
  if (view.assignedUrl === "") {
    return task;
  }
  const reference = taskReference(view.assignedUrl);
  return `${task} · next ${reference === "" ? view.assignedTitle : reference}`;
}

/** Whether a panel takes the keyboard, and so is closed with `Esc` rather than `E`. */
function takesKeyboard(interactableId: string): boolean {
  return interactableId === MANAGER_INTERACTABLE_ID;
}

/** Whether `Esc` closes a panel: one that takes the keyboard, and an agent's terminal. */
function closesWithEscape(interactableId: string): boolean {
  return (
    takesKeyboard(interactableId) ||
    interactableById(OFFICE_LAYOUT, interactableId)?.kind === INTERACTION_KIND.screen
  );
}

/** What the prompt reads at the interactable whose panel is open. */
function closeLabelFor(interactableId: string): string {
  if (interactableId === MANAGER_INTERACTABLE_ID) {
    return CLOSE_CONVERSATION_LABEL;
  }
  return interactableById(OFFICE_LAYOUT, interactableId)?.kind === INTERACTION_KIND.screen
    ? CLOSE_TERMINAL_LABEL
    : CLOSE_BOARD_LABEL;
}

function createCamera(canvas: HTMLCanvasElement, layout: OfficeLayout): THREE.PerspectiveCamera {
  const span = Math.max(layout.floor.maxX - layout.floor.minX, layout.floor.maxZ - layout.floor.minZ);
  return new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, span * 4);
}

function start(): void {
  const canvas = requireCanvas();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // One directional light casts, the floor receives, and nothing else
  // participates — see the notes in `scene/office.ts` and `scene/lighting.ts`.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const office = buildOffice(scene, OFFICE_LAYOUT);
  const lighting = buildLighting(scene, OFFICE_LAYOUT);
  // Lit for opening time until the first patch says what time it really is.
  const dayClock = new DayClock();
  lighting.showMinute(STARTING_MINUTE_OF_DAY);

  const boardSpec = OFFICE_LAYOUT.boards.find((spec) => spec.id === PROJECT_BOARD_ID);
  const wallBoard =
    boardSpec === undefined
      ? undefined
      : buildWallBoard(scene, boardSpec, renderer.capabilities.getMaxAnisotropy());

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

  // Undefined until the humanoid model has downloaded, and for the rest of the
  // session if it never does. Avatars built in the meantime stand as capsules
  // and are upgraded in place below.
  let avatarModel: AvatarModel | undefined;

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

  /**
   * Loads the prop kit and furnishes the office, or leaves the grey boxes up.
   *
   * All of the kit or none of it: the loading cover stays over the scene until
   * every model is in, then the props go in and the grey desks go out in the same
   * frame, so the office is never seen half-furnished. A failed download takes the
   * same exit as the flag being off — the grey office is already standing and
   * walkable, and the HUD says which of the two happened.
   */
  let placedProps = 0;
  // Live agents' terminals go on the kit's monitors, so there are none to show
  // them on in the grey office.
  let agentScreens: AgentScreens | undefined;
  const furnish = async (): Promise<void> => {
    if (!readPropsEnabled()) {
      publishHud({ assets: "greybox" });
      return;
    }
    try {
      const kit = await loadPropKit();
      placedProps = buildProps(scene, OFFICE_PROPS, kit).instances;
      const screen = screenMaterialOf(kit);
      if (screen !== undefined) {
        lighting.lightScreens(screen);
      }
      const monitor = kit.get("monitor");
      const face = screenFaceOf(kit);
      if (monitor !== undefined && face !== undefined) {
        agentScreens = new AgentScreens(scene, OFFICE_LAYOUT, monitor, face, renderer.capabilities.getMaxAnisotropy());
      }
      office.setGreyDesksVisible(false);
      publishHud({ assets: "ready" });
    } catch {
      publishHud({ assets: "failed" });
    }
  };
  void furnish();

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
        const caption = captionOf(view);
        const needsInput = view.agentStatus === LIVE_AGENT_STATUS.needsInput;
        const existing = avatars.get(view.id);
        if (existing === undefined) {
          const avatar = new Avatar({
            name: view.name,
            kind: view.kind,
            isCeo: view.isCeo,
            jobTitle: view.jobTitle,
            isLocal: view.isLocal,
            caption,
            needsInput,
            managerStatus: view.managerStatus,
            model: avatarModel,
          });
          scene.add(avatar.group);
          avatars.set(view.id, avatar);
        } else {
          existing.setLabel(view.name, view.isCeo, view.agentStatus === undefined ? view.jobTitle : caption);
          existing.setManagerStatus(view.managerStatus);
          existing.setNeedsInput(needsInput);
        }
      }

      for (const [id, avatar] of avatars) {
        if (!ids.has(id)) {
          avatar.dispose();
          avatars.delete(id);
        }
      }

      const local = present.find((view) => view.isLocal);
      const ceo = present.find((view) => view.isCeo);
      publishHud({
        roster: present.map((view) => ({
          id: view.id,
          name: view.name,
          kind: view.kind,
          isCeo: view.isCeo,
          isOperator: view.isOperator,
          jobTitle: view.jobTitle,
          isLocal: view.isLocal,
          caption: captionOf(view),
          needsInput: view.agentStatus === LIVE_AGENT_STATUS.needsInput,
          taskUrl: view.taskUrl,
          assignedUrl: view.assignedUrl,
          canTakeIssues: view.canTakeIssues,
          managerStatus: view.managerStatus,
        })),
        boardAccess: local === undefined ? undefined : boardAccessFor(local, ceo?.name),
        managerAccess: local === undefined ? undefined : managerAccessFor(local, ceo?.name),
        operatorAccess: local === undefined ? undefined : operatorAccessFor(local, room.operatorRequired()),
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
          : event.command === CLIENT_MESSAGE.managerSay
            ? "Too many messages to the manager — that one was dropped."
            : "Too many emotes — that one was dropped.",
      );
    },

    onWorkRejected: (event) => {
      showNotice(rejectionText(event.rejection, room.agentIssueLabel()));
    },

    // Announced in the chat log, where everyone in the office is already
    // looking, rather than only in the roster badge that silently moves.
    onCeoChanged: (event) => {
      const isLocal = event.ceoId === room.sessionId;
      const who = isLocal ? "You" : (room.occupantName(event.ceoId) ?? "Someone");
      appendChatLine({
        id: nextChatId++,
        author: "Office",
        text:
          event.change === CEO_CHANGE.operator
            ? `${who} verified as operator and ${isLocal ? "are" : "is"} now the CEO.`
            : `${isLocal ? "You are" : `${who} is`} now the CEO.`,
        isLocal: false,
        isSystem: true,
      });
      if (isLocal) {
        showNotice(
          event.change === CEO_CHANGE.operator
            ? "Verified — you are the operator and the CEO, and can send work to the live coding agents."
            : "The CEO left — you are now the CEO and hand out the project board's work.",
        );
      } else if (event.previousCeoId === room.sessionId) {
        showNotice("A verified operator has taken the CEO role; you are an executive now.");
      }
    },

    onOperatorRejected: (event) => {
      showNotice(operatorRejectionText(event.rejection));
    },

    // The same snapshot goes to the wall and to the close-up panel, so what
    // the board shows at a distance and up close cannot disagree.
    onProjectBoard: (snapshot) => {
      wallBoard?.show(snapshot);
      publishHud({ projectBoard: snapshot });
    },

    // The lighting runs the clock on between patches; React never hears of it.
    onClockChanged: (minuteOfDay) => {
      dayClock.observe(minuteOfDay, performance.now());
    },

    onWorkChanged: (work) => {
      publishHud({ work });
    },

    // Handed over whole on every join, a reconnection included, so it replaces
    // what this tab had rather than adding to it.
    onManagerHistory: (entries) => {
      publishHud({ managerLog: entries.slice(-MANAGER_LOG_LIMIT), managerUnread: 0 });
    },

    onManagerEntry: (entry) => {
      if (hud.managerLog.some((line) => line.id === entry.id)) {
        return;
      }
      const managerLog: readonly ManagerEntry[] = [...hud.managerLog, entry].slice(-MANAGER_LOG_LIMIT);
      publishHud({ managerLog, managerUnread: hud.managerOpen ? 0 : hud.managerUnread + 1 });
    },

    onManagerRejected: (event) => {
      showNotice(managerRejectionText(event.rejection));
    },
  });

  // The wall board, manager's desk or agent's screen whose panel is open, or
  // `""`. Local to this tab: reading a board, talking to the manager or
  // watching an agent holds nothing, so there is nothing for the server to know.
  let readingBoard = "";

  // Who holds what, as the last patch said, for the shared rules to read.
  const holderOf = (interactableId: string) => room.holderOf(interactableId);

  createRoot(requireHudMount()).render(
    createElement(Hud, {
      store: hudStore,
      actions: {
        sendEmote: (emote) => room.sendEmote(emote),
        sendChat: (text) => room.sendChat(text),
        projectBoard: {
          assign: (issueNumber, agentId) => room.sendWorkAssign(issueNumber, agentId),
          move: (issueNumber, status) => room.sendWorkMove(issueNumber, status),
          release: (issueNumber) => room.sendWorkRelease(issueNumber),
        },
        manager: {
          say: (text) => room.sendManagerSay(text),
          verify: (passphrase) => room.sendOperatorVerify(passphrase),
          close: () => {
            readingBoard = "";
          },
        },
        terminal: {
          screenOf: (agentId) => room.screenOf(agentId),
          close: () => {
            readingBoard = "";
          },
        },
      },
    }),
  );

  let previousFrameMs = performance.now();

  // Read back after the draw, not before, so the count is a real frame's. The
  // point of showing it is the instancing claim: this number stays put as desks
  // are added, which is the acceptance criterion for the prop batching.
  const debugEnabled = readDebugEnabled();
  let nextDebugMs = 0;

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
      // A screen nobody is working at is not offered, so behind an empty chair
      // this is the chair.
      target = nearestInteractable(OFFICE_LAYOUT, controller.pose, INTERACT_RANGE, holderOf);
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
          holderOf,
        );
        prompt = {
          keys: target.id === readingBoard && takesKeyboard(readingBoard) ? "Esc" : "E",
          label:
            target.id === readingBoard
              ? closeLabelFor(readingBoard)
              : decision.allowed
                ? promptFor(target)
                : `${promptFor(target)} — taken`,
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
    const engagedWith = room.viewOf(localId)?.interactableId ?? "";

    // Before the controller moves: a hold the server granted or let lapse has to
    // be in effect for this frame's prediction, not the next one's.
    controller.setHold(interactableById(OFFICE_LAYOUT, engagedWith));
    controller.update(deltaSeconds);

    // What the controller is predicting, not what the last patch said: between
    // a movement key standing the player up and the server confirming it, the
    // replicated hold is stale and would keep offering "Stand up".
    const locallyHeldWith = controller.held ? engagedWith : "";
    const target = refreshPrompt(locallyHeldWith);
    if (controller.takeReleaseRequest()) {
      room.sendRelease();
    }
    // Stepping out of reach closes a close-up just as `E` does, and so does an
    // agent's screen stopping being offered when it stands up or leaves.
    if (target?.id !== readingBoard) {
      readingBoard = "";
    }
    if (controller.takeCloseRequest() && closesWithEscape(readingBoard)) {
      readingBoard = "";
    }
    if (controller.takeInteractRequest() && target !== undefined) {
      if (target.id === readingBoard) {
        readingBoard = "";
      } else {
        // A wall board is read up close, and the manager's desk opens the
        // conversation and an agent's screen its terminal the same way.
        if (
          target.kind === INTERACTION_KIND.board ||
          target.kind === INTERACTION_KIND.manager ||
          target.kind === INTERACTION_KIND.screen
        ) {
          readingBoard = target.id;
        }
        room.sendInteract(target.id);
      }
    }
    const closeUp = readingBoard === PROJECT_BOARD_ID;
    if (closeUp !== hud.boardCloseUp) {
      publishHud({ boardCloseUp: closeUp });
    }
    const managerOpen = readingBoard === MANAGER_INTERACTABLE_ID;
    if (managerOpen !== hud.managerOpen) {
      publishHud(managerOpen ? { managerOpen, managerUnread: 0 } : { managerOpen });
    }
    // The agent at the screen's seat: it stays the same while the panel is
    // open, since the screen is only offered while that agent sits there.
    const watchedSeat = interactableById(OFFICE_LAYOUT, readingBoard)?.seatId;
    const terminalAgentId = watchedSeat === undefined ? undefined : room.holderOf(watchedSeat);
    if (terminalAgentId !== hud.terminalAgentId) {
      publishHud({ terminalAgentId });
    }

    room.sendPose(controller.pose, nowMs);
    if (room.localServerPose.known) {
      controller.applyCorrection(
        room.localServerPose.x,
        room.localServerPose.z,
        deltaSeconds,
      );
    }

    for (const [id, avatar] of avatars) {
      // The local player is drawn from the predicted hold, so standing up shows
      // on the frame the key goes down rather than a round trip later.
      const held = interactableById(
        OFFICE_LAYOUT,
        id === localId ? locallyHeldWith : room.viewOf(id)?.interactableId ?? "",
      );
      avatar.setHoldingCup(held?.kind === INTERACTION_KIND.coffee);

      if (held !== undefined) {
        // A held occupant's place comes straight from the layout, so a sitter
        // in the other tab is perfectly still in the chair instead of
        // interpolating toward a position that is not changing. A working
        // agent is the one sitter the server marks as typing.
        avatar.setPose(held.anchor.x, held.anchor.z, held.anchor.yaw);
        avatar.setAnimation(
          room.viewOf(id)?.animation === ANIMATION_STATE.typing
            ? ANIMATION_STATE.typing
            : heldAnimationFor(held),
        );
      } else if (id === localId) {
        avatar.setPose(controller.pose.x, controller.pose.z, controller.pose.yaw);
        avatar.setAnimation(controller.pose.animation);
      } else if (room.sampleRemote(id, nowMs, remotePose)) {
        avatar.setPose(remotePose.x, remotePose.z, remotePose.yaw);
        avatar.setAnimation(remotePose.animation);
      }
      avatar.update(deltaSeconds);
      // Overhead content is parented to the avatar, so it has already followed
      // the body; all that is left is retiring whatever has expired.
      avatar.updateExpressions(nowMs);
    }

    // Every seated live agent's terminal on its own desk's monitor, and none
    // for an agent that has stood up or gone.
    if (agentScreens !== undefined) {
      for (const id of avatars.keys()) {
        const view = room.viewOf(id);
        if (view?.agentStatus !== undefined && view.interactableId !== "") {
          agentScreens.show(id, view.interactableId, room.screenOf(id), nowMs, camera.position);
        }
      }
      agentScreens.sweep();
    }

    const minuteOfDay = dayClock.minuteAt(nowMs);
    if (minuteOfDay !== undefined) {
      lighting.showMinute(minuteOfDay);
    }

    renderer.render(scene, camera);

    if (debugEnabled && nowMs >= nextDebugMs) {
      nextDebugMs = nowMs + DEBUG_INTERVAL_MS;
      publishHud({ debug: { drawCalls: renderer.info.render.calls, props: placedProps } });
    }

    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);

  void loadAvatarModel(import.meta.env.BASE_URL)
    .then((model) => {
      avatarModel = model;
      for (const avatar of avatars.values()) {
        avatar.useModel(model);
      }
    })
    .catch(() => {
      // Every avatar stays the capsule it was built as, which is a body you can
      // see and walk rather than an invisible player.
    });

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
