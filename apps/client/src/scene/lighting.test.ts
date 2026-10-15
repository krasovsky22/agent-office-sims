/**
 * The office's lights, built into a scene and run through a day.
 *
 * Every light costs every lit pixel, so the thing worth pinning is that the day
 * adds none: the night is carried by the hemisphere and the desk screens' glow.
 */

import { OFFICE_LAYOUT } from "@sim/shared";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { type OfficeLighting, buildLighting } from "./lighting.js";

function lightsIn(scene: THREE.Scene): THREE.Light[] {
  const lights: THREE.Light[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Light) {
      lights.push(object);
    }
  });
  return lights;
}

function litScene(): { scene: THREE.Scene; lighting: OfficeLighting } {
  const scene = new THREE.Scene();
  return { scene, lighting: buildLighting(scene, OFFICE_LAYOUT) };
}

describe("buildLighting", () => {
  it("adds only the hemisphere and the one directional light, at every hour", () => {
    const { scene, lighting } = litScene();
    lighting.lightScreens(new THREE.MeshStandardMaterial());
    for (let minute = 0; minute < 24 * 60; minute += 30) {
      lighting.showMinute(minute);
      const lights = lightsIn(scene);
      expect(lights).toHaveLength(2);
      expect(lights.filter((light) => light instanceof THREE.HemisphereLight)).toHaveLength(1);
      expect(lights.filter((light) => light instanceof THREE.DirectionalLight)).toHaveLength(1);
    }
  });

  it("lights the screens at night and leaves them dark at noon", () => {
    const { lighting } = litScene();
    const screen = new THREE.MeshStandardMaterial();
    lighting.lightScreens(screen);

    lighting.showMinute(12 * 60);
    expect(screen.emissiveIntensity).toBe(0);

    lighting.showMinute(3 * 60);
    expect(screen.emissiveIntensity).toBeGreaterThan(0);
    expect(screen.emissive.getHex()).not.toBe(0);
  });

  it("lights screens that arrive after dark straight away", () => {
    const { lighting } = litScene();
    lighting.showMinute(3 * 60);

    const screen = new THREE.MeshStandardMaterial();
    lighting.lightScreens(screen);
    expect(screen.emissiveIntensity).toBeGreaterThan(0);
  });

  it("lifts the hemisphere at night to stand in for the interior lights", () => {
    const { scene, lighting } = litScene();
    const sky = lightsIn(scene).find((light) => light instanceof THREE.HemisphereLight);
    if (sky === undefined) {
      throw new Error("No hemisphere light in the scene.");
    }

    lighting.showMinute(3 * 60);
    expect(sky.intensity).toBeGreaterThanOrEqual(1);
  });
});
