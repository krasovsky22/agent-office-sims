/**
 * Standing up is not undone by the server's last word on the seat.
 *
 * Between the controller letting go of a chair and the server confirming it,
 * the replicated pose is still the seat anchor. Reconciling against it would
 * drag a player who walks off straight back into the chair they just left.
 *
 * And the camera leans in over a working agent's shoulder to read its
 * monitor only while the player stands still at it, never from inside a wall.
 *
 * The camera can be switched to first person, where the body faces where the
 * player looks, and back; the wheel zooms the third-person boom and never
 * pushes it through the ceiling.
 *
 * `Space` jumps only from the floor: never again in mid-air, never from a chair.
 */

import {
  INTERACTION_KIND,
  JUMP_SECONDS,
  doorwayGaps,
  type InteractableSpec,
  OFFICE_LAYOUT,
  RECONCILE_THRESHOLD,
  interactableById,
  interactables,
  monitorOfSeat,
} from "@sim/shared";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CAMERA_MODE, MAX_ZOOM_DISTANCE, MIN_ZOOM_DISTANCE } from "./cameraMode.js";
import { PlayerController, shoulderView } from "./controller.js";

const FRAME = 1 / 60;

function keyDown(code: string, repeat = false): Event {
  return Object.assign(new Event("keydown", { cancelable: true }), { code, repeat });
}

function keyUp(code: string): Event {
  return Object.assign(new Event("keyup"), { code });
}

function wheel(deltaY: number): Event {
  return Object.assign(new Event("wheel", { cancelable: true }), { deltaY, deltaMode: 0 });
}

function firstSeat(): InteractableSpec {
  const seat = interactables(OFFICE_LAYOUT).find(
    (spec) => spec.kind === INTERACTION_KIND.seat && spec.exit !== undefined,
  );
  if (seat === undefined) {
    throw new Error("the layout has no chair to sit on");
  }
  return seat;
}

describe("PlayerController reconciliation around standing up", () => {
  let controller: PlayerController;
  let seat: InteractableSpec;

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("HTMLElement", class {});
    controller = new PlayerController(
      new THREE.PerspectiveCamera(),
      new EventTarget() as HTMLCanvasElement,
    );
    controller.attach();
    seat = firstSeat();
    controller.teleport(seat.anchor.x, seat.anchor.z, seat.anchor.yaw);
    controller.setHold(seat);
  });

  afterEach(() => {
    controller.detach();
    vi.unstubAllGlobals();
  });

  /** Walks away from the desk with the replicated hold still on the seat. */
  function standAndWalk(frames: number): void {
    window.dispatchEvent(keyDown("KeyS"));
    for (let frame = 0; frame < frames; frame += 1) {
      controller.setHold(seat);
      controller.update(FRAME);
    }
  }

  function distanceFromAnchor(): number {
    return Math.hypot(controller.pose.x - seat.anchor.x, controller.pose.z - seat.anchor.z);
  }

  it("ignores the stale seat anchor until the server confirms the release", () => {
    standAndWalk(12);
    expect(controller.held).toBe(false);
    expect(distanceFromAnchor()).toBeGreaterThan(RECONCILE_THRESHOLD);

    const before = { x: controller.pose.x, z: controller.pose.z };
    controller.applyCorrection(seat.anchor.x, seat.anchor.z, FRAME);

    expect(controller.pose.x).toBe(before.x);
    expect(controller.pose.z).toBe(before.z);
  });

  it("reconciles again once the replicated hold clears", () => {
    standAndWalk(12);
    controller.setHold(undefined);

    const before = distanceFromAnchor();
    controller.applyCorrection(seat.anchor.x, seat.anchor.z, FRAME);

    expect(distanceFromAnchor()).toBeLessThan(before);
  });
});

describe("PlayerController close key", () => {
  let controller: PlayerController;

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("HTMLElement", class {});
    controller = new PlayerController(
      new THREE.PerspectiveCamera(),
      new EventTarget() as HTMLCanvasElement,
    );
    controller.attach();
  });

  afterEach(() => {
    controller.detach();
    vi.unstubAllGlobals();
  });

  it("asks to close once for an Esc pressed with focus outside any panel", () => {
    expect(controller.takeCloseRequest()).toBe(false);
    const press = keyDown("Escape");
    window.dispatchEvent(press);

    expect(press.defaultPrevented).toBe(false);
    expect(controller.takeCloseRequest()).toBe(true);
    expect(controller.takeCloseRequest()).toBe(false);
  });

  it("does not treat Esc as an interaction or a step", () => {
    window.dispatchEvent(keyDown("Escape"));
    controller.update(FRAME);

    expect(controller.takeInteractRequest()).toBe(false);
    expect(controller.pose.x).toBe(0);
    expect(controller.pose.z).toBe(0);
  });
});

/** Roughly where the kit's monitor face is centred, above the desk the monitor stands on. */
const FACE_CENTRE_HEIGHT = 0.34;

/** Every open-floor workstation's screen, its seat, and its monitor's face centre. */
function workstations(): Array<{ readonly screen: InteractableSpec; readonly seat: InteractableSpec; readonly centre: THREE.Vector3 }> {
  return interactables(OFFICE_LAYOUT).flatMap((screen) => {
    const seat = screen.kind === INTERACTION_KIND.screen && screen.seatId !== undefined ? interactableById(OFFICE_LAYOUT, screen.seatId) : undefined;
    const monitor = seat === undefined ? undefined : monitorOfSeat(OFFICE_LAYOUT, seat.id);
    return seat === undefined || monitor === undefined
      ? []
      : [{ screen, seat, centre: new THREE.Vector3(monitor.x, monitor.y + FACE_CENTRE_HEIGHT, monitor.z) }];
  });
}

/** Whether a point is inside any of the office's walls. */
function inWall(point: THREE.Vector3): boolean {
  return OFFICE_LAYOUT.walls.some(
    (wall) =>
      point.x >= wall.footprint.minX &&
      point.x <= wall.footprint.maxX &&
      point.z >= wall.footprint.minZ &&
      point.z <= wall.footprint.maxZ &&
      point.y <= wall.height,
  );
}

describe("shoulderView", () => {
  it("reads every workstation's monitor from just behind its agent, never from inside or through a wall", () => {
    const all = workstations();
    expect(all.length).toBeGreaterThan(0);
    // The south row backs onto the office's south wall, where the boom ends up inside it.
    expect(all.some(({ screen }) => screen.id.includes("south"))).toBe(true);
    for (const { screen, seat, centre } of all) {
      const view = shoulderView(seat.anchor, centre);
      expect(view, screen.id).toBeDefined();
      const { eye, target } = view!;
      expect(target.equals(centre)).toBe(true);
      // Close enough to read, and on the chair's side of the monitor.
      expect(eye.distanceTo(centre), screen.id).toBeGreaterThan(0.8);
      expect(eye.distanceTo(centre), screen.id).toBeLessThan(1.6);
      expect(Math.hypot(eye.x - seat.anchor.x, eye.z - seat.anchor.z), screen.id).toBeLessThan(0.3);
      for (let step = 0; step <= 20; step += 1) {
        expect(inWall(centre.clone().lerp(eye, step / 20)), `${screen.id} at ${step / 20}`).toBe(false);
      }
    }
  });

  it("comes in short of a wall behind the chair rather than into it", () => {
    const wall = OFFICE_LAYOUT.walls.find((candidate) => candidate.footprint.minZ > 10);
    if (wall === undefined) {
      throw new Error("the layout has no south wall");
    }
    // A chair backed right up against the wall, its monitor in front of it.
    const seat = { x: 0, z: wall.footprint.minZ - 0.05 };
    const centre = new THREE.Vector3(0, 1.09, seat.z - 1.1);
    const view = shoulderView(seat, centre);
    expect(view).toBeDefined();
    expect(view!.eye.z).toBeLessThan(wall.footprint.minZ);
    expect(inWall(view!.eye)).toBe(false);
  });

  it("offers no view of a screen at the chair itself", () => {
    expect(shoulderView({ x: 1, z: 1 }, new THREE.Vector3(1, 1.09, 1))).toBeUndefined();
  });
});

describe("PlayerController leaning in over a working agent's shoulder", () => {
  let controller: PlayerController;
  let camera: THREE.PerspectiveCamera;
  let view: ReturnType<typeof shoulderView>;

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("HTMLElement", class {});
    camera = new THREE.PerspectiveCamera();
    controller = new PlayerController(camera, new EventTarget() as HTMLCanvasElement);
    controller.attach();
    const [first] = workstations();
    if (first === undefined) {
      throw new Error("the layout has no workstation");
    }
    view = shoulderView(first.seat.anchor, first.centre);
    controller.teleport(first.screen.anchor.x, first.screen.anchor.z, first.screen.anchor.yaw);
  });

  afterEach(() => {
    controller.detach();
    vi.unstubAllGlobals();
  });

  /** Runs frames as `main.ts` does: the controller first, then this frame's focus, `null` for none. */
  function frames(seconds: number, focus: typeof view | null = view): void {
    for (let frame = 0; frame < Math.ceil(seconds / FRAME); frame += 1) {
      controller.update(FRAME);
      controller.setFocus(focus ?? undefined);
    }
  }

  it("leans in once the player has stood still a moment, and back out on the first step", () => {
    frames(0.2);
    expect(controller.leanedIn).toBe(0);
    expect(camera.position.distanceTo(view!.eye)).toBeGreaterThan(1);

    frames(1.2);
    expect(controller.leanedIn).toBe(1);
    expect(camera.position.distanceTo(view!.eye)).toBeLessThan(1e-6);

    window.dispatchEvent(keyDown("KeyS"));
    frames(0.7);
    expect(controller.leanedIn).toBe(0);
    expect(camera.position.distanceTo(view!.eye)).toBeGreaterThan(1);
  });

  it("never leans in while the player keeps walking", () => {
    window.dispatchEvent(keyDown("KeyA"));
    frames(2);
    expect(controller.leanedIn).toBe(0);
  });

  it("eases back out once there is nothing to lean in for, as when the agent stands up", () => {
    frames(1.5);
    expect(controller.leanedIn).toBe(1);
    frames(0.3, null);
    expect(controller.leanedIn).toBeGreaterThan(0);
    expect(controller.leanedIn).toBeLessThan(1);
    frames(0.4, null);
    expect(controller.leanedIn).toBe(0);
  });

  it("stays in the view it leaned into while easing out toward another screen's", () => {
    const [, second] = workstations();
    if (second === undefined) {
      throw new Error("the layout has fewer than two workstations");
    }
    const other = shoulderView(second.seat.anchor, second.centre);
    frames(1.5);
    expect(controller.leaningInto).toBe(view);

    frames(0.3, other);
    expect(controller.leanedIn).toBeGreaterThan(0);
    expect(controller.leaningInto).toBe(view);

    frames(1.5, other);
    expect(controller.leaningInto).toBe(other);
    expect(controller.leanedIn).toBe(1);
  });
});

describe("PlayerController camera through a doorway", () => {
  let controller: PlayerController;
  let camera: THREE.PerspectiveCamera;

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("HTMLElement", class {});
    camera = new THREE.PerspectiveCamera();
    controller = new PlayerController(camera, new EventTarget() as HTMLCanvasElement);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops the boom at the wall over a doorway the player has just walked through", () => {
    const gaps = doorwayGaps(OFFICE_LAYOUT);
    expect(gaps.length).toBeGreaterThan(0);

    for (const gap of gaps) {
      // Across the wall: +Z for a wall running along X, +X for one running along Z.
      const normalX = gap.yaw === 0 ? 0 : 1;
      const normalZ = gap.yaw === 0 ? 1 : 0;

      for (const side of [-1, 1]) {
        const x = gap.x + normalX * side * 2.5;
        const z = gap.z + normalZ * side * 2.5;
        // The boom trails behind the player, so facing away from the doorway points it back through.
        controller.teleport(x, z, Math.atan2(gap.x - x, gap.z - z));

        const cameraSide = (camera.position.x - gap.x) * normalX + (camera.position.z - gap.z) * normalZ;
        expect(Math.sign(cameraSide), `${gap.id} side ${side}`).toBe(side);
      }
    }
  });
});

describe("PlayerController camera modes", () => {
  let controller: PlayerController;
  let camera: THREE.PerspectiveCamera;
  let viewport: EventTarget;

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("HTMLElement", class {});
    camera = new THREE.PerspectiveCamera();
    viewport = new EventTarget();
    controller = new PlayerController(camera, viewport as HTMLCanvasElement);
    controller.attach();
  });

  afterEach(() => {
    controller.detach();
    vi.unstubAllGlobals();
  });

  it("asks to switch once per V press, not for a held key's repeats, and never walks for it", () => {
    window.dispatchEvent(keyDown("KeyV"));
    window.dispatchEvent(keyDown("KeyV", true));
    controller.update(FRAME);

    expect(controller.takeCameraToggleRequest()).toBe(true);
    expect(controller.takeCameraToggleRequest()).toBe(false);
    expect(controller.pose.x).toBe(0);
    expect(controller.pose.z).toBe(0);
  });

  it("zooms the third-person boom with the wheel, within its limits", () => {
    const start = controller.zoom;
    const out = wheel(240);
    viewport.dispatchEvent(out);
    expect(out.defaultPrevented).toBe(true);
    expect(controller.zoom).toBeGreaterThan(start);

    for (let notch = 0; notch < 50; notch += 1) {
      viewport.dispatchEvent(wheel(-240));
    }
    expect(controller.zoom).toBe(MIN_ZOOM_DISTANCE);
    for (let notch = 0; notch < 50; notch += 1) {
      viewport.dispatchEvent(wheel(240));
    }
    expect(controller.zoom).toBe(MAX_ZOOM_DISTANCE);
  });

  it("keeps a zoomed-out boom under the ceiling", () => {
    const ceiling = OFFICE_LAYOUT.ceiling;
    if (ceiling === undefined) {
      return;
    }
    const seat = firstSeat();
    const exit = seat.exit ?? seat.anchor;
    controller.teleport(exit.x, exit.z, 0);
    for (let notch = 0; notch < 50; notch += 1) {
      viewport.dispatchEvent(wheel(240));
    }
    controller.update(FRAME);

    expect(camera.position.y).toBeLessThan(ceiling);
    expect(inWall(camera.position)).toBe(false);
  });

  it("leaves the wheel alone in first person", () => {
    controller.setCameraMode(CAMERA_MODE.firstPerson);
    const start = controller.zoom;
    const turn = wheel(240);
    viewport.dispatchEvent(turn);

    expect(turn.defaultPrevented).toBe(false);
    expect(controller.zoom).toBe(start);
  });

  it("looks from the eyes in first person, the body facing the way the camera does as it sidesteps", () => {
    controller.teleport(0, 2, 1);
    controller.setCameraMode(CAMERA_MODE.firstPerson);
    controller.setEye(new THREE.Vector3(0, 1.4, 2));

    expect(controller.mode).toBe(CAMERA_MODE.firstPerson);
    expect(camera.position.y).toBeCloseTo(1.4, 6);
    expect(Math.hypot(camera.position.x, camera.position.z - 2)).toBeLessThan(0.35);

    const yaw = controller.pose.yaw;
    window.dispatchEvent(keyDown("KeyD"));
    for (let frame = 0; frame < 10; frame += 1) {
      controller.update(FRAME);
    }
    window.dispatchEvent(keyUp("KeyD"));
    expect(controller.pose.yaw).toBe(yaw);
    expect(Math.hypot(controller.pose.x, controller.pose.z - 2)).toBeGreaterThan(0.1);
  });

  it("puts the camera back on its boom when switched back", () => {
    controller.setCameraMode(CAMERA_MODE.firstPerson);
    controller.setEye(new THREE.Vector3(0, 1.4, 0));
    controller.setCameraMode(CAMERA_MODE.thirdPerson);

    expect(Math.hypot(camera.position.x, camera.position.z)).toBeGreaterThan(1);
  });
});

describe("PlayerController jumping", () => {
  let controller: PlayerController;

  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("HTMLElement", class {});
    controller = new PlayerController(
      new THREE.PerspectiveCamera(),
      new EventTarget() as HTMLCanvasElement,
    );
    controller.attach();
  });

  afterEach(() => {
    controller.detach();
    vi.unstubAllGlobals();
  });

  it("jumps once per Space press, never again in mid-air, and again once landed", () => {
    window.dispatchEvent(keyDown("Space"));
    window.dispatchEvent(keyDown("Space", true));
    controller.update(FRAME);
    expect(controller.takeJumpStart()).toBe(true);
    expect(controller.takeJumpStart()).toBe(false);

    window.dispatchEvent(keyDown("Space"));
    controller.update(FRAME);
    expect(controller.takeJumpStart()).toBe(false);

    controller.update(JUMP_SECONDS);
    window.dispatchEvent(keyDown("Space"));
    controller.update(FRAME);
    expect(controller.takeJumpStart()).toBe(true);
  });

  it("does not jump from a chair, nor stand up for it", () => {
    const seat = firstSeat();
    controller.teleport(seat.anchor.x, seat.anchor.z, seat.anchor.yaw);
    controller.setHold(seat);
    window.dispatchEvent(keyDown("Space"));
    controller.update(FRAME);

    expect(controller.takeJumpStart()).toBe(false);
    expect(controller.held).toBe(true);
    expect(controller.takeReleaseRequest()).toBe(false);
  });
});
