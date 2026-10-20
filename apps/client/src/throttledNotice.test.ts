/** Each dropped message is answered where it was sent from. */

import { CLIENT_MESSAGE } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { THROTTLED_PLACE, throttledNotice } from "./throttledNotice.js";

describe("throttledNotice", () => {
  it("answers a prompt, a key and a profile edit in the panel they came from", () => {
    expect(throttledNotice(CLIENT_MESSAGE.agentPrompt).place).toBe(THROTTLED_PLACE.prompt);
    expect(throttledNotice(CLIENT_MESSAGE.agentKey).place).toBe(THROTTLED_PLACE.key);
    expect(throttledNotice(CLIENT_MESSAGE.agentProfile).place).toBe(THROTTLED_PLACE.profile);
  });

  it("answers a standup's commands in the standup panel", () => {
    expect(throttledNotice(CLIENT_MESSAGE.standupStart).place).toBe(THROTTLED_PLACE.standup);
    expect(throttledNotice(CLIENT_MESSAGE.standupDirect).place).toBe(THROTTLED_PLACE.standup);
  });

  it("says each kind of message by name in a notice", () => {
    expect(throttledNotice(CLIENT_MESSAGE.chat)).toEqual({ place: THROTTLED_PLACE.notice, text: "Too many messages — that one was dropped." });
    expect(throttledNotice(CLIENT_MESSAGE.emote).text).toBe("Too many emotes — that one was dropped.");
    expect(throttledNotice(CLIENT_MESSAGE.standingPause).text).toBe(
      "Too many standing task buttons — that one was dropped. Wait a few seconds.",
    );
  });
});
