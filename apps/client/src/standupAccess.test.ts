/**
 * The standup's controls are offered exactly when the server will take them,
 * a refusal reads as a reason, and the meeting's header and directions read
 * as what is happening.
 */

import {
  CLIENT_MESSAGE,
  NO_STANDUP,
  OCCUPANT_KIND,
  STANDUP_DIRECTION_STATUS,
  STANDUP_REJECTION,
  type StandupDirectionData,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { directionStatusText, standupAccessFor, standupPhaseText, standupRejectionText } from "./standupAccess.js";

describe("standupAccessFor", () => {
  it("lets the CEO run the standup", () => {
    expect(standupAccessFor({ id: "a", kind: OCCUPANT_KIND.human, isCeo: true }, "Dana")).toMatchObject({ mayRun: true });
  });

  it("tells anyone else who can, and that they can follow along", () => {
    expect(standupAccessFor({ id: "b", kind: OCCUPANT_KIND.human, isCeo: false }, "Dana")).toEqual({
      mayRun: false,
      summary: "Only the CEO, Dana, can call a standup, end it or give directions at it. You can follow along.",
    });
    expect(standupAccessFor({ id: "b", kind: OCCUPANT_KIND.human, isCeo: false }, undefined).summary).toMatch(/^Only the CEO can/);
  });
});

describe("standupRejectionText", () => {
  it("has words for every refusal of every command", () => {
    for (const command of [CLIENT_MESSAGE.standupStart, CLIENT_MESSAGE.standupEnd, CLIENT_MESSAGE.standupDirect] as const) {
      for (const rejection of Object.values(STANDUP_REJECTION)) {
        expect(standupRejectionText({ command, rejection })).not.toBe("");
      }
    }
    expect(standupRejectionText({ command: CLIENT_MESSAGE.standupDirect, rejection: STANDUP_REJECTION.forbidden })).toBe(
      "Only the CEO can give directions at a standup.",
    );
    expect(standupRejectionText({ command: CLIENT_MESSAGE.standupStart, rejection: STANDUP_REJECTION.noAgents })).toBe(
      "There are no agents on the floor to gather for a standup.",
    );
  });
});

describe("directionStatusText", () => {
  const direction = (status: string, reason = ""): StandupDirectionData => ({
    id: 1,
    agentId: "agent:one",
    agentName: "Claude 1",
    authorName: "Dana",
    text: "Open the PR.",
    everyone: false,
    status,
    reason,
    at: 0,
  });

  it("says what came of each direction", () => {
    expect(directionStatusText(direction(STANDUP_DIRECTION_STATUS.typed))).toBe("typed into its terminal");
    expect(directionStatusText(direction(STANDUP_DIRECTION_STATUS.queued))).toBe(
      "kept for when it is next at its prompt, after the standup",
    );
    expect(directionStatusText(direction(STANDUP_DIRECTION_STATUS.delivered))).toBe("typed after the standup");
    expect(directionStatusText(direction(STANDUP_DIRECTION_STATUS.noted))).toMatch(/^noted/);
    expect(directionStatusText(direction(STANDUP_DIRECTION_STATUS.failed, "its runner could not be reached"))).toBe(
      "not typed: its runner could not be reached",
    );
  });
});

describe("standupPhaseText", () => {
  const nameOf = (id: string) => (id === "agent:one" ? "Claude 1" : undefined);

  it("follows the meeting from gathering, through each update, to done", () => {
    const on = { ...NO_STANDUP, active: true, calledBy: "Dana" };
    expect(standupPhaseText(on, nameOf)).toBe("Gathering in the conference room…");
    expect(standupPhaseText({ ...on, speakerId: "agent:one" }, nameOf)).toBe("Claude 1 is giving an update");
    const update = { agentId: "agent:one", agentName: "Claude 1", workedOn: "", blockers: "", needsYou: false, resolved: false, at: 0 };
    expect(standupPhaseText({ ...on, updates: [update] }, nameOf)).toBe("Updates done");
    expect(standupPhaseText(NO_STANDUP, nameOf)).toBe("Over");
  });
});
