import { describe, expect, it } from "vitest";

import { MAX_FLOORS, floorRoomName, parseLiftFloorsMessage, parseLiftRideMessage } from "./lift.js";
import { OFFICE_ROOM_NAME } from "./messages.js";

describe("floorRoomName", () => {
  it("keeps the ground floor's room the one the client has always joined, and numbers the rest", () => {
    expect(floorRoomName(1)).toBe(OFFICE_ROOM_NAME);
    expect(floorRoomName(2)).toBe(`${OFFICE_ROOM_NAME}-2`);
  });
});

describe("parseLiftRideMessage", () => {
  it("takes a floor the building could have", () => {
    expect(parseLiftRideMessage({ floor: 2 })).toEqual({ floor: 2 });
    expect(parseLiftRideMessage({ floor: MAX_FLOORS, extra: true })).toEqual({ floor: MAX_FLOORS });
  });

  it.each([undefined, null, "2", {}, { floor: "2" }, { floor: 0 }, { floor: 1.5 }, { floor: MAX_FLOORS + 1 }, { floor: Number.NaN }])(
    "refuses %j",
    (raw) => {
      expect(parseLiftRideMessage(raw)).toBeUndefined();
    },
  );
});

describe("parseLiftFloorsMessage", () => {
  it("takes any object and nothing else", () => {
    expect(parseLiftFloorsMessage({ anything: 1 })).toEqual({});
    expect(parseLiftFloorsMessage("floors")).toBeUndefined();
  });
});
