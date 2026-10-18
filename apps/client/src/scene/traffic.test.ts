/**
 * The street's traffic, driven for minutes without a renderer.
 *
 * What the issue asks of it is that cars, yellow cabs among them, drive both
 * ways continuously; what makes that believable is that they never drive
 * through each other and do stop for the lights at the crossing.
 */

import { OFFICE_LAYOUT, type StreetSpec } from "@sim/shared";
import { describe, expect, it } from "vitest";

import {
  CAB_YELLOW,
  CROSSING_HALF_WIDTH,
  type Traffic,
  carPose,
  createTraffic,
  signalAt,
  stepTraffic,
  stopLineAt,
} from "./traffic.js";

const street: StreetSpec = (() => {
  if (OFFICE_LAYOUT.street === undefined) {
    throw new Error("the shipped layout has no street");
  }
  return OFFICE_LAYOUT.street;
})();

const FRAME = 1 / 60;

function drive(traffic: Traffic, seconds: number, each?: () => void): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += FRAME) {
    stepTraffic(traffic, street, FRAME);
    each?.();
  }
}

describe("createTraffic", () => {
  it("puts cars in every lane, cabs and others among them", () => {
    const traffic = createTraffic(street);
    street.lanes.forEach((_, lane) => {
      expect(traffic.cars.some((car) => car.lane === lane), `lane ${lane}`).toBe(true);
    });
    expect(traffic.cars.some((car) => car.cab && car.colour === CAB_YELLOW)).toBe(true);
    expect(traffic.cars.some((car) => !car.cab)).toBe(true);
  });

  it("is the same street for the same seed", () => {
    expect(createTraffic(street, 7).cars).toEqual(createTraffic(street, 7).cars);
  });
});

describe("stepTraffic", () => {
  it("keeps every car driving, both ways, lap after lap", () => {
    const traffic = createTraffic(street);
    const driven = new Map(traffic.cars.map((car) => [car, 0]));
    let previous = new Map(traffic.cars.map((car) => [car, car.travelled]));
    const length = street.road.maxZ - street.road.minZ;
    drive(traffic, 180, () => {
      for (const car of traffic.cars) {
        const before = previous.get(car) ?? car.travelled;
        const moved = (car.travelled - before + length) % length;
        driven.set(car, (driven.get(car) ?? 0) + moved);
      }
      previous = new Map(traffic.cars.map((car) => [car, car.travelled]));
    });
    for (const [car, distance] of driven) {
      expect(distance, `car in lane ${car.lane}`).toBeGreaterThan(length);
    }
    const headings = new Set(traffic.cars.map((car) => carPose(street, car).yaw));
    expect(headings.size).toBe(2);
  });

  it("never lets two cars in a lane overlap", () => {
    const traffic = createTraffic(street);
    const length = street.road.maxZ - street.road.minZ;
    drive(traffic, 120, () => {
      street.lanes.forEach((_, lane) => {
        const cars = traffic.cars.filter((car) => car.lane === lane).sort((a, b) => a.travelled - b.travelled);
        cars.forEach((car, index) => {
          const leader = cars[(index + 1) % cars.length];
          if (leader === undefined || leader === car) {
            return;
          }
          const ahead = (leader.travelled - car.travelled + length) % length;
          expect(ahead - (leader.length + car.length) / 2).toBeGreaterThan(0);
        });
      });
    });
  });

  it("holds traffic at the stop line on red and clears the crossing", () => {
    const traffic = createTraffic(street);
    // Into a red phase by long enough for anyone caught by the change to be through.
    let redFor = 0;
    let checked = 0;
    let waited = 0;
    drive(traffic, 200, () => {
      redFor = signalAt(traffic.seconds) === "stop" ? redFor + FRAME : 0;
      if (redFor < 5) {
        return;
      }
      checked += 1;
      for (const car of traffic.cars) {
        const { z } = carPose(street, car);
        const reach = car.length / 2;
        const onCrossing =
          z + reach > street.crossingZ - CROSSING_HALF_WIDTH && z - reach < street.crossingZ + CROSSING_HALF_WIDTH;
        expect(onCrossing, `car in lane ${car.lane} at ${z}`).toBe(false);

        const lane = street.lanes[car.lane];
        const toLine = lane === undefined ? -1 : stopLineAt(street, lane.direction) - (car.travelled + reach);
        if (car.speed < 0.5 && toLine > 0 && toLine < 3) {
          waited += 1;
        }
      }
    });
    expect(checked).toBeGreaterThan(0);
    // And the lights are doing something: cars sit waiting at the line.
    expect(waited).toBeGreaterThan(0);
  });

  it("runs the lights through green, amber and red", () => {
    const phases = new Set<string>();
    for (let second = 0; second < 60; second += 0.5) {
      phases.add(signalAt(second));
    }
    expect([...phases].sort()).toEqual(["amber", "go", "stop"]);
  });

  it("draws every car on the road, in its lane", () => {
    const traffic = createTraffic(street);
    drive(traffic, 30);
    for (const car of traffic.cars) {
      const pose = carPose(street, car);
      expect(pose.x).toBe(street.lanes[car.lane]?.x);
      expect(pose.z).toBeGreaterThanOrEqual(street.road.minZ);
      expect(pose.z).toBeLessThanOrEqual(street.road.maxZ);
    }
  });
});
