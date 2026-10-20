/** What the HUD says when the office server turns a join away. */

import { ErrorCode, MatchMakeError } from "colyseus.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ConnectionStatus, RoomConnection, describeError, isOfficeFull, isSessionGone } from "./room.js";

/** A stand-in for the Colyseus client, so the connection's own decisions can be driven without a server. */
const fake = vi.hoisted(() => {
  // Answers every property and call with itself, which is all the state bindings ask of it.
  const inert: object = new Proxy(() => inert, { get: () => inert, apply: () => inert });
  const rooms: { leave: (code: number) => void; name: string }[] = [];
  const room = (name: string) => {
    let left: (code: number) => void = () => {};
    const created = {
      sessionId: `s${rooms.length}`,
      reconnectionToken: "token",
      state: inert,
      onMessage: () => {},
      onError: () => {},
      onLeave: (callback: (code: number) => void) => {
        left = callback;
      },
      leave: () => Promise.resolve(),
    };
    rooms.push({ leave: (code) => left(code), name });
    return created;
  };
  return {
    rooms,
    join: vi.fn((_roomName: string, options: { name: string }) => Promise.resolve(room(options.name))),
    reconnect: vi.fn((_token: string): Promise<unknown> => Promise.reject(new Error("unset"))),
    inert,
  };
});

vi.mock("colyseus.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("colyseus.js")>()),
  Client: class {
    public join = fake.join;
    public reconnect = fake.reconnect;
  },
  getStateCallbacks: () => () => fake.inert,
}));

describe("RoomConnection after a dropped socket", () => {
  let statuses: ConnectionStatus[];
  let connection: RoomConnection;

  beforeEach(async () => {
    vi.useFakeTimers();
    fake.rooms.length = 0;
    fake.join.mockClear();
    fake.reconnect.mockClear();
    statuses = [];
    connection = new RoomConnection({ onStatusChanged: (status) => statuses.push(status) });
    await connection.connect("ws://localhost:2567", "Ada");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resumes the same session while the server still has it", async () => {
    fake.reconnect.mockResolvedValueOnce({ ...fake.inert, onLeave: () => {}, onMessage: () => {}, onError: () => {} });
    fake.rooms[0]?.leave(1006);
    await vi.runAllTimersAsync();
    expect(fake.join).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("connected");
  });

  it("joins afresh under the same name once the server says the session is gone", async () => {
    fake.reconnect.mockRejectedValueOnce(new Error("offline"));
    fake.reconnect.mockRejectedValueOnce(new MatchMakeError("room has been disposed", ErrorCode.MATCHMAKE_INVALID_ROOM_ID));
    // A server shutting down closes cleanly, which is no reason to give up.
    fake.rooms[0]?.leave(4000);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fake.join).toHaveBeenCalledTimes(2);
    expect(fake.rooms[1]?.name).toBe("Ada");
    expect(statuses).toEqual(["connecting", "connected", "reconnecting", "connecting", "connected"]);
  });

  it("joins afresh after the grace period when the server never answers", async () => {
    fake.reconnect.mockRejectedValue(new Error("offline"));
    fake.rooms[0]?.leave(1006);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(fake.join).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.join).toHaveBeenCalledTimes(2);
  });

  it("leaves a Rejoin to the player when the fresh join fails, and seats them once however often it is pressed", async () => {
    fake.reconnect.mockRejectedValueOnce(new MatchMakeError("expired", ErrorCode.MATCHMAKE_EXPIRED));
    fake.join.mockRejectedValueOnce(new Error("offline"));
    fake.rooms[0]?.leave(1006);
    await vi.runAllTimersAsync();
    expect(statuses.at(-1)).toBe("failed");

    await Promise.all([connection.rejoin(), connection.rejoin()]);
    expect(fake.join).toHaveBeenCalledTimes(3);
    expect(statuses.at(-1)).toBe("connected");
  });

  it("stays out after a deliberate leave", async () => {
    await connection.leave();
    fake.rooms[0]?.leave(4000);
    await vi.runAllTimersAsync();
    expect(fake.reconnect).not.toHaveBeenCalled();
    expect(fake.join).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("disconnected");
  });

  it("comes back in when the player presses Rejoin after a deliberate leave", async () => {
    await connection.leave();
    fake.rooms[0]?.leave(4000);
    await connection.rejoin();
    expect(fake.join).toHaveBeenCalledTimes(2);
    expect(fake.rooms[1]?.name).toBe("Ada");
    expect(statuses.at(-1)).toBe("connected");
  });
});

describe("isSessionGone", () => {
  it("recognises a server that no longer has the room or the seat", () => {
    expect(isSessionGone(new MatchMakeError("disposed", ErrorCode.MATCHMAKE_INVALID_ROOM_ID))).toBe(true);
    expect(isSessionGone(new MatchMakeError("expired", ErrorCode.MATCHMAKE_EXPIRED))).toBe(true);
  });

  it("keeps retrying through anything else", () => {
    expect(isSessionGone(new Error("offline"))).toBe(false);
    expect(isSessionGone(new MatchMakeError("full", ErrorCode.MATCHMAKE_INVALID_CRITERIA))).toBe(false);
  });
});

describe("isOfficeFull", () => {
  it("recognises a join the office has no seat for", () => {
    const refused = new MatchMakeError("no rooms found with provided criteria", ErrorCode.MATCHMAKE_INVALID_CRITERIA);
    expect(isOfficeFull(refused)).toBe(true);
  });

  it("leaves any other matchmaking error alone", () => {
    const error = new MatchMakeError("invalid method", ErrorCode.MATCHMAKE_NO_HANDLER);
    expect(isOfficeFull(error)).toBe(false);
    expect(describeError(error)).toBe("invalid method");
  });
});
