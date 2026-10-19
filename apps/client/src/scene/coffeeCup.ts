/**
 * The coffee cup an occupant carries, its sips, and the steam off the top.
 *
 * The server counts the sips (`coffeeSips`); this module only turns the count
 * into something to look at. A drop in the count is a sip, played here as the
 * cup lifted to the mouth, tipped and lowered again, and a count of zero is no
 * cup — but only once the last sip has been drunk, so the cup does not vanish
 * from a hand still raised. Each client plays a sip from the moment its own
 * patch arrives, so everyone sees the same ten sips, give or take a round trip.
 *
 * Built to be cheap with a room full of drinkers: geometry and materials are
 * shared by every cup, steam is three tiny meshes moved along a fixed loop,
 * and nothing is allocated per frame.
 */

import { OCCUPANT_HEIGHT, OCCUPANT_RADIUS } from "@sim/shared";
import * as THREE from "three";

/** How long one sip takes, from lifting the cup to lowering it. */
export const SIP_DURATION_MS = 1600;

/** Fractions of a sip spent raising the cup, and lowering it again; the rest is drinking. */
const SIP_RAISE = 0.3;
const SIP_LOWER = 0.3;

/** How far the cup tips towards the drinker at the mouth, in radians. */
const SIP_TILT = 1.1;

/**
 * Where the cup is held, in the body's own frame (forward is -Z): out to one
 * side rather than straight ahead, because a cup in front of the chest is
 * hidden behind the body from the owner's own camera, which is exactly the
 * viewer who most needs to see it.
 */
const HELD_OFFSET = new THREE.Vector3(OCCUPANT_RADIUS + 0.07, OCCUPANT_HEIGHT * 0.56, -OCCUPANT_RADIUS * 0.7);
/** Where it is raised to: in front of the face, a little off centre. */
const MOUTH_OFFSET = new THREE.Vector3(0.1, OCCUPANT_HEIGHT * 0.78, -(OCCUPANT_RADIUS + 0.05));

const CUP_HEIGHT = 0.11;
const CUP_COLOUR = 0xe8dcc4;
const COFFEE_COLOUR = 0x4a2c1a;

/** Steam: a few puffs rising off the rim on a loop, swelling and then thinning away. */
const STEAM_PUFFS = 3;
const STEAM_PERIOD_MS = 1800;
const STEAM_RISE = 0.24;
const STEAM_SWAY = 0.018;
const STEAM_SCALE = 1.3;

const CUP_GEOMETRY = new THREE.CylinderGeometry(0.05, 0.04, CUP_HEIGHT, 10);
const COFFEE_GEOMETRY = new THREE.CircleGeometry(0.045, 10).rotateX(-Math.PI / 2);
const STEAM_GEOMETRY = new THREE.SphereGeometry(0.022, 6, 4);

const CUP_MATERIAL = new THREE.MeshLambertMaterial({ color: CUP_COLOUR });
const COFFEE_MATERIAL = new THREE.MeshLambertMaterial({ color: COFFEE_COLOUR });
const STEAM_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
});

/**
 * How far into a sip the cup is raised, from `0` at the hand to `1` at the
 * mouth, `elapsedMs` after the sip began. Eased at both ends so it reads as
 * an arm moving rather than a cup sliding.
 */
export function sipLift(elapsedMs: number): number {
  const t = elapsedMs / SIP_DURATION_MS;
  if (t <= 0 || t >= 1) {
    return 0;
  }
  if (t < SIP_RAISE) {
    return ease(t / SIP_RAISE);
  }
  if (t > 1 - SIP_LOWER) {
    return ease((1 - t) / SIP_LOWER);
  }
  return 1;
}

function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Turns the replicated sip count into when a sip is playing and whether a cup
 * is in hand.
 *
 * The first count seen is a starting point, not a sip: an occupant who comes
 * into view halfway through a cup has not just drunk from it.
 */
export class SipTracker {
  private lastSips: number | undefined;
  private sipStartedAt = Number.NEGATIVE_INFINITY;

  /** Records the latest count; a drop starts a sip at `nowMs`. */
  public observe(sips: number, nowMs: number): void {
    if (this.lastSips !== undefined && sips < this.lastSips) {
      this.sipStartedAt = nowMs;
    }
    this.lastSips = sips;
  }

  /** Milliseconds into the sip playing at `nowMs`, or `undefined` between sips. */
  public sipElapsed(nowMs: number): number | undefined {
    const elapsed = nowMs - this.sipStartedAt;
    return elapsed >= 0 && elapsed < SIP_DURATION_MS ? elapsed : undefined;
  }

  /**
   * Whether a cup is in hand: while there is coffee left, while the last sip
   * is still being drunk, and at the machine while it is being poured.
   */
  public holding(nowMs: number, atMachine: boolean): boolean {
    return atMachine || (this.lastSips ?? 0) > 0 || this.sipElapsed(nowMs) !== undefined;
  }
}

/** One occupant's cup: add {@link group} to the body and call {@link update} each frame. */
export class CoffeeCup {
  public readonly group = new THREE.Group();

  private readonly cup = new THREE.Group();
  private readonly steam = new THREE.Group();
  private readonly puffs: THREE.Mesh[] = [];
  private readonly tracker = new SipTracker();
  /** Spreads cups' steam out of step, so a room of drinkers does not puff in unison. */
  private readonly steamPhase = Math.random();

  public constructor() {
    const body = new THREE.Mesh(CUP_GEOMETRY, CUP_MATERIAL);
    const coffee = new THREE.Mesh(COFFEE_GEOMETRY, COFFEE_MATERIAL);
    coffee.position.y = CUP_HEIGHT / 2 - 0.012;
    this.cup.add(body, coffee);
    this.group.add(this.cup);

    for (let index = 0; index < STEAM_PUFFS; index += 1) {
      const puff = new THREE.Mesh(STEAM_GEOMETRY, STEAM_MATERIAL);
      this.puffs.push(puff);
      this.steam.add(puff);
    }
    this.group.add(this.steam);
    this.group.visible = false;
  }

  /**
   * Shows the cup where it belongs this frame.
   *
   * @param sips the replicated sips left.
   * @param atMachine whether the occupant is at the coffee machine, pouring.
   * @param drop how far the body has sunk below standing, so a seated
   * drinker's cup comes down with them.
   */
  public update(sips: number, atMachine: boolean, nowMs: number, drop: number): void {
    this.tracker.observe(sips, nowMs);
    const holding = this.tracker.holding(nowMs, atMachine);
    this.group.visible = holding;
    if (!holding) {
      return;
    }

    const elapsed = this.tracker.sipElapsed(nowMs);
    const lift = elapsed === undefined ? 0 : sipLift(elapsed);
    this.cup.position.lerpVectors(HELD_OFFSET, MOUTH_OFFSET, lift);
    this.cup.position.y -= drop;
    this.cup.rotation.x = SIP_TILT * lift;

    // Steam rises off the rim while the cup is down; mid-sip it would be
    // pouring out of the drinker's face.
    this.steam.visible = lift === 0;
    if (!this.steam.visible) {
      return;
    }
    this.steam.position.set(this.cup.position.x, this.cup.position.y + CUP_HEIGHT / 2, this.cup.position.z);
    this.puffs.forEach((puff, index) => {
      const phase = (nowMs / STEAM_PERIOD_MS + this.steamPhase + index / STEAM_PUFFS) % 1;
      const size = Math.sin(phase * Math.PI) * STEAM_SCALE;
      puff.position.set(Math.sin(phase * Math.PI * 2 + index * 2) * STEAM_SWAY, phase * STEAM_RISE, 0);
      puff.scale.setScalar(Math.max(size, 0.001));
    });
  }
}
