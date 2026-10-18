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
 * The street wall is glazed — a sill, glass and a header, so the street shows
 * through — and the pavement's railings are rails on posts; both still block
 * exactly the footprint the layout gives them, so seeing through a wall never
 * means walking through it.
 *
 * Only the floor receives shadows and only the furniture and the avatars cast
 * them: the walls are a closed box around the camera, so shadowing them would
 * cost a second pass over most of the scene's triangles and change almost
 * nothing you can see. The lights themselves are `lighting.ts`'s.
 */

import { type InteractableSpec, type OfficeLayout, type WallSpec, interactables } from "@sim/shared";
import * as THREE from "three";

const FLOOR_COLOUR = 0x4a4a50;
const WALL_COLOUR = 0x8e8e95;
const FURNITURE_COLOUR = 0x6c6c74;
const FIXTURE_COLOUR = 0xe6e8ee;
const FRAME_COLOUR = 0x3b3f46;
const GLASS_COLOUR = 0xb4d2e4;
const RAILING_COLOUR = 0x1c2420;

/** Top of a window's sill and bottom of its header, above the floor. */
const SILL_HEIGHT = 0.9;
const HEAD_HEIGHT = 2.7;

/** Widest pane between two mullions. */
const PANE_WIDTH = 1.5;
const MULLION_WIDTH = 0.08;
const GLASS_THICKNESS = 0.03;

/** Widest gap between two posts of a railing, and the rails' own size. */
const POST_SPACING = 1.2;
const POST_WIDTH = 0.07;
const RAIL_THICKNESS = 0.06;

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

export function centreOf(box: { minX: number; minZ: number; maxX: number; maxZ: number }) {
  return {
    x: (box.minX + box.maxX) / 2,
    z: (box.minZ + box.maxZ) / 2,
    width: box.maxX - box.minX,
    depth: box.maxZ - box.minZ,
  };
}

/** A box from `bottom` to `top`, over the footprint. */
function addSlab(
  parent: THREE.Object3D,
  name: string,
  footprint: ReturnType<typeof centreOf>,
  bottom: number,
  top: number,
  material: THREE.Material,
): void {
  const mesh = new THREE.Mesh(UNIT_BOX, material);
  mesh.scale.set(footprint.width, top - bottom, footprint.depth);
  mesh.position.set(footprint.x, (bottom + top) / 2, footprint.z);
  mesh.name = name;
  parent.add(mesh);
}

/**
 * Positions along a wall's length where an upright stands: both ends, and
 * evenly between so no gap is wider than `spacing`.
 */
function uprightsAlong(length: number, spacing: number): number[] {
  const gaps = Math.max(1, Math.ceil(length / spacing));
  return Array.from({ length: gaps + 1 }, (_, index) => -length / 2 + (length * index) / gaps);
}

/** The uprights of one styled wall, in world space, as matrices for one instanced batch. */
function uprightMatrices(
  spec: WallSpec,
  spacing: number,
  size: { readonly width: number; readonly bottom: number; readonly top: number },
): THREE.Matrix4[] {
  const box = centreOf(spec.footprint);
  const alongX = box.width >= box.depth;
  const length = alongX ? box.width : box.depth;
  const thickness = alongX ? box.depth : box.width;
  return uprightsAlong(length, spacing).map((offset) =>
    new THREE.Matrix4().compose(
      new THREE.Vector3(
        alongX ? box.x + offset : box.x,
        (size.bottom + size.top) / 2,
        alongX ? box.z : box.z + offset,
      ),
      new THREE.Quaternion(),
      new THREE.Vector3(
        alongX ? size.width : thickness,
        size.top - size.bottom,
        alongX ? thickness : size.width,
      ),
    ),
  );
}

/** The same footprint, thinned across its short axis to `thickness`. */
function thinned(box: ReturnType<typeof centreOf>, thickness: number): ReturnType<typeof centreOf> {
  return box.width >= box.depth ? { ...box, depth: thickness } : { ...box, width: thickness };
}

interface WallMaterials {
  readonly solid: THREE.Material;
  readonly frame: THREE.Material;
  readonly glass: THREE.Material;
  readonly railing: THREE.Material;
}

/**
 * Adds one wall's meshes, and returns the uprights it needs drawn — window
 * mullions or railing posts — so every wall's go into one instanced batch.
 */
function addWall(
  parent: THREE.Object3D,
  spec: WallSpec,
  materials: WallMaterials,
): { readonly mullions: THREE.Matrix4[]; readonly posts: THREE.Matrix4[] } {
  const box = centreOf(spec.footprint);
  switch (spec.style) {
    case "window":
      addSlab(parent, `${spec.id}-sill`, box, 0, SILL_HEIGHT, materials.solid);
      addSlab(parent, `${spec.id}-header`, box, HEAD_HEIGHT, spec.height, materials.solid);
      addSlab(parent, `${spec.id}-glass`, thinned(box, GLASS_THICKNESS), SILL_HEIGHT, HEAD_HEIGHT, materials.glass);
      return {
        mullions: uprightMatrices(spec, PANE_WIDTH, { width: MULLION_WIDTH, bottom: SILL_HEIGHT, top: HEAD_HEIGHT }),
        posts: [],
      };
    case "railing": {
      const rail = thinned(box, RAIL_THICKNESS);
      addSlab(parent, `${spec.id}-top`, rail, spec.height - RAIL_THICKNESS, spec.height, materials.railing);
      addSlab(parent, `${spec.id}-mid`, rail, spec.height / 2 - RAIL_THICKNESS / 2, spec.height / 2 + RAIL_THICKNESS / 2, materials.railing);
      return {
        mullions: [],
        posts: uprightMatrices(spec, POST_SPACING, { width: POST_WIDTH, bottom: 0, top: spec.height }),
      };
    }
    default:
      addSlab(parent, spec.id, box, 0, spec.height, materials.solid);
      return { mullions: [], posts: [] };
  }
}

/** One instanced batch of unit boxes, or nothing for an empty list. */
function addUprights(parent: THREE.Object3D, name: string, matrices: readonly THREE.Matrix4[], material: THREE.Material): void {
  if (matrices.length === 0) {
    return;
  }
  const mesh = new THREE.InstancedMesh(UNIT_BOX, material, matrices.length);
  matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = name;
  parent.add(mesh);
}

/**
 * Adds an interactable's box, scaled and positioned from its layout volume.
 *
 * Placed by a 3D box rather than a footprint and a height because not every
 * fixture stands on the floor — one hung on a wall sits at chest height. Only
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
 * Adds the floor, the walls, the grey desk boxes and the hand-placed fixtures
 * to a scene.
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

  const materials: WallMaterials = {
    solid: wallMaterial,
    frame: new THREE.MeshLambertMaterial({ color: FRAME_COLOUR }),
    // Faint and unlit-looking from either side, and drawn after the opaque
    // scene without hiding what is behind it.
    glass: new THREE.MeshLambertMaterial({
      color: GLASS_COLOUR,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    railing: new THREE.MeshLambertMaterial({ color: RAILING_COLOUR }),
  };
  const mullions: THREE.Matrix4[] = [];
  const posts: THREE.Matrix4[] = [];
  for (const spec of layout.walls) {
    const uprights = addWall(office, spec, materials);
    mullions.push(...uprights.mullions);
    posts.push(...uprights.posts);
  }
  addUprights(office, "window-mullions", mullions, materials.frame);
  addUprights(office, "railing-posts", posts, materials.railing);

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

  return {
    group: office,
    setGreyDesksVisible(visible) {
      greyDesks.visible = visible;
    },
  };
}
