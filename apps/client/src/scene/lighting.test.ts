/**
 * The office's lights, built into a scene and run through a day.
 *
 * Every light costs every lit pixel, so the thing worth pinning is that the day
 * adds none: the night is carried by the hemisphere and the ceiling panels'
 * glow. The panels come from the layout's rooms, so every room gets at least one
 * and none ends up outside the room it lights.
 */

import { OFFICE_LAYOUT, containsPoint } from "@sim/shared";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildLighting, ceilingPanelPositions } from "./lighting.js";

function lightsIn(scene: THREE.Scene): THREE.Light[] {
  const lights: THREE.Light[] = [];
  scene.traverse((object) => {
    if (object instanceof THREE.Light) {
      lights.push(object);
    }
  });
  return lights;
}

function litScene(): { scene: THREE.Scene; showMinute: (minute: number) => void } {
  const scene = new THREE.Scene();
  const lighting = buildLighting(scene, OFFICE_LAYOUT);
  return { scene, showMinute: (minute) => lighting.showMinute(minute) };
}

function panelsIn(scene: THREE.Scene): THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> {
  const panels = scene.getObjectByName("ceiling-panels");
  if (!(panels instanceof THREE.InstancedMesh) || !(panels.material instanceof THREE.MeshLambertMaterial)) {
    throw new Error("No ceiling panels in the scene.");
  }
  return panels as THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
}

describe("buildLighting", () => {
  it("adds only the hemisphere and the one directional light, at every hour", () => {
    const { scene, showMinute } = litScene();
    for (let minute = 0; minute < 24 * 60; minute += 30) {
      showMinute(minute);
      const lights = lightsIn(scene);
      expect(lights).toHaveLength(2);
      expect(lights.filter((light) => light instanceof THREE.HemisphereLight)).toHaveLength(1);
      expect(lights.filter((light) => light instanceof THREE.DirectionalLight)).toHaveLength(1);
    }
  });

  it("lights the panels at night and leaves them dark at noon", () => {
    const { scene, showMinute } = litScene();
    const panels = panelsIn(scene);
    expect(panels.castShadow).toBe(false);

    showMinute(12 * 60);
    expect(panels.material.emissiveIntensity).toBe(0);

    showMinute(3 * 60);
    expect(panels.material.emissiveIntensity).toBe(1);
  });

  it("lifts the hemisphere at night to stand in for the interior lights", () => {
    const { scene, showMinute } = litScene();
    const sky = lightsIn(scene).find((light) => light instanceof THREE.HemisphereLight);
    if (sky === undefined) {
      throw new Error("No hemisphere light in the scene.");
    }

    showMinute(3 * 60);
    expect(sky.intensity).toBeGreaterThanOrEqual(1);
  });
});

describe("ceilingPanelPositions", () => {
  const positions = ceilingPanelPositions(OFFICE_LAYOUT);

  it("puts a panel in every room", () => {
    for (const room of OFFICE_LAYOUT.rooms) {
      expect(positions.some((p) => containsPoint(room.bounds, { x: p.x, z: p.z }))).toBe(true);
    }
  });

  it("hangs every panel inside a room and under the ceiling", () => {
    for (const p of positions) {
      expect(OFFICE_LAYOUT.rooms.some((room) => containsPoint(room.bounds, { x: p.x, z: p.z }))).toBe(true);
      expect(p.y).toBeLessThan(3);
    }
  });
});
