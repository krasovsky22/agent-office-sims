/**
 * The street outside the office's glass: road, pavements, crossing, traffic
 * lights, street lamps, the city's buildings and the cars driving past.
 *
 * All of it is scenery, drawn from the layout's {@link StreetSpec} and nothing
 * else, and all of it is built to cost the office floor next to nothing. The
 * buildings are two merged meshes, one brick and one glass, their windows a
 * small canvas texture repeated up every facade; every repeated thing — car
 * parts, lamp posts, road stripes, water tanks — is one instanced mesh; nothing
 * casts or receives a shadow; and no light is added, since every light costs
 * every lit pixel and changes how many the scene has. Night comes from the
 * same daylight the office runs on: windows across the street, street lamps
 * and headlights glow brighter as the interior lights come up.
 *
 * Moving the cars is `traffic.ts`'s; this only draws where it says they are.
 */

import {
  type Aabb2,
  type OfficeLayout,
  type PropSpec,
  SIDEWALK_ROOM_ID,
  type StreetSpec,
  containsPoint,
} from "@sim/shared";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { type BuildingSpec, type BuildingStyle, skylineOf } from "./skyline.js";
import {
  CROSSING_HALF_WIDTH,
  type Car,
  type SignalPhase,
  type Traffic,
  carPose,
  createTraffic,
  signalAt,
  stepTraffic,
  stopLineAt,
} from "./traffic.js";

/** The road surface sits a kerb's height below the pavements and the office floor. */
const ROAD_Y = -0.15;
/** Lines are painted a hair above the road, so they never fight it for the pixel. */
const PAINT_Y = ROAD_Y + 0.006;

const ASPHALT = 0x2f3134;
const CITY_GROUND = 0x2a2b2e;
const PAVEMENT = 0xa3a19b;
const LINE_WHITE = 0xe8e6df;
const LINE_YELLOW = 0xe0b324;
const STREET_METAL = 0x2b302d;
const CANOPY_GREEN = 0x1f3b2d;

/** One window bay across, and one storey up, of every facade. */
const BAY_WIDTH = 3;
const STOREY_HEIGHT = 3.4;
/** The facade texture is this many bays across and storeys up before it repeats. */
const TILE_BAYS = 4;
const TEXTURE_SIZE = 256;

/** Lit windows across the street at night: warm, and not every one. */
const LIT_SHARE = { brick: 0.45, glass: 0.35 } as const;
const WINDOW_GLOW = 1.1;

const LAMP_SPACING = 16;
const LAMP_HEIGHT = 6;
const LAMP_GLOW = 1.6;

/** How bright a lit traffic signal is, and one that is off. */
const SIGNAL_ON = 1.8;
const SIGNAL_OFF = 0.04;

const HEADLIGHT_GLOW = { day: 0.25, night: 1.4 } as const;

/** Longest step the traffic is advanced by, so a tab coming back from the background does not teleport it. */
const MAX_TRAFFIC_STEP = 0.1;

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

export interface StreetView {
  readonly group: THREE.Group;
  /**
   * Drives the traffic on by `deltaSeconds` and lights the street for `night`,
   * 0 by day to 1 at night: the office's own interior-light level.
   */
  update(deltaSeconds: number, night: number): void;
}

/** How far the camera has to see to take in the whole street and its skyline. */
export function streetReach(layout: OfficeLayout): number {
  const buildings = skylineOf(layout);
  const { floor } = layout;
  const centreX = (floor.minX + floor.maxX) / 2;
  const centreZ = (floor.minZ + floor.maxZ) / 2;
  let reach = 0;
  for (const building of buildings) {
    const dx = Math.max(Math.abs(building.minX - centreX), Math.abs(building.maxX - centreX));
    const dz = Math.max(Math.abs(building.minZ - centreZ), Math.abs(building.maxZ - centreZ));
    reach = Math.max(reach, Math.hypot(dx, dz, building.height));
  }
  return reach;
}

/** A flat box from `bottom` to `top` over a footprint. */
function slab(box: Aabb2, bottom: number, top: number, material: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(UNIT_BOX, material);
  mesh.scale.set(box.maxX - box.minX, top - bottom, box.maxZ - box.minZ);
  mesh.position.set((box.minX + box.maxX) / 2, (bottom + top) / 2, (box.minZ + box.maxZ) / 2);
  mesh.name = name;
  return mesh;
}

/** A batch of axis-aligned boxes, given as centre and size, in one draw. */
function boxes(
  name: string,
  material: THREE.Material,
  items: readonly { readonly x: number; readonly y: number; readonly z: number; readonly sx: number; readonly sy: number; readonly sz: number }[],
  geometry: THREE.BufferGeometry = UNIT_BOX,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, items.length));
  mesh.count = items.length;
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  items.forEach((item, index) => {
    matrix.compose(
      new THREE.Vector3(item.x, item.y, item.z),
      rotation,
      new THREE.Vector3(item.sx, item.sy, item.sz),
    );
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = name;
  return mesh;
}

function canvas(size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const element = document.createElement("canvas");
  element.width = size;
  element.height = size;
  const context = element.getContext("2d");
  if (context === null) {
    throw new Error("no 2D canvas to draw the street's textures on");
  }
  return { canvas: element, context };
}

function repeating(element: HTMLCanvasElement, colour: boolean): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(element);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  if (colour) {
    texture.colorSpace = THREE.SRGBColorSpace;
  }
  return texture;
}

/**
 * A facade's window pattern and its night-time glow, one tile of
 * {@link TILE_BAYS} bays by as many storeys.
 *
 * The colour map is drawn near white so each building's own colour tints it;
 * the top-left pixel is always plain wall with no glow, which is where a
 * building's roof samples, so roofs come out the building's colour and dark.
 */
function facadeTextures(style: BuildingStyle, random: () => number): { map: THREE.Texture; glow: THREE.Texture } {
  const cell = TEXTURE_SIZE / TILE_BAYS;
  const colour = canvas(TEXTURE_SIZE);
  const glow = canvas(TEXTURE_SIZE);
  colour.context.fillStyle = style === "brick" ? "#f2ece6" : "#d9e2ea";
  colour.context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  glow.context.fillStyle = "#000000";
  glow.context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  // Brick has punched windows with a pale sill under each; a curtain wall is
  // nearly all glass between thin frames.
  const window =
    style === "brick"
      ? { left: 0.24, top: 0.16, width: 0.52, height: 0.6 }
      : { left: 0.05, top: 0.06, width: 0.9, height: 0.84 };

  for (let bay = 0; bay < TILE_BAYS; bay += 1) {
    for (let storey = 0; storey < TILE_BAYS; storey += 1) {
      const x = bay * cell + window.left * cell;
      const y = storey * cell + window.top * cell;
      const w = window.width * cell;
      const h = window.height * cell;
      const pane = colour.context.createLinearGradient(x, y, x + w, y + h);
      if (style === "brick") {
        pane.addColorStop(0, "#3b4652");
        pane.addColorStop(1, "#27303a");
      } else {
        pane.addColorStop(0, "#9fb6c9");
        pane.addColorStop(1, "#6f879b");
      }
      colour.context.fillStyle = pane;
      colour.context.fillRect(x, y, w, h);
      if (style === "brick") {
        colour.context.fillStyle = "#ffffff";
        colour.context.fillRect(x - 2, y + h, w + 4, 3);
      }
      if (random() < LIT_SHARE[style]) {
        glow.context.fillStyle = random() < 0.8 ? "#ffd59a" : "#e8f0ff";
        glow.context.fillRect(x, y, w, h);
      }
    }
  }
  return { map: repeating(colour.canvas, true), glow: repeating(glow.canvas, true) };
}

/**
 * One building's box, its facades mapped so a window bay is the same size on
 * every building and its roof samples plain wall.
 */
function buildingGeometry(building: BuildingSpec): THREE.BufferGeometry {
  const width = building.maxX - building.minX;
  const depth = building.maxZ - building.minZ;
  const geometry = new THREE.BoxGeometry(width, building.height, depth);
  geometry.translate((building.minX + building.maxX) / 2, building.height / 2, (building.minZ + building.maxZ) / 2);

  const uv = geometry.getAttribute("uv");
  const tileWidth = BAY_WIDTH * TILE_BAYS;
  const tileHeight = STOREY_HEIGHT * TILE_BAYS;
  // BoxGeometry's faces, four vertices each: +X, -X, +Y, -Y, +Z, -Z.
  const across = [depth, depth, 0, 0, width, width];
  for (let face = 0; face < 6; face += 1) {
    const span = across[face] ?? 0;
    for (let corner = 0; corner < 4; corner += 1) {
      const index = face * 4 + corner;
      if (span === 0) {
        uv.setXY(index, 0.001, 0.999);
      } else {
        uv.setXY(index, (uv.getX(index) * span) / tileWidth, (uv.getY(index) * building.height) / tileHeight);
      }
    }
  }

  const tint = new THREE.Color(building.colour);
  const colours = new Float32Array(uv.count * 3);
  for (let index = 0; index < uv.count; index += 1) {
    colours.set([tint.r, tint.g, tint.b], index * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
  return geometry;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The buildings, merged into one mesh per style, plus the water tanks on the walk-ups. */
function addBuildings(group: THREE.Group, layout: OfficeLayout, glowing: THREE.MeshLambertMaterial[]): void {
  const buildings = skylineOf(layout);
  const random = seededRandom(7);
  for (const style of ["brick", "glass"] as const) {
    const ofStyle = buildings.filter((building) => building.style === style);
    if (ofStyle.length === 0) {
      continue;
    }
    const geometry = mergeGeometries(ofStyle.map(buildingGeometry), false);
    const textures = facadeTextures(style, random);
    const material = new THREE.MeshLambertMaterial({
      map: textures.map,
      vertexColors: true,
      emissive: 0xffffff,
      emissiveMap: textures.glow,
      emissiveIntensity: 0,
    });
    glowing.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `buildings-${style}`;
    group.add(mesh);
  }

  const tanks = buildings.filter((building) => building.waterTank);
  const tankGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const tankMaterial = new THREE.MeshLambertMaterial({ color: 0x6b5340 });
  group.add(
    boxes(
      "water-tanks",
      tankMaterial,
      tanks.map((building) => ({
        x: building.minX + (building.maxX - building.minX) * 0.7,
        y: building.height + 1.6,
        z: building.minZ + (building.maxZ - building.minZ) * 0.35,
        sx: 3,
        sy: 3.2,
        sz: 3,
      })),
      tankGeometry,
    ),
  );
}

/** Ground, road, both pavements, and the paint on the road. */
function addGround(group: THREE.Group, layout: OfficeLayout, street: StreetSpec): void {
  const { road } = street;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshLambertMaterial({ color: CITY_GROUND }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.scale.set(600, 600, 1);
  ground.position.set(road.minX, ROAD_Y - 0.05, (road.minZ + road.maxZ) / 2);
  ground.name = "city-ground";
  // Drawn after everything else opaque, so the depth test throws away the
  // great part of it that lies under the office floor and the road instead of
  // shading it first.
  ground.renderOrder = 1;
  group.add(ground);

  const asphalt = new THREE.MeshLambertMaterial({ color: ASPHALT });
  group.add(slab(road, ROAD_Y - 0.04, ROAD_Y, asphalt, "road"));

  // Each pavement is a slab whose top is the office floor's level; its side
  // facing the road is the kerb.
  const pavement = new THREE.MeshLambertMaterial({ color: PAVEMENT });
  group.add(
    slab({ minX: layout.floor.maxX, minZ: road.minZ, maxX: road.minX, maxZ: road.maxZ }, ROAD_Y - 0.04, 0, pavement, "pavement-near"),
    slab({ minX: road.maxX, minZ: road.minZ, maxX: street.farFrontX + 1, maxZ: road.maxZ }, ROAD_Y - 0.04, 0, pavement, "pavement-far"),
  );

  const white = new THREE.MeshBasicMaterial({ color: LINE_WHITE });
  const yellow = new THREE.MeshBasicMaterial({ color: LINE_YELLOW });
  const southbound = street.lanes.filter((lane) => lane.direction === 1).map((lane) => lane.x);
  const northbound = street.lanes.filter((lane) => lane.direction === -1).map((lane) => lane.x);
  const centreX = (Math.max(...southbound) + Math.min(...northbound)) / 2;
  const stopSouthbound = road.minZ + stopLineAt(street, 1);
  const stopNorthbound = road.maxZ - stopLineAt(street, -1);
  const paint = 0.005;

  // The double yellow down the middle, broken for the crossing.
  const yellowLines = [-0.15, 0.15].flatMap((offset) => [
    { x: centreX + offset, y: PAINT_Y, z: (road.minZ + stopSouthbound) / 2, sx: 0.12, sy: paint, sz: stopSouthbound - road.minZ },
    { x: centreX + offset, y: PAINT_Y, z: (stopNorthbound + road.maxZ) / 2, sx: 0.12, sy: paint, sz: road.maxZ - stopNorthbound },
  ]);
  group.add(boxes("centre-line", yellow, yellowLines));

  // Dashes between the lanes that run the same way, and the stop lines.
  const dashes: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] = [];
  for (const lanes of [southbound, northbound]) {
    const sorted = [...lanes].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index += 1) {
      const x = ((sorted[index - 1] ?? 0) + (sorted[index] ?? 0)) / 2;
      for (let z = road.minZ + 2; z < road.maxZ - 2; z += 9) {
        if (z + 3 > stopSouthbound && z < stopNorthbound) {
          continue;
        }
        dashes.push({ x, y: PAINT_Y, z: z + 1.5, sx: 0.12, sy: paint, sz: 3 });
      }
    }
  }
  for (const [lanes, z] of [
    [southbound, stopSouthbound],
    [northbound, stopNorthbound],
  ] as const) {
    const minX = Math.min(...lanes) - 1.3;
    const maxX = Math.max(...lanes) + 1.3;
    dashes.push({ x: (minX + maxX) / 2, y: PAINT_Y, z, sx: maxX - minX, sy: paint, sz: 0.4 });
  }
  // The zebra across the whole road, outside the main entrance.
  for (let x = road.minX + 0.6; x < road.maxX - 0.3; x += 1.2) {
    dashes.push({ x, y: PAINT_Y, z: street.crossingZ, sx: 0.6, sy: paint, sz: CROSSING_HALF_WIDTH * 2 });
  }
  group.add(boxes("road-paint", white, dashes));
}

/** Street lamps down both kerbs, their heads lit at night. */
function addLamps(group: THREE.Group, street: StreetSpec, head: THREE.MeshLambertMaterial): void {
  const metal = new THREE.MeshLambertMaterial({ color: STREET_METAL });
  const { road } = street;
  const poles: { x: number; y: number; z: number; sx: number; sy: number; sz: number }[] = [];
  const arms: typeof poles = [];
  const heads: typeof poles = [];
  for (const [kerbX, reachOut] of [
    [road.minX - 0.15, 1],
    [road.maxX + 0.35, -1],
  ] as const) {
    for (let z = road.minZ + LAMP_SPACING / 2; z < road.maxZ; z += LAMP_SPACING) {
      // Clear of the crossing, where the traffic lights stand.
      if (Math.abs(z - street.crossingZ) < 5) {
        continue;
      }
      poles.push({ x: kerbX, y: LAMP_HEIGHT / 2, z, sx: 0.14, sy: LAMP_HEIGHT, sz: 0.14 });
      arms.push({ x: kerbX + reachOut * 0.8, y: LAMP_HEIGHT, z, sx: 1.6, sy: 0.1, sz: 0.1 });
      heads.push({ x: kerbX + reachOut * 1.5, y: LAMP_HEIGHT - 0.12, z, sx: 0.6, sy: 0.16, sz: 0.32 });
    }
  }
  group.add(boxes("lamp-poles", metal, poles), boxes("lamp-arms", metal, arms), boxes("lamp-heads", head, heads));
}

/** The three lamp materials of the traffic signals, shared by every head. */
interface SignalLamps {
  readonly stop: THREE.MeshLambertMaterial;
  readonly amber: THREE.MeshLambertMaterial;
  readonly go: THREE.MeshLambertMaterial;
}

function lampMaterial(colour: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color: 0x222222, emissive: colour, emissiveIntensity: SIGNAL_OFF });
}

/**
 * A traffic signal each side of the crossing, on a mast arm over the lanes it
 * stops and facing the traffic coming at it.
 */
function addSignals(group: THREE.Group, street: StreetSpec): SignalLamps {
  const lamps: SignalLamps = { stop: lampMaterial(0xff2a1a), amber: lampMaterial(0xffa21a), go: lampMaterial(0x2aff7a) };
  const metal = new THREE.MeshLambertMaterial({ color: STREET_METAL });
  const housing = new THREE.MeshLambertMaterial({ color: 0x1a1b1d });
  const { road } = street;
  const mastHeight = 5.4;

  for (const direction of [1, -1] as const) {
    const lanes = street.lanes.filter((lane) => lane.direction === direction).map((lane) => lane.x);
    const overX = (Math.min(...lanes) + Math.max(...lanes)) / 2;
    // On the kerb at the driver's right, just short of the crossing.
    const kerbX = direction === 1 ? road.minX - 0.15 : road.maxX + 0.35;
    const z = street.crossingZ - direction * (CROSSING_HALF_WIDTH + 0.5);
    const facing = -direction;

    group.add(slab({ minX: kerbX - 0.1, minZ: z - 0.1, maxX: kerbX + 0.1, maxZ: z + 0.1 }, 0, mastHeight, metal, "signal-pole"));
    const armMin = Math.min(kerbX, overX);
    const armMax = Math.max(kerbX, overX);
    group.add(slab({ minX: armMin, minZ: z - 0.06, maxX: armMax, maxZ: z + 0.06 }, mastHeight - 0.12, mastHeight, metal, "signal-arm"));
    const headTop = mastHeight - 0.12;
    group.add(slab({ minX: overX - 0.22, minZ: z - 0.18, maxX: overX + 0.22, maxZ: z + 0.18 }, headTop - 1.15, headTop, housing, "signal-head"));
    // The three lamps on the face towards the traffic, red at the top.
    const faceZ = z + facing * 0.19;
    ([
      [lamps.stop, headTop - 0.22],
      [lamps.amber, headTop - 0.57],
      [lamps.go, headTop - 0.92],
    ] as const).forEach(([material, y]) => {
      group.add(slab({ minX: overX - 0.13, minZ: faceZ - 0.02, maxX: overX + 0.13, maxZ: faceZ + 0.02 }, y - 0.13, y + 0.13, material, "signal-lamp"));
    });
  }
  return lamps;
}

function textTexture(text: string, background: string, foreground: string): THREE.CanvasTexture {
  const element = document.createElement("canvas");
  element.width = 512;
  element.height = 128;
  const context = element.getContext("2d");
  if (context !== null) {
    context.fillStyle = background;
    context.fillRect(0, 0, element.width, element.height);
    context.fillStyle = foreground;
    context.font = "bold 64px 'Helvetica Neue', Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, element.width / 2, element.height / 2 + 4, element.width - 40);
  }
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** The office's name, over the way in. */
const OFFICE_SIGN = "AGENT OFFICE";

/**
 * A canopy over the main entrance with the office's name on it, and the same
 * name on the wall behind reception, so the way in reads from the street and
 * the counter from the door.
 */
function addEntrance(group: THREE.Group, layout: OfficeLayout): void {
  const door = layout.doorways.find((doorway) => doorway.connects.includes(SIDEWALK_ROOM_ID));
  if (door === undefined) {
    return;
  }
  const sign = new THREE.MeshLambertMaterial({ map: textTexture(OFFICE_SIGN, "#1f3b2d", "#f4efe2") });
  const canopy = new THREE.MeshLambertMaterial({ color: CANOPY_GREEN });
  // The canopy sticks out from the street face of the wall the door is in.
  const face = layout.floor.maxX;
  const out = 1.5;
  const halfWidth = door.width / 2 + 0.6;
  group.add(
    slab({ minX: face, minZ: door.centre.z - halfWidth, maxX: face + out, maxZ: door.centre.z + halfWidth }, 2.62, 3.05, canopy, "entrance-canopy"),
  );
  const canopySign = new THREE.Mesh(new THREE.PlaneGeometry(halfWidth * 1.8, 0.36), sign);
  canopySign.position.set(face + out + 0.01, 2.835, door.centre.z);
  canopySign.rotation.y = Math.PI / 2;
  canopySign.name = "entrance-sign";
  group.add(canopySign);

  const reception = layout.props.find((spec) => spec.kind === "reception");
  if (reception !== undefined) {
    const wallBehind = behind(layout, reception);
    if (wallBehind !== undefined) {
      const lobbySign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), sign);
      lobbySign.position.set(wallBehind.x, 2.05, wallBehind.z);
      lobbySign.rotation.y = reception.yaw + Math.PI;
      lobbySign.name = "reception-sign";
      group.add(lobbySign);
    }
  }
}

/**
 * The face of the wall at a prop's back, a centimetre proud of it, or
 * `undefined` if no wall is within two metres.
 */
function behind(layout: OfficeLayout, spec: PropSpec): { x: number; z: number } | undefined {
  const backX = Math.sin(spec.yaw);
  const backZ = Math.cos(spec.yaw);
  for (let distance = spec.depth / 2; distance < 2; distance += 0.01) {
    const point = { x: spec.x + backX * distance, z: spec.z + backZ * distance };
    if (layout.walls.some((wall) => containsPoint(wall.footprint, point))) {
      const proud = distance - 0.02;
      return { x: spec.x + backX * proud, z: spec.z + backZ * proud };
    }
  }
  return undefined;
}

/** The parts every car is built from, each one instanced mesh for the whole street. */
interface CarParts {
  readonly wheels: THREE.InstancedMesh;
  readonly body: THREE.InstancedMesh;
  readonly cabin: THREE.InstancedMesh;
  readonly roofSign: THREE.InstancedMesh;
  readonly headlights: THREE.InstancedMesh;
  readonly taillights: THREE.InstancedMesh;
}

/** Where each part sits in a car's own frame, which faces -Z like everything else. */
function partMatrices(car: Car): Record<keyof CarParts, THREE.Matrix4> {
  const length = car.length;
  const local = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
  return {
    wheels: local(0, 0.28, 0, 1.86, 0.56, length * 0.72),
    body: local(0, 0.64, 0, 1.8, 0.64, length),
    cabin: local(0, 1.22, length * 0.06, 1.6, 0.54, length * 0.5),
    // Only a cab has the lit sign on its roof; everyone else's is squashed to nothing.
    roofSign: car.cab ? local(0, 1.58, length * 0.06, 0.6, 0.2, 0.3) : local(0, 0, 0, 0, 0, 0),
    headlights: local(0, 0.74, -length / 2 - 0.01, 1.5, 0.14, 0.04),
    taillights: local(0, 0.74, length / 2 + 0.01, 1.5, 0.14, 0.04),
  };
}

function addCars(group: THREE.Group, traffic: Traffic): { parts: CarParts; lights: THREE.MeshLambertMaterial[] } {
  const count = traffic.cars.length;
  const make = (name: string, material: THREE.Material) => {
    const mesh = new THREE.InstancedMesh(UNIT_BOX, material, count);
    mesh.name = name;
    // The cars move every frame, so a bounding sphere worked out once would
    // cull them in the wrong places.
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };
  const headlight = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xfff3d6, emissiveIntensity: HEADLIGHT_GLOW.day });
  const taillight = new THREE.MeshLambertMaterial({ color: 0x550000, emissive: 0xff2010, emissiveIntensity: HEADLIGHT_GLOW.day });
  const parts: CarParts = {
    wheels: make("car-wheels", new THREE.MeshLambertMaterial({ color: 0x141517 })),
    body: make("car-bodies", new THREE.MeshLambertMaterial({ color: 0xffffff })),
    cabin: make("car-cabins", new THREE.MeshLambertMaterial({ color: 0x263038 })),
    roofSign: make("cab-signs", new THREE.MeshLambertMaterial({ color: 0xfff6d0, emissive: 0xfff0b0, emissiveIntensity: 0.3 })),
    headlights: make("car-headlights", headlight),
    taillights: make("car-taillights", taillight),
  };
  const colour = new THREE.Color();
  traffic.cars.forEach((car, index) => parts.body.setColorAt(index, colour.setHex(car.colour)));
  if (parts.body.instanceColor !== null) {
    parts.body.instanceColor.needsUpdate = true;
  }
  return { parts, lights: [headlight, taillight] };
}

/**
 * Builds the street round a layout's front, or nothing for a layout with no
 * street.
 */
export function buildStreet(scene: THREE.Scene, layout: OfficeLayout): StreetView | undefined {
  const { street } = layout;
  if (street === undefined) {
    return undefined;
  }
  const group = new THREE.Group();
  group.name = "street";

  addGround(group, layout, street);
  const windows: THREE.MeshLambertMaterial[] = [];
  addBuildings(group, layout, windows);
  const lampHead = new THREE.MeshLambertMaterial({ color: 0xd8d4c8, emissive: 0xffd28a, emissiveIntensity: 0 });
  addLamps(group, street, lampHead);
  const signals = addSignals(group, street);
  addEntrance(group, layout);

  const traffic = createTraffic(street);
  const { parts, lights } = addCars(group, traffic);
  const locals = traffic.cars.map(partMatrices);
  const world = new THREE.Matrix4();
  const part = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const partNames = Object.keys(parts) as (keyof CarParts)[];

  let shownPhase: SignalPhase | undefined;
  let shownNight = -1;

  const placeCars = () => {
    traffic.cars.forEach((car, index) => {
      const pose = carPose(street, car);
      world.compose(position.set(pose.x, ROAD_Y, pose.z), turn.setFromAxisAngle(up, pose.yaw), one);
      const local = locals[index];
      if (local === undefined) {
        return;
      }
      for (const name of partNames) {
        parts[name].setMatrixAt(index, part.multiplyMatrices(world, local[name]));
      }
    });
    for (const name of partNames) {
      parts[name].instanceMatrix.needsUpdate = true;
    }
  };
  placeCars();

  scene.add(group);

  return {
    group,
    update(deltaSeconds, night) {
      stepTraffic(traffic, street, Math.min(deltaSeconds, MAX_TRAFFIC_STEP));
      placeCars();

      const phase = signalAt(traffic.seconds);
      if (phase !== shownPhase) {
        shownPhase = phase;
        signals.stop.emissiveIntensity = phase === "stop" ? SIGNAL_ON : SIGNAL_OFF;
        signals.amber.emissiveIntensity = phase === "amber" ? SIGNAL_ON : SIGNAL_OFF;
        signals.go.emissiveIntensity = phase === "go" ? SIGNAL_ON : SIGNAL_OFF;
      }
      // Only when the light has moved enough to see: these are uniforms, but
      // there is no reason to touch them every frame of a steady afternoon.
      if (Math.abs(night - shownNight) > 0.005) {
        shownNight = night;
        for (const material of windows) {
          material.emissiveIntensity = night * WINDOW_GLOW;
        }
        lampHead.emissiveIntensity = night * LAMP_GLOW;
        for (const material of lights) {
          material.emissiveIntensity = HEADLIGHT_GLOW.day + night * (HEADLIGHT_GLOW.night - HEADLIGHT_GLOW.day);
        }
      }
    },
  };
}
