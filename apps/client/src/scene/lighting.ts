/**
 * The office's lights, and turning the time of day into them.
 *
 * A hemisphere fill and one shadow-casting directional light that is the sun by
 * day and the moon by night: the same two lights the office always had. The
 * interior lights coming up at night are not lights at all. They are glowing
 * ceiling panels over each stretch of every room, and a warm lift in the
 * hemisphere that stands in for what they would throw. `daylight.ts` decides
 * what each of them should be at a given minute; this module owns them and
 * copies that on.
 *
 * It is all kept cheap enough to run every frame. Every light the renderer
 * shades costs every lit pixel, whatever its intensity, so the count never
 * grows past those two, and it never changes, because changing how many lights
 * the scene has recompiles every material in it. The panels are one instanced
 * mesh that casts nothing. The shadow map's size and camera are set once; a
 * moving sun only moves the light, which re-renders the one map the renderer
 * draws anyway.
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

/** Height of the ceiling panels: just under the 3m walls. */
const CEILING_PANEL_HEIGHT = 2.7;

/**
 * Longest stretch of room one ceiling panel covers.
 *
 * The panels are one instanced mesh, so more of them costs next to nothing;
 * this is close enough that a room reads as lit from end to end.
 */
const CEILING_PANEL_SPAN = 4;

/** Size of one ceiling panel. */
const CEILING_PANEL_LENGTH = 1.2;
const CEILING_PANEL_WIDTH = 0.6;

/** The panels' own colour, seen by day with the lights off. */
const CEILING_PANEL_COLOUR = 0xf2f2ee;

/** Warm white, the colour of an office at night. */
const INTERIOR_LIGHT_COLOUR = new THREE.Color(0xffe2b8);

/** How much the hemisphere brightens with the interior lights full. */
const INTERIOR_FILL = 0.5;

/** How far the hemisphere's sky colour turns to the interior's warm white at full. */
const INTERIOR_WARMTH = 0.6;

/** The office's lights, set to a time of day by {@link OfficeLighting.showMinute}. */
export interface OfficeLighting {
  /** Lights the scene for `minuteOfDay`, which may be fractional. */
  showMinute(minuteOfDay: number): void;
}

/**
 * Where the ceiling panels hang: a grid over each room, one panel per
 * {@link CEILING_PANEL_SPAN} of it in each direction.
 *
 * Derived from the layout's rooms rather than written down, so a new room is
 * lit at night without anyone remembering to light it.
 */
export function ceilingPanelPositions(layout: OfficeLayout): readonly THREE.Vector3[] {
  const positions: THREE.Vector3[] = [];
  for (const room of layout.rooms) {
    const across = Math.max(1, Math.ceil((room.bounds.maxX - room.bounds.minX) / CEILING_PANEL_SPAN));
    const down = Math.max(1, Math.ceil((room.bounds.maxZ - room.bounds.minZ) / CEILING_PANEL_SPAN));
    for (let i = 0; i < across; i += 1) {
      for (let j = 0; j < down; j += 1) {
        positions.push(
          new THREE.Vector3(
            cellCentre(room.bounds.minX, room.bounds.maxX, i, across),
            CEILING_PANEL_HEIGHT,
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
 * The ceiling panels, as one instanced mesh whose glow is the interior lights.
 *
 * Each faces down, so it is seen from under the ceiling and vanishes when the
 * camera looks down over the walls.
 */
function buildCeilingPanels(layout: OfficeLayout): THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial> {
  const geometry = new THREE.PlaneGeometry(CEILING_PANEL_LENGTH, CEILING_PANEL_WIDTH).rotateX(Math.PI / 2);
  const material = new THREE.MeshLambertMaterial({
    color: CEILING_PANEL_COLOUR,
    emissive: INTERIOR_LIGHT_COLOUR,
    emissiveIntensity: 0,
  });
  const positions = ceilingPanelPositions(layout);
  const panels = new THREE.InstancedMesh(geometry, material, positions.length);
  panels.name = "ceiling-panels";

  const matrix = new THREE.Matrix4();
  positions.forEach((position, index) => {
    panels.setMatrixAt(index, matrix.makeTranslation(position));
  });
  panels.instanceMatrix.needsUpdate = true;
  panels.computeBoundingSphere();
  return panels;
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

  const panels = buildCeilingPanels(layout);
  scene.add(panels);

  const background = new THREE.Color();
  scene.background = background;

  const daylight: Daylight = createDaylight();

  return {
    showMinute(minuteOfDay) {
      sampleDaylight(minuteOfDay, daylight);

      sky.color.lerpColors(daylight.skyColour, INTERIOR_LIGHT_COLOUR, daylight.interior * INTERIOR_WARMTH);
      sky.groundColor.copy(daylight.groundColour);
      sky.intensity = daylight.skyIntensity + daylight.interior * INTERIOR_FILL;

      sun.position
        .copy(daylight.sunDirection)
        .multiplyScalar(SUN_DISTANCE)
        .add(sun.target.position);
      sun.color.copy(daylight.sunColour);
      sun.intensity = daylight.sunIntensity;

      panels.material.emissiveIntensity = daylight.interior;

      background.copy(daylight.background);
    },
  };
}
