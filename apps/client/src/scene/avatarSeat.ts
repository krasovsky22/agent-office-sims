/**
 * Putting the seated humanoid on the chair rather than on the floor.
 *
 * The asset's `Sitting` clip is authored for a body sitting at the height of its
 * own short legs, with the root left on the floor: played as shipped, the thighs
 * end up a fifth of a metre inside the office chair's cushion and the back
 * straddles its backrest. Two facts fix that, and neither is written down here:
 *
 * - **Where the chair is** comes from {@link ChairSpec}, the shared record the
 *   chair prop is fitted to.
 * - **Where the seated body is** is measured off the model, posed at the end of
 *   the clip, the same way `avatarModel.ts` reads the standing height off the
 *   model's bounds instead of trusting a number.
 *
 * The difference is baked into the clip as a track on the skeleton's root bone,
 * which no clip in the asset drives, together with a slight lean in toward the
 * desk that keeps the asset's oversized head clear of the backrest. Being part of the clip is what makes it
 * free of pops: the animator cross-fades it in with the rest of the seated pose
 * as the occupant sits down and out again as they stand, and the typing clip,
 * derived from the seated pose, inherits it.
 *
 * The clip and bone names below are, like those in `avatarClips.ts`, facts about
 * the specific asset; see `public/models/ATTRIBUTION.md`.
 */

import type { ChairSpec } from "@sim/shared";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

/**
 * The bones whose geometry rests on the cushion: the two thighs and the body
 * the torso hangs from. Whichever reaches lowest in the seated pose is what
 * sits on the seat.
 */
const SEAT_BONES: readonly string[] = ["UpperLegL", "UpperLegR", "Body"];

/**
 * How far the seated pose leans in toward the desk, in radians, and the bones
 * that lean.
 *
 * The asset's head is nearly a metre deep and hangs well behind the torso, so
 * sat bolt upright with its back to the backrest the head would bury the top of
 * the chair. Leaning the body in brings the head forward of the backrest while
 * the small of the back stays against it — the posture of someone working at a
 * screen. The torso, arms and head all hang from `Body`; the thighs hang from it
 * too, and are turned back by the same amount so they stay along the seat.
 */
const SEATED_LEAN = 0.25;
const LEAN_BONE = "Body";
const THIGHS: readonly string[] = ["UpperLegL", "UpperLegR"];

/** How the seated body is moved onto the chair, in the avatar's own frame. */
export interface SeatPlacement {
  /** How far the body is raised so the lowest of {@link SEAT_BONES} meets the cushion. */
  readonly lift: number;
  /** How far forward it is moved so nothing level with the backrest is inside it. */
  readonly forward: number;
  /**
   * How far the crown of the placed seated body is below a standing one's.
   * Negative when sitting on a seat taller than the body's own legs leaves the
   * head higher than standing does.
   */
  readonly headDrop: number;
}

/**
 * Measures how far the asset's seated pose has to move to sit on `chair`, once
 * it is leaning in the way {@link placeOnSeat} leans it.
 *
 * @param model the avatar body in its bind pose, scaled to an occupant's height
 * and turned to face -Z; it is cloned, never posed itself. Distances are in the
 * frame it is placed in, which is the avatar's.
 * @param seated the asset's clip that ends in the seated pose.
 */
export function measureSeatPlacement(
  model: THREE.Object3D,
  seated: THREE.AnimationClip,
  chair: ChairSpec,
): SeatPlacement {
  return measurePose(model, leanIn(model, seated), chair);
}

/**
 * Measures how far the pose a clip ends in is from sitting on `chair`, taking
 * the clip as it is. A clip that already sits on the chair measures zero.
 */
export function measurePose(
  model: THREE.Object3D,
  clip: THREE.AnimationClip,
  chair: ChairSpec,
): SeatPlacement {
  const standingCrown = crownOf(model);

  const posed = cloneSkinned(model);
  holdLastFrame(posed, clip);

  const seatContact = lowestPoint(posed, SEAT_BONES);
  const lift = chair.seatHeight - seatContact;

  // The front of the backrest is the plane nothing between the cushion and the
  // top of the chair may reach behind. The body faces -Z, so behind is +Z.
  let back = Number.NEGATIVE_INFINITY;
  forEachVertex(posed, (point) => {
    const height = point.y + lift;
    if (height > chair.seatHeight && height < chair.height && Math.abs(point.x) < chair.width / 2) {
      back = Math.max(back, point.z);
    }
  });
  const forward = Number.isFinite(back) ? back - chair.backrestOffset : 0;

  return { lift, forward, headDrop: standingCrown - (crownOf(posed) + lift) };
}

/**
 * The seated clip, moved onto the chair.
 *
 * The root bone's offset ramps in over the clip's own length, so the body
 * travels onto the seat while it sits down rather than being lifted before it
 * has bent. The lean is ramped in the same way.
 *
 * @param model the avatar body in its bind pose, read for the root bone's rest
 * position and the frame its offset is expressed in.
 */
export function placeOnSeat(
  model: THREE.Object3D,
  seated: THREE.AnimationClip,
  placement: SeatPlacement,
): THREE.AnimationClip {
  const root = rootBone(model);
  if (root === undefined || root.parent === null) {
    return seated;
  }

  // The offset is measured in the avatar's frame; the track is written in the
  // root bone's parent frame, which in this asset is a Z-up armature scaled by
  // a hundred.
  model.updateMatrixWorld(true);
  const toParent = new THREE.Matrix3().setFromMatrix4(root.parent.matrixWorld).invert();
  const avatarToWorld = new THREE.Matrix3().setFromMatrix4(avatarFrame(model));
  const offset = new THREE.Vector3(0, placement.lift, -placement.forward)
    .applyMatrix3(avatarToWorld)
    .applyMatrix3(toParent);

  const times = keyframeTimes(seated);
  const values: number[] = [];
  for (const time of times) {
    const ramp = seated.duration > 0 ? time / seated.duration : 1;
    values.push(
      root.position.x + offset.x * ramp,
      root.position.y + offset.y * ramp,
      root.position.z + offset.z * ramp,
    );
  }

  const placed = leanIn(model, seated);
  return new THREE.AnimationClip(placed.name, placed.duration, [
    ...placed.tracks,
    new THREE.VectorKeyframeTrack(`${root.name}.position`, times, values),
  ]);
}

/**
 * The clip with the body leaning in by {@link SEATED_LEAN}, ramped in.
 *
 * The lean is a turn about the avatar's own left-right axis, found in the lean
 * bone's frame as the seated pose leaves it, so it tips the body forward
 * whatever way the armature happens to be authored.
 */
function leanIn(model: THREE.Object3D, seated: THREE.AnimationClip): THREE.AnimationClip {
  const posed = cloneSkinned(model);
  holdLastFrame(posed, seated);
  const bone = posed.getObjectByName(LEAN_BONE);
  if (bone === undefined) {
    return seated;
  }
  // Facing -Z, a turn about +X by a negative angle tips the head toward -Z.
  const axis = new THREE.Vector3(1, 0, 0)
    .transformDirection(avatarFrame(posed))
    .applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()).invert());

  const lean = new THREE.Quaternion();
  const rotation = new THREE.Quaternion();
  const tracks = seated.tracks.map((track) => {
    const leans = track.name === `${LEAN_BONE}.quaternion`;
    const counters = THIGHS.some((thigh) => track.name === `${thigh}.quaternion`);
    if (!leans && !counters) {
      return track;
    }
    const values = Array.from(track.values);
    track.times.forEach((time, index) => {
      const ramp = seated.duration > 0 ? time / seated.duration : 1;
      lean.setFromAxisAngle(axis, -SEATED_LEAN * ramp);
      rotation.fromArray(values, index * 4);
      // A child's world turn is its parent's times its own, so turning a thigh
      // by the inverse of its parent's lean leaves it where it was.
      if (leans) {
        rotation.multiply(lean);
      } else {
        rotation.premultiply(lean.invert());
      }
      rotation.toArray(values, index * 4);
    });
    return new THREE.QuaternionKeyframeTrack(track.name, Array.from(track.times), values);
  });
  return new THREE.AnimationClip(seated.name, seated.duration, tracks);
}

/** Every keyframe time any track of the clip uses, ascending. */
function keyframeTimes(clip: THREE.AnimationClip): number[] {
  const times = new Set<number>([0, clip.duration]);
  for (const track of clip.tracks) {
    for (const time of track.times) {
      times.add(time);
    }
  }
  return [...times].sort((a, b) => a - b);
}

/** The topmost bone of the skeleton, the one every other bone hangs from. */
function rootBone(model: THREE.Object3D): THREE.Bone | undefined {
  let found: THREE.Bone | undefined;
  model.traverse((node) => {
    if (found === undefined && node instanceof THREE.Bone && !(node.parent instanceof THREE.Bone)) {
      found = node;
    }
  });
  return found;
}

/** Poses a model at the final frame of a one-shot clip. */
function holdLastFrame(model: THREE.Object3D, clip: THREE.AnimationClip): void {
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(clip.duration);
  model.updateMatrixWorld(true);
}

/** Height of the highest point of a model, in the avatar's frame. */
function crownOf(model: THREE.Object3D): number {
  model.updateMatrixWorld(true);
  let crown = Number.NEGATIVE_INFINITY;
  forEachVertex(model, (point) => {
    crown = Math.max(crown, point.y);
  });
  return crown;
}

/** Height of the lowest point of the geometry attached to any of `bones`. */
function lowestPoint(model: THREE.Object3D, bones: readonly string[]): number {
  let lowest = Number.POSITIVE_INFINITY;
  forEachVertex(model, (point, bone) => {
    if (bone !== undefined && bones.includes(bone.name)) {
      lowest = Math.min(lowest, point.y);
    }
  });
  return lowest;
}

/**
 * The frame an avatar body is placed in: its parent's, which is where its own
 * scale and facing turn have already been applied.
 */
function avatarFrame(model: THREE.Object3D): THREE.Matrix4 {
  return model.parent === null ? new THREE.Matrix4() : model.parent.matrixWorld.clone();
}

/**
 * Visits every vertex of every mesh in a model, posed, in the avatar's frame,
 * with the bone that carries it.
 *
 * A rigid mesh is carried by the nearest bone above it; a skinned vertex by the
 * joint that weighs on it most. The asset uses both: its limbs are rigid meshes
 * hung off bones and its hands are skinned.
 */
function forEachVertex(
  model: THREE.Object3D,
  visit: (point: THREE.Vector3, bone: THREE.Bone | undefined) => void,
): void {
  const toAvatar = avatarFrame(model).invert();
  const point = new THREE.Vector3();
  const local = new THREE.Matrix4();

  model.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    local.multiplyMatrices(toAvatar, node.matrixWorld);
    const geometry = node.geometry as THREE.BufferGeometry;
    const positions = geometry.getAttribute("position");

    if (node instanceof THREE.SkinnedMesh) {
      node.skeleton.update();
      const joints = geometry.getAttribute("skinIndex");
      const weights = geometry.getAttribute("skinWeight");
      for (let index = 0; index < positions.count; index += 1) {
        node.getVertexPosition(index, point).applyMatrix4(local);
        visit(point, node.skeleton.bones[dominantJoint(joints, weights, index)]);
      }
      return;
    }

    const bone = carrier(node);
    for (let index = 0; index < positions.count; index += 1) {
      visit(point.fromBufferAttribute(positions, index).applyMatrix4(local), bone);
    }
  });
}

function dominantJoint(
  joints: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  weights: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
): number {
  let best = 0;
  let joint = joints.getX(index);
  for (let slot = 1; slot < 4; slot += 1) {
    if (weights.getComponent(index, slot) > weights.getComponent(index, best)) {
      best = slot;
      joint = joints.getComponent(index, slot);
    }
  }
  return joint;
}

/** The nearest bone above a node, or `undefined` for one outside the skeleton. */
function carrier(node: THREE.Object3D): THREE.Bone | undefined {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent instanceof THREE.Bone) {
      return parent;
    }
  }
  return undefined;
}
