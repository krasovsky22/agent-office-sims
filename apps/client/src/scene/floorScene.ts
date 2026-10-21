/**
 * The parts of the scene that differ from floor to floor: the shell, its
 * doors, the street outside and the furniture, built from one floor's plan
 * and taken down whole when the lift brings the player to another.
 *
 * Everything else — the lights, the wall boards, the decor, the agents'
 * screens — hangs where it does on every floor, since `upperFloorLayout` in
 * `@sim/shared` keeps the office where the ground floor has it, so it stays
 * up across a ride and keeps what it shows.
 */

import { type OfficeLayout, derivedProps } from "@sim/shared";
import * as THREE from "three";

import { Doors } from "./doors.js";
import { type OfficeView, buildOffice } from "./office.js";
import type { PropKit } from "./propKit.js";
import { type PropsView, buildProps } from "./props.js";
import { type StreetView, buildStreet } from "./street.js";

/** How far each floor stands above the one below it, which is how far down the street is seen from it. */
export const STOREY_HEIGHT = 3.6;

export interface FloorScene {
  readonly doors: Doors;
  readonly street: StreetView | undefined;
  /** Props placed, `0` until the kit has furnished the floor. */
  readonly placedProps: number;
  /** Puts the kit's furniture in, and takes the grey desks out. */
  furnish(kit: PropKit): void;
  /** Takes every piece of the floor out of the scene and frees what it drew with. */
  dispose(): void;
}

export function buildFloorScene(scene: THREE.Scene, layout: OfficeLayout, floor: number): FloorScene {
  const office: OfficeView = buildOffice(scene, layout);
  const doors = new Doors(scene, layout);
  const street = buildStreet(scene, layout);
  if (street !== undefined) {
    street.group.position.y = -(floor - 1) * STOREY_HEIGHT;
  }
  let props: PropsView | undefined;

  return {
    doors,
    street,
    get placedProps() {
      return props?.instances ?? 0;
    },
    furnish(kit) {
      props?.dispose();
      props = buildProps(scene, derivedProps(layout), kit);
      office.setGreyDesksVisible(false);
    },
    dispose() {
      // The kit's geometry is the next floor's too, so the props let go of their instances alone.
      props?.dispose();
      for (const group of [office.group, doors.group, street?.group]) {
        if (group !== undefined) {
          group.removeFromParent();
          disposeMeshes(group);
        }
      }
    },
  };
}

/** Frees every mesh's geometry, materials and their textures; three.js uploads any of them again if it is drawn again. */
function disposeMeshes(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) {
      return;
    }
    (node.geometry as THREE.BufferGeometry).dispose();
    const materials: THREE.Material[] = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) {
          value.dispose();
        }
      }
      material.dispose();
    }
  });
}
