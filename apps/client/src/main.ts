/**
 * Renderer, scene, and the game loop.
 *
 * The loop is imperative and runs every frame: read input, predict the local
 * player, reconcile against the server, interpolate everyone else, draw. React
 * is mounted once, over the canvas, and never touched by the loop — it only
 * hears about things that change a few times a session.
 */

import {
  type AgentPromptEntry,
  ANIMATION_STATE,
  CLIENT_MESSAGE,
  INTERACT_RANGE,
  INTERACTION_KIND,
  type InteractableSpec,
  type IssueState,
  LIVE_AGENT_STATUS,
  MANAGER_INTERACTABLE_ID,
  type ManagerEntry,
  OFFICE_DECOR,
  OFFICE_LAYOUT,
  OFFICE_PROPS,
  type OfficeLayout,
  PROJECT_BOARD_ID,
  type ProjectBoardSnapshot,
  STARTING_MINUTE_OF_DAY,
  type WorkData,
  authorizeInteract,
  describeLiveAgentTask,
  deskTerminalSeat,
  heldAnimationFor,
  interactableById,
  nearestInteractable,
  promptFor,
  sanitizeName,
  stickerNotes,
  taskReference,
} from "@sim/shared";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";

import {
  AGENT_MENU_HOLD_MS,
  AGENT_MENU_RANGE,
  type AgentMenuView,
  type AgentSpot,
  agentActionRejectionText,
  agentMenuFor,
  facedAgent,
} from "./agentMenu.js";
import { agentProfileAccessFor, agentProfileRejectionText } from "./agentProfileAccess.js";
import { agentKeyRejectionText, agentPromptAccessFor, agentPromptRejectionText } from "./agentPromptAccess.js";
import { deskForbiddenText, deskPanelFor, deskScreenKey, sameDeskPanel } from "./deskTerminalAccess.js";
import { standupAccessFor, standupRejectionText } from "./standupAccess.js";
import { boardAccessFor, issueStateRejectionText, rejectionText } from "./boardAccess.js";
import { DayClock } from "./dayClock.js";
import { hasIssueMoveLanded } from "./projectBoard.js";
import { managerAccessFor, managerRejectionText } from "./managerAccess.js";
import { standingAccessFor, standingRejectionText } from "./standingAccess.js";
import { type OccupantView, RoomConnection, type RemotePose } from "./net/room.js";
import { resolveServerUrl } from "./net/serverUrl.js";
import { CAMERA_MODE, type CameraMode, otherCameraMode, readCameraMode, writeCameraMode } from "./player/cameraMode.js";
import { type CameraFocus, PlayerController, shoulderView } from "./player/controller.js";
import { AgentScreens } from "./scene/agentScreen.js";
import { Avatar } from "./scene/avatar.js";
import { type AvatarModel, loadAvatarModel } from "./scene/avatarModel.js";
import { Doors } from "./scene/doors.js";
import { buildWallBoard } from "./scene/wallBoard.js";
import { buildWallDecor } from "./scene/wallDecor.js";
import { buildLighting } from "./scene/lighting.js";
import { buildOffice } from "./scene/office.js";
import { loadPropKit, screenFaceOf, screenMaterialOf } from "./scene/propKit.js";
import { buildProps } from "./scene/props.js";
import { StickerBoards } from "./scene/stickerBoards.js";
import { buildStreet, streetReach } from "./scene/street.js";
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

/** Prompts typed into the agents' terminals kept on the client; the server hands a joiner fewer. */
const AGENT_PROMPT_LIMIT = 100;

/** How long a "you are going too fast" notice stays on the HUD. */
const NOTICE_DURATION_MS = 2500;

/** How long the board says why a dragged card went back: long enough to read a sentence about GitHub. */
const BOARD_NOTICE_DURATION_MS = 8000;

/**
 * How long a card dropped on Closed or Open waits for the server's answer
 * before it goes back; past the server's own wait on GitHub, which answers first.
 */
const ISSUE_MOVE_ANSWER_MS = 30_000;

/**
 * How long a card GitHub moved stays where it was dropped without a snapshot
 * showing it there, for a feed that has gone stale and stopped publishing.
 */
const ISSUE_MOVE_HOLD_MS = 120_000;

/**
 * How far into its lean over a working agent's shoulder the camera hides
 * that agent: about where the boom has come in past the player to the agent's
 * head, which would otherwise fill the view.
 */
const LEAN_HIDES_AGENT_AT = 0.5;

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

/** The browser's local storage, or `undefined` where merely touching it throws, as a locked-down browser's does. */
function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The second line of a live agent's nameplate and roster entry, with what the
 * manager has assigned it next; `""` for anyone else.
 */
function captionOf(view: OccupantView): string {
  if (view.agentStatus === undefined) {
    return "";
  }
  if (view.fired) {
    return "Fired, leaving the office";
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

  const scene = new THREE.Scene();
  const office = buildOffice(scene, OFFICE_LAYOUT);
  const lighting = buildLighting(scene, OFFICE_LAYOUT);
  const street = buildStreet(scene, OFFICE_LAYOUT);
  const wallDecor = buildWallDecor(scene, OFFICE_LAYOUT, OFFICE_DECOR, renderer.capabilities.getMaxAnisotropy());
  const doors = new Doors(scene, OFFICE_LAYOUT);
  // Where everyone is drawn this frame, which is what swings the doors open.
  const bodies: { x: number; z: number }[] = [];
  // Lit for opening time until the first patch says what time it really is.
  const dayClock = new DayClock();
  lighting.showMinute(STARTING_MINUTE_OF_DAY);
  wallDecor.showMinute(STARTING_MINUTE_OF_DAY);

  const boardSpec = OFFICE_LAYOUT.boards.find((spec) => spec.id === PROJECT_BOARD_ID);
  const wallBoard =
    boardSpec === undefined
      ? undefined
      : buildWallBoard(scene, boardSpec, renderer.capabilities.getMaxAnisotropy());
  const stickerBoards = new StickerBoards(scene, OFFICE_LAYOUT, renderer.capabilities.getMaxAnisotropy());
  // What the sticker boards' notes are worked out from, besides who carries what.
  let boardSnapshot: ProjectBoardSnapshot | undefined;
  let officeWork: readonly WorkData[] = [];

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
  publishHud({ cameraMode: controller.mode });

  /** Looks through the other camera, and keeps the choice for the next visit. */
  const toggleCameraMode = () => {
    const mode: CameraMode = otherCameraMode(controller.mode);
    controller.setCameraMode(mode);
    writeCameraMode(browserStorage(), mode);
    publishHud({ cameraMode: mode });
  };

  let nextChatId = 1;
  let nextRefusalId = 1;
  let noticeTimer: number | undefined;
  let standupNoticeTimer: number | undefined;
  // The agent whose key pad in the standup panel was last pressed, for a key the limiter dropped.
  let lastKeyAgentId = "";
  // The agent whose profile was last saved, for an edit the limiter dropped.
  let lastProfileAgentId = "";
  // The agent whose terminal panel is open: the one watched at its screen, or the one lent to the CEO's desk.
  const openTerminalAgentId = (): string | undefined =>
    hud.terminalAgentId ?? (hud.desk === undefined || hud.desk.agentId === "" ? undefined : hud.desk.agentId);

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

  let boardNoticeTimer: number | undefined;

  /** Shows a line on the project board's close-up, to this player only, and takes it down again. */
  const showBoardNotice = (text: string) => {
    if (boardNoticeTimer !== undefined) {
      window.clearTimeout(boardNoticeTimer);
    }
    publishHud({ boardNotice: text });
    boardNoticeTimer = window.setTimeout(() => {
      boardNoticeTimer = undefined;
      publishHud({ boardNotice: undefined });
    }, BOARD_NOTICE_DURATION_MS);
  };

  /**
   * The cards this player dropped on Closed or Open, shown there at once.
   *
   * Each waits for the server's answer; a refusal puts it back and says why.
   * One GitHub took stays until a snapshot shows it there, or one from a poll
   * begun after the change shows GitHub's own state, whatever this tab assumed.
   */
  interface PendingIssueMove {
    readonly issueNumber: number;
    readonly state: IssueState;
    /** Once GitHub made the change, the fresh snapshots since; the move now waits only for a snapshot. */
    freshSince: number | undefined;
    timer: number;
  }
  let issueMoves: PendingIssueMove[] = [];

  const publishIssueMoves = () => {
    publishHud({ issueMoves: issueMoves.map(({ issueNumber, state }) => ({ issueNumber, state })) });
  };

  const dropIssueMove = (move: PendingIssueMove) => {
    window.clearTimeout(move.timer);
    issueMoves = issueMoves.filter((candidate) => candidate !== move);
    publishIssueMoves();
  };

  const moveIssue = (issueNumber: number, state: IssueState) => {
    if (issueMoves.some((move) => move.issueNumber === issueNumber)) {
      return;
    }
    const move: PendingIssueMove = {
      issueNumber,
      state,
      freshSince: undefined,
      timer: window.setTimeout(() => {
        dropIssueMove(move);
        showBoardNotice(`No answer about #${issueNumber} from the server; the board shows it as GitHub last did.`);
      }, ISSUE_MOVE_ANSWER_MS),
    };
    issueMoves = [...issueMoves, move];
    publishIssueMoves();
    room.sendIssueState(issueNumber, state);
  };

  /** Shows a line in the standup panel, to this player only, and takes it down again shortly. */
  const showStandupNotice = (text: string) => {
    if (standupNoticeTimer !== undefined) {
      window.clearTimeout(standupNoticeTimer);
    }
    publishHud({ standupNotice: text });
    standupNoticeTimer = window.setTimeout(() => {
      standupNoticeTimer = undefined;
      publishHud({ standupNotice: undefined });
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

  // Recomputed from replicated state whenever any of it changes; the boards
  // repaint only when the notes come out different.
  const refreshStickerNotes = () => {
    const carriers = room
      .occupants()
      .filter((view) => view.agentStatus !== undefined)
      .map((view) => ({ id: view.id, carriedIssue: view.carriedIssue }));
    stickerBoards.show(
      stickerNotes(boardSnapshot, officeWork, carriers, room.agentRestrictLabel()),
      (id) => room.occupantName(id),
      performance.now(),
    );
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
        const caption = captionOf(view);
        const needsInput = view.agentStatus === LIVE_AGENT_STATUS.needsInput;
        const existing = avatars.get(view.id);
        if (existing === undefined) {
          const avatar = new Avatar({
            name: view.name,
            title: view.agentTitle,
            kind: view.kind,
            isCeo: view.isCeo,
            isLocal: view.isLocal,
            caption,
            needsInput,
            managerStatus: view.managerStatus,
            model: avatarModel,
          });
          avatar.setFired(view.fired);
          scene.add(avatar.group);
          avatars.set(view.id, avatar);
        } else {
          existing.setLabel(view.name, view.isCeo, caption, view.agentTitle);
          existing.setManagerStatus(view.managerStatus);
          existing.setNeedsInput(needsInput);
          existing.setFired(view.fired);
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
          isLocal: view.isLocal,
          caption: captionOf(view),
          needsInput: view.agentStatus === LIVE_AGENT_STATUS.needsInput,
          taskUrl: view.taskUrl,
          assignedUrl: view.assignedUrl,
          canTakeIssues: view.canTakeIssues,
          title: view.agentTitle,
          description: view.agentDescription,
          profileEditable: view.profileEditable,
          managerStatus: view.managerStatus,
        })),
        boardAccess: local === undefined ? undefined : boardAccessFor(local, ceo?.name, room.issuesWritable()),
        managerAccess: local === undefined ? undefined : managerAccessFor(local, ceo?.name),
        agentPromptAccess: local === undefined ? undefined : agentPromptAccessFor(local, ceo?.name),
        standingAccess: local === undefined ? undefined : standingAccessFor(local, ceo?.name),
        standupAccess: local === undefined ? undefined : standupAccessFor(local, ceo?.name),
        agentProfileAccess: local === undefined ? undefined : agentProfileAccessFor(local, ceo?.name),
      });
      refreshStickerNotes();
    },

    // Expression events arrive for everyone, the local player included, so
    // there is one path from "somebody did a thing" to it being drawn. An
    // avatar can already be gone when an event lands — the state patch that
    // removed it may be decoded first — in which case there is nothing above
    // which to draw, and the chat log still records what was said.
    onJump: (event) => {
      avatars.get(event.occupantId)?.jump();
    },
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
      if (event.command === CLIENT_MESSAGE.agentPrompt) {
        // Said in the terminal panel the prompt was sent from, which is waiting on an answer.
        publishHud({
          agentPromptRefusal: {
            id: nextRefusalId++,
            agentId: openTerminalAgentId() ?? "",
            text: "Too many prompts — that one was dropped. Wait a few seconds and send it again.",
          },
        });
        return;
      }
      if (event.command === CLIENT_MESSAGE.agentKey) {
        publishHud({
          agentPromptRefusal: {
            id: nextRefusalId++,
            agentId: openTerminalAgentId() ?? lastKeyAgentId,
            text: "Too many keys — that one was not pressed. Check the terminal, then go on.",
            forKey: true,
          },
        });
        return;
      }
      if (event.command === CLIENT_MESSAGE.agentProfile) {
        // Said on the profile card the edit was saved from, which is waiting on an answer.
        publishHud({
          agentProfileNotice: {
            id: nextRefusalId++,
            agentId: lastProfileAgentId,
            text: "Too many profile edits — that one was dropped. Wait a few seconds and save it again.",
          },
        });
        return;
      }
      if (event.command === CLIENT_MESSAGE.standupDirect || event.command === CLIENT_MESSAGE.standupStart) {
        showStandupNotice(
          event.command === CLIENT_MESSAGE.standupDirect
            ? "Too many directions — that one was dropped. Wait a few seconds and send it again."
            : "Too many standups called or ended — that one was dropped. Wait a few seconds.",
        );
        return;
      }
      showNotice(
        event.command === CLIENT_MESSAGE.chat
          ? "Too many messages — that one was dropped."
          : event.command === CLIENT_MESSAGE.managerSay
            ? "Too many messages to the manager — that one was dropped."
            : event.command === CLIENT_MESSAGE.emote
              ? "Too many emotes — that one was dropped."
              : "Too many standing task buttons — that one was dropped. Wait a few seconds.",
      );
    },

    onWorkRejected: (event) => {
      showNotice(rejectionText(event.rejection, room.agentRestrictLabel()));
    },

    onIssueStateResult: (event) => {
      const move = issueMoves.find(
        (candidate) => candidate.issueNumber === event.issueNumber && candidate.state === event.state && candidate.freshSince === undefined,
      );
      if (move === undefined) {
        return;
      }
      if (event.rejection !== undefined) {
        dropIssueMove(move);
        showBoardNotice(issueStateRejectionText(event.rejection, event.issueNumber, event.state));
        return;
      }
      window.clearTimeout(move.timer);
      move.freshSince = 0;
      move.timer = window.setTimeout(() => dropIssueMove(move), ISSUE_MOVE_HOLD_MS);
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

    // The same snapshot goes to the wall and to the close-up panel, so what
    // the board shows at a distance and up close cannot disagree.
    onProjectBoard: (snapshot) => {
      for (const move of issueMoves) {
        if (move.freshSince === undefined) {
          continue;
        }
        if (hasIssueMoveLanded(snapshot, move, move.freshSince)) {
          dropIssueMove(move);
        } else if (!snapshot.stale) {
          move.freshSince += 1;
        }
      }
      wallBoard?.show(snapshot);
      publishHud({ projectBoard: snapshot });
      boardSnapshot = snapshot;
      refreshStickerNotes();
    },

    // The lighting runs the clock on between patches; React never hears of it.
    onClockChanged: (minuteOfDay) => {
      dayClock.observe(minuteOfDay, performance.now());
    },

    onWorkChanged: (work) => {
      publishHud({ work });
      officeWork = work;
      refreshStickerNotes();
    },

    onSpendChanged: (runnerSpend) => {
      publishHud({ runnerSpend });
    },

    onStandingChanged: (standingTasks) => {
      publishHud({ standingTasks });
    },

    onStandingRejected: (event) => {
      showNotice(standingRejectionText(event.rejection));
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

    // Handed over on every join, a reconnection included, so it replaces what this tab had.
    onAgentPromptHistory: (entries) => {
      publishHud({ agentPrompts: entries.slice(-AGENT_PROMPT_LIMIT) });
    },

    onAgentPrompted: (entry) => {
      if (hud.agentPrompts.some((known) => known.id === entry.id)) {
        return;
      }
      const agentPrompts: readonly AgentPromptEntry[] = [...hud.agentPrompts, entry].slice(-AGENT_PROMPT_LIMIT);
      publishHud({ agentPrompts });
    },

    // Shown in the agent's terminal panel, and as a notice for a panel already closed.
    onAgentPromptRejected: (event) => {
      const agentName = room.occupantName(event.agentId) ?? "The agent";
      const text =
        event.key === undefined
          ? agentPromptRejectionText(event.rejection, agentName)
          : agentKeyRejectionText(event.rejection, agentName, event.key);
      publishHud({ agentPromptRefusal: { id: nextRefusalId++, agentId: event.agentId, text, forKey: event.key !== undefined } });
      // The standup panel says it under the agent's key pad, as the terminal panel does.
      if (openTerminalAgentId() !== event.agentId && !hud.standup.active) {
        showNotice(text);
      }
    },

    onAgentActionRejected: (event) => {
      showNotice(
        agentActionRejectionText(event.rejection, room.occupantName(event.agentId) ?? "The agent", hud.roster.find((entry) => entry.isCeo)?.name),
      );
    },

    // On the agent's profile card, where the edit was saved from.
    onAgentProfileRejected: (event) => {
      const text = agentProfileRejectionText(event.rejection, room.occupantName(event.agentId) ?? "The agent");
      publishHud({ agentProfileNotice: { id: nextRefusalId++, agentId: event.agentId, text } });
    },

    onStandupChanged: (standup) => {
      publishHud({ standup });
    },

    // In the standup panel while one is on, where the command came from; as a notice otherwise.
    onStandupRejected: (event) => {
      const text = standupRejectionText(event);
      if (hud.standup.active) {
        showStandupNotice(text);
      } else {
        showNotice(text);
      }
    },
  });

  // The wall board, manager's desk or agent's screen whose panel is open, or
  // `""`. Local to this tab: reading a board, talking to the manager or
  // watching an agent holds nothing, so there is nothing for the server to know.
  let readingBoard = "";

  // The desk panel's Stand up button, taken by the next frame as `E` would be.
  let standUpRequested = false;
  // The computer the local player last sat at and was told is the CEO's alone, so it is said once a sitting.
  let toldDeskForbidden = "";
  // The agent whose long-press menu is open, or `undefined`. Local to this tab, like a board's close-up.
  let agentMenuId: string | undefined;
  // `E` went down facing an agent: held long enough it opens the menu, let go sooner it is `E` as always.
  let heldAt: { readonly agentId: string; readonly since: number } | undefined;
  // The menu as last published, so React hears only of a change.
  let agentMenuKey = "";
  const agentSpots: AgentSpot[] = [];

  // Who holds what, as the last patch said, for the shared rules to read.
  const holderOf = (interactableId: string) => room.holderOf(interactableId);

  createRoot(requireHudMount()).render(
    createElement(Hud, {
      store: hudStore,
      actions: {
        sendEmote: (emote) => room.sendEmote(emote),
        sendChat: (text) => room.sendChat(text),
        toggleCamera: toggleCameraMode,
        projectBoard: {
          assign: (issueNumber, agentId) => room.sendWorkAssign(issueNumber, agentId),
          move: (issueNumber, status) => room.sendWorkMove(issueNumber, status),
          release: (issueNumber) => room.sendWorkRelease(issueNumber),
          setIssueState: moveIssue,
        },
        manager: {
          say: (text) => room.sendManagerSay(text),
          close: () => {
            readingBoard = "";
          },
        },
        standing: {
          act: (action, taskId) => room.sendStanding(action, taskId),
        },
        terminal: {
          screenOf: (agentId) => room.screenOf(agentId),
          prompt: (agentId, text) => room.sendAgentPrompt(agentId, text),
          key: (agentId, key) => room.sendAgentKey(agentId, key),
          resizeDesk: (cols, rows) => room.sendDeskTerminalSize(cols, rows),
          close: () => {
            readingBoard = "";
          },
        },
        profile: {
          save: (agentId, profile) => {
            lastProfileAgentId = agentId;
            return room.sendAgentProfile(agentId, profile);
          },
        },
        standUp: () => {
          standUpRequested = true;
        },
        agentMenu: {
          act: (agentId, action) => {
            room.sendAgentAction(agentId, action);
            agentMenuId = undefined;
          },
        },
        standup: {
          start: () => room.sendStandupStart(),
          end: () => room.sendStandupEnd(),
          direct: (agentId, text) => room.sendStandupDirection(agentId, text),
          key: (agentId, key) => {
            lastKeyAgentId = agentId;
            return room.sendAgentKey(agentId, key);
          },
          screenOf: (agentId) => room.screenOf(agentId),
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

  // The seat whose agent the camera last leaned in over, and the agent hidden
  // for it: leaned in, the camera is where that agent's head is.
  let leanSeat: string | undefined;
  let hiddenAgentId: string | undefined;

  // Where the local player's eyes are, filled in from its body each frame for the first-person camera.
  const eye = new THREE.Vector3();

  // Each screen's view over its agent's shoulder, worked out once: the layout
  // does not move, and the controller tells a view it is already in by identity.
  const shoulderViews = new Map<string, CameraFocus | undefined>();
  const shoulderViewOf = (screen: InteractableSpec): CameraFocus | undefined => {
    // Nothing to lean in for without the monitors: the grey-box office, or a kit still loading.
    if (agentScreens === undefined || screen.seatId === undefined) {
      return undefined;
    }
    if (!shoulderViews.has(screen.id)) {
      const seat = interactableById(OFFICE_LAYOUT, screen.seatId);
      const centre = agentScreens.screenCentre(screen.seatId);
      shoulderViews.set(screen.id, seat === undefined || centre === undefined ? undefined : shoulderView(seat.anchor, centre));
    }
    return shoulderViews.get(screen.id);
  };

  // The prompt as last published, held as loose fields so the per-frame check
  // that nothing has changed costs no allocation.
  let promptKeys = "";
  let promptLabel = "";
  let promptBlocked = false;
  let promptHold: string | undefined;

  /** The live agent the local player faces, not one already fired, or `undefined`. */
  const faceAgent = (): string | undefined => {
    agentSpots.length = 0;
    for (const [id, avatar] of avatars) {
      const view = room.viewOf(id);
      if (view?.agentStatus !== undefined && !view.fired) {
        agentSpots.push({ id, x: avatar.group.position.x, z: avatar.group.position.z });
      }
    }
    return facedAgent(controller.pose, agentSpots);
  };

  /** Whether the agent whose menu is open is still there, still employed, and near enough to talk to. */
  const menuInReach = (agentId: string): boolean => {
    const view = room.viewOf(agentId);
    const body = avatars.get(agentId);
    return (
      view !== undefined &&
      !view.fired &&
      body !== undefined &&
      Math.hypot(body.group.position.x - controller.pose.x, body.group.position.z - controller.pose.z) <= AGENT_MENU_RANGE * 1.5
    );
  };

  /**
   * Works out what the player can do from where they are standing, and tells
   * React only when the answer changes.
   *
   * The availability test is `authorizeInteract` — the same function the server
   * will run on the message this prompt invites — so the prompt is never an
   * offer the server is going to turn down.
   *
   * Facing an agent, it also says that holding `E` opens the agent's menu.
   *
   * @returns the interactable `E` would use, or `undefined`.
   */
  const refreshPrompt = (engagedWith: string, facing: string | undefined): InteractableSpec | undefined => {
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

    if (facing !== undefined) {
      const hold = `Cancel task or fire ${room.occupantName(facing) ?? "the agent"}`;
      prompt = prompt === undefined ? { keys: "Hold E", label: hold, blocked: false } : { ...prompt, hold };
    }

    const keys = prompt?.keys ?? "";
    const label = prompt?.label ?? "";
    const blocked = prompt?.blocked ?? false;
    const hold = prompt?.hold;
    if (keys !== promptKeys || label !== promptLabel || blocked !== promptBlocked || hold !== promptHold) {
      promptKeys = keys;
      promptLabel = label;
      promptBlocked = blocked;
      promptHold = hold;
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
    if (controller.takeCameraToggleRequest()) {
      toggleCameraMode();
    }
    controller.update(deltaSeconds);
    if (controller.takeJumpStart()) {
      avatars.get(localId)?.jump();
      room.sendJump();
    }

    // What the controller is predicting, not what the last patch said: between
    // a movement key standing the player up and the server confirming it, the
    // replicated hold is stale and would keep offering "Stand up".
    const locallyHeldWith = controller.held ? engagedWith : "";
    // Only standing free with nothing open: with a panel open, `E` closes it.
    const facing = locallyHeldWith === "" && readingBoard === "" && agentMenuId === undefined ? faceAgent() : undefined;
    const target = refreshPrompt(locallyHeldWith, facing);
    // Standing still behind a working agent's chair leans the camera in over
    // its shoulder, to read its monitor; `E` still opens the whole terminal.
    const shoulder = target?.kind === INTERACTION_KIND.screen ? shoulderViewOf(target) : undefined;
    controller.setFocus(shoulder);
    if (shoulder !== undefined && controller.leaningInto === shoulder) {
      leanSeat = target?.seatId;
    }
    const hide = controller.leanedIn > LEAN_HIDES_AGENT_AT && leanSeat !== undefined ? room.holderOf(leanSeat) : undefined;
    if (hide !== hiddenAgentId) {
      if (hiddenAgentId !== undefined) {
        avatars.get(hiddenAgentId)?.setBodyHidden(false);
      }
      if (hide !== undefined) {
        avatars.get(hide)?.setBodyHidden(true);
      }
      hiddenAgentId = hide;
    }
    if (controller.takeReleaseRequest() || (standUpRequested && locallyHeldWith !== "")) {
      room.sendRelease();
    }
    standUpRequested = false;
    // Stepping out of reach closes a close-up just as `E` does, and so does an
    // agent's screen stopping being offered when it stands up or leaves.
    if (target?.id !== readingBoard) {
      readingBoard = "";
    }
    const closeRequested = controller.takeCloseRequest();
    let interactPressed = controller.takeInteractRequest();
    if (agentMenuId !== undefined) {
      // `E` again, `Esc`, stepping away, or the agent leaving or being fired closes it.
      if (interactPressed || closeRequested || !menuInReach(agentMenuId)) {
        agentMenuId = undefined;
      }
      interactPressed = false;
    } else if (closeRequested && closesWithEscape(readingBoard)) {
      readingBoard = "";
    }
    // Facing an agent, `E` waits to see whether it is held for the agent's menu.
    if (interactPressed && facing !== undefined) {
      heldAt = { agentId: facing, since: nowMs };
      interactPressed = false;
    }
    if (heldAt !== undefined) {
      if (!controller.interactHeld) {
        heldAt = undefined;
        interactPressed = true;
      } else if (nowMs - heldAt.since >= AGENT_MENU_HOLD_MS) {
        agentMenuId = heldAt.agentId;
        heldAt = undefined;
        // Its buttons are clicked, which a captured pointer cannot do.
        if (document.pointerLockElement !== null) {
          document.exitPointerLock();
        }
      }
    }
    const menuAgent = agentMenuId === undefined ? undefined : room.viewOf(agentMenuId);
    const localView = room.viewOf(localId);
    const agentMenu: AgentMenuView | undefined =
      menuAgent === undefined || localView === undefined
        ? undefined
        : agentMenuFor(localView, menuAgent, officeWork, hud.roster.find((entry) => entry.isCeo)?.name);
    const menuKey = agentMenu === undefined ? "" : JSON.stringify(agentMenu);
    if (menuKey !== agentMenuKey) {
      agentMenuKey = menuKey;
      publishHud({ agentMenu });
    }
    if (interactPressed && target !== undefined) {
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
    // The sticker boards are the project board's too, and open the same close-up.
    const closeUp = interactableById(OFFICE_LAYOUT, readingBoard)?.kind === INTERACTION_KIND.board;
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
    // The CEO sitting at a computer has its terminal; anyone else is told why not, once.
    const desk = room.desk();
    // A sitting lists only the prompts typed after it began.
    const promptsAfter = hud.desk?.promptsAfter ?? hud.agentPrompts.at(-1)?.id ?? 0;
    const deskPanel = deskPanelFor(desk, localId, locallyHeldWith, promptsAfter);
    if (!sameDeskPanel(deskPanel, hud.desk)) {
      publishHud({ desk: deskPanel });
    }
    const deskSeat = deskTerminalSeat(OFFICE_LAYOUT, locallyHeldWith);
    if (deskSeat === undefined) {
      toldDeskForbidden = "";
    } else if (room.viewOf(localId)?.isCeo === false && toldDeskForbidden !== deskSeat.id) {
      toldDeskForbidden = deskSeat.id;
      showNotice(deskForbiddenText(hud.roster.find((entry) => entry.isCeo)?.name));
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
      avatar.setCoffee(room.viewOf(id)?.coffeeSips ?? 0, held?.kind === INTERACTION_KIND.coffee, nowMs);

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
      if (id === localId) {
        const firstPerson = controller.mode === CAMERA_MODE.firstPerson;
        avatar.setFirstPerson(firstPerson);
        if (firstPerson) {
          controller.setEye(avatar.eyePosition(eye));
        }
      }
      // Overhead content is parented to the avatar, so it has already followed
      // the body; all that is left is retiring whatever has expired.
      avatar.updateExpressions(nowMs);
    }

    // Doors open for wherever everyone has just been drawn.
    bodies.length = 0;
    for (const avatar of avatars.values()) {
      bodies.push(avatar.group.position);
    }
    doors.update(deltaSeconds, bodies);

    // Carried sticky notes follow their agents, after the agents have moved.
    stickerBoards.update(nowMs, (id) => avatars.get(id));

    // Every seated live agent's terminal on its own desk's monitor, and none
    // for an agent that has stood up or gone.
    if (agentScreens !== undefined) {
      for (const id of avatars.keys()) {
        const view = room.viewOf(id);
        if (view?.agentStatus !== undefined && view.interactableId !== "") {
          agentScreens.show(id, view.interactableId, room.screenOf(id), nowMs, camera.position);
        }
      }
      // The CEO's desk shows its lent agent's terminal, in every tab, and is lit while one is on its way.
      const deskKey = deskScreenKey(desk);
      if (desk !== undefined && deskKey !== undefined) {
        agentScreens.show(deskKey, desk.seatId, room.screenOf(deskKey), nowMs, camera.position);
      }
      agentScreens.sweep();
    }

    const minuteOfDay = dayClock.minuteAt(nowMs);
    if (minuteOfDay !== undefined) {
      lighting.showMinute(minuteOfDay);
      wallDecor.showMinute(minuteOfDay);
    }
    street?.update(deltaSeconds, lighting.daylight.interior);

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
