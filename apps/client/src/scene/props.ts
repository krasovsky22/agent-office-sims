/**
 * Draws the shared layout's props as instanced meshes.
 *
 * One `InstancedMesh` per kind per material, which is where this milestone's
 * render budget goes: sixteen desks are one draw call with sixteen matrices, not
 * sixteen draw calls, so the floor can be populated without the cost following.
 * The grouping is {@link groupPropsByKind}, in the shared package, where it has a
 * test asserting the batch count does not grow with the prop count.
 *
 * Nothing here decides where anything goes. Every position, rotation, and size
 * arrives in the {@link PropSpec} list; this file only turns specs into matrices.
 */

import { type PropSpec, groupPropsByKind } from "@sim/shared";
import * as THREE from "three";

import type { PropKit } from "./propKit.js";

const UP = new THREE.Vector3(0, 1, 0);

/** Guard against dividing by a degenerate model dimension. */
const MIN_MODEL_EXTENT = 1e-6;

export interface PropsView {
  readonly group: THREE.Group;
  /**
   * Instanced meshes added, which is also the draw calls the props cost.
   *
   * Reported so the running client can show it — the issue's acceptance for
   * instancing is a draw-call count that does not scale with desk count, and this
   * is the number to watch while walking the office.
   */
  readonly drawCalls: number;
  /** Props placed, so the two numbers can be compared at a glance. */
  readonly instances: number;
  dispose(): void;
}

/**
 * Per-axis scale that turns a model's natural size into the size a spec asks for.
 *
 * `fit` is an exact box the prop has to agree with — a desk's collision
 * footprint, a doorway's gap — so it wins and stretches each axis independently.
 * `scale` is a plain multiplier for a prop the kit models at the wrong size.
 * Neither means the model is drawn as authored.
 */
function scaleFor(spec: PropSpec, size: THREE.Vector3, into: THREE.Vector3): THREE.Vector3 {
  if (spec.fit !== undefined) {
    return into.set(
      size.x > MIN_MODEL_EXTENT ? spec.fit.width / size.x : 1,
      size.y > MIN_MODEL_EXTENT ? spec.fit.height / size.y : 1,
      size.z > MIN_MODEL_EXTENT ? spec.fit.depth / size.z : 1,
    );
  }
  const uniform = spec.scale ?? 1;
  return into.set(uniform, uniform, uniform);
}

/**
 * Builds the prop meshes and parents them under one group.
 *
 * Props cast shadows and receive them; walls and the floor slab are handled in
 * `office.ts`. A kind with no model in the kit is skipped rather than fatal, so a
 * layout that grows a kind ahead of its asset still renders everything else.
 */
export function buildProps(
  parent: THREE.Object3D,
  specs: readonly PropSpec[],
  kit: PropKit,
): PropsView {
  const group = new THREE.Group();
  group.name = "props";

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  let drawCalls = 0;
  let instances = 0;

  for (const [kind, batch] of groupPropsByKind(specs)) {
    const model = kit.get(kind);
    if (model === undefined || batch.length === 0) {
      continue;
    }

    const meshes = model.parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, batch.length);
      mesh.name = `props-${kind}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    });

    batch.forEach((spec, index) => {
      position.set(spec.x, spec.y, spec.z);
      rotation.setFromAxisAngle(UP, spec.yaw);
      matrix.compose(position, rotation, scaleFor(spec, model.size, scale));
      for (const mesh of meshes) {
        mesh.setMatrixAt(index, matrix);
      }
    });

    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      // Culling an instanced mesh needs a sphere around every instance, not
      // around the one geometry they share.
      mesh.computeBoundingSphere();
      group.add(mesh);
    }

    drawCalls += meshes.length;
    instances += batch.length;
  }

  parent.add(group);

  return {
    group,
    drawCalls,
    instances,
    dispose() {
      group.removeFromParent();
      for (const child of group.children) {
        if (child instanceof THREE.InstancedMesh) {
          child.dispose();
        }
      }
      group.clear();
    },
  };
}
