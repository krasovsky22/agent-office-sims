/**
 * A fired agent's send-off: the cardboard box of its belongings it carries
 * out, held in both hands in front of it, and the tears running down from
 * its eyes.
 *
 * The server says only that the agent is fired (`LiveAgent.fired`) and walks
 * it out; this module turns that into something to look at, the same in every
 * tab. Geometry and materials are shared by every send-off, the tears are a
 * few tiny meshes moved along a fixed loop, and nothing is allocated per
 * frame, as for the coffee cup.
 */

import { OCCUPANT_HEIGHT, OCCUPANT_RADIUS } from "@sim/shared";
import * as THREE from "three";

/** Where the box is held, in the body's own frame (forward is -Z): at the hands, raised to the chest. */
const BOX_OFFSET = new THREE.Vector3(0, OCCUPANT_HEIGHT * 0.5, -(OCCUPANT_RADIUS + 0.12));
const BOX_WIDTH = 0.46;
const BOX_HEIGHT = 0.26;
const BOX_DEPTH = 0.32;

/** Where the eyes are when the body has no head to read them off: a little under the crown. */
const CAPSULE_EYES = new THREE.Vector3(0, OCCUPANT_HEIGHT - 0.25, -OCCUPANT_RADIUS * 0.8);
/** From the middle of the visor to each eye, and out in front of the face so the tears are not inside it. */
const EYE_SPREAD = 0.075;
const EYE_FORWARD = 0.17;
const EYE_DROP = 0.04;

/** Tears: a few drops per eye running down on a loop, out of step with each other. */
const TEARS_PER_EYE = 2;
const TEAR_PERIOD_MS = 900;
const TEAR_FALL = 0.32;

const BOX_GEOMETRY = new THREE.BoxGeometry(BOX_WIDTH, BOX_HEIGHT, BOX_DEPTH);
const FLAP_GEOMETRY = new THREE.BoxGeometry(BOX_WIDTH, 0.01, BOX_DEPTH * 0.45);
const POT_GEOMETRY = new THREE.CylinderGeometry(0.05, 0.04, 0.08, 8);
const LEAVES_GEOMETRY = new THREE.SphereGeometry(0.085, 8, 6);
const MUG_GEOMETRY = new THREE.CylinderGeometry(0.04, 0.04, 0.09, 8);
const FRAME_GEOMETRY = new THREE.BoxGeometry(0.15, 0.12, 0.015);
const TEAR_GEOMETRY = new THREE.SphereGeometry(0.026, 6, 4);

const BOX_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xb8864b });
const FLAP_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xa47640 });
const POT_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xc0623c });
const LEAVES_MATERIAL = new THREE.MeshLambertMaterial({ color: 0x4f9a45 });
const MUG_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xf2f2ee });
const FRAME_MATERIAL = new THREE.MeshLambertMaterial({ color: 0x3a3a44 });
// Unlit, so a tear still shows at night under the room's dimmed light.
const TEAR_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x7cc8ff, transparent: true, opacity: 0.9 });

/** How far down its run a tear is, from `0` at the eye to `1` gone, `nowMs` in. */
export function tearFall(nowMs: number, phase: number): number {
  return (((nowMs / TEAR_PERIOD_MS + phase) % 1) + 1) % 1;
}

/** One fired agent's box and tears: add {@link group} to the body and call {@link update} each frame. */
export class SendOff {
  public readonly group = new THREE.Group();

  private readonly box = new THREE.Group();
  private readonly tears: THREE.Mesh[] = [];
  private readonly eyes = new THREE.Vector3();

  public constructor() {
    this.box.add(new THREE.Mesh(BOX_GEOMETRY, BOX_MATERIAL));
    // An open flap leaning out at the front and back, and what is packed sticking up out of it.
    for (const side of [-1, 1]) {
      const flap = new THREE.Mesh(FLAP_GEOMETRY, FLAP_MATERIAL);
      flap.position.set(0, BOX_HEIGHT / 2 + 0.05, side * (BOX_DEPTH / 2 + 0.03));
      flap.rotation.x = side * 0.9;
      this.box.add(flap);
    }
    const pot = new THREE.Mesh(POT_GEOMETRY, POT_MATERIAL);
    pot.position.set(-0.12, BOX_HEIGHT / 2 + 0.02, 0);
    const leaves = new THREE.Mesh(LEAVES_GEOMETRY, LEAVES_MATERIAL);
    leaves.position.set(-0.12, BOX_HEIGHT / 2 + 0.12, 0);
    const mug = new THREE.Mesh(MUG_GEOMETRY, MUG_MATERIAL);
    mug.position.set(0.1, BOX_HEIGHT / 2 + 0.02, 0.05);
    const frame = new THREE.Mesh(FRAME_GEOMETRY, FRAME_MATERIAL);
    frame.position.set(0.04, BOX_HEIGHT / 2 + 0.04, -0.08);
    frame.rotation.x = -0.3;
    this.box.add(pot, leaves, mug, frame);
    this.box.position.copy(BOX_OFFSET);
    this.group.add(this.box);

    for (let index = 0; index < TEARS_PER_EYE * 2; index += 1) {
      const tear = new THREE.Mesh(TEAR_GEOMETRY, TEAR_MATERIAL);
      this.tears.push(tear);
      this.group.add(tear);
    }
    this.group.visible = false;
  }

  /**
   * Shows the box and runs the tears this frame, or hides both.
   *
   * @param eyes where the body sees from, in world space, or `undefined` for a
   * body with no head, whose eyes are taken to be under its crown.
   */
  public update(fired: boolean, nowMs: number, eyes: THREE.Vector3 | undefined): void {
    this.group.visible = fired;
    if (!fired) {
      return;
    }
    if (eyes === undefined) {
      this.eyes.copy(CAPSULE_EYES);
    } else {
      this.group.worldToLocal(this.eyes.copy(eyes));
      this.eyes.z -= EYE_FORWARD;
      this.eyes.y -= EYE_DROP;
    }
    this.tears.forEach((tear, index) => {
      const side = index % 2 === 0 ? -1 : 1;
      const fall = tearFall(nowMs, Math.floor(index / 2) / TEARS_PER_EYE + (side > 0 ? 0.25 : 0));
      tear.position.set(this.eyes.x + side * EYE_SPREAD, this.eyes.y - fall * TEAR_FALL, this.eyes.z - fall * 0.04);
      // Swells as it leaves the eye, thins as it runs off the chin.
      tear.scale.setScalar(Math.max(Math.sin(Math.min(fall * 1.3, 1) * Math.PI), 0.001));
    });
  }
}
