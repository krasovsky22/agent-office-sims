import { EMOTES } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { EMOTE_APPEARANCE } from "./emotes.js";
import { CONTROLS, HELP_SEEN_STORAGE_KEY, helpSeen, markHelpSeen } from "./help.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

const refusing: Pick<Storage, "getItem" | "setItem"> = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("helpSeen", () => {
  it("is false until the overlay has been shown once", () => {
    const storage = memoryStorage();
    expect(helpSeen(storage)).toBe(false);
    markHelpSeen(storage);
    expect(storage.getItem(HELP_SEEN_STORAGE_KEY)).toBe("1");
    expect(helpSeen(storage)).toBe(true);
  });

  it("shows the overlay again where storage is missing or refused", () => {
    expect(helpSeen(undefined)).toBe(false);
    expect(helpSeen(refusing)).toBe(false);
    expect(() => markHelpSeen(refusing)).not.toThrow();
  });
});

describe("CONTROLS", () => {
  it("names the emote digits the HUD actually binds", () => {
    const hotkeys = EMOTES.map((emote) => EMOTE_APPEARANCE[emote].hotkey);
    expect(CONTROLS.map((control) => control.keys)).toContain(`${hotkeys[0]}–${hotkeys[hotkeys.length - 1]}`);
  });
});
