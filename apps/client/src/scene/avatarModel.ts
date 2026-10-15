/**
 * Loading the humanoid model once, and stamping a body out of it per occupant.
 *
 * One download, one copy of the geometry and one copy of the materials, however
 * many people are in the office: `SkeletonUtils.clone` gives each body its own
 * skeleton and its own node transforms while sharing everything the GPU holds.
 * That is what keeps twenty avatars affordable.
 *
 * Bodies come in four looks. A remote player wears the model as authored; the
 * local player gets a lighter copy of its materials, so you can spot yourself;
 * every agent shares one recoloured copy of the shell, so an agent is never
 * mistaken for a person and a floor of them costs one extra material, not one
 * per agent; a simulated agent employee wears that shell over one shared
 * translucent copy of every material, so it reads as a ghost of an agent that
 * is doing nothing real; every live coding agent shares another shell, in a
 * colour of its own, so a real agent is told apart from a simulated one too;
 * and the AI manager wears a third, so the one in charge is picked out at once.
 *
 * The load is allowed to fail. Nothing here throws anything the caller cannot
 * handle by leaving the avatar as the capsule it was built as.
 */

import { DESK_CHAIR, OCCUPANT_HEIGHT } from "@sim/shared";
import * as THREE from "three";
import { type GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

import { type AvatarClips, buildAvatarClips, sourceSeatedClip } from "./avatarClips.js";
import { measureSeatPlacement } from "./avatarSeat.js";

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

/**
 * The material that makes up the robot's shell, and so its colour at a glance.
 *
 * A fact about this asset, like the clip names in `avatarClips.ts`: the model's
 * three materials are `Main` (the orange shell), `Grey` and `Black`. A swapped
 * asset without one leaves agents in the player colours, still told apart by
 * their nameplates and badges.
 */
const SHELL_MATERIAL_NAME = "Main";

/** The agents' shell: teal, as far from the players' orange as the wheel goes. */
const AGENT_SHELL_COLOUR = 0x2bb3a3;

/**
 * How opaque a simulated agent employee's body is.
 *
 * See-through is the one look that reads as "not really here" from across the
 * open floor without changing its shape or its colour.
 */
export const SIMULATED_BODY_OPACITY = 0.45;

/** A live coding agent's shell: violet, clear of both the players and the agent employees. */
const LIVE_AGENT_SHELL_COLOUR = 0x8a6cf0;

/** The AI manager's shell: crimson, the one body in the office in charge of the rest. */
const MANAGER_SHELL_COLOUR = 0xcf3d4f;

/** Which coat of paint a body is stamped out with. */
export type AvatarLook = "local" | "remote" | "agent" | "simulated-agent" | "liveAgent" | "manager";

/** A body ready to be added to an avatar's group, with the clips that drive it. */
export interface AvatarModelInstance {
  readonly root: THREE.Object3D;
  readonly clips: AvatarClips;
  /** How far the crown sits below a standing one's once seated in a chair. */
  readonly seatedHeadDrop: number;
  /** Releases only what this instance owns; the shared template is untouched. */
  dispose: () => void;
}

export interface AvatarModel {
  createInstance: (look: AvatarLook) => AvatarModelInstance;
}

/**
 * Downloads and prepares the avatar model.
 *
 * @param baseUrl the client's base URL, so a deployment under a sub-path still
 * finds the asset.
 */
export async function loadAvatarModel(baseUrl: string): Promise<AvatarModel> {
  return prepareAvatarModel(await new GLTFLoader().loadAsync(`${baseUrl}${AVATAR_MODEL_PATH}`));
}

/** Prepares a loaded model for stamping bodies out of it. */
export function prepareAvatarModel(gltf: GLTF): AvatarModel {
  const template = standAtOrigin(gltf.scene);
  const seat = measureSeatPlacement(template, sourceSeatedClip(gltf.animations), DESK_CHAIR);
  const clips = buildAvatarClips(template, gltf.animations, seat);

  // Made on the first agent of each look and shared by every one after it, for
  // the life of the page, like the template's own materials.
  const agentPaint = new Map<THREE.Material, THREE.Material>();
  const simulatedAgentPaint = new Map<THREE.Material, THREE.Material>();
  const liveAgentPaint = new Map<THREE.Material, THREE.Material>();
  const managerPaint = new Map<THREE.Material, THREE.Material>();

  return {
    createInstance: (look: AvatarLook): AvatarModelInstance => {
      const root = cloneSkinned(template);
      let owned: THREE.Material[] = [];
      if (look === "local") {
        owned = repaint(root, new Map(), brighten);
      } else if (look === "agent") {
        repaint(root, agentPaint, paintAgentShell);
      } else if (look === "simulated-agent") {
        repaint(root, simulatedAgentPaint, paintSimulatedAgent);
      } else if (look === "liveAgent") {
        repaint(root, liveAgentPaint, paintLiveAgentShell);
      } else if (look === "manager") {
        repaint(root, managerPaint, paintManagerShell);
      }
      return {
        root,
        clips,
        seatedHeadDrop: seat.headDrop,
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
export function standAtOrigin(model: THREE.Object3D): THREE.Object3D {
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
 * Makes a recoloured copy of a template material, or declines to.
 *
 * @returns the copy, or `undefined` to leave the body on the shared original.
 */
type MaterialPaint = (source: THREE.Material) => THREE.Material | undefined;

/** The local player's paint: every material, lighter. */
const brighten: MaterialPaint = (source) => {
  const copy = source.clone();
  if ("color" in copy && copy.color instanceof THREE.Color) {
    copy.color.multiplyScalar(LOCAL_BODY_BRIGHTNESS);
  }
  return copy;
};

/** Paints the shell one colour, leaving everything else shared. */
function paintShell(colour: number): MaterialPaint {
  return (source) => {
    if (source.name !== SHELL_MATERIAL_NAME) {
      return undefined;
    }
    const copy = source.clone();
    if ("color" in copy && copy.color instanceof THREE.Color) {
      copy.color.set(colour);
    }
    return copy;
  };
}

/** The agent employees' paint. */
const paintAgentShell = paintShell(AGENT_SHELL_COLOUR);

/** The live coding agents' paint. */
const paintLiveAgentShell = paintShell(LIVE_AGENT_SHELL_COLOUR);

/** The AI manager's paint. */
const paintManagerShell = paintShell(MANAGER_SHELL_COLOUR);

/** A simulated agent's paint: the agents' shell, and the whole body translucent. */
const paintSimulatedAgent: MaterialPaint = (source) => {
  const copy = paintAgentShell(source) ?? source.clone();
  markSimulated(copy);
  return copy;
};

/** Makes a material see-through, the way every simulated agent's body is. */
export function markSimulated(material: THREE.Material): void {
  material.transparent = true;
  material.opacity = SIMULATED_BODY_OPACITY;
}

/**
 * Swaps a body's materials for painted copies, reusing any already in `copies`.
 *
 * Pass a fresh map to give one body copies of its own, or a long-lived one to
 * share a paint across every body that wears it.
 *
 * @returns the copies this call made, which whoever owns `copies` disposes.
 */
function repaint(
  root: THREE.Object3D,
  copies: Map<THREE.Material, THREE.Material>,
  paint: MaterialPaint,
): THREE.Material[] {
  const made: THREE.Material[] = [];

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
      copy = paint(source);
      if (copy !== undefined) {
        copies.set(source, copy);
        made.push(copy);
      }
    }
    if (copy !== undefined) {
      node.material = copy;
    }
  });

  return made;
}
