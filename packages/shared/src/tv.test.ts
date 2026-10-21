/** The TV's channel message, read the same way by the client and the server. */

import { describe, expect, it } from "vitest";

import { TV_CHANNEL, TV_CHANNELS, isTvChannel, parseTvTuneMessage, tvLoudness } from "./tv.js";

describe("parseTvTuneMessage", () => {
  it.each(TV_CHANNELS)("switches to %s", (channel) => {
    expect(parseTvTuneMessage({ channel })).toEqual({ channel, video: undefined });
  });

  it("takes a YouTube video or playlist for the YouTube channel", () => {
    expect(parseTvTuneMessage({ channel: TV_CHANNEL.youtube, link: "https://youtu.be/dQw4w9WgXcQ" })).toEqual({
      channel: TV_CHANNEL.youtube,
      video: { videoId: "dQw4w9WgXcQ", listId: "" },
    });
    expect(
      parseTvTuneMessage({ channel: TV_CHANNEL.youtube, link: "youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI" }),
    ).toEqual({ channel: TV_CHANNEL.youtube, video: { videoId: "", listId: "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI" } });
  });

  it.each([
    undefined,
    "daily",
    {},
    { channel: "news" },
    { channel: 3 },
    // A link only goes with the YouTube channel, and only a YouTube one.
    { channel: TV_CHANNEL.daily, link: "https://youtu.be/dQw4w9WgXcQ" },
    { channel: TV_CHANNEL.youtube, link: "https://example.com/watch?v=dQw4w9WgXcQ" },
    { channel: TV_CHANNEL.youtube, link: "rp-main" },
    { channel: TV_CHANNEL.youtube, link: 42 },
    { channel: TV_CHANNEL.youtube, link: `https://youtu.be/dQw4w9WgXcQ?x=${"a".repeat(400)}` },
  ])("refuses %j", (raw) => {
    expect(parseTvTuneMessage(raw)).toBeUndefined();
  });
});

describe("isTvChannel", () => {
  it("knows its five channels and nothing else", () => {
    expect(TV_CHANNELS).toHaveLength(5);
    expect(isTvChannel("sprint")).toBe(true);
    expect(isTvChannel("Sprint")).toBe(false);
  });
});

describe("tvLoudness", () => {
  it("is full in the conference room and quiet, never silent, across the office", () => {
    expect(tvLoudness(0)).toBe(1);
    expect(tvLoudness(5)).toBe(1);
    expect(tvLoudness(12)).toBeLessThan(1);
    expect(tvLoudness(100)).toBeCloseTo(0.15);
  });
});
