/**
 * The camera choice survives a reload where the browser allows it and never
 * breaks the page where it does not, and the wheel's zoom stays in range.
 */

import { describe, expect, it } from "vitest";

import {
  CAMERA_MODE,
  CAMERA_MODE_STORAGE_KEY,
  DEFAULT_ZOOM_DISTANCE,
  MAX_ZOOM_DISTANCE,
  MIN_ZOOM_DISTANCE,
  otherCameraMode,
  readCameraMode,
  writeCameraMode,
  zoomedDistance,
} from "./cameraMode.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

const refusingStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("camera mode storage", () => {
  it("starts behind the player when nothing was kept", () => {
    expect(readCameraMode(memoryStorage())).toBe(CAMERA_MODE.thirdPerson);
    expect(readCameraMode(undefined)).toBe(CAMERA_MODE.thirdPerson);
  });

  it("comes back as the player left it", () => {
    const storage = memoryStorage();
    writeCameraMode(storage, CAMERA_MODE.firstPerson);
    expect(readCameraMode(storage)).toBe(CAMERA_MODE.firstPerson);
    writeCameraMode(storage, CAMERA_MODE.thirdPerson);
    expect(readCameraMode(storage)).toBe(CAMERA_MODE.thirdPerson);
  });

  it("treats anything else kept under the key as third person", () => {
    const storage = memoryStorage();
    storage.setItem(CAMERA_MODE_STORAGE_KEY, "overhead");
    expect(readCameraMode(storage)).toBe(CAMERA_MODE.thirdPerson);
  });

  it("shrugs off storage that refuses to be read or written", () => {
    expect(readCameraMode(refusingStorage)).toBe(CAMERA_MODE.thirdPerson);
    expect(() => writeCameraMode(refusingStorage, CAMERA_MODE.firstPerson)).not.toThrow();
  });

  it("toggles between the two", () => {
    expect(otherCameraMode(CAMERA_MODE.firstPerson)).toBe(CAMERA_MODE.thirdPerson);
    expect(otherCameraMode(CAMERA_MODE.thirdPerson)).toBe(CAMERA_MODE.firstPerson);
  });
});

describe("zoomedDistance", () => {
  it("pulls back on a scroll down and comes in on a scroll up", () => {
    expect(zoomedDistance(DEFAULT_ZOOM_DISTANCE, 100, 0)).toBeGreaterThan(DEFAULT_ZOOM_DISTANCE);
    expect(zoomedDistance(DEFAULT_ZOOM_DISTANCE, -100, 0)).toBeLessThan(DEFAULT_ZOOM_DISTANCE);
  });

  it("stays between the limits however far the wheel turns", () => {
    expect(zoomedDistance(DEFAULT_ZOOM_DISTANCE, 1e6, 0)).toBe(MAX_ZOOM_DISTANCE);
    expect(zoomedDistance(DEFAULT_ZOOM_DISTANCE, -1e6, 0)).toBe(MIN_ZOOM_DISTANCE);
    expect(zoomedDistance(DEFAULT_ZOOM_DISTANCE, Number.NaN, 0)).toBe(DEFAULT_ZOOM_DISTANCE);
  });

  it("zooms a line-stepped wheel about as far per notch as a pixel-stepped one", () => {
    const byLines = zoomedDistance(DEFAULT_ZOOM_DISTANCE, 3, 1);
    const byPixels = zoomedDistance(DEFAULT_ZOOM_DISTANCE, 48, 0);
    expect(byLines).toBeCloseTo(byPixels, 6);
  });
});
