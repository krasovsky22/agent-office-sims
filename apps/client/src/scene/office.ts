/**
 * Builds the office shell from the shared layout.
 *
 * Every box in here comes from `@sim/shared`'s layout data. Nothing in this file
 * decides where a wall is, which is what lets the server collide against the
 * same floor plan the player can see.
 *
 * The shell — floor slab and walls — is still untextured grey boxes. The
 * furniture is not: `props.ts` draws that from the asset kit, and the grey desk
 * boxes this file makes are the fallback it replaces. See {@link OfficeView}.
 *
 * Lighting is a hemisphere fill plus one shadow-casting directional light. Only
 * the floor receives its shadows and only the furniture and the avatars cast
 * them: the walls are a closed box around the camera, so shadowing them would
 * cost a second pass over most of the scene's triangles and change almost
 * nothing you can see.
 */

import { type InteractableSpec, type OfficeLayout, type WallSpec, interactables } from "@sim/shared";
import * as THREE from "three";

const FLOOR_COLOUR = 0x4a4a50;
const WALL_COLOUR = 0x8e8e95;
const FURNITURE_COLOUR = 0x6c6c74;
const FIXTURE_COLOUR = 0xe6e8ee;

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
 * One unit cube, scaled per mesh.
 *
 * Walls, desks and props are all boxes of different sizes; sharing the geometry
 * and scaling the mesh keeps the scene to three materials and one box buffer.
 */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/**
 * A built office, and the one thing a caller needs to do to it afterwards.
 *
 * The grey desk boxes exist so that the office is walkable before — or without —
 * the asset kit. Once the kit has loaded, the desk props stand in exactly the
 * same footprints, so the boxes are hidden rather than deleted: a kit that fails
 * to load leaves them showing, which is the fallback the milestone asks for.
 */
export interface OfficeView {
  readonly group: THREE.Group;
  setGreyDesksVisible(visible: boolean): void;
}

function centreOf(box: { minX: number; minZ: number; maxX: number; maxZ: number }) {
  return {
    x: (box.minX + box.maxX) / 2,
    z: (box.minZ + box.maxZ) / 2,
    width: box.maxX - box.minX,
    depth: box.maxZ - box.minZ,
  };
}

function addWall(parent: THREE.Object3D, spec: WallSpec, material: THREE.Material): void {
  const { x, z, width, depth } = centreOf(spec.footprint);
  const mesh = new THREE.Mesh(UNIT_BOX, material);
  mesh.scale.set(width, spec.height, depth);
  mesh.position.set(x, spec.height / 2, z);
  mesh.name = spec.id;
  parent.add(mesh);
}

/**
 * Adds an interactable's box, scaled and positioned from its layout volume.
 *
 * Placed by a 3D box rather than a footprint and a height because not every
 * fixture stands on the floor — the whiteboard hangs at chest height. Only
 * fixtures the asset kit has no model for carry a volume, so this stays up
 * whether or not the kit loads.
 */
function addFixture(parent: THREE.Object3D, spec: InteractableSpec, material: THREE.Material): void {
  const { volume } = spec;
  if (volume === undefined) {
    return;
  }
  const mesh = new THREE.Mesh(UNIT_BOX, material);
  mesh.scale.set(volume.maxX - volume.minX, volume.maxY - volume.minY, volume.maxZ - volume.minZ);
  mesh.position.set(
    (volume.minX + volume.maxX) / 2,
    (volume.minY + volume.maxY) / 2,
    (volume.minZ + volume.maxZ) / 2,
  );
  mesh.name = spec.id;
  parent.add(mesh);
}

/**
 * Frames the whole floor in the one shadow camera.
 *
 * Derived from the layout's extent rather than written down, so a bigger floor
 * plan keeps its shadows instead of losing them off the edge of the map.
 */
function aimShadowCamera(sun: THREE.DirectionalLight, layout: OfficeLayout): void {
  const floor = centreOf(layout.floor);
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
  shadowCamera.far = sun.position.length() + reach;
  shadowCamera.updateProjectionMatrix();
}

/**
 * Adds the floor, the walls, the grey desk boxes, the hand-placed fixtures and
 * the lighting to a scene.
 *
 * @returns a handle on the world, so a caller can remove the whole office in one
 * call and swap the grey desks for the prop kit's.
 */
export function buildOffice(scene: THREE.Scene, layout: OfficeLayout): OfficeView {
  const office = new THREE.Group();
  office.name = layout.name;

  const wallMaterial = new THREE.MeshLambertMaterial({ color: WALL_COLOUR });
  const furnitureMaterial = new THREE.MeshLambertMaterial({ color: FURNITURE_COLOUR });
  const floorMaterial = new THREE.MeshLambertMaterial({ color: FLOOR_COLOUR });

  const floor = centreOf(layout.floor);
  const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(floor.width, floor.depth), floorMaterial);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.set(floor.x, 0, floor.z);
  floorMesh.receiveShadow = true;
  floorMesh.name = "floor";
  office.add(floorMesh);

  for (const spec of layout.walls) {
    addWall(office, spec, wallMaterial);
  }

  const greyDesks = new THREE.Group();
  greyDesks.name = "grey-desks";
  // Desks and props are grey boxes alike until the asset kit lands, and both
  // are positioned the same way, so one loop builds both. The mesh is rotated,
  // while collision uses the axis-aligned box the shared layout derives from
  // the same yaw; for the quarter turns the layout uses, those are the same
  // footprint.
  for (const spec of [...layout.desks, ...layout.props]) {
    const mesh = new THREE.Mesh(UNIT_BOX, furnitureMaterial);
    mesh.scale.set(spec.width, spec.height, spec.depth);
    mesh.position.set(spec.x, spec.height / 2, spec.z);
    mesh.rotation.y = spec.yaw;
    mesh.castShadow = true;
    mesh.name = spec.id;
    greyDesks.add(mesh);
  }
  office.add(greyDesks);

  const fixtureMaterial = new THREE.MeshLambertMaterial({ color: FIXTURE_COLOUR });
  for (const spec of interactables(layout)) {
    addFixture(office, spec, fixtureMaterial);
  }

  scene.add(office);

  const sky = new THREE.HemisphereLight(0xdfe3ea, 0x3a3a40, 1.1);
  scene.add(sky);

  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(-8, 14, 6);
  aimShadowCamera(sun, layout);
  scene.add(sun);

  return {
    group: office,
    setGreyDesksVisible(visible) {
      greyDesks.visible = visible;
    },
  };
}
