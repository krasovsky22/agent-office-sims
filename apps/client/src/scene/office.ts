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
 * The street front is glazed — a sill, glass and a header, so the street shows
 * through — and the pavement's railings are rails on posts; both still block
 * exactly the footprint the layout gives them, so seeing through a wall never
 * means walking through it.
 *
 * The ceiling closes the box over the whole floor slab, with light panels let
 * into it, and faces only downwards: the camera is kept under it indoors
 * (`player/controller.ts`), and from anywhere above, the upper storeys drawn
 * round it outside (`street.ts`) are what show. The lifts in the lobby are
 * doors on the wall and nothing more.
 *
 * A doorway is wall up to the ceiling but for the opening itself: a lintel
 * fills the gap from the top of the door frame to the top of the wall, so no
 * slot is left over a door. The doors hung in the frames are `doors.ts`'s.
 * Each lintel carries a sign on both faces, naming the room through the door,
 * so a newcomer can find their way from the room names the layout already has.
 *
 * Carpet runners lie along the open floor's walkways, a hair above the floor
 * and receiving the same shadows it does.
 *
 * Only the floor receives shadows and only the furniture and the avatars cast
 * them: the walls are a closed box around the camera, so shadowing them would
 * cost a second pass over most of the scene's triangles and change almost
 * nothing you can see. The lights themselves are `lighting.ts`'s.
 */

import {
  type CarpetSpec,
  type DoorwayGap,
  type InteractableSpec,
  type LiftSpec,
  type OfficeLayout,
  type WallSpec,
  SIDEWALK_ROOM_ID,
  doorwayGaps,
  interactables,
} from "@sim/shared";
import * as THREE from "three";

import { textTexture } from "./street.js";

const FLOOR_COLOUR = 0x4a4a50;
const WALL_COLOUR = 0x8e8e95;
const FURNITURE_COLOUR = 0x6c6c74;
const FIXTURE_COLOUR = 0xe6e8ee;
const FRAME_COLOUR = 0x3b3f46;
const GLASS_COLOUR = 0xb4d2e4;
const RAILING_COLOUR = 0x1c2420;
const CEILING_COLOUR = 0xd9d8d2;
const LIGHT_PANEL_COLOUR = 0xfff6e2;
const STEEL_COLOUR = 0xa7adb3;
const LIFT_FRAME_COLOUR = 0x5b6168;
const LIFT_INDICATOR_COLOUR = 0xffb547;
const CARPET_COLOUR = 0x7a3b3f;
const CARPET_BORDER_COLOUR = 0x4e2629;

/** Width of a runner's darker border, and how high above the floor each layer lies. */
const CARPET_BORDER = 0.08;
const CARPET_BORDER_Y = 0.004;
const CARPET_Y = 0.008;

/** Spacing of the light panels let into the ceiling, and each panel's size. */
const LIGHT_PANEL_SPACING = 3;
const LIGHT_PANEL_SIZE = { width: 1.2, depth: 0.6 } as const;
/** How far below the ceiling a panel hangs, so the two never fight for a pixel. */
const LIGHT_PANEL_DROP = 0.01;

/** How far a lift's frame and doors stand proud of the wall they are set into. */
const LIFT_FRAME_DEPTH = 0.06;
const LIFT_FRAME_WIDTH = 0.12;
const LIFT_DOOR_DEPTH = 0.03;

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
 * The wall over a doorway, from the top of its frame to the top of the wall,
 * across the gap's whole width and the wall's whole thickness.
 */
function addLintel(parent: THREE.Object3D, gap: DoorwayGap, material: THREE.Material): void {
  if (gap.wallHeight <= gap.frameHeight) {
    return;
  }
  const alongX = gap.yaw === 0;
  const footprint = {
    x: gap.x,
    z: gap.z,
    width: alongX ? gap.width : gap.depth,
    depth: alongX ? gap.depth : gap.width,
  };
  addSlab(parent, `lintel-${gap.id}`, footprint, gap.frameHeight, gap.wallHeight, material);
}

/** How tall a room sign over a door is, and how far it stands off the lintel's face. */
const ROOM_SIGN_HEIGHT = 0.3;
const ROOM_SIGN_STANDOFF = 0.01;

/** A sign on one face of a doorway's lintel, naming the room through it. */
export interface RoomSign {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Turns the sign's face, +Z at rest, towards the room it is read from. */
  readonly yaw: number;
  readonly width: number;
}

/**
 * Where every room sign goes: one on each side of every doorway with a lintel,
 * naming the room on the other side. The way in from the street is skipped, as
 * its canopy already carries the office's name.
 */
export function roomSigns(layout: OfficeLayout): RoomSign[] {
  const rooms = new Map(layout.rooms.map((room) => [room.id, room]));
  const gaps = doorwayGaps(layout);
  const signs: RoomSign[] = [];
  for (const doorway of layout.doorways) {
    const gap = gaps.find((candidate) => Math.hypot(candidate.x - doorway.centre.x, candidate.z - doorway.centre.z) < 0.05);
    if (gap === undefined || gap.wallHeight <= gap.frameHeight || doorway.connects.includes(SIDEWALK_ROOM_ID)) {
      continue;
    }
    const y = gap.frameHeight + (gap.wallHeight - gap.frameHeight) / 2;
    const offset = gap.depth / 2 + ROOM_SIGN_STANDOFF;
    for (const [readFrom, through] of [doorway.connects, [doorway.connects[1], doorway.connects[0]]] as const) {
      const near = rooms.get(readFrom);
      const far = rooms.get(through);
      if (near === undefined || far === undefined) {
        continue;
      }
      const side = centreOf(near.bounds);
      if (doorway.axis === "x") {
        const toward = Math.sign(side.z - doorway.centre.z);
        signs.push({ text: far.name, x: doorway.centre.x, y, z: doorway.centre.z + toward * offset, yaw: toward > 0 ? 0 : Math.PI, width: gap.width });
      } else {
        const toward = Math.sign(side.x - doorway.centre.x);
        signs.push({ text: far.name, x: doorway.centre.x + toward * offset, y, z: doorway.centre.z, yaw: toward * (Math.PI / 2), width: gap.width });
      }
    }
  }
  return signs;
}

function addRoomSign(parent: THREE.Object3D, sign: RoomSign): void {
  const material = new THREE.MeshLambertMaterial({ map: textTexture(sign.text, "#1b1f27", "#f2f2f2") });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sign.width, ROOM_SIGN_HEIGHT), material);
  mesh.position.set(sign.x, sign.y, sign.z);
  mesh.rotation.y = sign.yaw;
  mesh.name = `room-sign-${sign.text}`;
  parent.add(mesh);
}

/** A flat rectangle lying on the floor at `y`, receiving shadows as the floor does. */
function addRug(parent: THREE.Object3D, name: string, box: ReturnType<typeof centreOf>, y: number, material: THREE.Material): void {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(box.width, box.depth), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(box.x, y, box.z);
  mesh.receiveShadow = true;
  mesh.name = name;
  parent.add(mesh);
}

/** One carpet runner: a darker border with the body of the runner laid inside it. */
function addCarpet(parent: THREE.Object3D, spec: CarpetSpec, materials: { readonly body: THREE.Material; readonly border: THREE.Material }): void {
  const box = centreOf(spec.footprint);
  addRug(parent, `${spec.id}-border`, box, CARPET_BORDER_Y, materials.border);
  const inset = {
    ...box,
    width: Math.max(0, box.width - CARPET_BORDER * 2),
    depth: Math.max(0, box.depth - CARPET_BORDER * 2),
  };
  addRug(parent, spec.id, inset, CARPET_Y, materials.body);
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
 * The ceiling over the floor slab, a plane facing down, and a grid of light
 * panels just under it, every one clear of the walls so none is half buried
 * in one. Nothing for a floor open to the sky.
 */
function addCeiling(parent: THREE.Object3D, layout: OfficeLayout): void {
  const height = layout.ceiling;
  if (height === undefined) {
    return;
  }
  const floor = centreOf(layout.floor);
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(floor.width, floor.depth),
    new THREE.MeshLambertMaterial({ color: CEILING_COLOUR }),
  );
  // Turned to face the floor, so from above it is culled and looks through.
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(floor.x, height, floor.z);
  ceiling.name = "ceiling";
  parent.add(ceiling);

  const panels: THREE.Matrix4[] = [];
  const halfWidth = LIGHT_PANEL_SIZE.width / 2;
  const halfDepth = LIGHT_PANEL_SIZE.depth / 2;
  const columns = Math.floor(floor.width / LIGHT_PANEL_SPACING);
  const rows = Math.floor(floor.depth / LIGHT_PANEL_SPACING);
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const x = layout.floor.minX + (column + 0.5) * (floor.width / columns);
      const z = layout.floor.minZ + (row + 0.5) * (floor.depth / rows);
      const clear = !layout.walls.some(
        ({ footprint }) =>
          x - halfWidth < footprint.maxX &&
          x + halfWidth > footprint.minX &&
          z - halfDepth < footprint.maxZ &&
          z + halfDepth > footprint.minZ,
      );
      if (clear) {
        panels.push(
          new THREE.Matrix4().compose(
            new THREE.Vector3(x, height - LIGHT_PANEL_DROP, z),
            new THREE.Quaternion(),
            new THREE.Vector3(LIGHT_PANEL_SIZE.width, LIGHT_PANEL_DROP, LIGHT_PANEL_SIZE.depth),
          ),
        );
      }
    }
  }
  // Lit from within, so they read as lights whatever the hour.
  addUprights(parent, "ceiling-lights", panels, new THREE.MeshBasicMaterial({ color: LIGHT_PANEL_COLOUR }));
}

/** Materials every lift shares. */
interface LiftMaterials {
  readonly frame: THREE.Material;
  readonly door: THREE.Material;
  readonly seam: THREE.Material;
  readonly indicator: THREE.Material;
}

/** A box in a lift's own frame, which faces -Z from the wall's surface at z = 0. */
function addLocalBox(
  parent: THREE.Object3D,
  material: THREE.Material,
  centre: { readonly x: number; readonly y: number; readonly z: number },
  size: { readonly x: number; readonly y: number; readonly z: number },
): void {
  const mesh = new THREE.Mesh(UNIT_BOX, material);
  mesh.scale.set(size.x, size.y, size.z);
  mesh.position.set(centre.x, centre.y, centre.z);
  parent.add(mesh);
}

/**
 * One lift: a steel frame round the opening, a pair of closed doors with the
 * seam between them, a floor indicator over the frame and a call button
 * beside it. A placeholder, so nothing about it moves.
 */
function addLift(parent: THREE.Object3D, spec: LiftSpec, materials: LiftMaterials): void {
  const lift = new THREE.Group();
  lift.name = spec.id;
  lift.position.set(spec.x, 0, spec.z);
  lift.rotation.y = spec.yaw;
  const halfWidth = spec.width / 2;
  const frameZ = -LIFT_FRAME_DEPTH / 2;
  // Jambs and head.
  for (const side of [-1, 1]) {
    addLocalBox(
      lift,
      materials.frame,
      { x: side * (halfWidth + LIFT_FRAME_WIDTH / 2), y: spec.height / 2, z: frameZ },
      { x: LIFT_FRAME_WIDTH, y: spec.height, z: LIFT_FRAME_DEPTH },
    );
  }
  addLocalBox(
    lift,
    materials.frame,
    { x: 0, y: spec.height + LIFT_FRAME_WIDTH / 2, z: frameZ },
    { x: spec.width + LIFT_FRAME_WIDTH * 2, y: LIFT_FRAME_WIDTH, z: LIFT_FRAME_DEPTH },
  );
  // The two leaves, closed, and the dark line where they meet.
  for (const side of [-1, 1]) {
    addLocalBox(
      lift,
      materials.door,
      { x: (side * halfWidth) / 2, y: spec.height / 2, z: -LIFT_DOOR_DEPTH / 2 },
      { x: halfWidth - 0.005, y: spec.height, z: LIFT_DOOR_DEPTH },
    );
  }
  addLocalBox(lift, materials.seam, { x: 0, y: spec.height / 2, z: -LIFT_DOOR_DEPTH / 2 }, { x: 0.01, y: spec.height, z: LIFT_DOOR_DEPTH + 0.002 });
  // Which floor it is at, over the head, and the button to call it, beside the frame.
  addLocalBox(
    lift,
    materials.indicator,
    { x: 0, y: spec.height + LIFT_FRAME_WIDTH + 0.12, z: frameZ },
    { x: 0.36, y: 0.14, z: LIFT_FRAME_DEPTH },
  );
  addLocalBox(
    lift,
    materials.frame,
    { x: halfWidth + LIFT_FRAME_WIDTH + 0.2, y: 1.1, z: frameZ },
    { x: 0.1, y: 0.2, z: LIFT_FRAME_DEPTH },
  );
  addLocalBox(
    lift,
    materials.indicator,
    { x: halfWidth + LIFT_FRAME_WIDTH + 0.2, y: 1.1, z: frameZ - LIFT_FRAME_DEPTH / 2 },
    { x: 0.04, y: 0.04, z: 0.01 },
  );
  parent.add(lift);
}

/**
 * Adds the floor, the walls, the ceiling, the lifts, the grey desk boxes and
 * the hand-placed fixtures to a scene.
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
  for (const gap of doorwayGaps(layout)) {
    addLintel(office, gap, wallMaterial);
  }
  for (const sign of roomSigns(layout)) {
    addRoomSign(office, sign);
  }

  const carpetMaterials = {
    body: new THREE.MeshLambertMaterial({ color: CARPET_COLOUR }),
    border: new THREE.MeshLambertMaterial({ color: CARPET_BORDER_COLOUR }),
  };
  for (const spec of layout.carpets) {
    addCarpet(office, spec, carpetMaterials);
  }

  addCeiling(office, layout);
  const liftMaterials: LiftMaterials = {
    frame: new THREE.MeshLambertMaterial({ color: LIFT_FRAME_COLOUR }),
    door: new THREE.MeshLambertMaterial({ color: STEEL_COLOUR }),
    seam: new THREE.MeshLambertMaterial({ color: FRAME_COLOUR }),
    indicator: new THREE.MeshBasicMaterial({ color: LIFT_INDICATOR_COLOUR }),
  };
  for (const spec of layout.lifts) {
    addLift(office, spec, liftMaterials);
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

  return {
    group: office,
    setGreyDesksVisible(visible) {
      greyDesks.visible = visible;
    },
  };
}
