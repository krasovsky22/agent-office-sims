/**
 * The street's traffic, as a small simulation with no renderer in it.
 *
 * Cars are decoration: nobody else sees the same cars, the server never hears
 * of them, and a tab that reloads gets a fresh street. What makes them read as
 * traffic rather than boxes on rails is that they keep their distance, slow
 * behind each other, and stop for the lights at the crossing outside the main
 * entrance, and those rules are kept here, apart from Three.js, so a test can
 * drive the street for minutes in milliseconds.
 *
 * Each lane is a loop: a car that drives off one end of the drawn street comes
 * back on at the other, far enough out that the fog hides the jump. So the
 * traffic never runs out and never piles up.
 */

import type { StreetSpec } from "@sim/shared";

import { seededRandom } from "./skyline.js";

/** The yellow of a New York cab. */
export const CAB_YELLOW = 0xf2c200;

/** Everyone else: the dark, silver and muted colours most cars come in. */
const CAR_COLOURS = [0x1d2b44, 0xd7d9dc, 0x2b2b2e, 0x8a1c1c, 0x4f5d6b, 0x0f3d2e, 0xb8b2a6, 0xf0f0ec] as const;

/** Share of the cars that are cabs. */
const CAB_SHARE = 0.4;

/** Distance along a lane from one car to the next, as they are first spread out. */
const CAR_SPACING = 28;

/** Cruising speeds, metres a second: a city avenue, not a highway. */
const MIN_CRUISE = 8;
const MAX_CRUISE = 11.5;

const MIN_LENGTH = 4.2;
const MAX_LENGTH = 4.9;

/** How hard a car speeds up, and how hard it brakes for a light or a car ahead. */
const ACCELERATION = 3;
const COMFORTABLE_BRAKING = 3.5;
/** The hardest a car brakes, for a light that changes under it. */
const HARD_BRAKING = 7;

/** Bumper-to-bumper gap a car keeps to the one ahead when stopped. */
const STANDING_GAP = 1.8;
/** Gap a car leaves before the stop line. */
const STOP_LINE_GAP = 0.3;

/** Half the width of the crossing's stripes, along the street. */
export const CROSSING_HALF_WIDTH = 1.8;
/** From the crossing's edge back to the stop line. */
const STOP_LINE_SETBACK = 1.2;

/**
 * The lights on the avenue, in seconds: green, then amber, then red while
 * the crossing has its turn.
 */
const GREEN_SECONDS = 22;
const AMBER_SECONDS = 3;
const RED_SECONDS = 10;
const SIGNAL_CYCLE = GREEN_SECONDS + AMBER_SECONDS + RED_SECONDS;

export type SignalPhase = "go" | "amber" | "stop";

/** What the avenue's lights show `seconds` into the street's life. */
export function signalAt(seconds: number): SignalPhase {
  const into = ((seconds % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  if (into < GREEN_SECONDS) {
    return "go";
  }
  return into < GREEN_SECONDS + AMBER_SECONDS ? "amber" : "stop";
}

/**
 * One car. `travelled`, `speed` and what it decided about the lights change as
 * it drives; the rest is who it is.
 */
export interface Car {
  /** Index into the street's lanes. */
  readonly lane: number;
  /** How far along its lane the car's centre is, from the end its traffic enters at. */
  travelled: number;
  speed: number;
  readonly cruise: number;
  readonly length: number;
  readonly cab: boolean;
  readonly colour: number;
  /** The light cycle the car last decided whether to stop in, or -1 before its first. */
  decidedCycle: number;
  /** Whether it stops for the lights in {@link Car.decidedCycle}, or carries on through. */
  stopsForLight: boolean;
}

export interface Traffic {
  readonly cars: readonly Car[];
  /** Seconds simulated, which is also what the lights run off. */
  seconds: number;
}

/** Where a car is on the ground, and which way it faces: yaw 0 faces -Z, as everywhere. */
export interface CarPose {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

function laneLength(street: StreetSpec): number {
  return street.road.maxZ - street.road.minZ;
}

/** How far along a lane of `direction` the stop line before the crossing is. */
export function stopLineAt(street: StreetSpec, direction: 1 | -1): number {
  const setback = CROSSING_HALF_WIDTH + STOP_LINE_SETBACK;
  return direction === 1
    ? street.crossingZ - setback - street.road.minZ
    : street.road.maxZ - (street.crossingZ + setback);
}

/** Fills the street's lanes, evenly spread with a little jitter, cabs among the cars. */
export function createTraffic(street: StreetSpec, seed = 115): Traffic {
  const random = seededRandom(seed);
  const length = laneLength(street);
  const cars: Car[] = [];
  street.lanes.forEach((_, lane) => {
    const count = Math.max(1, Math.round(length / CAR_SPACING));
    for (let index = 0; index < count; index += 1) {
      const spacing = length / count;
      const cab = random() < CAB_SHARE;
      const colour = CAR_COLOURS[Math.floor(random() * CAR_COLOURS.length)] ?? CAR_COLOURS[0];
      cars.push({
        lane,
        travelled: (index + 0.15 + random() * 0.7) * spacing,
        speed: 0,
        cruise: MIN_CRUISE + random() * (MAX_CRUISE - MIN_CRUISE),
        length: MIN_LENGTH + random() * (MAX_LENGTH - MIN_LENGTH),
        cab,
        colour: cab ? CAB_YELLOW : colour,
        decidedCycle: -1,
        stopsForLight: false,
      });
    }
  });
  for (const car of cars) {
    car.speed = car.cruise;
  }
  return { cars, seconds: 0 };
}

/** The fastest a car may go and still stop `distance` ahead, braking at `braking`. */
function speedToStopIn(distance: number, braking: number): number {
  return Math.sqrt(2 * braking * Math.max(0, distance));
}

/**
 * Advances the street by `deltaSeconds`.
 *
 * Every car's new speed is decided from where everyone was, then everyone
 * moves, so the order cars are listed in never matters. No car moves further
 * than the gap to the one ahead allows, which is what guarantees two cars in
 * a lane never overlap, whatever the frame rate.
 */
export function stepTraffic(traffic: Traffic, street: StreetSpec, deltaSeconds: number): void {
  if (deltaSeconds <= 0) {
    return;
  }
  traffic.seconds += deltaSeconds;
  const phase = signalAt(traffic.seconds);
  const cycle = Math.floor(traffic.seconds / SIGNAL_CYCLE);
  const length = laneLength(street);

  const moves = new Map<Car, number>();
  street.lanes.forEach((lane, laneIndex) => {
    const inLane = traffic.cars.filter((car) => car.lane === laneIndex).sort((a, b) => a.travelled - b.travelled);
    const stopLine = stopLineAt(street, lane.direction);

    inLane.forEach((car, index) => {
      let gap = Number.POSITIVE_INFINITY;
      const leader = inLane[(index + 1) % inLane.length];
      if (leader !== undefined && leader !== car) {
        let ahead = leader.travelled - car.travelled;
        if (ahead <= 0) {
          ahead += length;
        }
        gap = ahead - (leader.length + car.length) / 2;
      }

      let target = Math.min(car.cruise, speedToStopIn(gap - STANDING_GAP, COMFORTABLE_BRAKING));

      // Once a cycle, when the lights stop being green, each car still short
      // of the line decides: it stops for amber only if it can do so
      // comfortably, and for red if it can at all; one already too close
      // carries on through. Deciding once is what keeps a car braking along
      // the edge of what it can manage from changing its mind half way.
      const toLine = stopLine - (car.travelled + car.length / 2) - STOP_LINE_GAP;
      if (phase !== "go" && toLine > 0 && car.decidedCycle !== cycle) {
        const braking = phase === "stop" ? HARD_BRAKING : COMFORTABLE_BRAKING;
        car.decidedCycle = cycle;
        car.stopsForLight = toLine >= (car.speed * car.speed) / (2 * braking);
      }
      // A car that has crept a little over the line holds there, rather than
      // taking that as having passed it.
      if (phase !== "go" && car.decidedCycle === cycle && car.stopsForLight && toLine > -STOP_LINE_SETBACK) {
        target = Math.min(target, speedToStopIn(toLine, COMFORTABLE_BRAKING));
      }

      const change = target - car.speed;
      const speed = Math.max(
        0,
        car.speed + Math.min(ACCELERATION * deltaSeconds, Math.max(-HARD_BRAKING * deltaSeconds, change)),
      );
      car.speed = speed;
      moves.set(car, Math.min(speed * deltaSeconds, Math.max(0, gap - STANDING_GAP / 2)));
    });
  });

  for (const [car, distance] of moves) {
    car.travelled = (car.travelled + distance) % length;
  }
}

/** Where a car is drawn. */
export function carPose(street: StreetSpec, car: Car): CarPose {
  const lane = street.lanes[car.lane];
  if (lane === undefined) {
    return { x: 0, z: 0, yaw: 0 };
  }
  return lane.direction === 1
    ? { x: lane.x, z: street.road.minZ + car.travelled, yaw: Math.PI }
    : { x: lane.x, z: street.road.maxZ - car.travelled, yaw: 0 };
}
