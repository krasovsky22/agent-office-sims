/** The radio's links, read the same way by the client and the server. */

import { describe, expect, it } from "vitest";

import { RADIO_STATIONS, parseRadioSource, parseRadioTuneMessage, radioLoudness, youtubeUrl } from "./radio.js";

describe("parseRadioSource", () => {
  it("takes a station by id", () => {
    expect(parseRadioSource("rp-rock")).toEqual({ kind: "station", stationId: "rp-rock" });
  });

  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ", ""],
    ["youtube.com/watch?v=dQw4w9WgXcQ&t=42", "dQw4w9WgXcQ", ""],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ", ""],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ", ""],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI", "dQw4w9WgXcQ", "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"],
    ["  https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI ", "", "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"],
  ])("reads %s", (link, videoId, listId) => {
    expect(parseRadioSource(link)).toEqual({ kind: "youtube", videoId, listId });
  });

  it.each([
    "",
    "not a link",
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/playlist",
    "https://www.youtube.com/channel/UC-9-kyTW8ZkZNDHQJ6FgpwQ",
    "https://youtu.be/dQw4w9WgXcQ?list=bad list",
    `https://youtu.be/dQw4w9WgXcQ?x=${"a".repeat(400)}`,
  ])("refuses %j", (link) => {
    expect(parseRadioSource(link)).toBeUndefined();
  });

  it("parses a tune payload only when its source is a string that reads", () => {
    expect(parseRadioTuneMessage({ source: RADIO_STATIONS[0]?.id })).toEqual({
      source: { kind: "station", stationId: RADIO_STATIONS[0]?.id },
    });
    expect(parseRadioTuneMessage({ source: 7 })).toBeUndefined();
    expect(parseRadioTuneMessage(null)).toBeUndefined();
  });
});

describe("youtubeUrl", () => {
  it("rebuilds the page YouTube shows for a source", () => {
    expect(youtubeUrl("dQw4w9WgXcQ", "")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(youtubeUrl("", "PL0123456789")).toBe("https://www.youtube.com/playlist?list=PL0123456789");
    expect(youtubeUrl("dQw4w9WgXcQ", "PL0123456789")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL0123456789");
  });
});

describe("radioLoudness", () => {
  it("is full beside the radio, quieter across the office, and never silent", () => {
    expect(radioLoudness(0)).toBe(1);
    expect(radioLoudness(8)).toBeLessThan(1);
    expect(radioLoudness(8)).toBeGreaterThan(radioLoudness(14));
    expect(radioLoudness(100)).toBeCloseTo(0.5);
  });
});
