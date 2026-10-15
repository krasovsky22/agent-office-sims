/**
 * Standing up is not undone by the server's last word on the seat.
 *
 * Between the controller letting go of a chair and the server confirming it,
 * the replicated pose is still the seat anchor. Reconciling against it would
 * drag a player who walks off straight back into the chair they just left.
 */

import {
  INTERACTION_KIND,
  type InteractableSpec,
  OFFICE_LAYOUT,
  RECONCILE_THRESHOLD,
  interactables,
} from "@sim/shared";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlayerController } from "./controller.js";

const FRAME = 1 / 60;

function keyDown(code: string): Event {
  return Object.assign(new Event("keydown", { cancelable: true }), { code, repeat: false });
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
