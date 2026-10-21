/** Tuning the office radio: only from beside it, and only to what YouTube will play. */

import type { Client } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  DEFAULT_RADIO_STATION_ID,
  HumanPlayer,
  OFFICE_LAYOUT,
  OfficeState,
  RADIO_INTERACTABLE_ID,
  RADIO_REJECTION,
  SERVER_MESSAGE,
  interactableById,
} from "@sim/shared";
import { describe, expect, it, vi } from "vitest";

import type { YoutubeAnswer } from "../sim/youtube.js";
import { registerRadioHandlers } from "./radioHandlers.js";

const SPOT = interactableById(OFFICE_LAYOUT, RADIO_INTERACTABLE_ID)!.anchor;

function harness(options: { readonly answer?: YoutubeAnswer; readonly at?: typeof SPOT } = {}) {
  // An `undefined` answer is one of the cases, so only a missing one means "plays".
  const answer = "answer" in options ? options.answer : { playable: true as const, title: "Lo-fi beats" };
  const at = options.at ?? SPOT;
  const state = new OfficeState();
  const player = new HumanPlayer();
  player.name = "Ada";
  player.x = at.x;
  player.z = at.z;
  state.occupants.set("ada", player);
  const handlers = new Map<string, (client: Client, raw: unknown) => Promise<void>>();
  const checkYoutube = vi.fn(() => Promise.resolve(answer));
  const allow = vi.fn(() => true);
  registerRadioHandlers(
    { onMessage: ((type: string, handler: (client: Client, raw: unknown) => Promise<void>) => handlers.set(type, handler)) as never },
    { state, allow, checkYoutube, now: () => 1234 },
  );
  const client = { sessionId: "ada", send: vi.fn() } as unknown as Client & { send: ReturnType<typeof vi.fn> };
  const tune = (source: unknown) => handlers.get(CLIENT_MESSAGE.radioTune)!(client, { source });
  return { state, client, tune, checkYoutube, allow };
}

describe("registerRadioHandlers", () => {
  it("opens on the default station", () => {
    expect(harness().state.radio.stationId).toBe(DEFAULT_RADIO_STATION_ID);
  });

  it("plays a YouTube link YouTube says it will play, from the moment it was put on", async () => {
    const { state, tune, checkYoutube } = harness();
    await tune("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL0123456789");
    expect(checkYoutube).toHaveBeenCalledWith("dQw4w9WgXcQ", "PL0123456789");
    expect(state.radio.toJSON()).toEqual({
      stationId: "",
      videoId: "dQw4w9WgXcQ",
      listId: "PL0123456789",
      title: "Lo-fi beats",
      startedAt: 1234,
      tunedBy: "Ada",
    });
  });

  it("switches station without asking YouTube", async () => {
    const { state, tune, checkYoutube } = harness();
    await tune("rp-mellow");
    expect(state.radio.stationId).toBe("rp-mellow");
    expect(checkYoutube).not.toHaveBeenCalled();
  });

  it.each([
    [{ playable: false } as const, RADIO_REJECTION.unplayable],
    [undefined, RADIO_REJECTION.unchecked],
  ])("keeps playing and tells the sender alone when YouTube answers %j", async (answer, rejection) => {
    const { state, client, tune } = harness({ answer });
    await tune("https://youtu.be/dQw4w9WgXcQ");
    expect(state.radio.stationId).toBe(DEFAULT_RADIO_STATION_ID);
    expect(client.send).toHaveBeenCalledWith(SERVER_MESSAGE.radioRejected, { rejection });
  });

  it("refuses a sender across the office before charging them or asking YouTube", async () => {
    const { state, client, tune, checkYoutube, allow } = harness({ at: { x: SPOT.x + 5, z: SPOT.z, yaw: 0 } });
    await tune("https://youtu.be/dQw4w9WgXcQ");
    expect(client.send).toHaveBeenCalledWith(SERVER_MESSAGE.radioRejected, { rejection: RADIO_REJECTION.outOfRange });
    expect(allow).not.toHaveBeenCalled();
    expect(checkYoutube).not.toHaveBeenCalled();
    expect(state.radio.stationId).toBe(DEFAULT_RADIO_STATION_ID);
  });

  it("drops a link that is not one without a word", async () => {
    const { client, tune, checkYoutube } = harness();
    await tune("https://example.com/song.mp3");
    expect(client.send).not.toHaveBeenCalled();
    expect(checkYoutube).not.toHaveBeenCalled();
  });
});
