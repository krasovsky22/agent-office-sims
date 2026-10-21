/**
 * The blocky rig: its size, its walk, and what each body shares with the rest.
 */

import { OCCUPANT_HEIGHT } from "@sim/shared";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  LEG_LENGTH,
  WALK_CLIP_GROUND_SPEED,
  WALK_PERIOD_SECONDS,
  avatarSourceClips,
  buildAvatarRig,
  createAvatarModel,
  walkSwing,
} from "./avatarModel.js";

describe("the rig", () => {
  it("stands an occupant's height tall, on the floor", () => {
    const rig = buildAvatarRig();
    rig.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(rig);
    expect(bounds.min.y).toBeCloseTo(0, 6);
    expect(bounds.max.y).toBeCloseTo(OCCUPANT_HEIGHT, 6);
  });
});

describe("walkSwing", () => {
  it("swings the legs opposite each other, and each arm opposite its own side's leg", () => {
    for (let step = 0; step < 8; step += 1) {
      const swing = walkSwing((step * WALK_PERIOD_SECONDS) / 8);
      expect(swing.legL).toBeCloseTo(-swing.legR, 10);
      expect(swing.armL).toBeCloseTo(-swing.armR, 10);
      expect(Math.sign(swing.armR) * Math.sign(swing.legR)).toBeLessThanOrEqual(0);
    }
  });

  it("ends a loop where it started, so the cycle does not jump", () => {
    const start = walkSwing(0);
    const end = walkSwing(WALK_PERIOD_SECONDS);
    expect(end.legR).toBeCloseTo(start.legR, 10);
    expect(end.armR).toBeCloseTo(start.armR, 10);
  });
});

describe("WALK_CLIP_GROUND_SPEED", () => {
  it("is the ground the planted foot covers on the posed rig", () => {
    // Pose the real rig at both ends of the right leg's stride and read where its sole is.
    const rig = buildAvatarRig();
    const sole = new THREE.Object3D();
    sole.position.y = -(LEG_LENGTH / 2);
    rig.getObjectByName("LowerLegR")?.add(sole);
    const walking = avatarSourceClips().find((clip) => clip.name === "Walking");
    expect(walking).toBeDefined();
    const mixer = new THREE.AnimationMixer(rig);
    mixer.clipAction(walking as THREE.AnimationClip).play();

    const soleAt = (seconds: number) => {
      mixer.setTime(seconds);
      rig.updateMatrixWorld(true);
      return sole.getWorldPosition(new THREE.Vector3());
    };
    const front = soleAt(WALK_PERIOD_SECONDS / 4);
    const back = soleAt((WALK_PERIOD_SECONDS * 3) / 4);
    // Forward is -Z; the planted foot goes from the front of the stride to the back in half a loop.
    expect(front.z).toBeLessThan(back.z);
    expect((back.z - front.z) / (WALK_PERIOD_SECONDS / 2)).toBeCloseTo(WALK_CLIP_GROUND_SPEED, 2);
  });
});

describe("createAvatarModel", () => {
  it("shares the boxes between bodies and gives each its own paint", () => {
    const model = createAvatarModel();
    const meshes = (root: THREE.Object3D) => {
      const found: THREE.Mesh[] = [];
      root.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          found.push(node);
        }
      });
      return found;
    };
    const ada = meshes(model.createInstance("remote", "Ada").root);
    const maya = meshes(model.createInstance("liveAgent", "Maya").root);
    expect(ada).toHaveLength(10);
    expect(ada.map((mesh) => mesh.geometry)).toEqual(maya.map((mesh) => mesh.geometry));
    expect(new Set(ada.map((mesh) => mesh.material)).size).toBe(1);
    expect(ada[0]?.material).not.toBe(maya[0]?.material);
  });

  it("sits a body lower than it stands", () => {
    const instance = createAvatarModel().createInstance("remote", "Ada");
    expect(instance.seatedHeadDrop).toBeGreaterThan(0);
  });
});
