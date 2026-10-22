import { TV_CHANNEL } from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { YtPlayer } from "./radioPlayer.js";
import type { TvView } from "./tv.js";

/** Captured from the fake YouTube API: fires the player's onReady with a working player. */
let ready: ((event: { target: YtPlayer }) => void) | undefined;

vi.mock("./radioPlayer.js", () => ({
  loadYoutubeApi: () =>
    Promise.resolve({
      // Like YouTube's own, the constructed player has none of its methods until it is ready.
      Player: function Player(_mount: unknown, options: { events: { onReady: typeof ready } }) {
        ready = options.events.onReady;
      },
    }),
}));

const { TvPlayer } = await import("./tvPlayer.js");

const listeners: Array<() => void> = [];

beforeEach(() => {
  ready = undefined;
  listeners.length = 0;
  const element = () => ({ className: "", setAttribute: () => {}, append: () => {}, replaceChildren: () => {} });
  vi.stubGlobal("document", { createElement: element });
  vi.stubGlobal("window", { addEventListener: (_type: string, listener: () => void) => listeners.push(listener) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const tv: TvView = { channel: TV_CHANNEL.youtube, videoId: "aqz-KE-bpKQ", listId: "", title: "", startedAt: 0, changedBy: "" };

function fakePlayer(): YtPlayer {
  return {
    setVolume: vi.fn(),
    seekTo: vi.fn(),
    getDuration: () => 0,
    playVideo: vi.fn(),
    destroy: vi.fn(),
  };
}

describe("TvPlayer", () => {
  it("does not touch a player that YouTube has not readied yet", async () => {
    const player = new TvPlayer(() => {});
    player.update(tv, 0.5);
    await vi.waitFor(() => expect(ready).toBeDefined());

    // A tab joining while the TV plays: the game loop and the first key press reach it before onReady.
    expect(() => player.update(tv, 0.3)).not.toThrow();
    expect(() => listeners.forEach((listener) => listener())).not.toThrow();

    const target = fakePlayer();
    ready?.({ target });
    player.update(tv, 0.8);
    expect(target.setVolume).toHaveBeenLastCalledWith(80);
  });

  it("drops a player that becomes ready after the TV moved on", async () => {
    const player = new TvPlayer(() => {});
    player.update(tv, 0.5);
    await vi.waitFor(() => expect(ready).toBeDefined());
    player.update({ ...tv, channel: TV_CHANNEL.daily }, 0.5);

    const target = fakePlayer();
    ready?.({ target });
    expect(target.destroy).toHaveBeenCalled();
    expect(target.playVideo).not.toHaveBeenCalled();
  });
});
