/**
 * Replicated room state.
 *
 * {@link Occupant} is deliberately the base type for everyone who can stand in
 * the office, not just for players. This milestone only ever puts
 * {@link HumanPlayer} instances in the map, but the agent employees this
 * prototype exists to host will be a sibling class added alongside it, and the
 * occupants map will not have to be reshaped to hold them.
 *
 * Positions are `float32`: the wire stays small and the rounding is far below
 * the drift the client tolerates before it corrects itself.
 *
 * Fields are wired up with `defineTypes` rather than Colyseus' `@type()`
 * decorator, and declared with `declare` so no field initialiser is emitted.
 * Both choices avoid a compiler setting:
 *
 * - `@type()` is a legacy-style decorator, and the three toolchains that compile
 *   this package (tsx on the server, Vite in the browser, Vitest in the test
 *   run) do not all honour `experimentalDecorators` from the tsconfig. Compiled
 *   under standard decorator semantics it throws at module load.
 * - Colyseus installs its change-tracking accessors as own properties of each
 *   instance, so a class field initialiser compiled under
 *   `useDefineForClassFields` would overwrite them and silently stop replicating
 *   that field.
 *
 * Defaults therefore live in the constructors, which assign through those
 * accessors exactly as a tracked write should.
 */

import { MapSchema, Schema, defineTypes } from "@colyseus/schema";

/** What sort of thing an occupant is. */
export const OCCUPANT_KIND = {
  human: "human",
  agent: "agent",
} as const;

export type OccupantKind = (typeof OCCUPANT_KIND)[keyof typeof OCCUPANT_KIND];

/**
 * What an occupant is currently doing, for the renderer's benefit.
 *
 * A string rather than a boolean because sitting, typing and talking all land
 * here once there is anything in the office to do.
 */
export const ANIMATION_STATE = {
  idle: "idle",
  walking: "walking",
} as const;

export type AnimationState = (typeof ANIMATION_STATE)[keyof typeof ANIMATION_STATE];

/** Anyone standing in the office: a player now, an agent employee later. */
export class Occupant extends Schema {
  declare public id: string;
  declare public name: string;
  declare public kind: OccupantKind;
  declare public x: number;
  declare public z: number;
  declare public yaw: number;
  declare public animation: AnimationState;

  public constructor() {
    super();
    this.id = "";
    this.name = "";
    this.kind = OCCUPANT_KIND.human;
    this.x = 0;
    this.z = 0;
    this.yaw = 0;
    this.animation = ANIMATION_STATE.idle;
  }
}

defineTypes(Occupant, {
  id: "string",
  name: "string",
  kind: "string",
  x: "float32",
  z: "float32",
  yaw: "float32",
  animation: "string",
});

/** An occupant driven by a browser. */
export class HumanPlayer extends Occupant {
  /** Set on the first player to join the room, and re-homed if they leave. */
  declare public isCeo: boolean;

  public constructor() {
    super();
    this.isCeo = false;
  }
}

defineTypes(HumanPlayer, { isCeo: "boolean" });

export class OfficeState extends Schema {
  declare public occupants: MapSchema<Occupant>;
  declare public tick: number;

  public constructor() {
    super();
    this.occupants = new MapSchema<Occupant>();
    this.tick = 0;
  }
}

defineTypes(OfficeState, {
  occupants: { map: Occupant },
  tick: "uint32",
});

const TAU = Math.PI * 2;

/**
 * Folds a yaw into [-pi, pi).
 *
 * Both sides store yaw in this range so that the shortest rotation between two
 * samples can be found by subtraction, which is what remote interpolation needs
 * to avoid spinning an avatar the long way around.
 */
export function normalizeYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) {
    return 0;
  }
  const wrapped = (((yaw + Math.PI) % TAU) + TAU) % TAU;
  return wrapped - Math.PI;
}

/** The shorter of the two rotations from `from` to `to`, in [-pi, pi). */
export function shortestYawDelta(from: number, to: number): number {
  return normalizeYaw(to - from);
}

/**
 * Narrows an occupant to a human player.
 *
 * Tests the replicated `kind` field rather than using `instanceof`: the browser
 * client builds its state from the schema the server reflects to it on join, so
 * the objects it holds carry the right fields without being instances of these
 * classes. When agent employees arrive they get the same treatment.
 */
export function isHumanPlayer(occupant: Occupant): occupant is HumanPlayer {
  return occupant.kind === OCCUPANT_KIND.human;
}
