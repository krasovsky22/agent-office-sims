/** Changing the conference room's TV: only from in front of it, and only to a link YouTube will play. */

import type { Client } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  DEFAULT_TV_CHANNEL,
  HumanPlayer,
  OFFICE_LAYOUT,
  OfficeState,
  SERVER_MESSAGE,
  TV_CHANNEL,
  TV_INTERACTABLE_ID,
  TV_REJECTION,
  interactableById,
} from "@sim/shared";
import { describe, expect, it, vi } from "vitest";

import type { YoutubeAnswer } from "../sim/youtube.js";
import { registerTvHandlers } from "./tvHandlers.js";

const SPOT = interactableById(OFFICE_LAYOUT, TV_INTERACTABLE_ID)!.anchor;

function harness(options: { readonly answer?: YoutubeAnswer; readonly at?: typeof SPOT } = {}) {
  // An `undefined` answer is one of the cases, so only a missing one means "plays".
  const answer = "answer" in options ? options.answer : { playable: true as const, title: "Keynote" };
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
  registerTvHandlers(
    { onMessage: ((type: string, handler: (client: Client, raw: unknown) => Promise<void>) => handlers.set(type, handler)) as never },
    { state, layout: OFFICE_LAYOUT, allow, checkYoutube, now: () => 1234 },
  );
  const client = { sessionId: "ada", send: vi.fn() } as unknown as Client & { send: ReturnType<typeof vi.fn> };
  const tune = (payload: unknown) => handlers.get(CLIENT_MESSAGE.tvTune)!(client, payload);
  return { state, client, tune, checkYoutube, allow };
}

describe("registerTvHandlers", () => {
  it("opens on the daily board, with no video", () => {
    const { state } = harness();
    expect(state.tv.channel).toBe(DEFAULT_TV_CHANNEL);
    expect(state.tv.startedAt).toBe(0);
  });

  it("switches channel for everyone without asking YouTube", async () => {
    const { state, tune, checkYoutube } = harness();
    await tune({ channel: TV_CHANNEL.sprint });
    expect(state.tv.channel).toBe(TV_CHANNEL.sprint);
    expect(state.tv.changedBy).toBe("Ada");
    expect(checkYoutube).not.toHaveBeenCalled();
  });

  it("plays a YouTube link YouTube says it will play, from the moment it was given", async () => {
    const { state, tune, checkYoutube } = harness();
    await tune({ channel: TV_CHANNEL.youtube, link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL0123456789" });
    expect(checkYoutube).toHaveBeenCalledWith("dQw4w9WgXcQ", "PL0123456789");
    expect(state.tv.toJSON()).toEqual({
      channel: TV_CHANNEL.youtube,
      videoId: "dQw4w9WgXcQ",
      listId: "PL0123456789",
      title: "Keynote",
      startedAt: 1234,
      changedBy: "Ada",
    });
  });

  it("keeps the link through another channel, so switching back finds it running", async () => {
    const { state, tune } = harness();
    await tune({ channel: TV_CHANNEL.youtube, link: "https://youtu.be/dQw4w9WgXcQ" });
    await tune({ channel: TV_CHANNEL.status });
    await tune({ channel: TV_CHANNEL.youtube });
    expect(state.tv.channel).toBe(TV_CHANNEL.youtube);
    expect(state.tv.videoId).toBe("dQw4w9WgXcQ");
    expect(state.tv.startedAt).toBe(1234);
  });

  it.each([
    [{ playable: false } as const, TV_REJECTION.unplayable],
    [undefined, TV_REJECTION.unchecked],
  ])("keeps the channel it had and tells the sender alone when YouTube answers %j", async (answer, rejection) => {
    const { state, client, tune } = harness({ answer });
    await tune({ channel: TV_CHANNEL.youtube, link: "https://youtu.be/dQw4w9WgXcQ" });
    expect(state.tv.channel).toBe(DEFAULT_TV_CHANNEL);
    expect(state.tv.videoId).toBe("");
    expect(client.send).toHaveBeenCalledWith(SERVER_MESSAGE.tvRejected, { rejection });
  });

  it("refuses a sender away from the TV before charging them or asking YouTube", async () => {
    const { state, client, tune, checkYoutube, allow } = harness({ at: { x: SPOT.x, z: SPOT.z - 6, yaw: 0 } });
    await tune({ channel: TV_CHANNEL.youtube, link: "https://youtu.be/dQw4w9WgXcQ" });
    expect(client.send).toHaveBeenCalledWith(SERVER_MESSAGE.tvRejected, { rejection: TV_REJECTION.outOfRange });
    expect(allow).not.toHaveBeenCalled();
    expect(checkYoutube).not.toHaveBeenCalled();
    expect(state.tv.channel).toBe(DEFAULT_TV_CHANNEL);
  });

  it("drops a change the limiter refuses", async () => {
    const { state, tune, allow } = harness();
    allow.mockReturnValue(false);
    await tune({ channel: TV_CHANNEL.tickets });
    expect(state.tv.channel).toBe(DEFAULT_TV_CHANNEL);
  });

  it.each([{ channel: "news" }, { channel: TV_CHANNEL.daily, link: "https://youtu.be/dQw4w9WgXcQ" }, { channel: TV_CHANNEL.youtube, link: "https://example.com/a.mp4" }])(
    "drops %j without a word",
    async (payload) => {
      const { state, client, tune, checkYoutube } = harness();
      await tune(payload);
      expect(client.send).not.toHaveBeenCalled();
      expect(checkYoutube).not.toHaveBeenCalled();
      expect(state.tv.channel).toBe(DEFAULT_TV_CHANNEL);
    },
  );
});
