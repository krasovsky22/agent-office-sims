/**
 * Only a simulated agent employee's body is marked as simulated.
 *
 * Built from the shipped asset, as `avatarSeat.test.ts` is, because what has
 * to hold is what each look does to this robot's own materials: a live coding
 * agent wears the plain agents' look and must not read as a ghost.
 */

import { OCCUPANT_KIND } from "@sim/shared";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { beforeAll, describe, expect, it } from "vitest";

import robotData from "../../public/models/RobotExpressive.glb?inline";
import { isSimulated } from "../agentActivity.js";
import { type AvatarLook, type AvatarModel, prepareAvatarModel } from "./avatarModel.js";

let model: AvatarModel;

beforeAll(async () => {
  const buffer = await (await fetch(robotData)).arrayBuffer();
  model = prepareAvatarModel(await new GLTFLoader().parseAsync(buffer, ""));
});

function materialsOf(look: AvatarLook): THREE.Material[] {
  const materials: THREE.Material[] = [];
  model.createInstance(look).root.traverse((node) => {
    if (node instanceof THREE.Mesh && node.material instanceof THREE.Material) {
      materials.push(node.material);
    }
  });
  return materials;
}

describe("the simulated marker", () => {
  it("leaves a non-simulated agent's body opaque", () => {
    const materials = materialsOf("agent");
    expect(materials.length).toBeGreaterThan(0);
    for (const material of materials) {
      expect(material.transparent).toBe(false);
      expect(material.opacity).toBe(1);
    }
  });

  it("makes every material of a simulated agent's body translucent", () => {
    const materials = materialsOf("simulated-agent");
    expect(materials.length).toBeGreaterThan(0);
    for (const material of materials) {
      expect(material.transparent).toBe(true);
      expect(material.opacity).toBeLessThan(1);
    }
  });

  it("is worn by the simulated employee kind and by no one else", () => {
    expect(isSimulated(OCCUPANT_KIND.agent)).toBe(true);
    expect(isSimulated(OCCUPANT_KIND.human)).toBe(false);
  });
});
