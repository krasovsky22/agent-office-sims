/**
 * Builds the office geometry from the shared layout.
 *
 * Every box in here comes from `@sim/shared`'s layout data. Nothing in this file
 * decides where a wall is, which is what lets the server collide against the
 * same floor plan the player can see.
 *
 * The look is the intended one, not a placeholder: untextured grey boxes, two
 * lights, no shadows and no post-processing. A low-poly asset kit replaces the
 * boxes in a later milestone; until then the render budget stays this small.
 */

import type { OfficeLayout, WallSpec } from "@sim/shared";
import * as THREE from "three";

const FLOOR_COLOUR = 0x4a4a50;
const WALL_COLOUR = 0x8e8e95;
const DESK_COLOUR = 0x6c6c74;

/**
 * One unit cube, scaled per mesh.
 *
 * Walls and desks are all boxes of different sizes; sharing the geometry and
 * scaling the mesh keeps the scene to three materials and one box buffer.
 */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

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
 * Adds the floor, the walls, the desks and the lighting to a scene.
 *
 * @returns the group holding the world, so a caller can remove the whole office
 * in one call.
 */
export function buildOffice(scene: THREE.Scene, layout: OfficeLayout): THREE.Group {
  const office = new THREE.Group();
  office.name = layout.name;

  const wallMaterial = new THREE.MeshLambertMaterial({ color: WALL_COLOUR });
  const deskMaterial = new THREE.MeshLambertMaterial({ color: DESK_COLOUR });
  const floorMaterial = new THREE.MeshLambertMaterial({ color: FLOOR_COLOUR });

  const floor = centreOf(layout.floor);
  const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(floor.width, floor.depth), floorMaterial);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.set(floor.x, 0, floor.z);
  floorMesh.name = "floor";
  office.add(floorMesh);

  for (const spec of layout.walls) {
    addWall(office, spec, wallMaterial);
  }

  for (const spec of layout.desks) {
    // The mesh is rotated, while collision uses the axis-aligned box the shared
    // layout derives from the same yaw. For the quarter turns the layout uses,
    // those are the same footprint.
    const mesh = new THREE.Mesh(UNIT_BOX, deskMaterial);
    mesh.scale.set(spec.width, spec.height, spec.depth);
    mesh.position.set(spec.x, spec.height / 2, spec.z);
    mesh.rotation.y = spec.yaw;
    mesh.name = spec.id;
    office.add(mesh);
  }

  scene.add(office);

  const sky = new THREE.HemisphereLight(0xdfe3ea, 0x3a3a40, 1.1);
  scene.add(sky);

  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(-8, 14, 6);
  scene.add(sun);

  return office;
}
