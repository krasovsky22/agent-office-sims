/**
 * The seated avatar sits on the chair the shared layout describes.
 *
 * This is the regression test for a body sitting on the floor through its own
 * chair, so unlike `avatarClips.test.ts` it uses the real rig: what has to hold
 * is a fact about the body's seated pose and the shared {@link DESK_CHAIR}, and
 * a stand-in rig would only prove the arithmetic. The model is prepared exactly
 * as the renderer prepares it.
 */

import { ANIMATION_STATE, DESK_CHAIR } from "@sim/shared";
import * as THREE from "three";
import { beforeAll, describe, expect, it } from "vitest";

import { type AvatarClips, buildAvatarClips, sourceSeatedClip } from "./avatarClips.js";
import { avatarSourceClips, buildAvatarRig } from "./avatarModel.js";
import { type SeatPlacement, measurePose, measureSeatPlacement } from "./avatarSeat.js";

/** A millimetre: well inside anything visible, well outside float noise. */
const TOLERANCE = 1e-3;

let template: THREE.Object3D;
let source: THREE.AnimationClip[];
let seat: SeatPlacement;
let clips: AvatarClips;

beforeAll(() => {
  template = buildAvatarRig();
  source = avatarSourceClips();
  seat = measureSeatPlacement(template, sourceSeatedClip(source), DESK_CHAIR);
  clips = buildAvatarClips(template, source, seat);
});

describe("the seated pose", () => {
  for (const state of [ANIMATION_STATE.sitting, ANIMATION_STATE.typing]) {
    it(`rests ${state} on the shared seat height and against the backrest`, () => {
      // Measured again once placed, the pose has nowhere left to go: its seat
      // is the cushion and nothing level with the backrest is behind it.
      const placed = measurePose(template, clips[state], DESK_CHAIR);
      expect(Math.abs(placed.lift)).toBeLessThan(TOLERANCE);
      expect(Math.abs(placed.forward)).toBeLessThan(TOLERANCE);
    });
  }

  it("follows the shared seat height rather than a number of its own", () => {
    const taller = { ...DESK_CHAIR, seatHeight: DESK_CHAIR.seatHeight + 0.1 };
    const raised = measureSeatPlacement(template, sourceSeatedClip(source), taller);
    expect(raised.lift - seat.lift).toBeCloseTo(0.1, 6);

    // And a clip placed for one chair is a tenth of a metre short of the other.
    expect(measurePose(template, clips[ANIMATION_STATE.sitting], taller).lift).toBeCloseTo(0.1, 3);
  });

  it("leaves the standing states on the floor, so standing up drops the lift", () => {
    for (const state of [ANIMATION_STATE.idle, ANIMATION_STATE.walking]) {
      const root = clips[state].tracks.find((track) => track.name.endsWith(".position") && isRoot(track));
      expect(root, state).toBeDefined();
      const bind = template.getObjectByName(root?.name.split(".")[0] ?? "")?.position;
      expect(bind, state).toBeDefined();
      // Every keyframe holds the bind position, so blending back to a standing
      // state takes the lift and the forward shift away with the seated pose.
      const values = Array.from(root?.values ?? []);
      values.forEach((value, index) => {
        expect(value, `${state}[${index}]`).toBeCloseTo(bind?.getComponent(index % 3) ?? Number.NaN, 6);
      });
    }
  });
});

/** Whether a track drives the skeleton's topmost bone. */
function isRoot(track: THREE.KeyframeTrack): boolean {
  const node = template.getObjectByName(track.name.split(".")[0] ?? "");
  return node instanceof THREE.Bone && !(node.parent instanceof THREE.Bone);
}
