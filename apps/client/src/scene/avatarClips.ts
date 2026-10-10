/**
 * The avatar's animation clips: one per replicated animation state, all of them
 * blendable against each other.
 *
 * The shipped model's clips were authored independently, which costs two pieces
 * of work before they can be cross-faded:
 *
 * - **A clip per state.** The asset has no typing clip, so one is derived here
 *   from the seated pose. `sitting` is therefore a hard requirement of the
 *   asset and `typing` is not.
 * - **A common track set.** `Idle` drives nine channels and `Walking`
 *   twenty-two. A cross-fade only moves the channels the incoming clip actually
 *   drives, so a bone the outgoing clip animated and the incoming one does not
 *   is abandoned wherever the fade left it — arms frozen mid-stride the moment a
 *   player stops walking. Every clip is padded with a constant track, holding
 *   the model's bind-pose value, for each channel any other clip drives.
 *
 * The clip and bone names below are the only two facts about the specific asset
 * that reach the code; see `public/models/ATTRIBUTION.md`.
 */

import { ANIMATION_STATE, type AnimationState } from "@sim/shared";
import * as THREE from "three";

/** A clip for every state the replicated `animation` field can carry. */
export type AvatarClips = Readonly<Record<AnimationState, THREE.AnimationClip>>;

/** Which clip in the asset each state plays, where the asset has one. */
const CLIP_FOR_STATE = {
  [ANIMATION_STATE.idle]: "Idle",
  [ANIMATION_STATE.walking]: "Walking",
  [ANIMATION_STATE.sitting]: "Sitting",
} as const;

/** Name given to the derived clip, so it is recognisable in a debugger. */
const TYPING_CLIP_NAME = "Typing";

/** One loop of the derived typing clip: a little under three keystrokes a second. */
const TYPING_PERIOD_SECONDS = 0.36;

/**
 * Keyframes in one typing loop. Enough that the wrists read as moving
 * continuously rather than stepping between two poses.
 */
const TYPING_KEYFRAMES = 8;

/**
 * Elbow bend, in radians, that lifts the seated forearms to about desk height.
 *
 * Open-loop: the hands land where the rig puts them rather than on a surface.
 * Placing them on an actual desk needs inverse kinematics, which this milestone
 * does not have.
 */
const TYPING_ELBOW_BEND = 1;

/** How far the elbow travels per keystroke, in radians. */
const TYPING_ELBOW_TRAVEL = 0.07;

/**
 * Bone-local axis the elbow bends about.
 *
 * Found by measurement, not convention: rotating a forearm bone about its local
 * X is the only one of the three axes that moves the hand, and it moves it
 * upward.
 */
const ELBOW_AXIS = new THREE.Vector3(1, 0, 0);

/** The two bones the typing loop drives, and the phase each one types on. */
const TYPING_ELBOWS: readonly { readonly bone: string; readonly phase: number }[] = [
  { bone: "LowerArmL", phase: 0 },
  { bone: "LowerArmR", phase: Math.PI },
];

/**
 * A keyframe track's constructor, which `KeyframeTrack` does not expose.
 *
 * Padding a clip has to produce a track of the same kind as the one it stands in
 * for — quaternion channels must be slerped, not lerped — and the only handle on
 * that kind is the class of a track that already drives the channel.
 */
type KeyframeTrackConstructor = new (
  name: string,
  times: readonly number[],
  values: readonly number[],
) => THREE.KeyframeTrack;

/**
 * Builds the clip set the animator plays.
 *
 * @param model the loaded model, in its bind pose, read for the values padded
 * tracks hold.
 * @param source every clip the asset carries.
 * @throws if the asset is missing a clip that cannot be derived from another.
 */
export function buildAvatarClips(
  model: THREE.Object3D,
  source: readonly THREE.AnimationClip[],
): AvatarClips {
  const byName = new Map(source.map((clip) => [clip.name, clip]));
  const seated = requireClip(byName, CLIP_FOR_STATE[ANIMATION_STATE.sitting]);

  return padToCommonTracks(model, {
    [ANIMATION_STATE.idle]: requireClip(byName, CLIP_FOR_STATE[ANIMATION_STATE.idle]),
    [ANIMATION_STATE.walking]: requireClip(byName, CLIP_FOR_STATE[ANIMATION_STATE.walking]),
    [ANIMATION_STATE.sitting]: seated,
    [ANIMATION_STATE.typing]: deriveTypingClip(seated),
  });
}

function requireClip(
  byName: ReadonlyMap<string, THREE.AnimationClip>,
  name: string,
): THREE.AnimationClip {
  const clip = byName.get(name);
  if (clip === undefined) {
    throw new Error(`the avatar model has no "${name}" animation clip`);
  }
  return clip;
}

/**
 * Derives a looping typing clip from the sit-down transition.
 *
 * The seated pose is the last keyframe of that transition, so every channel is
 * held at its value there and the two forearms are given a keystroke
 * oscillation on top. Building the clip over the same channels the seated pose
 * drives is what makes `sitting -> typing` free of movement anywhere but the
 * arms.
 */
function deriveTypingClip(seated: THREE.AnimationClip): THREE.AnimationClip {
  const times = Array.from(
    { length: TYPING_KEYFRAMES + 1 },
    (_unused, index) => (index * TYPING_PERIOD_SECONDS) / TYPING_KEYFRAMES,
  );

  const tracks = seated.tracks.map((track) => {
    const elbow = TYPING_ELBOWS.find((candidate) => track.name === `${candidate.bone}.quaternion`);
    const held = lastKeyframe(track);
    if (elbow === undefined) {
      return constantTrack(track, track.name, held, TYPING_PERIOD_SECONDS);
    }
    return new THREE.QuaternionKeyframeTrack(track.name, times, keystrokeValues(held, times, elbow.phase));
  });

  return new THREE.AnimationClip(TYPING_CLIP_NAME, TYPING_PERIOD_SECONDS, tracks);
}

/** The forearm rotation for each keyframe of one typing loop. */
function keystrokeValues(
  seatedRotation: readonly number[],
  times: readonly number[],
  phase: number,
): number[] {
  const base = new THREE.Quaternion().fromArray([...seatedRotation]);
  const bend = new THREE.Quaternion();
  const posed = new THREE.Quaternion();
  const values: number[] = [];

  for (const time of times) {
    const cycle = (time / TYPING_PERIOD_SECONDS) * Math.PI * 2;
    const angle = TYPING_ELBOW_BEND + TYPING_ELBOW_TRAVEL * Math.sin(cycle + phase);
    bend.setFromAxisAngle(ELBOW_AXIS, angle);
    posed.copy(base).multiply(bend);
    values.push(posed.x, posed.y, posed.z, posed.w);
  }

  return values;
}

/**
 * Pads every clip out to the union of the channels they drive between them.
 *
 * @see the module comment for why a clip that leaves a channel alone has to say
 * so explicitly rather than simply omit it.
 */
function padToCommonTracks(
  model: THREE.Object3D,
  clips: Record<AnimationState, THREE.AnimationClip>,
): AvatarClips {
  const channels = new Map<string, { prototype: THREE.KeyframeTrack; rest: readonly number[] }>();
  for (const clip of Object.values(clips)) {
    for (const track of clip.tracks) {
      if (!channels.has(track.name)) {
        channels.set(track.name, { prototype: track, rest: bindPoseValue(model, track) });
      }
    }
  }

  const padded: Partial<Record<AnimationState, THREE.AnimationClip>> = {};
  for (const [state, clip] of entriesOf(clips)) {
    const driven = new Set(clip.tracks.map((track) => track.name));
    const extra: THREE.KeyframeTrack[] = [];
    for (const [name, channel] of channels) {
      if (!driven.has(name)) {
        extra.push(constantTrack(channel.prototype, name, channel.rest, clip.duration));
      }
    }
    padded[state] =
      extra.length === 0
        ? clip
        : new THREE.AnimationClip(clip.name, clip.duration, [...clip.tracks, ...extra]);
  }

  return padded as AvatarClips;
}

/** The value a channel holds in the model's bind pose. */
function bindPoseValue(model: THREE.Object3D, track: THREE.KeyframeTrack): readonly number[] {
  const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
  const node = model.getObjectByName(nodeName);
  if (node !== undefined) {
    switch (propertyName) {
      case "quaternion":
        return node.quaternion.toArray();
      case "position":
        return node.position.toArray();
      case "scale":
        return node.scale.toArray();
      default:
        break;
    }
  }
  // Morph target influences and anything else unrecognised rest at zero, which
  // for this model's three facial expressions is the neutral face.
  return new Array<number>(track.getValueSize()).fill(0);
}

/** A two-keyframe track that holds one value for the whole of `duration`. */
function constantTrack(
  prototype: THREE.KeyframeTrack,
  name: string,
  value: readonly number[],
  duration: number,
): THREE.KeyframeTrack {
  const Track = prototype.constructor as KeyframeTrackConstructor;
  // Three.js rejects a track whose keyframe times do not ascend, and a padded
  // clip is only ever as long as the clip it pads.
  const end = duration > 0 ? duration : Number.EPSILON;
  return new Track(name, [0, end], [...value, ...value]);
}

/** The last keyframe of a track, which for a transition clip is its end pose. */
function lastKeyframe(track: THREE.KeyframeTrack): readonly number[] {
  const stride = track.getValueSize();
  const values = track.values;
  return Array.from(values.slice(values.length - stride));
}

/** `Object.entries`, with the key type the record was declared with. */
function entriesOf(
  clips: Record<AnimationState, THREE.AnimationClip>,
): readonly [AnimationState, THREE.AnimationClip][] {
  return Object.entries(clips) as [AnimationState, THREE.AnimationClip][];
}
