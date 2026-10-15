/**
 * The office's lights, and turning the time of day into them.
 *
 * A hemisphere fill, one shadow-casting directional light that is the sun by day
 * and the moon by night, and a ceiling light over each stretch of every room
 * that comes up as the light outside falls. `daylight.ts` decides what each of
 * them should be at a given minute; this module owns the lights and copies that
 * onto them.
 *
 * It is all kept cheap enough to run every frame. Every light exists from the
 * start and stays in the scene: a light switched off is one at zero intensity,
 * never one removed or hidden, because changing how many lights the scene has
 * recompiles every material in it. The shadow map's size and camera are set
 * once; a moving sun only moves the light, which re-renders the one map the
 * renderer draws anyway. Only the sun casts — interior lights cast nothing, so
 * they add no shadow passes.
 */

import { type Aabb2, type OfficeLayout } from "@sim/shared";
import * as THREE from "three";

import { type Daylight, createDaylight, sampleDaylight } from "./daylight.js";

/** Shadow map resolution. One light, one map, so this is the whole budget. */
const SHADOW_MAP_SIZE = 2048;

/**
 * Pulls the shadow comparison off the surface that cast it.
 *
 * Without it the low-poly desk tops self-shadow into stripes, which is far more
 * visible than the slight contact gap the bias introduces.
 */
const SHADOW_NORMAL_BIAS = 0.02;

/** Slack added to the shadow camera's frustum so the floor's corners are inside it. */
const SHADOW_MARGIN = 2;

/**
 * How far the directional light sits from the middle of the floor.
 *
 * Fixed whatever the hour, so the shadow camera's depth range is worked out once
 * and the sun only ever swings round on it.
 */
const SUN_DISTANCE = 18;

/** Height of the interior lights: just under the 3m walls. */
const INTERIOR_LIGHT_HEIGHT = 2.7;

/**
 * Longest stretch of room one interior light covers.
 *
 * Wide enough that the whole floor takes only a handful of lights — every one is
 * a cost on every lit pixel — and close enough that the open floor's middle is
 * not left dimmer than its ends.
 */
const INTERIOR_LIGHT_SPAN = 12;

/** Warm white, the colour of an office at night. */
const INTERIOR_LIGHT_COLOUR = 0xffe2b8;

/** Intensity of one interior light at full, in candela. */
const INTERIOR_LIGHT_INTENSITY = 14;

/** Reach of an interior light, after which it contributes nothing. */
const INTERIOR_LIGHT_RANGE = 10;

/** The office's lights, set to a time of day by {@link OfficeLighting.showMinute}. */
export interface OfficeLighting {
  /** Lights the scene for `minuteOfDay`, which may be fractional. */
  showMinute(minuteOfDay: number): void;
}

/**
 * Where the interior lights hang: a grid over each room, one light per
 * {@link INTERIOR_LIGHT_SPAN} of it in each direction.
 *
 * Derived from the layout's rooms rather than written down, so a new room is
 * lit at night without anyone remembering to light it.
 */
export function interiorLightPositions(layout: OfficeLayout): readonly THREE.Vector3[] {
  const positions: THREE.Vector3[] = [];
  for (const room of layout.rooms) {
    const across = Math.max(1, Math.ceil((room.bounds.maxX - room.bounds.minX) / INTERIOR_LIGHT_SPAN));
    const down = Math.max(1, Math.ceil((room.bounds.maxZ - room.bounds.minZ) / INTERIOR_LIGHT_SPAN));
    for (let i = 0; i < across; i += 1) {
      for (let j = 0; j < down; j += 1) {
        positions.push(
          new THREE.Vector3(
            cellCentre(room.bounds.minX, room.bounds.maxX, i, across),
            INTERIOR_LIGHT_HEIGHT,
            cellCentre(room.bounds.minZ, room.bounds.maxZ, j, down),
          ),
        );
      }
    }
  }
  return positions;
}

function cellCentre(min: number, max: number, index: number, count: number): number {
  return min + ((max - min) * (index + 0.5)) / count;
}

function centreOf(box: Aabb2): { x: number; z: number; width: number; depth: number } {
  return {
    x: (box.minX + box.maxX) / 2,
    z: (box.minZ + box.maxZ) / 2,
    width: box.maxX - box.minX,
    depth: box.maxZ - box.minZ,
  };
}

/**
 * Frames the whole floor in the one shadow camera.
 *
 * Derived from the layout's extent rather than written down, so a bigger floor
 * plan keeps its shadows instead of losing them off the edge of the map. Set once:
 * the sun moves round the floor at {@link SUN_DISTANCE}, so the frustum that
 * fits at one hour fits at all of them.
 */
function aimShadowCamera(sun: THREE.DirectionalLight, floor: ReturnType<typeof centreOf>): void {
  const reach = Math.hypot(floor.width, floor.depth) / 2 + SHADOW_MARGIN;

  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.normalBias = SHADOW_NORMAL_BIAS;

  const shadowCamera = sun.shadow.camera;
  shadowCamera.left = -reach;
  shadowCamera.right = reach;
  shadowCamera.top = reach;
  shadowCamera.bottom = -reach;
  shadowCamera.near = 0.5;
  shadowCamera.far = SUN_DISTANCE + reach;
  shadowCamera.updateProjectionMatrix();
}

/**
 * Adds the office's lights to a scene and hands back the one control they need.
 *
 * The scene's background is taken over as well, so the sky above the walls
 * darkens with the light.
 */
export function buildLighting(scene: THREE.Scene, layout: OfficeLayout): OfficeLighting {
  const floor = centreOf(layout.floor);

  const sky = new THREE.HemisphereLight();
  scene.add(sky);

  const sun = new THREE.DirectionalLight();
  sun.target.position.set(floor.x, 0, floor.z);
  aimShadowCamera(sun, floor);
  scene.add(sun, sun.target);

  const interiors = interiorLightPositions(layout).map((position) => {
    const light = new THREE.PointLight(INTERIOR_LIGHT_COLOUR, 0, INTERIOR_LIGHT_RANGE);
    light.position.copy(position);
    scene.add(light);
    return light;
  });

  const background = new THREE.Color();
  scene.background = background;

  const daylight: Daylight = createDaylight();

  return {
    showMinute(minuteOfDay) {
      sampleDaylight(minuteOfDay, daylight);

      sky.color.copy(daylight.skyColour);
      sky.groundColor.copy(daylight.groundColour);
      sky.intensity = daylight.skyIntensity;

      sun.position
        .copy(daylight.sunDirection)
        .multiplyScalar(SUN_DISTANCE)
        .add(sun.target.position);
      sun.color.copy(daylight.sunColour);
      sun.intensity = daylight.sunIntensity;

      const interior = daylight.interior * INTERIOR_LIGHT_INTENSITY;
      for (const light of interiors) {
        light.intensity = interior;
      }

      background.copy(daylight.background);
    },
  };
}
