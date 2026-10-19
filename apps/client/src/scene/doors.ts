/**
 * The doors hung in the floor plan's doorways, swinging open for whoever comes
 * near and closing again behind them.
 *
 * A door here is decor, like the frame it hangs in: nothing collides with it
 * and the server never hears of it, so it can never stand in anyone's way or
 * in an agent's path. It only has to look right, which is why the swing is
 * worked out from where everyone is drawn, each frame, on the client: the
 * local player's prediction and every other body alike. It swings away from
 * whoever opens it, and holds that way until it has closed again, so it never
 * flips through someone halfway along.
 *
 * Each doorway comes from `doorwayGaps`, the same gaps the frames and the
 * lintels over them are fitted to. A narrow gap gets one leaf, hinged on one
 * jamb; the wide main entrance gets a pair, one on each.
 */

import { type DoorwayGap, doorwayGaps, type OfficeLayout } from "@sim/shared";
import * as THREE from "three";

const LEAF_COLOUR = 0x9a7650;
const HANDLE_COLOUR = 0x2e3136;

/**
 * The door frame model's jamb and head, as fractions of the gap it is fitted
 * to: measured off `doorwayOpen.glb`, so a leaf fills the frame's opening.
 */
const JAMB_FRACTION = 0.058;
const HEAD_FRACTION = 0.029;

const LEAF_THICKNESS = 0.045;
/** A hair of air round a leaf, so it never touches the frame it swings in. */
const LEAF_CLEARANCE = 0.01;

/** Gaps at least this wide get a pair of leaves rather than one. */
const DOUBLE_DOOR_WIDTH = 1.6;

/** How close anyone has to be to a doorway's centre for its door to open. */
export const DOOR_OPEN_RADIUS = 1.6;

/** A door's swing, wide open, and how fast it gets there or back, in radians a second. */
export const DOOR_OPEN_ANGLE = Math.PI / 2;
const SWING_SPEED = Math.PI * 1.6;

/**
 * Below this swing a door counts as shut: the next person through picks which
 * way it opens. Above it, it keeps opening the way it already is.
 */
const LATCH_ANGLE = 0.05;

/**
 * One frame of a door's swing.
 *
 * `angle` is the swing so far: positive opens towards the doorway's local -Z
 * side, negative towards +Z. `nearestSide` is the local Z of the nearest body
 * in reach, or `undefined` with nobody near. The door swings away from that
 * body, unless it is already open the other way, and closes with nobody near.
 *
 * @returns the swing after `deltaSeconds`.
 */
export function swingDoor(angle: number, nearestSide: number | undefined, deltaSeconds: number): number {
  let target = 0;
  if (nearestSide !== undefined) {
    // Away from whoever opens it: someone on the -Z side sends it to +Z.
    const direction = Math.abs(angle) > LATCH_ANGLE ? Math.sign(angle) : nearestSide < 0 ? -1 : 1;
    target = direction * DOOR_OPEN_ANGLE;
  }
  const step = SWING_SPEED * deltaSeconds;
  const gap = target - angle;
  return Math.abs(gap) <= step ? target : angle + Math.sign(gap) * step;
}

/**
 * Where a body stands in a doorway's own frame: `along` the gap and `across`
 * the wall, from its centre.
 */
export function doorwayLocal(gap: DoorwayGap, point: { readonly x: number; readonly z: number }): { along: number; across: number } {
  const dx = point.x - gap.x;
  const dz = point.z - gap.z;
  const cos = Math.cos(gap.yaw);
  const sin = Math.sin(gap.yaw);
  // The inverse of a rotation by `yaw` about +Y.
  return { along: dx * cos - dz * sin, across: dx * sin + dz * cos };
}

/**
 * The local Z of the nearest of `bodies` within {@link DOOR_OPEN_RADIUS} of a
 * doorway's centre, or `undefined` if none is.
 */
export function nearestSideOf(gap: DoorwayGap, bodies: Iterable<{ readonly x: number; readonly z: number }>): number | undefined {
  let nearest = DOOR_OPEN_RADIUS;
  let side: number | undefined;
  for (const body of bodies) {
    const distance = Math.hypot(body.x - gap.x, body.z - gap.z);
    if (distance < nearest) {
      nearest = distance;
      side = doorwayLocal(gap, body).across;
    }
  }
  return side;
}

interface HungDoor {
  readonly gap: DoorwayGap;
  /** Each leaf's hinge, turned by the swing; `-1` for a leaf hinged on the far jamb, mirroring it. */
  readonly hinges: readonly { readonly pivot: THREE.Object3D; readonly hand: 1 | -1 }[];
  angle: number;
}

/** A leaf hinged at its pivot's origin, reaching `hand` along local X across `width`. */
function leaf(width: number, height: number, hand: 1 | -1, materials: { readonly leaf: THREE.Material; readonly handle: THREE.Material }): THREE.Object3D {
  const pivot = new THREE.Group();
  const panel = new THREE.Mesh(new THREE.BoxGeometry(width, height, LEAF_THICKNESS), materials.leaf);
  panel.position.set((hand * width) / 2, height / 2, 0);
  pivot.add(panel);
  // A handle each side, near the leading edge at hand height.
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, LEAF_THICKNESS + 0.1), materials.handle);
  handle.position.set(hand * (width - 0.09), 1.0, 0);
  pivot.add(handle);
  return pivot;
}

/** The doors of a floor, built and ready to swing. */
export class Doors {
  readonly group = new THREE.Group();
  private readonly doors: HungDoor[] = [];

  constructor(scene: THREE.Scene, layout: OfficeLayout) {
    this.group.name = "doors";
    const materials = {
      leaf: new THREE.MeshLambertMaterial({ color: LEAF_COLOUR }),
      handle: new THREE.MeshLambertMaterial({ color: HANDLE_COLOUR }),
    };
    for (const gap of doorwayGaps(layout)) {
      const jamb = gap.width * JAMB_FRACTION;
      const opening = gap.width - jamb * 2;
      const height = gap.frameHeight * (1 - HEAD_FRACTION) - LEAF_CLEARANCE;
      const frame = new THREE.Group();
      frame.position.set(gap.x, 0, gap.z);
      frame.rotation.y = gap.yaw;
      // Hung in the middle of the wall's thickness, hinged on the jambs.
      const hands: readonly (1 | -1)[] = gap.width >= DOUBLE_DOOR_WIDTH ? [1, -1] : [1];
      const leafWidth = opening / hands.length - LEAF_CLEARANCE;
      const hinges = hands.map((hand) => {
        const pivot = leaf(leafWidth, height, hand, materials);
        pivot.position.set(-hand * (opening / 2), LEAF_CLEARANCE, 0);
        frame.add(pivot);
        return { pivot, hand };
      });
      frame.name = `door-${gap.id}`;
      this.group.add(frame);
      this.doors.push({ gap, hinges, angle: 0 });
    }
    scene.add(this.group);
  }

  /** Swings every door towards open for whoever is near it, or shut for nobody. */
  update(deltaSeconds: number, bodies: readonly { readonly x: number; readonly z: number }[]): void {
    for (const door of this.doors) {
      const angle = swingDoor(door.angle, nearestSideOf(door.gap, bodies), deltaSeconds);
      if (angle === door.angle) {
        continue;
      }
      door.angle = angle;
      for (const { pivot, hand } of door.hinges) {
        // A leaf on the far jamb turns the other way to swing to the same side.
        pivot.rotation.y = hand * angle;
      }
    }
  }
}
