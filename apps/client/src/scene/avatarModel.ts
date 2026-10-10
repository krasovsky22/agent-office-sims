/**
 * Loading the humanoid model once, and stamping a body out of it per occupant.
 *
 * One download, one copy of the geometry and one copy of the materials, however
 * many people are in the office: `SkeletonUtils.clone` gives each body its own
 * skeleton and its own node transforms while sharing everything the GPU holds.
 * That is what keeps twenty avatars affordable.
 *
 * The load is allowed to fail. Nothing here throws anything the caller cannot
 * handle by leaving the avatar as the capsule it was built as.
 */

import { OCCUPANT_HEIGHT } from "@sim/shared";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

import { type AvatarClips, buildAvatarClips } from "./avatarClips.js";

/** Where the model lives, relative to the client's base URL. */
export const AVATAR_MODEL_PATH = "models/RobotExpressive.glb";

/**
 * Half turn applied to the model so its face points the way yaw 0 does.
 *
 * The asset was authored facing +Z, which is measurable from the walk cycle:
 * through the stance phase the planted foot travels toward -Z, and a planted
 * foot travels opposite to the direction of travel. Project yaw 0 faces -Z.
 */
const MODEL_FACING_YAW = Math.PI;

/** How much brighter the local player's own body is, so you can spot yourself. */
const LOCAL_BODY_BRIGHTNESS = 1.35;

/** A body ready to be added to an avatar's group, with the clips that drive it. */
export interface AvatarModelInstance {
  readonly root: THREE.Object3D;
  readonly clips: AvatarClips;
  /** Releases only what this instance owns; the shared template is untouched. */
  dispose: () => void;
}

export interface AvatarModel {
  /** @param brighten whether this is the local player's own body. */
  createInstance: (brighten: boolean) => AvatarModelInstance;
}

/**
 * Downloads and prepares the avatar model.
 *
 * @param baseUrl the client's base URL, so a deployment under a sub-path still
 * finds the asset.
 */
export async function loadAvatarModel(baseUrl: string): Promise<AvatarModel> {
  const gltf = await new GLTFLoader().loadAsync(`${baseUrl}${AVATAR_MODEL_PATH}`);
  const template = standAtOrigin(gltf.scene);
  const clips = buildAvatarClips(template, gltf.animations);

  return {
    createInstance: (brighten: boolean): AvatarModelInstance => {
      const root = cloneSkinned(template);
      const owned = brighten ? brightenMaterials(root) : [];
      return {
        root,
        clips,
        dispose: () => {
          root.removeFromParent();
          for (const material of owned) {
            material.dispose();
          }
        },
      };
    },
  };
}

/**
 * Scales the model to an occupant's height and stands it on the floor, facing
 * forward.
 *
 * Done to the template once rather than to each body, and read from the model's
 * own bounds rather than written down, so swapping the asset for a differently
 * proportioned one does not need a number here changed. The clips drive bones
 * below this wrapper, so none of them fight it.
 */
function standAtOrigin(model: THREE.Object3D): THREE.Object3D {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const height = bounds.max.y - bounds.min.y;

  model.position.y -= bounds.min.y;

  const body = new THREE.Group();
  body.name = "avatar-body";
  body.add(model);
  body.scale.setScalar(height > 0 ? OCCUPANT_HEIGHT / height : 1);
  body.rotation.y = MODEL_FACING_YAW;
  return body;
}

/**
 * Gives one body its own, lighter, copy of the shared materials.
 *
 * Paid for by exactly one avatar — the local player's — so the office still
 * renders from a single material set.
 *
 * @returns the materials this body now owns and has to dispose.
 */
function brightenMaterials(root: THREE.Object3D): THREE.Material[] {
  const copies = new Map<THREE.Material, THREE.Material>();

  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    const source: unknown = node.material;
    if (!(source instanceof THREE.Material)) {
      return;
    }
    let copy = copies.get(source);
    if (copy === undefined) {
      copy = source.clone();
      if ("color" in copy && copy.color instanceof THREE.Color) {
        copy.color.multiplyScalar(LOCAL_BODY_BRIGHTNESS);
      }
      copies.set(source, copy);
    }
    node.material = copy;
  });

  return [...copies.values()];
}
