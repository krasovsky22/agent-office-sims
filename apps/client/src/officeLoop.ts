/**
 * The scene and the frame loop that draws it, with the room's events that
 * move it.
 *
 * The loop is imperative and runs every frame: read input, predict the local
 * player, reconcile against the server, interpolate everyone else, draw. It
 * tells React only of what changes a few times a session.
 *
 * Kept apart from `main.ts`, which mounts the HUD and wires the room's events
 * only the HUD hears of, so a scene feature is added here.
 */

import {
  ANIMATION_STATE,
  INTERACT_RANGE,
  INTERACTION_KIND,
  type InteractableSpec,
  LIVE_AGENT_STATUS,
  MANAGER_INTERACTABLE_ID,
  OFFICE_DECOR,
  OFFICE_LAYOUT,
  OFFICE_PROPS,
  PROJECT_BOARD_ID,
  type ProjectBoardSnapshot,
  RECURRING_TASKS_BOARD_ID,
  STARTING_MINUTE_OF_DAY,
  type WorkData,
  authorizeInteract,
  describeLiveAgentTask,
  deskTerminalSeat,
  heldAnimationFor,
  interactableById,
  nearestInteractable,
  promptFor,
  stickerNotes,
  taskReference,
} from "@sim/shared";
import * as THREE from "three";

import {
  AGENT_MENU_HOLD_MS,
  AGENT_MENU_RANGE,
  type AgentMenuView,
  type AgentSpot,
  agentMenuFor,
  facedAgent,
} from "./agentMenu.js";
import { agentProfileAccessFor } from "./agentProfileAccess.js";
import { agentPromptAccessFor } from "./agentPromptAccess.js";
import { deskForbiddenText, deskPanelFor, deskScreenKey, sameDeskPanel } from "./deskTerminalAccess.js";
import { standupAccessFor } from "./standupAccess.js";
import { boardAccessFor } from "./boardAccess.js";
import { browserStorage, readDebugEnabled, readPropsEnabled } from "./browserEnv.js";
import { DayClock } from "./dayClock.js";
import { withOfficeWork } from "./projectBoard.js";
import { managerAccessFor } from "./managerAccess.js";
import { chime, needsYouTitle, newlyWaiting, notifyNeedsYou } from "./needsYou.js";
import { keepAcceptedName } from "./playerName.js";
import { recurringRow, standingAccessFor } from "./standingAccess.js";
import type { RemotePose } from "./net/poseBuffer.js";
import { type OccupantView, RoomConnection } from "./net/room.js";
import type { RoomConnectionEvents } from "./net/roomEvents.js";
import { CAMERA_MODE } from "./player/cameraMode.js";
import { type CameraFocus, type PlayerController, shoulderView } from "./player/controller.js";
import { AgentScreens } from "./scene/agentScreen.js";
import { Avatar } from "./scene/avatar.js";
import { type AvatarModel, loadAvatarModel } from "./scene/avatarModel.js";
import { Doors } from "./scene/doors.js";
import { buildRecurringBoard } from "./scene/recurringBoard.js";
import { buildWallBoard } from "./scene/wallBoard.js";
import { buildWallDecor } from "./scene/wallDecor.js";
import { buildLighting } from "./scene/lighting.js";
import { buildOffice } from "./scene/office.js";
import { loadPropKit, screenFaceOf, screenMaterialOf } from "./scene/propKit.js";
import { buildProps } from "./scene/props.js";
import { StickerBoards } from "./scene/stickerBoards.js";
import { buildStreet } from "./scene/street.js";
import type { HudPrompt, HudSnapshot } from "./ui/hudStore.js";

/**
 * Longest frame the simulation will integrate.
 *
 * A backgrounded tab resumes with a gap of seconds. Without this cap the first
 * frame back would ask the resolver for a single huge step, and a held key would
 * fling the player the length of the office.
 */
const MAX_FRAME_SECONDS = 0.1;

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

/** What the loop needs of `main.ts`. */
export interface OfficeLoopHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly controller: PlayerController;
  readonly publish: (next: Partial<HudSnapshot>) => void;
  /** The snapshot as last published. */
  readonly hud: () => HudSnapshot;
  /** Shows a line to this player only, and takes it down again shortly. */
  readonly notice: (text: string) => void;
  /** Looks through the other camera, and keeps the choice for the next visit. */
  readonly toggleCamera: () => void;
  /**
   * The room's events only the HUD hears of. Where the scene hears of one
   * too, a chat line or the project board, the scene's handler passes it on.
   */
  readonly hudEvents: RoomConnectionEvents;
}

/** What the HUD's actions tell the loop, and the room it joined. */
export interface OfficeLoop {
  readonly room: RoomConnection;
  /** Opens an agent's terminal panel from the roster or a notification, wherever the player stands. */
  readonly answer: (agentId: string) => void;
  /** The name asked for on the card or in Rename, kept in the browser only once the office gives it. */
  readonly askedFor: (name: string) => void;
  readonly closePanel: () => void;
  readonly closeTerminal: () => void;
  /** The desk panel's Stand up button, taken by the next frame as `E` would be. */
  readonly standUp: () => void;
  readonly closeAgentMenu: () => void;
}

/** Builds the scene, joins its handlers to the room's, and starts drawing. */
export function startOfficeLoop(host: OfficeLoopHost): OfficeLoop {
  const { renderer, camera, controller, publish: publishHud, notice: showNotice, toggleCamera: toggleCameraMode } = host;

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
  const recurringSpec = OFFICE_LAYOUT.boards.find((spec) => spec.id === RECURRING_TASKS_BOARD_ID);
  const recurringBoard =
    recurringSpec === undefined ? undefined : buildRecurringBoard(scene, recurringSpec, renderer.capabilities.getMaxAnisotropy());
  // What the recurring tasks board last painted, so it repaints only when a line on it changes.
  let recurringPainted = "";
  let recurringCheckedAt = 0;
  // What the sticker boards' notes are worked out from, besides who carries what.
  let boardSnapshot: ProjectBoardSnapshot | undefined;
  let officeWork: readonly WorkData[] = [];

  const avatars = new Map<string, Avatar>();
  const remotePose: RemotePose = { x: 0, z: 0, yaw: 0, animation: ANIMATION_STATE.idle };

  // Undefined until the humanoid model has downloaded, and for the rest of the
  // session if it never does. Avatars built in the meantime stand as capsules
  // and are upgraded in place below.
  let avatarModel: AvatarModel | undefined;

  // The agent whose terminal the CEO opened from the roster's Answer button, from wherever they stand.
  let answeringAgentId: string | undefined;
  // The agents waiting on a person as of the last roster, so only one that has just started waiting chimes.
  let waitingIds: ReadonlySet<string> = new Set();
  const baseTitle = document.title;

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

  // The wall shows the office's work placed as the close-up does, and repaints
  // for a work patch only when it moves a card, so notes ticking by cost nothing.
  let wallBoardShown: { snapshot: ProjectBoardSnapshot; inProgress: string } | undefined;
  const showWallBoard = () => {
    if (boardSnapshot === undefined) {
      return;
    }
    const shown = withOfficeWork(boardSnapshot, officeWork);
    const inProgress = shown.inProgress.map((issue) => issue.number).join(",");
    if (wallBoardShown?.snapshot === boardSnapshot && wallBoardShown.inProgress === inProgress) {
      return;
    }
    wallBoardShown = { snapshot: boardSnapshot, inProgress };
    wallBoard?.show(shown);
  };

  // The name asked for on the card or in Rename, kept in the browser only once the office gives it.
  let askedName: string | undefined;

  const room: RoomConnection = new RoomConnection({
    ...host.hudEvents,
    onLocalSpawn: (x, z, yaw) => {
      controller.teleport(x, z, yaw);
    },

    onOccupantsChanged: () => {
      if (askedName !== undefined && keepAcceptedName(browserStorage(), askedName, room.occupantName(room.sessionId))) {
        askedName = undefined;
      }
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
            title: view.title,
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
          existing.setLabel(view.name, view.isCeo, caption, view.title);
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
          ...view,
          caption: captionOf(view),
          needsInput: view.agentStatus === LIVE_AGENT_STATUS.needsInput,
        })),
        boardAccess: local === undefined ? undefined : boardAccessFor(local, ceo?.name, room.issuesWritable()),
        managerAccess: local === undefined ? undefined : managerAccessFor(local, ceo?.name),
        agentPromptAccess: local === undefined ? undefined : agentPromptAccessFor(local, ceo?.name),
        standingAccess: local === undefined ? undefined : standingAccessFor(local, ceo?.name),
        standupAccess: local === undefined ? undefined : standupAccessFor(local, ceo?.name),
        agentProfileAccess: local === undefined ? undefined : agentProfileAccessFor(local, ceo?.name),
      });
      refreshStickerNotes();
      // Only the CEO can answer, so only the CEO's tab counts, chimes and notifies.
      const waiting = present.filter((view) => view.agentStatus === LIVE_AGENT_STATUS.needsInput);
      const ceoTab = local?.isCeo === true;
      document.title = needsYouTitle(baseTitle, ceoTab ? waiting.length : 0);
      const fresh = newlyWaiting(waitingIds, waiting.map((view) => view.id));
      if (ceoTab && fresh.length > 0) {
        chime();
        // A visible tab already shows the beacon and the roster's Answer button.
        if (document.hidden) {
          for (const view of waiting.filter((candidate) => fresh.includes(candidate.id))) {
            notifyNeedsYou(view.id, view.name, captionOf(view), () => answer(view.id));
          }
        }
      }
      waitingIds = new Set(waiting.map((view) => view.id));
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
      host.hudEvents.onChat?.(event);
    },


    // The same snapshot goes to the wall and to the close-up panel, so what
    // the board shows at a distance and up close cannot disagree.
    onProjectBoard: (snapshot) => {
      host.hudEvents.onProjectBoard?.(snapshot);
      publishHud({ projectBoard: snapshot });
      boardSnapshot = snapshot;
      showWallBoard();
      refreshStickerNotes();
    },

    // The lighting runs the clock on between patches; React never hears of it.
    onClockChanged: (minuteOfDay) => {
      dayClock.observe(minuteOfDay, performance.now());
    },

    onWorkChanged: (work) => {
      publishHud({ work });
      officeWork = work;
      showWallBoard();
      refreshStickerNotes();
    },
  });

  // The wall board, manager's desk or agent's screen whose panel is open, or
  // `""`. Local to this tab: reading a board, talking to the manager or
  // watching an agent holds nothing, so there is nothing for the server to know.
  let readingBoard = "";

  /** Opens an agent's terminal panel from the roster or a notification, wherever the player stands. */
  const answer = (agentId: string) => {
    readingBoard = "";
    answeringAgentId = agentId;
  };

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
    } else if (closeRequested) {
      answeringAgentId = undefined;
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
        : agentMenuFor(localView, menuAgent, officeWork, host.hud().roster.find((entry) => entry.isCeo)?.name);
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
    // The sticker boards are the project board's too, and open the same close-up;
    // the recurring tasks board opens its own.
    const recurringOpen = readingBoard === RECURRING_TASKS_BOARD_ID;
    const closeUp = interactableById(OFFICE_LAYOUT, readingBoard)?.kind === INTERACTION_KIND.board && !recurringOpen;
    if (closeUp !== host.hud().boardCloseUp) {
      publishHud({ boardCloseUp: closeUp });
    }
    if (recurringOpen !== host.hud().recurringOpen) {
      publishHud({ recurringOpen });
    }
    const managerOpen = readingBoard === MANAGER_INTERACTABLE_ID;
    if (managerOpen !== host.hud().managerOpen) {
      publishHud(managerOpen ? { managerOpen, managerUnread: 0 } : { managerOpen });
    }
    // The agent at the screen's seat: it stays the same while the panel is
    // open, since the screen is only offered while that agent sits there.
    // A panel opened with `E`, sitting at the desk, or the agent leaving, closes the one opened from the roster.
    if (
      readingBoard !== "" ||
      host.hud().desk !== undefined ||
      (answeringAgentId !== undefined && room.viewOf(answeringAgentId) === undefined)
    ) {
      answeringAgentId = undefined;
    }
    const watchedSeat = interactableById(OFFICE_LAYOUT, readingBoard)?.seatId;
    const terminalAgentId = watchedSeat === undefined ? answeringAgentId : room.holderOf(watchedSeat);
    if (terminalAgentId !== host.hud().terminalAgentId) {
      publishHud({ terminalAgentId });
    }
    // The CEO sitting at a computer has its terminal; anyone else is told why not, once.
    const desk = room.desk();
    // A sitting lists only the prompts typed after it began.
    const promptsAfter = host.hud().desk?.promptsAfter ?? host.hud().agentPrompts.at(-1)?.id ?? 0;
    const deskPanel = deskPanelFor(desk, localId, locallyHeldWith, promptsAfter);
    if (!sameDeskPanel(deskPanel, host.hud().desk)) {
      publishHud({ desk: deskPanel });
    }
    const deskSeat = deskTerminalSeat(OFFICE_LAYOUT, locallyHeldWith);
    if (deskSeat === undefined) {
      toldDeskForbidden = "";
    } else if (room.viewOf(localId)?.isCeo === false && toldDeskForbidden !== deskSeat.id) {
      toldDeskForbidden = deskSeat.id;
      showNotice(deskForbiddenText(host.hud().roster.find((entry) => entry.isCeo)?.name));
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

    // The recurring tasks board, looked at once a second: its "last run" lines age by the minute.
    if (recurringBoard !== undefined && nowMs - recurringCheckedAt >= 1000) {
      recurringCheckedAt = nowMs;
      const now = Date.now();
      const rows = [...host.hud().standingTasks]
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map((task) => recurringRow(task, now, task.agentId === "" ? undefined : host.hud().roster.find((entry) => entry.id === task.agentId)?.name));
      const painted = JSON.stringify(rows);
      if (painted !== recurringPainted) {
        recurringPainted = painted;
        recurringBoard.show(rows);
      }
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

  return {
    room,
    answer,
    askedFor: (name) => {
      askedName = name;
    },
    closePanel: () => {
      readingBoard = "";
    },
    closeTerminal: () => {
      readingBoard = "";
      answeringAgentId = undefined;
    },
    standUp: () => {
      standUpRequested = true;
    },
    closeAgentMenu: () => {
      agentMenuId = undefined;
    },
  };
}
