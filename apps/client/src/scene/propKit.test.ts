/**
 * Which way the screen faces, measured on the shipped model.
 *
 * A monitor's facing is split across two places: the shared layout turns each
 * one towards its seat, and the kit table turns the model to the layout's -Z
 * convention. Either half being wrong leaves every screen showing its back to
 * the chair, and nothing but a screenshot would notice. So this parses the real
 * file, runs it through the same normalisation the renderer uses, and checks the
 * display face against the chair it belongs to.
 */

import { OFFICE_LAYOUT, OFFICE_PROPS, type AssetPropSpec, derivedProps } from "@sim/shared";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";

import monitorData from "../assets/office-kit/computerScreen.glb?inline";
import { modelFromScene } from "./propKit.js";

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The display face, in the normalised model's frame.
 *
 * In this pack the screen is a single light-metal quad set into a dark-metal
 * body, so its material is what picks it out. The mean of its normals is the
 * direction a viewer has to stand in to see it.
 */
async function screenNormal(): Promise<THREE.Vector3> {
  const buffer = await (await fetch(monitorData)).arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(buffer, "");
  const model = modelFromScene("monitor", gltf.scene);
  const screen = model.parts.find((part) => part.material.name === "metal");
  if (screen === undefined) {
    throw new Error("the monitor model has no display face");
  }

  const normals = screen.geometry.getAttribute("normal");
  const index = screen.geometry.getIndex();
  const vertices =
    index === null
      ? Array.from({ length: normals.count }, (_, i) => i)
      : new Set(Array.from({ length: index.count }, (_, i) => index.getX(i)));
  const sum = new THREE.Vector3();
  for (const vertex of vertices) {
    sum.add(new THREE.Vector3().fromBufferAttribute(normals, vertex));
  }
  return sum.normalize();
}

/** Pairs every monitor with the chair of the same workstation. */
function workstations(props: readonly AssetPropSpec[]): [AssetPropSpec, AssetPropSpec][] {
  const byId = new Map(props.map((prop) => [prop.id, prop]));
  return props
    .filter((prop) => prop.kind === "monitor")
    .map((monitor) => {
      const chair = byId.get(monitor.id.replace("-monitor-", "-chair-"));
      if (chair === undefined) {
        throw new Error(`monitor ${monitor.id} has no chair`);
      }
      return [monitor, chair];
    });
}

/** How squarely the screen faces its chair: 1 is head on, -1 is its back. */
function facing(normal: THREE.Vector3, monitor: AssetPropSpec, chair: AssetPropSpec): number {
  const world = normal.clone().applyAxisAngle(UP, monitor.yaw).setY(0).normalize();
  const toChair = new THREE.Vector3(chair.x - monitor.x, 0, chair.z - monitor.z).normalize();
  return world.dot(toChair);
}

describe("monitor facing", () => {
  it("turns every screen in the shipped office towards its own chair", async () => {
    const normal = await screenNormal();
    const stations = workstations(OFFICE_PROPS);
    expect(stations.length).toBeGreaterThan(0);

    for (const [monitor, chair] of stations) {
      expect(facing(normal, monitor, chair), monitor.id).toBeGreaterThan(0.95);
    }
  });

  it("keeps the screen on its chair whatever way the desk is turned", async () => {
    const normal = await screenNormal();
    const template = OFFICE_LAYOUT.desks[0];
    if (template === undefined) {
      throw new Error("the shipped layout has no desks");
    }
    // Off the quarter turns on purpose, so a sign error in either rotation
    // cannot cancel out the way it can at 0 and a half turn.
    const yaws = [0, 0.7, Math.PI / 2, 2.4, Math.PI, -2.1, -Math.PI / 2];
    const desks = yaws.map((yaw, index) => ({ ...template, id: `desk-turned-${index}`, yaw }));

    for (const [monitor, chair] of workstations(derivedProps({ ...OFFICE_LAYOUT, desks }))) {
      expect(facing(normal, monitor, chair), monitor.id).toBeGreaterThan(0.95);
    }
  });
});
