/**
 * A fired agent's send-off: the cardboard box of its belongings it carries
 * out, held in both hands in front of it, a trophy, two framed photos and a
 * plant standing up out of it, and the tears running down from its eyes.
 *
 * The server says only that the agent is fired (`LiveAgent.fired`) and walks
 * it out; this module turns that into something to look at, the same in every
 * tab. Geometry and materials are shared by every send-off, the tears are a
 * few tiny meshes moved along a fixed loop, and nothing is allocated per
 * frame, as for the coffee cup.
 */

import { OCCUPANT_HEIGHT, OCCUPANT_RADIUS } from "@sim/shared";
import * as THREE from "three";

import { EYE_ABOVE_HEAD } from "./avatarModel.js";

/**
 * Where the box is held, in the body's own frame (forward is -Z): between the
 * raised hands, under the chin and clear of the chest, so what is packed in it
 * shows in front of the face.
 */
const BOX_OFFSET = new THREE.Vector3(0, OCCUPANT_HEIGHT * 0.58, -(OCCUPANT_RADIUS + 0.13));
const BOX_WIDTH = 0.46;
const BOX_HEIGHT = 0.26;
const BOX_DEPTH = 0.32;

/**
 * From the middle of the head, level with the eyes, to each eye, and out to
 * just proud of the face so the tears run down it rather than inside the head.
 */
const EYE_SPREAD = 0.08;
const EYE_FORWARD = 0.23;
const EYE_DROP = 0.03;

/** Tears: a few drops per eye running down on a loop, out of step with each other. */
const TEARS_PER_EYE = 2;
const TEAR_PERIOD_MS = 900;
const TEAR_FALL = 0.2;

const BOX_GEOMETRY = new THREE.BoxGeometry(BOX_WIDTH, BOX_HEIGHT, BOX_DEPTH);
const FLAP_GEOMETRY = new THREE.BoxGeometry(BOX_WIDTH, 0.01, BOX_DEPTH * 0.45);
const POT_GEOMETRY = new THREE.CylinderGeometry(0.05, 0.04, 0.08, 8);
const LEAVES_GEOMETRY = new THREE.SphereGeometry(0.085, 8, 6);
/** A trophy: a plinth, a stem and an open cup, about 0.24 m tall. */
const PLINTH_GEOMETRY = new THREE.BoxGeometry(0.08, 0.04, 0.08);
const STEM_GEOMETRY = new THREE.CylinderGeometry(0.012, 0.02, 0.07, 6);
const CUP_GEOMETRY = new THREE.CylinderGeometry(0.06, 0.025, 0.11, 10, 1, true);
/** A framed photo, standing on its edge: the frame, and the picture just proud of its face. */
const FRAME_GEOMETRY = new THREE.BoxGeometry(0.16, 0.2, 0.018);
const PHOTO_GEOMETRY = new THREE.PlaneGeometry(0.12, 0.155);
const TEAR_GEOMETRY = new THREE.SphereGeometry(0.03, 6, 4);

const BOX_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xb8864b });
const FLAP_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xa47640 });
const POT_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xc0623c });
const LEAVES_MATERIAL = new THREE.MeshLambertMaterial({ color: 0x4f9a45 });
const PLINTH_MATERIAL = new THREE.MeshLambertMaterial({ color: 0x2e2a28 });
const GOLD_MATERIAL = new THREE.MeshLambertMaterial({ color: 0xf2c230, emissive: 0x3a2a00, side: THREE.DoubleSide });
const FRAME_MATERIAL = new THREE.MeshLambertMaterial({ color: 0x6b4426 });
/** The photos: bright enough to read as pictures across the room. */
const PHOTO_MATERIALS = [
  new THREE.MeshLambertMaterial({ color: 0x8fd0ff }),
  new THREE.MeshLambertMaterial({ color: 0xffb3c7 }),
];
// Unlit, so a tear still shows at night under the room's dimmed light.
const TEAR_MATERIAL = new THREE.MeshBasicMaterial({ color: 0x7cc8ff, transparent: true, opacity: 0.9 });

/** How far down its run a tear is, from `0` at the eye to `1` gone, `nowMs` in. */
function tearFall(nowMs: number, phase: number): number {
  return (((nowMs / TEAR_PERIOD_MS + phase) % 1) + 1) % 1;
}

/** Where the rim of the box is, in its own frame: what is packed stands on the bottom and up past it. */
const RIM = BOX_HEIGHT / 2;

/** A trophy standing in the box at `x`, `z`, its cup well above the rim. */
function trophy(x: number, z: number): THREE.Group {
  const group = new THREE.Group();
  const plinth = new THREE.Mesh(PLINTH_GEOMETRY, PLINTH_MATERIAL);
  plinth.position.y = 0.02;
  const stem = new THREE.Mesh(STEM_GEOMETRY, GOLD_MATERIAL);
  stem.position.y = 0.075;
  const cup = new THREE.Mesh(CUP_GEOMETRY, GOLD_MATERIAL);
  cup.position.y = 0.165;
  group.add(plinth, stem, cup);
  group.position.set(x, RIM - 0.05, z);
  return group;
}

/** A framed photo standing on its edge in the box, its picture facing out ahead of the carrier (-Z), leaning back a little. */
function framedPhoto(x: number, z: number, turn: number, photo: number): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(FRAME_GEOMETRY, FRAME_MATERIAL));
  const picture = new THREE.Mesh(PHOTO_GEOMETRY, PHOTO_MATERIALS[photo % PHOTO_MATERIALS.length]);
  picture.position.z = -0.0095;
  picture.rotation.y = Math.PI;
  group.add(picture);
  group.position.set(x, RIM + 0.05, z);
  group.rotation.set(0.2, turn, 0);
  return group;
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
    this.box.add(pot, leaves, trophy(0.13, 0.02), framedPhoto(-0.01, 0.07, -0.18, 0), framedPhoto(0.07, -0.07, 0.25, 1));
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
   * @param head the head pivot, at the neck: the eyes are read off it, so the
   * tears stay on the face as it bows.
   */
  public update(fired: boolean, nowMs: number, head: THREE.Object3D): void {
    this.group.visible = fired;
    if (!fired) {
      return;
    }
    head.updateWorldMatrix(true, false);
    this.group.worldToLocal(head.localToWorld(this.eyes.set(0, EYE_ABOVE_HEAD - EYE_DROP, -EYE_FORWARD)));
    this.tears.forEach((tear, index) => {
      const side = index % 2 === 0 ? -1 : 1;
      const fall = tearFall(nowMs, Math.floor(index / 2) / TEARS_PER_EYE + (side > 0 ? 0.25 : 0));
      tear.position.set(this.eyes.x + side * EYE_SPREAD, this.eyes.y - fall * TEAR_FALL, this.eyes.z - fall * 0.04);
      // Swells as it leaves the eye, thins as it runs off the chin.
      tear.scale.setScalar(Math.max(Math.sin(Math.min(fall * 1.3, 1) * Math.PI), 0.001));
    });
  }
}
