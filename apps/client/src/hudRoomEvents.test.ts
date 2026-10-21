/** The room's events the HUD alone hears of, each said where this player will look for it. */

import { AGENT_PROMPT_REJECTION, CLIENT_MESSAGE, LIFT_REJECTION, MANAGER_ENTRY_KIND, type ManagerEntry, RADIO_REJECTION } from "@sim/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { type HudRoomEventsHost, hudRoomEvents } from "./hudRoomEvents.js";
import type { RoomConnectionEvents } from "./net/roomEvents.js";
import { type HudSnapshot, createHudStore } from "./ui/hudStore.js";

const line = (id: number): ManagerEntry => ({ id, kind: MANAGER_ENTRY_KIND.reply, authorName: "Manager", text: "hi", at: id });

describe("hudRoomEvents", () => {
  let hud: HudSnapshot;
  let notices: string[];
  let events: RoomConnectionEvents;

  beforeEach(() => {
    hud = createHudStore().getSnapshot();
    notices = [];
    const host: HudRoomEventsHost = {
      publish: (next) => {
        hud = { ...hud, ...next };
      },
      hud: () => hud,
      notice: (text) => notices.push(text),
      standupNotice: (text) => notices.push(`standup: ${text}`),
      radioNotice: (text) => notices.push(`radio: ${text}`),
      liftNotice: (text) => notices.push(`lift: ${text}`),
      nameOf: (id) => (id === "agent-1" ? "Maya" : undefined),
      localId: () => "me",
      restrictLabel: () => "no-agents",
      lastKeyAgentId: () => "agent-1",
      lastProfileAgentId: () => "agent-2",
    };
    events = hudRoomEvents(host);
  });

  it("counts the manager's new lines as unread while its panel is closed, once each", () => {
    events.onManagerEntry?.(line(1));
    events.onManagerEntry?.(line(1));
    events.onManagerEntry?.(line(2));
    expect(hud.managerLog.map((entry) => entry.id)).toEqual([1, 2]);
    expect(hud.managerUnread).toBe(2);
    events.onManagerHistory?.([line(3)]);
    expect(hud).toMatchObject({ managerLog: [line(3)], managerUnread: 0 });
  });

  it("says a dropped key under the key pad last pressed, and a dropped standup command in the standup panel", () => {
    events.onThrottled?.({ command: CLIENT_MESSAGE.agentKey });
    expect(hud.agentPromptRefusal).toMatchObject({ agentId: "agent-1", forKey: true });
    events.onThrottled?.({ command: CLIENT_MESSAGE.standupDirect });
    expect(notices).toEqual(["standup: Too many directions — that one was dropped. Wait a few seconds and send it again."]);
  });

  it("says a refused prompt in the agent's terminal panel, and as a notice once that panel is closed", () => {
    hud = { ...hud, terminalAgentId: "agent-1" };
    events.onAgentPromptRejected?.({ agentId: "agent-1", rejection: AGENT_PROMPT_REJECTION.forbidden });
    expect(hud.agentPromptRefusal?.agentId).toBe("agent-1");
    expect(notices).toEqual([]);
    hud = { ...hud, terminalAgentId: undefined };
    events.onAgentPromptRejected?.({ agentId: "agent-1", rejection: AGENT_PROMPT_REJECTION.forbidden });
    expect(notices).toHaveLength(1);
  });

  it("says why the radio did not take a tune, and a dropped one, where the radio is changed", () => {
    events.onRadioRejected?.({ rejection: RADIO_REJECTION.unplayable });
    events.onThrottled?.({ command: CLIENT_MESSAGE.radioTune });
    expect(notices).toHaveLength(2);
    expect(notices.every((text) => text.startsWith("radio: "))).toBe(true);
  });

  it("lists the floors the lift was called for, and says why it would not take this player where the lift is called", () => {
    const floors = [{ floor: 1, repository: "acme/office", people: 1 }];
    events.onLiftFloors?.({ floors });
    expect(hud.liftFloors).toEqual(floors);
    events.onLiftRejected?.({ rejection: LIFT_REJECTION.full });
    expect(notices).toEqual(["lift: That floor is full; try again when someone leaves."]);
  });
});
