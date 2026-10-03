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
 */

import {
  ANIMATION_STATE,
  type AnimationState,
  OCCUPANT_RADIUS,
  OFFICE_LAYOUT,
  RECONCILE_EASE_RATE,
  RECONCILE_SNAP_THRESHOLD,
  RECONCILE_THRESHOLD,
  WALK_SPEED,
  normalizeYaw,
  resolveMove,
  shortestYawDelta,
} from "@sim/shared";
import * as THREE from "three";

/** Distance from the camera to the player when nothing is in the way. */
const CAMERA_DISTANCE = 7;

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

const CAMERA_PITCH_MIN = 0.08;
const CAMERA_PITCH_MAX = 1.1;
const CAMERA_PITCH_DEFAULT = 0.45;

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

const ALL_KEYS = new Set([...FORWARD_KEYS, ...BACKWARD_KEYS, ...LEFT_KEYS, ...RIGHT_KEYS]);

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  animation: AnimationState;
}

interface Box3 {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/**
 * The walls, as padded 3D boxes, for shortening the camera boom.
 *
 * Only walls: desks are knee height and the camera flies well above them, so
 * including them would make the view lurch every time the boom passed over one.
 * Built once — the layout does not change at runtime.
 */
const CAMERA_OCCLUDERS: readonly Box3[] = OFFICE_LAYOUT.walls.map((spec) => ({
  minX: spec.footprint.minX - CAMERA_WALL_PADDING,
  minY: -CAMERA_WALL_PADDING,
  minZ: spec.footprint.minZ - CAMERA_WALL_PADDING,
  maxX: spec.footprint.maxX + CAMERA_WALL_PADDING,
  maxY: spec.height + CAMERA_WALL_PADDING,
  maxZ: spec.footprint.maxZ + CAMERA_WALL_PADDING,
}));

/**
 * How far along a segment the first wall is, as a fraction in (0, 1].
 *
 * Slab test per box, taking the nearest hit. Returns 1 when the segment reaches
 * its end unobstructed. A segment that starts inside a box reports 0, which the
 * caller turns into the minimum boom length.
 */
function distanceToFirstWall(
  originX: number,
  originY: number,
  originZ: number,
  deltaX: number,
  deltaY: number,
  deltaZ: number,
): number {
  let nearest = 1;

  for (const box of CAMERA_OCCLUDERS) {
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

export class PlayerController {
  /** The predicted pose, which is what the local avatar renders at. */
  public readonly pose: Pose = { x: 0, z: 0, yaw: 0, animation: ANIMATION_STATE.idle };

  private readonly pressed = new Set<string>();
  private cameraYaw = 0;
  private cameraPitch = CAMERA_PITCH_DEFAULT;
  private readonly cameraTarget = new THREE.Vector3();
  private disposers: Array<() => void> = [];

  public constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly viewport: HTMLCanvasElement,
  ) {}

  /** Places the player without any easing. Used on join. */
  public teleport(x: number, z: number, yaw: number): void {
    this.pose.x = x;
    this.pose.z = z;
    this.pose.yaw = normalizeYaw(yaw);
    this.pose.animation = ANIMATION_STATE.idle;
    this.cameraYaw = this.pose.yaw;
    this.updateCamera();
  }

  public attach(): void {
    const onKeyDown = (event: KeyboardEvent) => {
      if (ALL_KEYS.has(event.code)) {
        this.pressed.add(event.code);
        // Stop the arrow keys from scrolling the page out from under the canvas.
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      this.pressed.delete(event.code);
    };
    // A window that loses focus mid-stride would otherwise keep walking.
    const onBlur = () => {
      this.pressed.clear();
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
      this.cameraPitch = Math.min(
        CAMERA_PITCH_MAX,
        Math.max(CAMERA_PITCH_MIN, this.cameraPitch + event.movementY * LOOK_SENSITIVITY),
      );
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    this.viewport.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("mousemove", onMouseMove);

    this.disposers = [
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("blur", onBlur),
      () => this.viewport.removeEventListener("pointerdown", onPointerDown),
      () => window.removeEventListener("mousemove", onMouseMove),
    ];
  }

  public detach(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
    this.pressed.clear();
  }

  /** Advances the local player by one frame and follows with the camera. */
  public update(deltaSeconds: number): void {
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
        OFFICE_LAYOUT,
      );
      this.pose.x = resolved.x;
      this.pose.z = resolved.z;
      this.pose.animation = ANIMATION_STATE.walking;
      this.turnToward(Math.atan2(-inputX, -inputZ), deltaSeconds);
    } else {
      this.pose.animation = ANIMATION_STATE.idle;
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

  private turnToward(targetYaw: number, deltaSeconds: number): void {
    const delta = shortestYawDelta(this.pose.yaw, targetYaw);
    const blend = Math.min(1, TURN_RATE * deltaSeconds);
    this.pose.yaw = normalizeYaw(this.pose.yaw + delta * blend);
  }

  /**
   * Places the camera on a boom behind the player, shortened by anything in the
   * way.
   *
   * Without the shortening the boom pushes straight through the nearest wall
   * whenever the player stands near one, and the player disappears behind the
   * geometry the camera is now outside of.
   */
  private updateCamera(): void {
    const horizontal = Math.cos(this.cameraPitch) * CAMERA_DISTANCE;
    const boomX = Math.sin(this.cameraYaw) * horizontal;
    const boomY = Math.sin(this.cameraPitch) * CAMERA_DISTANCE;
    const boomZ = Math.cos(this.cameraYaw) * horizontal;

    this.cameraTarget.set(this.pose.x, CAMERA_TARGET_Y, this.pose.z);

    const reach = distanceToFirstWall(
      this.cameraTarget.x,
      this.cameraTarget.y,
      this.cameraTarget.z,
      boomX,
      boomY,
      boomZ,
    );
    const fraction = Math.max(reach, CAMERA_MIN_DISTANCE / CAMERA_DISTANCE);

    this.camera.position.set(
      this.cameraTarget.x + boomX * fraction,
      this.cameraTarget.y + boomY * fraction,
      this.cameraTarget.z + boomZ * fraction,
    );
    this.camera.lookAt(this.cameraTarget);
  }
}
