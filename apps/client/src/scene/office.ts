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

import {
  INTERACTION_KIND,
  type InteractableSpec,
  type OfficeLayout,
  type WallSpec,
  interactables,
} from "@sim/shared";
import * as THREE from "three";

const FLOOR_COLOUR = 0x4a4a50;
const WALL_COLOUR = 0x8e8e95;
const DESK_COLOUR = 0x6c6c74;
const CHAIR_COLOUR = 0x5a5a62;
const FIXTURE_COLOUR = 0x39424c;
const WHITEBOARD_COLOUR = 0xe6e8ee;

/** Chair dimensions. Visual only: you sit through a chair, you do not hit one. */
const CHAIR_WIDTH = 0.46;
const CHAIR_DEPTH = 0.46;
const CHAIR_HEIGHT = 0.45;

/** What {@link buildOffice} hands back to the game loop. */
export interface Office {
  /** The whole world, so a caller can remove it in one call. */
  readonly group: THREE.Group;
  /**
   * An empty object at each seat's anchor pose, keyed by interactable id.
   *
   * A seated avatar is parented to one of these, which is what makes sitting a
   * single scene-graph operation: the body stops being positioned by the game
   * loop and simply inherits the desk's place in the office.
   */
  readonly seatAnchors: ReadonlyMap<string, THREE.Object3D>;
}

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
 * Adds a fixture's box, scaled and positioned from its layout volume.
 *
 * A fixture is placed by a 3D box rather than a footprint and a height because
 * not all of them stand on the floor — the whiteboard hangs at chest height.
 */
function addFixture(
  parent: THREE.Object3D,
  spec: InteractableSpec,
  material: THREE.Material,
): void {
  const { volume } = spec;
  if (volume === undefined) {
    return;
  }
  const mesh = new THREE.Mesh(UNIT_BOX, material);
  mesh.scale.set(
    volume.maxX - volume.minX,
    volume.maxY - volume.minY,
    volume.maxZ - volume.minZ,
  );
  mesh.position.set(
    (volume.minX + volume.maxX) / 2,
    (volume.minY + volume.maxY) / 2,
    (volume.minZ + volume.maxZ) / 2,
  );
  mesh.name = spec.id;
  parent.add(mesh);
}

/**
 * Adds the floor, the walls, the desks, the interactables and the lighting.
 *
 * Every position still comes from the shared layout, interactables included, so
 * the prompt the player sees sits where the server thinks the thing is.
 */
export function buildOffice(scene: THREE.Scene, layout: OfficeLayout): Office {
  const office = new THREE.Group();
  office.name = layout.name;

  const wallMaterial = new THREE.MeshLambertMaterial({ color: WALL_COLOUR });
  const deskMaterial = new THREE.MeshLambertMaterial({ color: DESK_COLOUR });
  const floorMaterial = new THREE.MeshLambertMaterial({ color: FLOOR_COLOUR });
  const chairMaterial = new THREE.MeshLambertMaterial({ color: CHAIR_COLOUR });
  const fixtureMaterial = new THREE.MeshLambertMaterial({ color: FIXTURE_COLOUR });
  const whiteboardMaterial = new THREE.MeshLambertMaterial({ color: WHITEBOARD_COLOUR });

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

  const seatAnchors = new Map<string, THREE.Object3D>();
  for (const spec of interactables(layout)) {
    if (spec.kind === INTERACTION_KIND.seat) {
      // The anchor carries the seat's pose, so anything parented to it — the
      // chair now, a sitting avatar later — needs no transform of its own.
      const anchor = new THREE.Object3D();
      anchor.position.set(spec.anchor.x, 0, spec.anchor.z);
      anchor.rotation.y = spec.anchor.yaw;
      anchor.name = spec.id;
      office.add(anchor);
      seatAnchors.set(spec.id, anchor);

      const chair = new THREE.Mesh(UNIT_BOX, chairMaterial);
      chair.scale.set(CHAIR_WIDTH, CHAIR_HEIGHT, CHAIR_DEPTH);
      chair.position.y = CHAIR_HEIGHT / 2;
      anchor.add(chair);
      continue;
    }
    addFixture(
      office,
      spec,
      spec.kind === INTERACTION_KIND.whiteboard ? whiteboardMaterial : fixtureMaterial,
    );
  }

  scene.add(office);

  const sky = new THREE.HemisphereLight(0xdfe3ea, 0x3a3a40, 1.1);
  scene.add(sky);

  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(-8, 14, 6);
  scene.add(sun);

  return { group: office, seatAnchors };
}
