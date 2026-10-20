/** Which handler each event-borne server message reaches. */

import { SERVER_MESSAGE } from "@sim/shared";
import type { Room } from "colyseus.js";
import { describe, expect, it, vi } from "vitest";

import { type RoomConnectionEvents, forwardServerEvents } from "./roomEvents.js";

/** A room that only records its message handlers, so a test can deliver one. */
function fakeRoom(): { room: Room; deliver: (type: string, payload: unknown) => void } {
  const handlers = new Map<string, (payload: unknown) => void>();
  const room = { onMessage: (type: string, handler: (payload: unknown) => void) => handlers.set(type, handler) };
  return { room: room as unknown as Room, deliver: (type, payload) => handlers.get(type)?.(payload) };
}

describe("forwardServerEvents", () => {
  it("hands each forwarded event to its handler whole", () => {
    const { room, deliver } = fakeRoom();
    const onEmote = vi.fn();
    const onStandupRejected = vi.fn();
    forwardServerEvents(room, { onEmote, onStandupRejected });
    deliver(SERVER_MESSAGE.emote, { id: "s1", emote: "wave" });
    deliver(SERVER_MESSAGE.standupRejected, { reason: "nope" });
    expect(onEmote).toHaveBeenCalledWith({ id: "s1", emote: "wave" });
    expect(onStandupRejected).toHaveBeenCalledWith({ reason: "nope" });
  });

  it("hands on a history's lines rather than its wrapper", () => {
    const { room, deliver } = fakeRoom();
    const onManagerHistory = vi.fn();
    const onAgentPromptHistory = vi.fn();
    forwardServerEvents(room, { onManagerHistory, onAgentPromptHistory });
    deliver(SERVER_MESSAGE.managerHistory, { entries: ["a"] });
    deliver(SERVER_MESSAGE.agentPromptHistory, { entries: ["b"] });
    expect(onManagerHistory).toHaveBeenCalledWith(["a"]);
    expect(onAgentPromptHistory).toHaveBeenCalledWith(["b"]);
  });

  it("drops an event nobody handles", () => {
    const { room, deliver } = fakeRoom();
    const events: RoomConnectionEvents = {};
    forwardServerEvents(room, events);
    expect(() => deliver(SERVER_MESSAGE.chat, { text: "hi" })).not.toThrow();
  });
});
