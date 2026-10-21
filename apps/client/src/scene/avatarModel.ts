/**
 * The blocky body every occupant is drawn as: boxes on a rig of pivots, built
 * here rather than downloaded, and stamped out once per occupant.
 *
 * One template serves the whole office. Its pivots are `THREE.Bone`s, so the
 * seat placement (`avatarSeat.ts`) and the clip set (`avatarClips.ts`) find
 * them by name exactly as they would on a loaded skeleton. Each body is a
 * clone: pivots of its own, the template's ten box geometries shared, and one
 * material whose small pixel-art texture is painted from the occupant's name
 * (`avatarSkin.ts`). Ten boxes are ten draw calls a body, and nothing here is
 * allocated per frame.
 *
 * Sizes are counted in texture pixels, {@link PX} metres each, so every face
 * of every box shows its pixels square: legs twelve tall, the torso twelve, the
 * head eight, which stands a body exactly {@link OCCUPANT_HEIGHT} tall. The rig
 * faces -Z, which is where yaw 0 looks.
 *
 * The local player's body is a lighter copy of its own colours, so you can
 * spot yourself; what tells the kinds apart is the shirt (see `avatarSkin.ts`).
 */

import { DESK_CHAIR, OCCUPANT_HEIGHT } from "@sim/shared";
import * as THREE from "three";

import { type AvatarClips, buildAvatarClips, sourceSeatedClip } from "./avatarClips.js";
import { measureSeatPlacement } from "./avatarSeat.js";
import {
  type AvatarLook,
  type BoxFace,
  type BoxNet,
  NET,
  SKIN_HEIGHT,
  SKIN_WIDTH,
  avatarPalette,
  faceRect,
  paintSkin,
} from "./avatarSkin.js";

/** Metres per texture pixel: a body is 32 of them from the floor to its crown. */
export const PX = OCCUPANT_HEIGHT / 32;

/** From the hip pivot to the sole: both leg segments. */
export const LEG_LENGTH = 12 * PX;

/** From the head pivot, at the neck, up to the eyes, which sit four pixels under the crown. */
export const EYE_ABOVE_HEAD = 3.5 * PX;

/** How much brighter the local player's own body is, so you can spot yourself. */
const LOCAL_BODY_BRIGHTNESS = 1.35;

/** One pivot of the rig, and the box hung off it, in pixels. */
interface RigPart {
  readonly bone: string;
  readonly parent: string | undefined;
  /** Where the pivot sits in its parent. */
  readonly at: readonly [number, number, number];
  /** The box it carries, and the box's centre from the pivot; absent on a bare pivot. */
  readonly box?: { readonly net: BoxNet; readonly centre: readonly [number, number, number] };
}

const HANGING = [0, -3, 0] as const;

/**
 * The rig. The torso, head, arms and thighs all hang from `Body`, which pivots
 * at the hips, so leaning it in at a desk carries the whole upper body; the
 * limbs pivot at the shoulder, elbow, hip and knee and hang straight down.
 */
const RIG: readonly RigPart[] = [
  { bone: "Hips", parent: undefined, at: [0, 12, 0] },
  { bone: "Body", parent: "Hips", at: [0, 0, 0], box: { net: NET.torso, centre: [0, 6, 0] } },
  { bone: "Head", parent: "Body", at: [0, 12, 0], box: { net: NET.head, centre: [0, 4, 0] } },
  { bone: "UpperArmR", parent: "Body", at: [5.5, 12, 0], box: { net: NET.upperArm, centre: HANGING } },
  { bone: "LowerArmR", parent: "UpperArmR", at: [0, -6, 0], box: { net: NET.lowerArm, centre: HANGING } },
  { bone: "HandR", parent: "LowerArmR", at: [0, -6, 0] },
  { bone: "UpperArmL", parent: "Body", at: [-5.5, 12, 0], box: { net: NET.upperArm, centre: HANGING } },
  { bone: "LowerArmL", parent: "UpperArmL", at: [0, -6, 0], box: { net: NET.lowerArm, centre: HANGING } },
  { bone: "UpperLegR", parent: "Body", at: [2, 0, 0], box: { net: NET.upperLeg, centre: HANGING } },
  { bone: "LowerLegR", parent: "UpperLegR", at: [0, -6, 0], box: { net: NET.lowerLeg, centre: HANGING } },
  { bone: "UpperLegL", parent: "Body", at: [-2, 0, 0], box: { net: NET.upperLeg, centre: HANGING } },
  { bone: "LowerLegL", parent: "UpperLegL", at: [0, -6, 0], box: { net: NET.lowerLeg, centre: HANGING } },
];

/** `BoxGeometry`'s faces in the order it builds them: +X, -X, +Y, -Y, +Z, -Z. */
const BOX_FACES: readonly BoxFace[] = ["right", "left", "top", "bottom", "back", "front"];

/** A box the size of `net`, its faces mapped onto the net's place in the texture. */
function boxGeometry(net: BoxNet): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(net.w * PX, net.h * PX, net.d * PX);
  const uv = geometry.getAttribute("uv");
  BOX_FACES.forEach((face, index) => {
    const rect = faceRect(net, face);
    for (let corner = index * 4; corner < index * 4 + 4; corner += 1) {
      // The texture's rows are uploaded top row first, so its top is at v = 0.
      uv.setXY(
        corner,
        (rect.x + uv.getX(corner) * rect.w) / SKIN_WIDTH,
        (rect.y + (1 - uv.getY(corner)) * rect.h) / SKIN_HEIGHT,
      );
    }
  });
  return geometry;
}

/** Builds the rig in its rest pose: standing, arms down, on the floor at the origin. */
export function buildAvatarRig(): THREE.Group {
  const body = new THREE.Group();
  body.name = "avatar-body";
  const geometries = new Map<BoxNet, THREE.BoxGeometry>();
  const bones = new Map<string, THREE.Bone>();

  for (const part of RIG) {
    const bone = new THREE.Bone();
    bone.name = part.bone;
    bone.position.set(part.at[0] * PX, part.at[1] * PX, part.at[2] * PX);
    (part.parent === undefined ? body : bones.get(part.parent))?.add(bone);
    bones.set(part.bone, bone);
    if (part.box !== undefined) {
      let geometry = geometries.get(part.box.net);
      if (geometry === undefined) {
        geometry = boxGeometry(part.box.net);
        geometries.set(part.box.net, geometry);
      }
      const mesh = new THREE.Mesh(geometry);
      mesh.position.set(part.box.centre[0] * PX, part.box.centre[1] * PX, part.box.centre[2] * PX);
      bone.add(mesh);
    }
  }
  return body;
}

/**
 * One loop of the walk at playback rate 1, in seconds: a stride of each leg.
 * A stroll; the animator plays it about twice as fast at walking speed.
 */
export const WALK_PERIOD_SECONDS = 1.1;

/** How far each leg and arm swings forward and back of straight down in the walk, in radians. */
export const WALK_LEG_SWING = 0.75;
export const WALK_ARM_SWING = 0.6;

/**
 * Ground the walk covers at playback rate 1, in metres per second.
 *
 * A straight leg swung `WALK_LEG_SWING` either side of plumb moves its sole
 * `2 * LEG_LENGTH * sin(WALK_LEG_SWING)` between the front and the back of its
 * stride, and the planted foot makes that trip in half a loop. Played at
 * `speed / this`, the planted foot keeps pace with the floor.
 */
export const WALK_CLIP_GROUND_SPEED = (4 * LEG_LENGTH * Math.sin(WALK_LEG_SWING)) / WALK_PERIOD_SECONDS;

/** How far forward each limb is swung `seconds` into the walk, in radians; negative is back. */
export interface WalkSwing {
  readonly legR: number;
  readonly legL: number;
  readonly armR: number;
  readonly armL: number;
}

/**
 * The walk's limbs at a moment of it: the legs swing opposite each other, and
 * each arm opposite the leg on its own side, the way people counter a stride.
 */
export function walkSwing(seconds: number): WalkSwing {
  const phase = Math.sin((seconds / WALK_PERIOD_SECONDS) * Math.PI * 2);
  return {
    legR: WALK_LEG_SWING * phase,
    legL: -WALK_LEG_SWING * phase,
    armR: -WALK_ARM_SWING * phase,
    armL: WALK_ARM_SWING * phase,
  };
}

/** One loop of the idle sway, in seconds, and how far the arms drift out from the sides. */
const IDLE_PERIOD_SECONDS = 3;
const IDLE_ARM_OUT = 0.05;
const IDLE_ARM_DRIFT = 0.03;

/** The sit-down: how long it takes, and where the limbs end up, in radians forward. */
const SIT_SECONDS = 0.4;
const SEATED_UPPER_ARM = 0.2;
const SEATED_LOWER_ARM = 0.15;

/** A limb swung forward is a turn about +X: the rig faces -Z, so a hanging limb's end goes forward. */
const FORWARD = new THREE.Vector3(1, 0, 0);
/** A turn about +Z takes a hanging limb's end toward +X, which is the body's right. */
const OUTWARD = new THREE.Vector3(0, 0, 1);

/** Keyframes spread over one loop, both ends included so it closes. */
function loopTimes(period: number, keyframes: number): number[] {
  return Array.from({ length: keyframes + 1 }, (_unused, index) => (index * period) / keyframes);
}

/** A rotation channel: `bone` turned about `axis` by each angle in turn. */
function turnTrack(bone: string, axis: THREE.Vector3, times: readonly number[], angles: readonly number[]): THREE.QuaternionKeyframeTrack {
  const turn = new THREE.Quaternion();
  const values = angles.flatMap((angle) => turn.setFromAxisAngle(axis, angle).toArray());
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [...times], values);
}

/**
 * The rig's own clips, named as `avatarClips.ts` expects an asset's: `Idle`
 * and `Walking` loop, `Sitting` is the one-shot sit-down that ends in the
 * seated pose the typing clip is derived from.
 */
export function avatarSourceClips(): THREE.AnimationClip[] {
  const walkTimes = loopTimes(WALK_PERIOD_SECONDS, 16);
  const swings = walkTimes.map(walkSwing);
  const walking = new THREE.AnimationClip("Walking", WALK_PERIOD_SECONDS, [
    turnTrack("UpperLegR", FORWARD, walkTimes, swings.map((swing) => swing.legR)),
    turnTrack("UpperLegL", FORWARD, walkTimes, swings.map((swing) => swing.legL)),
    turnTrack("UpperArmR", FORWARD, walkTimes, swings.map((swing) => swing.armR)),
    turnTrack("UpperArmL", FORWARD, walkTimes, swings.map((swing) => swing.armL)),
  ]);

  const idleTimes = loopTimes(IDLE_PERIOD_SECONDS, 12);
  const drift = idleTimes.map(
    (time) => IDLE_ARM_OUT + IDLE_ARM_DRIFT * Math.sin((time / IDLE_PERIOD_SECONDS) * Math.PI * 2),
  );
  const idle = new THREE.AnimationClip("Idle", IDLE_PERIOD_SECONDS, [
    turnTrack("UpperArmR", OUTWARD, idleTimes, drift),
    turnTrack("UpperArmL", OUTWARD, idleTimes, drift.map((angle) => -angle)),
  ]);

  const sitTimes = [0, SIT_SECONDS];
  const sitting = new THREE.AnimationClip("Sitting", SIT_SECONDS, [
    // Held still, but present: the seat placement leans the body in on this channel.
    turnTrack("Body", FORWARD, sitTimes, [0, 0]),
    turnTrack("UpperLegR", FORWARD, sitTimes, [0, Math.PI / 2]),
    turnTrack("UpperLegL", FORWARD, sitTimes, [0, Math.PI / 2]),
    turnTrack("LowerLegR", FORWARD, sitTimes, [0, -Math.PI / 2]),
    turnTrack("LowerLegL", FORWARD, sitTimes, [0, -Math.PI / 2]),
    turnTrack("UpperArmR", FORWARD, sitTimes, [0, SEATED_UPPER_ARM]),
    turnTrack("UpperArmL", FORWARD, sitTimes, [0, SEATED_UPPER_ARM]),
    turnTrack("LowerArmR", FORWARD, sitTimes, [0, SEATED_LOWER_ARM]),
    turnTrack("LowerArmL", FORWARD, sitTimes, [0, SEATED_LOWER_ARM]),
  ]);

  return [idle, walking, sitting];
}

/** A body ready to be added to an avatar's group, with the clips that drive it. */
export interface AvatarModelInstance {
  readonly root: THREE.Object3D;
  readonly clips: AvatarClips;
  /** How far the crown sits below a standing one's once seated in a chair. */
  readonly seatedHeadDrop: number;
  /** Repaints the body for a new name, in place. */
  setIdentity: (identity: string) => void;
  /** Releases only what this instance owns; the shared template is untouched. */
  dispose: () => void;
}

export interface AvatarModel {
  createInstance: (look: AvatarLook, identity: string) => AvatarModelInstance;
}

/** Builds the template, its clips and its seat placement, once for the page. */
export function createAvatarModel(): AvatarModel {
  const template = buildAvatarRig();
  const source = avatarSourceClips();
  const seat = measureSeatPlacement(template, sourceSeatedClip(source), DESK_CHAIR);
  const clips = buildAvatarClips(template, source, seat);

  return {
    createInstance: (look: AvatarLook, identity: string): AvatarModelInstance => {
      const root = template.clone();
      const pixels = new Uint8Array(SKIN_WIDTH * SKIN_HEIGHT * 4);
      paintSkin(avatarPalette(look, identity), pixels);
      const texture = new THREE.DataTexture(pixels, SKIN_WIDTH, SKIN_HEIGHT);
      texture.colorSpace = THREE.SRGBColorSpace;
      // Square pixels up close: the texture is a few dozen pixels across.
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.needsUpdate = true;
      const material = new THREE.MeshLambertMaterial({ map: texture });
      if (look === "local") {
        material.color.setScalar(LOCAL_BODY_BRIGHTNESS);
      }
      root.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.material = material;
        }
      });

      return {
        root,
        clips,
        seatedHeadDrop: seat.headDrop,
        setIdentity: (next) => {
          paintSkin(avatarPalette(look, next), pixels);
          texture.needsUpdate = true;
        },
        dispose: () => {
          root.removeFromParent();
          material.dispose();
          texture.dispose();
        },
      };
    },
  };
}
