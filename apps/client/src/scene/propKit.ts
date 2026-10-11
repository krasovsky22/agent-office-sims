/**
 * The prop asset kit: one model per {@link AssetPropKind}, loaded and normalised.
 *
 * This module is the whole of what the client knows about the asset pack — the
 * six files, which kind each one draws, and which way round each one happens to
 * have been authored. Everything downstream works in metres with the prop's
 * footprint centred on its position, because models arrive here in neither of
 * those conventions and leave in both.
 *
 * Provenance and licence for the pack live in `../assets/office-kit/README.md`.
 * It is a CC0 kit by Kenney; adding a model means adding a row there too.
 *
 * Normalising up front is what makes instancing possible. A loaded GLTF is a
 * little tree of nodes with their own transforms, which cannot be instanced; what
 * can be is a flat list of (geometry, material) pairs with the node transforms
 * already baked into the vertices. That is what a {@link PropModel} is.
 */

import type { AssetPropKind } from "@sim/shared";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import chairUrl from "../assets/office-kit/chairDesk.glb?url";
import monitorUrl from "../assets/office-kit/computerScreen.glb?url";
import deskUrl from "../assets/office-kit/desk.glb?url";
import doorUrl from "../assets/office-kit/doorwayOpen.glb?url";
import coffeeUrl from "../assets/office-kit/kitchenCoffeeMachine.glb?url";
import plantUrl from "../assets/office-kit/pottedPlant.glb?url";

/**
 * Metres per kit unit.
 *
 * The pack is authored at roughly half scale: its desk is 0.38 units tall, its
 * door frame 1.01. Doubling puts a desk at 0.77 m and a door at 2.02 m, which is
 * the office this game is set in. Measured once, here, rather than written into
 * any individual model's entry.
 */
const KIT_SCALE = 2;

/**
 * One drawable piece of a model: geometry in metres, centred on its footprint,
 * standing on y = 0, paired with the material the pack gave it.
 */
export interface PropPart {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
}

export interface PropModel {
  readonly kind: AssetPropKind;
  /** One entry per material in the model. This is the batch count for the kind. */
  readonly parts: readonly PropPart[];
  /** Natural size in metres, which `AssetPropSpec.fit` is measured against. */
  readonly size: THREE.Vector3;
}

export type PropKit = ReadonlyMap<AssetPropKind, PropModel>;

interface KitEntry {
  readonly url: string;
  /**
   * Turn applied to the model before anything else, so that the normalised model
   * faces -Z like every other yaw in this codebase.
   *
   * This is a fact about how the pack was exported, not about the office, which
   * is why it lives here and not in the shared layout.
   */
  readonly yawOffset: number;
}

const HALF_TURN = Math.PI;

/**
 * The registry. The layout names a kind; this says which file draws it.
 *
 * The pack models desks and chairs looking along +Z and screens looking along
 * -Z, so the first two are turned and the rest are not.
 */
const KIT: Readonly<Record<AssetPropKind, KitEntry>> = {
  desk: { url: deskUrl, yawOffset: HALF_TURN },
  chair: { url: chairUrl, yawOffset: HALF_TURN },
  monitor: { url: monitorUrl, yawOffset: 0 },
  plant: { url: plantUrl, yawOffset: 0 },
  door: { url: doorUrl, yawOffset: 0 },
  coffee: { url: coffeeUrl, yawOffset: HALF_TURN },
};

/** Every kind the kit supplies, for callers that want to preload or report. */
export const PROP_KINDS = Object.keys(KIT) as readonly AssetPropKind[];

function materialOf(mesh: THREE.Mesh): THREE.Material | undefined {
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
}

/**
 * Flattens a loaded GLTF into instanceable parts.
 *
 * Three passes, because the centring offset cannot be known until every vertex
 * has been placed: bake each mesh's world transform (plus the kit scale and the
 * entry's yaw) into a cloned geometry, measure the result, then shift everything
 * so the footprint's centre is the origin and the base is y = 0.
 */
function normalise(kind: AssetPropKind, root: THREE.Object3D, yawOffset: number): PropModel {
  root.updateWorldMatrix(false, true);

  const bake = new THREE.Matrix4()
    .makeRotationY(yawOffset)
    .multiply(new THREE.Matrix4().makeScale(KIT_SCALE, KIT_SCALE, KIT_SCALE));
  const intoRoot = root.matrixWorld.clone().invert();

  const baked: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    const material = materialOf(node);
    if (material === undefined) {
      return;
    }
    const geometry = node.geometry.clone();
    geometry.applyMatrix4(bake.clone().multiply(intoRoot.clone().multiply(node.matrixWorld)));
    geometry.computeBoundingBox();
    baked.push({ geometry, material });
  });

  if (baked.length === 0) {
    throw new Error(`the ${kind} model contains no meshes`);
  }

  const bounds = new THREE.Box3();
  for (const part of baked) {
    if (part.geometry.boundingBox !== null) {
      bounds.union(part.geometry.boundingBox);
    }
  }

  const offsetX = -(bounds.min.x + bounds.max.x) / 2;
  const offsetZ = -(bounds.min.z + bounds.max.z) / 2;
  for (const part of baked) {
    part.geometry.translate(offsetX, -bounds.min.y, offsetZ);
    part.geometry.computeBoundingSphere();
  }

  return {
    kind,
    parts: mergeByMaterial(baked),
    size: bounds.getSize(new THREE.Vector3()),
  };
}

/**
 * Collapses the parts that share a material into one geometry each.
 *
 * A GLTF primitive is one mesh per material *per node*, so a chair whose seat and
 * frame are both painted metal arrives as two meshes that could be one. Merging
 * them means one fewer instanced draw for every chair in the office at once. The
 * pack's geometries all carry the same attributes, so the merge always succeeds;
 * the fallback is there so a model that breaks that assumption still draws.
 */
function mergeByMaterial(
  baked: readonly { geometry: THREE.BufferGeometry; material: THREE.Material }[],
): PropPart[] {
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const part of baked) {
    const group = groups.get(part.material);
    if (group === undefined) {
      groups.set(part.material, [part.geometry]);
    } else {
      group.push(part.geometry);
    }
  }

  const parts: PropPart[] = [];
  for (const [material, geometries] of groups) {
    const first = geometries[0];
    if (first === undefined) {
      continue;
    }
    if (geometries.length === 1) {
      parts.push({ geometry: first, material });
      continue;
    }
    const merged = mergeGeometries(geometries);
    if (merged === null) {
      for (const geometry of geometries) {
        parts.push({ geometry, material });
      }
      continue;
    }
    merged.computeBoundingSphere();
    for (const geometry of geometries) {
      geometry.dispose();
    }
    parts.push({ geometry: merged, material });
  }
  return parts;
}

/**
 * Loads every model in the registry.
 *
 * All six at once and all-or-nothing: the caller shows one loading state and then
 * furnishes the office in a single frame, rather than watching it assemble. The
 * whole kit is 85 KB of untextured geometry, so there is nothing to gain from
 * streaming it and a half-built office to lose.
 *
 * Rejects if any model fails, which is the signal to fall back to grey boxes.
 */
export async function loadPropKit(): Promise<PropKit> {
  const loader = new GLTFLoader();
  const loaded = await Promise.all(
    PROP_KINDS.map(async (kind) => {
      const entry = KIT[kind];
      const gltf = await loader.loadAsync(entry.url);
      return normalise(kind, gltf.scene, entry.yawOffset);
    }),
  );
  return new Map(loaded.map((model) => [model.kind, model]));
}

/** Releases every GPU buffer the kit holds. */
export function disposePropKit(kit: PropKit): void {
  const materials = new Set<THREE.Material>();
  for (const model of kit.values()) {
    for (const part of model.parts) {
      part.geometry.dispose();
      materials.add(part.material);
    }
  }
  for (const material of materials) {
    material.dispose();
  }
}
