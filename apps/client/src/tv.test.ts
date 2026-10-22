import { TV_CHANNEL } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { type TvView, tvSilencesRadio } from "./tv.js";

const VIDEO: TvView = { channel: TV_CHANNEL.youtube, videoId: "dQw4w9WgXcQ", listId: "", title: "", startedAt: 0, changedBy: "" };

describe("tvSilencesRadio", () => {
  it("silences the radio while the TV's video is heard", () => {
    expect(tvSilencesRadio(VIDEO, 0.4, false)).toBe(true);
    expect(tvSilencesRadio({ ...VIDEO, videoId: "", listId: "PL123" }, 0.1, false)).toBe(true);
  });

  it("lets the radio play once the TV is on another channel or has no video", () => {
    expect(tvSilencesRadio({ ...VIDEO, channel: TV_CHANNEL.daily }, 0.4, false)).toBe(false);
    expect(tvSilencesRadio({ ...VIDEO, videoId: "" }, 0.4, false)).toBe(false);
  });

  it("lets the radio play while the TV is muted, or YouTube refuses it in this tab", () => {
    expect(tvSilencesRadio(VIDEO, 0, false)).toBe(false);
    expect(tvSilencesRadio(VIDEO, 0.4, true)).toBe(false);
  });
});
