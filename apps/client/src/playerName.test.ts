import { NAME_REJECTION } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { PLAYER_NAME_STORAGE_KEY, nameRejectionText, readPlayerName, writePlayerName } from "./playerName.js";

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

describe("readPlayerName", () => {
  it("prefers ?name=, then the name kept last time, then nothing", () => {
    const storage = memoryStorage();
    expect(readPlayerName("", storage)).toBe("");
    writePlayerName(storage, "  Dana  ");
    expect(storage.getItem(PLAYER_NAME_STORAGE_KEY)).toBe("Dana");
    expect(readPlayerName("", storage)).toBe("Dana");
    expect(readPlayerName("?name=Milo", storage)).toBe("Milo");
    expect(readPlayerName("?name=%20", storage)).toBe("Dana");
  });

  it("starts empty where storage is missing or refused", () => {
    expect(readPlayerName("", undefined)).toBe("");
    expect(readPlayerName("", refusing)).toBe("");
    expect(() => writePlayerName(refusing, "Dana")).not.toThrow();
  });
});

describe("nameRejectionText", () => {
  it("says why, and what the player is called instead when known", () => {
    expect(nameRejectionText({ name: "Dana", rejection: NAME_REJECTION.taken }, "Dana 2")).toBe(
      "Someone here is already called Dana. You are Dana 2; rename yourself from the roster.",
    );
    expect(nameRejectionText({ name: "AI Manager", rejection: NAME_REJECTION.reserved }, undefined)).toBe(
      "AI Manager is the name of someone who works here.",
    );
  });
});
