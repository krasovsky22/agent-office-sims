/**
 * The clip set, against a stand-in rig rather than the shipped asset.
 *
 * What is being pinned is the contract {@link buildAvatarClips} owes the
 * animator: a clip for every replicated state, and every clip driving the same
 * channels so that cross-fading between any two of them cannot abandon a bone.
 * Using a fabricated rig keeps the test about that contract instead of about the
 * particular clips one downloaded file happens to contain.
 */

import { ANIMATION_STATE } from "@sim/shared";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildAvatarClips } from "./avatarClips.js";

const BONES = ["Body", "Head", "UpperArmL", "LowerArmL", "LowerArmR", "UpperLegL"] as const;

/** A distinctive bind-pose rotation, so a padded track can be told apart. */
const BIND_ROTATION = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);

/** Bind-pose position of every stand-in bone. */
const BIND_POSITION: readonly number[] = [0, 1, 0];

function rig(): THREE.Object3D {
  const root = new THREE.Object3D();
  for (const name of BONES) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.quaternion.copy(BIND_ROTATION);
    bone.position.fromArray([...BIND_POSITION]);
    root.add(bone);
  }
  return root;
}

function spin(bone: string, duration: number): THREE.QuaternionKeyframeTrack {
  const start = new THREE.Quaternion();
  const end = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1);
  return new THREE.QuaternionKeyframeTrack(
    `${bone}.quaternion`,
    [0, duration],
    [...start.toArray(), ...end.toArray()],
  );
}

function bob(bone: string, duration: number): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(`${bone}.position`, [0, duration], [0, 1, 0, 0, 1.2, 0]);
}

/**
 * A morph channel, aimed at a node the stand-in rig deliberately does not have.
 *
 * The shipped asset animates facial expressions on meshes rather than bones, and
 * a channel whose node cannot be resolved still has to be padded with
 * *something* the mixer can blend.
 */
function expression(duration: number): THREE.NumberKeyframeTrack {
  return new THREE.NumberKeyframeTrack(
    "Face.morphTargetInfluences",
    [0, duration],
    [0, 0.5, 1, 0],
  );
}

/** Clips shaped like the asset's: one long loop, one busy loop, one transition. */
function sourceClips(): THREE.AnimationClip[] {
  return [
    new THREE.AnimationClip("Idle", 3, [spin("Head", 3), bob("Body", 3)]),
    new THREE.AnimationClip("Walking", 1, [
      spin("Head", 1),
      spin("UpperArmL", 1),
      spin("UpperLegL", 1),
      bob("Body", 1),
      expression(1),
    ]),
    new THREE.AnimationClip("Sitting", 0.4, [
      spin("LowerArmL", 0.4),
      spin("LowerArmR", 0.4),
      bob("Body", 0.4),
    ]),
  ];
}

/** The channels the clips above drive between them. */
const ALL_CHANNELS: readonly string[] = [
  "Body.position",
  "Face.morphTargetInfluences",
  "Head.quaternion",
  "LowerArmL.quaternion",
  "LowerArmR.quaternion",
  "UpperArmL.quaternion",
  "UpperLegL.quaternion",
];

function trackNames(clip: THREE.AnimationClip): string[] {
  return clip.tracks.map((track) => track.name).sort();
}

function trackOf(clip: THREE.AnimationClip, name: string): THREE.KeyframeTrack {
  const track = clip.tracks.find((candidate) => candidate.name === name);
  if (track === undefined) {
    throw new Error(`${clip.name} has no ${name} track`);
  }
  return track;
}

function valuesOf(track: THREE.KeyframeTrack): number[] {
  return Array.from(track.values);
}

/**
 * Keyframe values are stored as float32, so they come back a few bits off
 * whatever float64 went in. Nothing here is checking arithmetic to the bit.
 */
const PLACES = 6;

function expectValues(track: THREE.KeyframeTrack, expected: readonly number[]): void {
  const actual = valuesOf(track);
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i] ?? Number.NaN, PLACES);
  }
}

/** The last keyframe of a track, which for a transition clip is its end pose. */
function endPoseOf(track: THREE.KeyframeTrack): number[] {
  const stride = track.getValueSize();
  return valuesOf(track).slice(-stride);
}

describe("buildAvatarClips", () => {
  it("returns a clip for every state the replicated field can carry", () => {
    const clips = buildAvatarClips(rig(), sourceClips());
    for (const state of Object.values(ANIMATION_STATE)) {
      expect(clips[state].duration).toBeGreaterThan(0);
    }
  });

  it("gives every clip the same channels, so a fade cannot abandon a bone", () => {
    const clips = buildAvatarClips(rig(), sourceClips());
    for (const state of Object.values(ANIMATION_STATE)) {
      expect(trackNames(clips[state])).toEqual([...ALL_CHANNELS]);
    }
  });

  it("holds a padded rotation at the model's bind pose", () => {
    const clips = buildAvatarClips(rig(), sourceClips());
    // Nothing drives the left upper arm while idling, so idling has to say so.
    const padded = trackOf(clips[ANIMATION_STATE.idle], "UpperArmL.quaternion");
    expect(padded).toBeInstanceOf(THREE.QuaternionKeyframeTrack);
    expectValues(padded, [...BIND_ROTATION.toArray(), ...BIND_ROTATION.toArray()]);
    expect(padded.times[padded.times.length - 1]).toBeCloseTo(
      clips[ANIMATION_STATE.idle].duration,
      10,
    );
  });

  it("pads a position channel as a vector track, not a number one", () => {
    const sources = sourceClips().filter((clip) => clip.name !== "Idle");
    sources.push(new THREE.AnimationClip("Idle", 3, [spin("Head", 3)]));
    const clips = buildAvatarClips(rig(), sources);
    const padded = trackOf(clips[ANIMATION_STATE.idle], "Body.position");
    expect(padded).toBeInstanceOf(THREE.VectorKeyframeTrack);
    expectValues(padded, [...BIND_POSITION, ...BIND_POSITION]);
  });

  it("rests a channel whose node it cannot find at zero", () => {
    const clips = buildAvatarClips(rig(), sourceClips());
    const padded = trackOf(clips[ANIMATION_STATE.sitting], "Face.morphTargetInfluences");
    expect(padded).toBeInstanceOf(THREE.NumberKeyframeTrack);
    // Two influences per keyframe, held across two keyframes.
    expectValues(padded, [0, 0, 0, 0]);
  });

  it("derives a looping typing clip the seated pose can slide into", () => {
    const clips = buildAvatarClips(rig(), sourceClips());
    const typing = clips[ANIMATION_STATE.typing];

    // The forearms move over several keyframes rather than between two poses.
    expect(trackOf(typing, "LowerArmL.quaternion").times.length).toBeGreaterThan(2);

    // Everything else holds the pose the sit-down transition ended on, which is
    // what makes sitting -> typing move only the arms.
    const seatedBody = endPoseOf(trackOf(clips[ANIMATION_STATE.sitting], "Body.position"));
    expect(seatedBody[1]).toBeCloseTo(1.2, PLACES);
    expectValues(trackOf(typing, "Body.position"), [...seatedBody, ...seatedBody]);
  });

  it("moves the two forearms out of phase with each other", () => {
    const clips = buildAvatarClips(rig(), sourceClips());
    const typing = clips[ANIMATION_STATE.typing];
    const left = trackOf(typing, "LowerArmL.quaternion");
    const right = trackOf(typing, "LowerArmR.quaternion");

    // A quarter of the way through the loop one wrist is at the bottom of its
    // travel and the other at the top. At the start of the loop they coincide,
    // which is why that is not the keyframe to compare.
    const quarter = Math.floor((left.times.length - 1) / 4) * 4;
    expect(quarter).toBeGreaterThan(0);
    expect(valuesOf(left).slice(quarter, quarter + 4)).not.toEqual(
      valuesOf(right).slice(quarter, quarter + 4),
    );
  });

  it("returns the forearms to where they started, so the loop does not jump", () => {
    const clips = buildAvatarClips(rig(), sourceClips());
    const elbow = trackOf(clips[ANIMATION_STATE.typing], "LowerArmL.quaternion");
    const values = valuesOf(elbow);
    for (let i = 0; i < 4; i += 1) {
      expect(values[values.length - 4 + i]).toBeCloseTo(values[i] ?? Number.NaN, 10);
    }
  });

  it("names the clip it could not find when the asset is missing one", () => {
    const incomplete = sourceClips().filter((clip) => clip.name !== "Walking");
    expect(() => buildAvatarClips(rig(), incomplete)).toThrow(/Walking/);
  });

  it("refuses an asset with no seated pose, which typing is derived from", () => {
    const incomplete = sourceClips().filter((clip) => clip.name !== "Sitting");
    expect(() => buildAvatarClips(rig(), incomplete)).toThrow(/Sitting/);
  });
});
