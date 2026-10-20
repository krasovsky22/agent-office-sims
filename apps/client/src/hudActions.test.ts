/** What the HUD's buttons do: send the office a command, or tell the loop to close a panel. */

import { describe, expect, it, vi } from "vitest";

import { type HudActionsHost, hudActions } from "./hudActions.js";
import { NOT_A_YOUTUBE_LINK, readRadioSettings } from "./radio.js";
import type { RoomConnection } from "./net/room.js";
import { type HudSnapshot, createHudStore } from "./ui/hudStore.js";

function harness() {
  let hud: HudSnapshot = createHudStore().getSnapshot();
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  } as unknown as Storage;
  const room = {
    connect: vi.fn(() => Promise.resolve()),
    sendRename: vi.fn(),
    sendAgentKey: vi.fn(() => true),
    sendAgentAction: vi.fn(),
    sendRadioTune: vi.fn(),
  };
  const host: HudActionsHost = {
    room: room as unknown as RoomConnection,
    publish: (next) => {
      hud = { ...hud, ...next };
    },
    hud: () => hud,
    browserStorage: () => storage,
    serverUrl: () => "ws://localhost:2567",
    toggleCamera: vi.fn(),
    answer: vi.fn(),
    issueMoves: { move: vi.fn() },
    askedFor: vi.fn(),
    closePanel: vi.fn(),
    closeTerminal: vi.fn(),
    savedProfile: vi.fn(),
    pressedKey: vi.fn(),
    standUp: vi.fn(),
    closeAgentMenu: vi.fn(),
    radioNotice: vi.fn(),
  };
  return { actions: hudActions(host), host, room, hud: () => hud, storage };
}

describe("hudActions", () => {
  it("joins under the name typed, opening the controls on a first visit only", () => {
    const first = harness();
    first.actions.join("Ada");
    expect(first.host.askedFor).toHaveBeenCalledWith("Ada");
    expect(first.room.connect).toHaveBeenCalledWith("ws://localhost:2567", "Ada");
    expect(first.hud()).toMatchObject({ nameCard: undefined, helpOpen: true });
    first.actions.toggleHelp();
    first.actions.join("Ada");
    expect(first.hud().helpOpen).toBe(false);
  });

  it("remembers the agent a standup key pad pressed, and closes the agent menu once it acts", () => {
    const { actions, host, room } = harness();
    expect(actions.standup.key("agent-1", "enter")).toBe(true);
    expect(host.pressedKey).toHaveBeenCalledWith("agent-1");
    expect(room.sendAgentKey).toHaveBeenCalledWith("agent-1", "enter");
    actions.agentMenu.act("agent-1", "fire");
    expect(room.sendAgentAction).toHaveBeenCalledWith("agent-1", "fire");
    expect(host.closeAgentMenu).toHaveBeenCalled();
  });

  it("sends the radio a station or a YouTube link, and says so at once for anything else", () => {
    const { actions, host, room } = harness();
    actions.radio.tune("rp-mellow");
    actions.radio.tune("https://youtu.be/dQw4w9WgXcQ");
    actions.radio.tune("https://example.com/song.mp3");
    expect(room.sendRadioTune.mock.calls).toEqual([["rp-mellow"], ["https://youtu.be/dQw4w9WgXcQ"]]);
    expect(host.radioNotice).toHaveBeenCalledWith(NOT_A_YOUTUBE_LINK);
  });

  it("keeps the listener's own volume and mute for the next visit", () => {
    const { actions, hud, storage } = harness();
    actions.radio.toggleMute();
    expect(hud().radioSettings.muted).toBe(true);
    actions.radio.setVolume(0.8);
    expect(hud().radioSettings).toEqual({ volume: 0.8, muted: false });
    expect(readRadioSettings(storage)).toEqual({ volume: 0.8, muted: false });
  });
});
