/**
 * Input, local prediction, and the third-person camera.
 *
 * The local player moves the moment a key goes down. Nothing waits for the
 * server: the step is resolved here, against the shared collision function, and
 * only then reported. That is what makes walking feel free of input delay, and
 * it is safe because the server re-runs the identical resolver before publishing
 * the result (see the server's `sim/movement.ts`).
 *
 * The server can still disagree — a clamped speed, a dropped packet — so
 * {@link PlayerController.applyCorrection} eases the predicted position back
 * toward the authoritative one, but only once the gap is wider than anything an
 * honest round trip explains.
 *
 * The camera follows on a boom behind the player, which the mouse wheel draws
 * in and lets out, or, in first person, sits at the player's eyes and looks
 * where the mouse points; `V` switches between the two. A seated agent's monitor is
 * right in front of that agent, so from the boom the agent's head and the
 * player's own avatar hide it, and its text is too small to read; a player
 * standing still behind a working agent's chair has the camera lean in over
 * the agent's shoulder instead, {@link shoulderView}, and back out on the
 * first step.
 *
 * `Space` jumps: the arc is the shared {@link jumpHeight}, drawn by the avatar,
 * so the controller only decides whether a jump may start — on the floor and
 * out of any hold — and walking during one still goes through the collision.
 */

import {
  ANIMATION_STATE,
  type InteractableSpec,
  OCCUPANT_RADIUS,
  OFFICE_LAYOUT,
  type OfficeLayout,
  RECONCILE_EASE_RATE,
  RECONCILE_SNAP_THRESHOLD,
  RECONCILE_THRESHOLD,
  type ReportedAnimation,
  WALK_SPEED,
  JUMP_SECONDS,
  doorwayGaps,
  normalizeYaw,
  resolveMove,
  shortestYawDelta,
} from "@sim/shared";
import * as THREE from "three";

import { isTypingTarget } from "../keys.js";
import { CAMERA_MODE, type CameraMode, DEFAULT_ZOOM_DISTANCE, zoomedDistance } from "./cameraMode.js";

/** Closest the camera is ever pulled in, so it never sits inside the avatar. */
const CAMERA_MIN_DISTANCE = 1.6;

/**
 * Padding added to each wall when testing the camera boom against it.
 *
 * Stopping the camera exactly on a wall face puts the surface inside the near
 * plane, which renders as a hole in the wall.
 */
const CAMERA_WALL_PADDING = 0.3;

/** Height on the avatar the camera aims at. */
const CAMERA_TARGET_Y = 1.25;

/**
 * Where the over-the-shoulder eye sits: just behind the seated agent's chair,
 * at the height of its head, square on to its monitor and close enough to read
 * it. An avatar's head is wider than the monitor and nearly touches it, so
 * nowhere beside or above it sees the screen; the agent the camera leans in
 * over is hidden while it is there (`gameLoop.ts`).
 */
const SHOULDER_BACK = 0.1;
const SHOULDER_HEIGHT = 1.25;

/** How long a player stands still at a working agent's screen before the camera leans in, in seconds. */
const FOCUS_DWELL_SECONDS = 0.35;

/** How long the camera takes to lean in over the shoulder, or back out to the boom, in seconds. */
const FOCUS_EASE_SECONDS = 0.6;

const CAMERA_PITCH_MIN = 0.08;
const CAMERA_PITCH_MAX = 1.1;
/**
 * Shallow enough that, with the boom stopped under the ceiling, the camera
 * still stands far enough back to show the room ahead rather than the desk in
 * front of the player.
 */
const CAMERA_PITCH_DEFAULT = 0.3;

/**
 * How far a first-person look can tip down or up, in radians: short of
 * straight down, where yaw stops meaning anything and the view flips.
 */
const LOOK_PITCH_MIN = -1.2;
const LOOK_PITCH_MAX = 1.3;
/** A little below level, so the desks and the floor ahead are in view as the player walks. */
const LOOK_PITCH_DEFAULT = 0.12;

/**
 * How far behind the eyes the first-person camera sits, in metres.
 *
 * The robot's arms are short and hang from well below its visor, so seen from
 * the visor itself even raised hands sit under the bottom of the view. Drawn
 * back this far, still inside the hidden head and the body's own collision
 * radius, they come up into the lower part of it.
 */
const EYE_PULLBACK = 0.25;

/** Radians of camera rotation per pixel of mouse travel. */
const LOOK_SENSITIVITY = 0.0026;

/** How fast the avatar turns to face the direction it is walking, per second. */
const TURN_RATE = 12;

/** Below this the player is treated as standing still. */
const MOVEMENT_EPSILON = 1e-4;

const FORWARD_KEYS = new Set(["KeyW", "ArrowUp"]);
const BACKWARD_KEYS = new Set(["KeyS", "ArrowDown"]);
const LEFT_KEYS = new Set(["KeyA", "ArrowLeft"]);
const RIGHT_KEYS = new Set(["KeyD", "ArrowRight"]);

/** The one verb key. Named in the HUD prompt as `E`. */
const INTERACT_KEY = "KeyE";

/** Closes whatever panel is open over the office. Named in the HUD prompt as `Esc`. */
const CLOSE_KEY = "Escape";

/** Switches between first and third person. Named in the HUD as `V`. */
const CAMERA_KEY = "KeyV";

/** Jumps. Named in the README as `Space`. */
const JUMP_KEY = "Space";

const MOVEMENT_KEYS = new Set([
  ...FORWARD_KEYS,
  ...BACKWARD_KEYS,
  ...LEFT_KEYS,
  ...RIGHT_KEYS,
]);

const ALL_KEYS = new Set([...MOVEMENT_KEYS, INTERACT_KEY, CAMERA_KEY, JUMP_KEY]);

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  animation: ReportedAnimation;
}

interface Box3 {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** How thick the ceiling is taken to be, for stopping the boom against it. */
const CEILING_THICKNESS = 0.3;

/**
 * The walls, the wall over each doorway, and the ceiling, as padded 3D boxes,
 * for shortening the camera boom.
 *
 * The ceiling is what keeps the camera indoors under it, so the office is seen
 * as the room it is rather than from over its roof; outside, on the pavement,
 * the boom is free. Not desks: they are knee height and the camera flies well
 * above them, so including them would make the view lurch every time the boom
 * passed over one. Built once per floor plan, and again only when the lift
 * brings the player to a floor of another.
 */
const occluderCache = new WeakMap<OfficeLayout, readonly Box3[]>();

function cameraOccludersOf(layout: OfficeLayout): readonly Box3[] {
  const cached = occluderCache.get(layout);
  if (cached !== undefined) {
    return cached;
  }
  const occluders = [
    ...layout.walls.map((spec) => ({
      minX: spec.footprint.minX - CAMERA_WALL_PADDING,
      minY: -CAMERA_WALL_PADDING,
      minZ: spec.footprint.minZ - CAMERA_WALL_PADDING,
      maxX: spec.footprint.maxX + CAMERA_WALL_PADDING,
      maxY: spec.height + CAMERA_WALL_PADDING,
      maxZ: spec.footprint.maxZ + CAMERA_WALL_PADDING,
    })),
    // Without the lintel the boom slips through the doorway over the frame and
    // leaves the camera in the room behind, looking at a closed door.
    ...doorwayGaps(layout)
      .filter((gap) => gap.wallHeight > gap.frameHeight)
      .map((gap) => {
        const halfX = (gap.yaw === 0 ? gap.width : gap.depth) / 2;
        const halfZ = (gap.yaw === 0 ? gap.depth : gap.width) / 2;
        return {
          minX: gap.x - halfX - CAMERA_WALL_PADDING,
          minY: gap.frameHeight - CAMERA_WALL_PADDING,
          minZ: gap.z - halfZ - CAMERA_WALL_PADDING,
          maxX: gap.x + halfX + CAMERA_WALL_PADDING,
          maxY: gap.wallHeight + CAMERA_WALL_PADDING,
          maxZ: gap.z + halfZ + CAMERA_WALL_PADDING,
        };
      }),
    ...(layout.ceiling === undefined
      ? []
      : [
          {
            minX: layout.floor.minX,
            minY: layout.ceiling - CAMERA_WALL_PADDING,
            minZ: layout.floor.minZ,
            maxX: layout.floor.maxX,
            maxY: layout.ceiling + CEILING_THICKNESS,
            maxZ: layout.floor.maxZ,
          },
        ]),
  ];
  occluderCache.set(layout, occluders);
  return occluders;
}

/**
 * A view the camera can lean into instead of its boom: where the eye is, and
 * the point it looks at.
 */
export interface CameraFocus {
  readonly eye: THREE.Vector3;
  readonly target: THREE.Vector3;
}

/**
 * How far along a segment the first wall is, as a fraction in (0, 1].
 *
 * Slab test per box, taking the nearest hit. Returns 1 when the segment reaches
 * its end unobstructed. A segment that starts inside a box reports 0, which the
 * caller turns into the minimum boom length.
 */
function distanceToFirstWall(
  occluders: readonly Box3[],
  originX: number,
  originY: number,
  originZ: number,
  deltaX: number,
  deltaY: number,
  deltaZ: number,
): number {
  let nearest = 1;

  for (const box of occluders) {
    let enter = 0;
    let exit = nearest;

    for (let axis = 0; axis < 3 && enter <= exit; axis += 1) {
      const origin = axis === 0 ? originX : axis === 1 ? originY : originZ;
      const delta = axis === 0 ? deltaX : axis === 1 ? deltaY : deltaZ;
      const min = axis === 0 ? box.minX : axis === 1 ? box.minY : box.minZ;
      const max = axis === 0 ? box.maxX : axis === 1 ? box.maxY : box.maxZ;

      if (Math.abs(delta) < 1e-9) {
        // Parallel to this slab: either inside it for the whole segment or
        // outside it for the whole segment.
        if (origin < min || origin > max) {
          enter = Number.POSITIVE_INFINITY;
        }
        continue;
      }

      const first = (min - origin) / delta;
      const second = (max - origin) / delta;
      enter = Math.max(enter, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
    }

    if (enter <= exit) {
      nearest = enter;
    }
  }

  return nearest;
}

/**
 * The view over the shoulder of the agent seated at `seat`, looking at its
 * monitor's screen, centred at `screen`.
 *
 * A wall between the screen and the eye brings the eye in along that line to
 * just short of the wall, as the boom is brought in, so it is never inside one.
 *
 * @returns the view, or `undefined` when no eye outside a wall is far enough
 * from the screen to show it.
 */
export function shoulderView(
  seat: { readonly x: number; readonly z: number },
  screen: THREE.Vector3,
  layout: OfficeLayout = OFFICE_LAYOUT,
): CameraFocus | undefined {
  const forwardX = screen.x - seat.x;
  const forwardZ = screen.z - seat.z;
  const length = Math.hypot(forwardX, forwardZ);
  if (length < MOVEMENT_EPSILON) {
    return undefined;
  }
  const eye = new THREE.Vector3(
    seat.x - (forwardX / length) * SHOULDER_BACK,
    SHOULDER_HEIGHT,
    seat.z - (forwardZ / length) * SHOULDER_BACK,
  );
  const reach = distanceToFirstWall(cameraOccludersOf(layout), screen.x, screen.y, screen.z, eye.x - screen.x, eye.y - screen.y, eye.z - screen.z);
  eye.sub(screen).multiplyScalar(reach).add(screen);
  // An eye pulled in almost onto the screen shows nothing worth leaning in for.
  return eye.distanceTo(screen) < CAMERA_MIN_DISTANCE / 2 ? undefined : { eye, target: screen.clone() };
}

/** Eases in and out of a blend, so the camera neither lurches off nor slams into place. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export class PlayerController {
  /** The predicted pose, which is what the local avatar renders at. */
  public readonly pose: Pose = { x: 0, z: 0, yaw: 0, animation: ANIMATION_STATE.idle };

  private readonly pressed = new Set<string>();
  private cameraYaw = 0;
  private cameraPitch = CAMERA_PITCH_DEFAULT;
  private cameraMode: CameraMode = CAMERA_MODE.thirdPerson;
  /** How long the boom is when nothing is in the way; the wheel sets it. */
  private zoomDistance = DEFAULT_ZOOM_DISTANCE;
  /** How far down a first-person look is tipped, in radians; negative is up. */
  private lookPitch = LOOK_PITCH_DEFAULT;
  /** Where the first-person camera sees from; the avatar says, sitting or standing, until then the shoulder. */
  private readonly eye = new THREE.Vector3(0, SHOULDER_HEIGHT, 0);
  private eyeKnown = false;
  private readonly cameraTarget = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private disposers: Array<() => void> = [];

  /** The view to lean into while the player stands still, if there is one this frame. */
  private focus: CameraFocus | undefined;
  /** The view the camera is in or easing out of, kept until it is back on its boom. */
  private leaning: CameraFocus | undefined;
  /** How far into {@link leaning} the camera is, 0 on its boom to 1 in the view. */
  private focusBlend = 0;
  /** How long the player has stood still, in seconds. */
  private stillSeconds = 0;

  /** The interactable the player is being held at, or `undefined` when free. */
  private hold: InteractableSpec | undefined;

  /**
   * Set between asking the server to let go and the server saying it has.
   *
   * Without it the hold still in the replicated state would re-seat the player
   * on the very next frame, and standing up would never take.
   */
  private releasePending = false;

  private interactRequested = false;
  /** `E` is down, from its press until it comes up: how long it is held opens the agent menu. */
  private interactDown = false;
  private releaseRequested = false;
  private closeRequested = false;
  private cameraToggleRequested = false;
  private jumpRequested = false;
  /** Set on the frame a jump starts, until {@link takeJumpStart} reads it. */
  private jumpStarted = false;
  /** How long the player has been in the air, or `undefined` on the floor. */
  private airborneSeconds: number | undefined;

  /** The floor plan the player walks, and the camera keeps inside; the ground floor's until the room says otherwise. */
  private layout: OfficeLayout = OFFICE_LAYOUT;

  public constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly viewport: HTMLCanvasElement,
  ) {}

  /** Walks another floor's plan from now on, as when the lift arrives there. */
  public setLayout(layout: OfficeLayout): void {
    this.layout = layout;
  }

  /** Places the player without any easing. Used on join. */
  public teleport(x: number, z: number, yaw: number): void {
    this.pose.x = x;
    this.pose.z = z;
    this.pose.yaw = normalizeYaw(yaw);
    this.pose.animation = ANIMATION_STATE.idle;
    // A rejoin reuses this controller, and the player arrives standing however
    // they left.
    this.hold = undefined;
    this.releasePending = false;
    this.cameraYaw = this.pose.yaw;
    this.updateCamera();
  }

  public attach(): void {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }
      if (event.code === CLOSE_KEY) {
        if (!event.repeat) {
          this.closeRequested = true;
        }
        return;
      }
      if (!ALL_KEYS.has(event.code)) {
        return;
      }
      // Stop the arrow keys from scrolling the page out from under the canvas.
      event.preventDefault();
      if (event.code === INTERACT_KEY) {
        // A press, not a state: holding the key down must not fire repeatedly.
        if (!event.repeat) {
          this.interactRequested = true;
          this.interactDown = true;
        }
        return;
      }
      if (event.code === CAMERA_KEY) {
        if (!event.repeat) {
          this.cameraToggleRequested = true;
        }
        return;
      }
      if (event.code === JUMP_KEY) {
        // Holding the key down is one jump, not a bounce.
        if (!event.repeat) {
          this.jumpRequested = true;
        }
        return;
      }
      this.pressed.add(event.code);
    };
    // Key-up is *not* filtered by target: focus can move between a key going
    // down and coming up, and a key released into a newly focused input would
    // otherwise stay held forever.
    const onKeyUp = (event: KeyboardEvent) => {
      this.pressed.delete(event.code);
      if (event.code === INTERACT_KEY) {
        this.interactDown = false;
      }
    };
    // A window that loses focus mid-stride would otherwise keep walking.
    const onBlur = () => {
      this.pressed.clear();
      this.interactDown = false;
    };
    // Same for focus moving into a text field mid-stride, which stays inside the
    // window and so never reaches `blur`.
    const onFocusIn = (event: FocusEvent) => {
      if (isTypingTarget(event.target)) {
        this.pressed.clear();
      }
    };
    const onPointerDown = () => {
      if (document.pointerLockElement !== this.viewport) {
        void this.viewport.requestPointerLock();
      }
    };
    const onMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== this.viewport) {
        return;
      }
      this.cameraYaw = normalizeYaw(this.cameraYaw - event.movementX * LOOK_SENSITIVITY);
      const tilt = event.movementY * LOOK_SENSITIVITY;
      if (this.cameraMode === CAMERA_MODE.firstPerson) {
        this.lookPitch = Math.min(LOOK_PITCH_MAX, Math.max(LOOK_PITCH_MIN, this.lookPitch + tilt));
      } else {
        this.cameraPitch = Math.min(CAMERA_PITCH_MAX, Math.max(CAMERA_PITCH_MIN, this.cameraPitch + tilt));
      }
    };
    // On the canvas only: over a HUD panel the wheel lands on the panel and
    // scrolls it instead, which is what a player reading a terminal wants.
    const onWheel = (event: WheelEvent) => {
      if (this.cameraMode !== CAMERA_MODE.thirdPerson) {
        return;
      }
      event.preventDefault();
      this.zoomDistance = zoomedDistance(this.zoomDistance, event.deltaY, event.deltaMode);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focusin", onFocusIn);
    this.viewport.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("mousemove", onMouseMove);
    this.viewport.addEventListener("wheel", onWheel, { passive: false });

    this.disposers = [
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("blur", onBlur),
      () => window.removeEventListener("focusin", onFocusIn),
      () => this.viewport.removeEventListener("pointerdown", onPointerDown),
      () => window.removeEventListener("mousemove", onMouseMove),
      () => this.viewport.removeEventListener("wheel", onWheel),
    ];
  }

  public detach(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
    this.pressed.clear();
  }

  /**
   * Tells the controller where the server is holding the player, if anywhere.
   *
   * Called every frame from the replicated state, so a hold the server granted,
   * a hold that timed out on its own, and a hold released after a reconnect all
   * arrive through one path.
   *
   * @param hold the interactable being held at, or `undefined` when the player
   * is free.
   */
  public setHold(hold: InteractableSpec | undefined): void {
    if (hold === undefined) {
      // A hold the server ended without being asked stands the player where
      // it did, which for a chair is its exit rather than the seat.
      const exit = this.releasePending ? undefined : this.hold?.exit;
      if (exit !== undefined) {
        this.pose.x = exit.x;
        this.pose.z = exit.z;
      }
      this.hold = undefined;
      this.releasePending = false;
      return;
    }
    if (this.releasePending || this.hold === hold) {
      return;
    }
    // Snap onto the anchor rather than easing: the server derived it from the
    // same shared layout, so this is not a correction, it is the same answer.
    const { anchor } = hold;
    this.hold = hold;
    this.pose.x = anchor.x;
    this.pose.z = anchor.z;
    this.pose.yaw = normalizeYaw(anchor.yaw);
    this.pose.animation = ANIMATION_STATE.idle;
  }

  /** Whether the player is standing in a held pose this frame. */
  public get held(): boolean {
    return this.hold !== undefined;
  }

  /** Which camera the player is looking through. */
  public get mode(): CameraMode {
    return this.cameraMode;
  }

  /**
   * Looks through the given camera from the next frame on.
   *
   * Going into first person turns the body to face the way the camera was
   * looking, so the first step forward goes where the player was already
   * facing on screen.
   */
  public setCameraMode(mode: CameraMode): void {
    if (mode === this.cameraMode) {
      return;
    }
    this.cameraMode = mode;
    if (mode === CAMERA_MODE.firstPerson && this.hold === undefined) {
      this.pose.yaw = this.cameraYaw;
    }
    this.updateCamera();
  }

  /** How far the third-person boom reaches when nothing is in the way. */
  public get zoom(): number {
    return this.zoomDistance;
  }

  /**
   * Where the player's eyes are this frame, from the drawn body, and places the
   * first-person camera there again: the body is posed after the controller
   * moves, and a camera a frame behind it would shake against the hands.
   */
  public setEye(eye: THREE.Vector3): void {
    this.eye.copy(eye);
    this.eyeKnown = true;
    if (this.cameraMode === CAMERA_MODE.firstPerson) {
      this.updateCamera();
    }
  }

  /**
   * Whether a jump started this frame, for the avatar to draw and the server to
   * hear of; reading it clears it.
   */
  public takeJumpStart(): boolean {
    const started = this.jumpStarted;
    this.jumpStarted = false;
    return started;
  }

  /** Takes a pending `V` press, if there is one. */
  public takeCameraToggleRequest(): boolean {
    const requested = this.cameraToggleRequested;
    this.cameraToggleRequested = false;
    return requested;
  }

  /** How far the camera has leaned into its focus, 0 on its boom to 1 all the way in. */
  public get leanedIn(): number {
    return this.focusBlend;
  }

  /** The view {@link leanedIn} measures, which may still be one the camera is easing out of. */
  public get leaningInto(): CameraFocus | undefined {
    return this.leaning;
  }

  /**
   * The view the camera leans into once the player has stood still for a
   * moment, such as {@link shoulderView} at a working agent's screen, or
   * `undefined` for none. Set every frame; a view that goes away, or a step,
   * eases the camera back to its boom.
   */
  public setFocus(focus: CameraFocus | undefined): void {
    this.focus = focus;
    if (focus !== undefined && (this.leaning === undefined || this.focusBlend === 0)) {
      this.leaning = focus;
    }
  }

  /**
   * Takes a pending interact keypress, if there is one.
   *
   * Swallowed while a release is pending: the replicated hold is still the old
   * one, so the request would pass the client's check, re-seat the player in
   * the same server tick as the release, and the release would never be seen.
   */
  public takeInteractRequest(): boolean {
    const requested = this.interactRequested && !this.releasePending;
    this.interactRequested = false;
    return requested;
  }

  /** Whether `E` is still held down since its last press. */
  public get interactHeld(): boolean {
    return this.interactDown;
  }

  /**
   * Takes a pending `Esc` press made outside any keyboard owner, if there is one.
   *
   * A panel that owns the keyboard handles its own `Esc`; this is the press
   * that reaches the office with such a panel still open.
   */
  public takeCloseRequest(): boolean {
    const requested = this.closeRequested;
    this.closeRequested = false;
    return requested;
  }

  /** Takes a pending request to be let go of, if there is one. */
  public takeReleaseRequest(): boolean {
    const requested = this.releaseRequested;
    this.releaseRequested = false;
    return requested;
  }

  /** Advances the local player by one frame and follows with the camera. */
  public update(deltaSeconds: number): void {
    // A press made in a chair or in mid-air is dropped, not kept for later.
    const jump = this.jumpRequested;
    this.jumpRequested = false;
    if (this.airborneSeconds !== undefined) {
      this.airborneSeconds += deltaSeconds;
      if (this.airborneSeconds >= JUMP_SECONDS) {
        this.airborneSeconds = undefined;
      }
    }

    this.stillSeconds = this.movementPressed() ? 0 : this.stillSeconds + deltaSeconds;
    const leanIn = this.focus !== undefined && this.focus === this.leaning && this.stillSeconds >= FOCUS_DWELL_SECONDS;
    const step = deltaSeconds / FOCUS_EASE_SECONDS;
    this.focusBlend = Math.min(1, Math.max(0, this.focusBlend + (leanIn ? step : -step)));
    if (this.focusBlend === 0) {
      this.leaning = this.focus;
    }

    if (this.hold !== undefined) {
      if (!this.movementPressed()) {
        // Held: the pose is the server's, so there is nothing to predict. The
        // camera still swings, which is what makes sitting feel like a place to
        // be rather than a cutscene.
        this.updateCamera();
        return;
      }
      // Movement input is the only way out of a hold. Let go locally and walk
      // this same frame; the server frees the anchor when the request lands,
      // which is before any pose sent after it, because the socket is ordered.
      // The walk starts from where the server will stand the player: the exit
      // of a chair, which is solid, or the anchor of anything else.
      const exit = this.hold.exit;
      if (exit !== undefined) {
        this.pose.x = exit.x;
        this.pose.z = exit.z;
      }
      this.hold = undefined;
      this.releasePending = true;
      this.releaseRequested = true;
    }

    if (jump && this.airborneSeconds === undefined) {
      this.airborneSeconds = 0;
      this.jumpStarted = true;
    }

    // Camera yaw defines which way "forward" is: the player walks away from the
    // camera, as a third-person control scheme should.
    const forwardX = -Math.sin(this.cameraYaw);
    const forwardZ = -Math.cos(this.cameraYaw);
    const rightX = -forwardZ;
    const rightZ = forwardX;

    let inputX = 0;
    let inputZ = 0;
    for (const code of this.pressed) {
      if (FORWARD_KEYS.has(code)) {
        inputX += forwardX;
        inputZ += forwardZ;
      } else if (BACKWARD_KEYS.has(code)) {
        inputX -= forwardX;
        inputZ -= forwardZ;
      } else if (RIGHT_KEYS.has(code)) {
        inputX += rightX;
        inputZ += rightZ;
      } else if (LEFT_KEYS.has(code)) {
        inputX -= rightX;
        inputZ -= rightZ;
      }
    }

    const magnitude = Math.hypot(inputX, inputZ);
    if (magnitude > MOVEMENT_EPSILON) {
      // Normalised, so walking diagonally is not faster than walking straight.
      const step = (WALK_SPEED * deltaSeconds) / magnitude;
      const resolved = resolveMove(
        this.pose,
        { x: inputX * step, z: inputZ * step },
        OCCUPANT_RADIUS,
        this.layout,
      );
      this.pose.x = resolved.x;
      this.pose.z = resolved.z;
      this.pose.animation = ANIMATION_STATE.walking;
      if (this.cameraMode === CAMERA_MODE.thirdPerson) {
        this.turnToward(Math.atan2(-inputX, -inputZ), deltaSeconds);
      }
    } else {
      this.pose.animation = ANIMATION_STATE.idle;
    }
    // In first person the body faces where the player looks, so stepping
    // sideways is a sidestep rather than a turn, and others see the player
    // looking the way they are.
    if (this.cameraMode === CAMERA_MODE.firstPerson) {
      this.pose.yaw = this.cameraYaw;
    }

    this.updateCamera();
  }

  /**
   * Nudges the predicted position toward the server's.
   *
   * The gap between the two is normally just the travel still in flight, which
   * is why nothing happens below {@link RECONCILE_THRESHOLD}: correcting that
   * would drag the player backwards on every step. Past it, the position is
   * eased rather than assigned, so a clamp the server applied resolves as a
   * glide. Only a gap too large to walk off — a rejected teleport, a long
   * stall — is snapped.
   */
  public applyCorrection(serverX: number, serverZ: number, deltaSeconds: number): void {
    if (this.hold !== undefined || this.releasePending) {
      return;
    }
    const errorX = serverX - this.pose.x;
    const errorZ = serverZ - this.pose.z;
    const error = Math.hypot(errorX, errorZ);

    if (error < RECONCILE_THRESHOLD) {
      return;
    }
    if (error > RECONCILE_SNAP_THRESHOLD) {
      this.pose.x = serverX;
      this.pose.z = serverZ;
      return;
    }

    const blend = 1 - Math.exp(-RECONCILE_EASE_RATE * deltaSeconds);
    this.pose.x += errorX * blend;
    this.pose.z += errorZ * blend;
  }

  private movementPressed(): boolean {
    for (const code of this.pressed) {
      if (MOVEMENT_KEYS.has(code)) {
        return true;
      }
    }
    return false;
  }

  private turnToward(targetYaw: number, deltaSeconds: number): void {
    const delta = shortestYawDelta(this.pose.yaw, targetYaw);
    const blend = Math.min(1, TURN_RATE * deltaSeconds);
    this.pose.yaw = normalizeYaw(this.pose.yaw + delta * blend);
  }

  /**
   * Places the camera at the player's eyes, or on a boom behind the player,
   * shortened by anything in the way, then leans it into any focus.
   *
   * Without the shortening the boom pushes straight through the nearest wall
   * whenever the player stands near one, and the player disappears behind the
   * geometry the camera is now outside of.
   */
  private updateCamera(): void {
    if (this.cameraMode === CAMERA_MODE.firstPerson) {
      // The eyes are inside the body's own collision radius, so no wall is
      // ever nearer than the near plane and there is nothing to shorten.
      const eyeX = this.eyeKnown ? this.eye.x : this.pose.x;
      const eyeZ = this.eyeKnown ? this.eye.z : this.pose.z;
      const forwardX = -Math.sin(this.cameraYaw);
      const forwardZ = -Math.cos(this.cameraYaw);
      const level = Math.cos(this.lookPitch);
      this.camera.position.set(eyeX - forwardX * EYE_PULLBACK, this.eye.y, eyeZ - forwardZ * EYE_PULLBACK);
      this.lookTarget.set(
        this.camera.position.x + forwardX * level,
        this.eye.y - Math.sin(this.lookPitch),
        this.camera.position.z + forwardZ * level,
      );
      this.leanAndLook();
      return;
    }

    const horizontal = Math.cos(this.cameraPitch) * this.zoomDistance;
    const boomX = Math.sin(this.cameraYaw) * horizontal;
    const boomY = Math.sin(this.cameraPitch) * this.zoomDistance;
    const boomZ = Math.cos(this.cameraYaw) * horizontal;

    this.cameraTarget.set(this.pose.x, CAMERA_TARGET_Y, this.pose.z);

    const reach = distanceToFirstWall(
      cameraOccludersOf(this.layout),
      this.cameraTarget.x,
      this.cameraTarget.y,
      this.cameraTarget.z,
      boomX,
      boomY,
      boomZ,
    );
    const fraction = Math.max(reach, Math.min(1, CAMERA_MIN_DISTANCE / this.zoomDistance));

    this.camera.position.set(
      this.cameraTarget.x + boomX * fraction,
      this.cameraTarget.y + boomY * fraction,
      this.cameraTarget.z + boomZ * fraction,
    );
    this.lookTarget.copy(this.cameraTarget);
    this.leanAndLook();
  }

  /** Eases the camera from where it was just placed into any view it is leaning into, and aims it. */
  private leanAndLook(): void {
    if (this.leaning !== undefined && this.focusBlend > 0) {
      const blend = smoothstep(this.focusBlend);
      this.camera.position.lerp(this.leaning.eye, blend);
      this.lookTarget.lerp(this.leaning.target, blend);
    }
    this.camera.lookAt(this.lookTarget);
  }
}
