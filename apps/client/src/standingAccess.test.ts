/**
 * The roster's standing tasks: each row reads as the office's state says, and
 * the buttons are the CEO's alone, disabled with the reason for anyone else.
 */

import { OCCUPANT_KIND } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { type StandingTaskData, agoText, standingAccessFor, standingRejectionText, standingRow } from "./standingAccess.js";

const NOW = 1_792_320_000_000;

const WATCH: StandingTaskData = {
  id: "st-abcd",
  runnerId: "box",
  kind: "pr-review",
  name: "Watch for new pull requests",
  status: "active",
  trigger: "every 2 min",
  lastCheckAt: NOW - 3 * 60_000,
  nextCheckAt: NOW + 60_000,
  queued: 0,
  handledToday: 1,
  spentTodayUsd: 0.2,
  dailyUsd: 2,
  lastError: "",
  lastOutcome: "simulated",
  lastRunAt: NOW - 60_000,
  lastRunPr: 112,
  runningAgentId: "",
};

describe("standingRow", () => {
  it("reads as the task stands", () => {
    expect(standingRow(WATCH, NOW)).toEqual({
      title: "Watch for new pull requests · active",
      lines: ["every 2 min · checked 3 min ago", "Last: simulated PR #112", "$0.20 of $2.00 today"],
      paused: false,
      alert: false,
    });
  });

  it("says what waits, what went wrong, and when it is over budget or paused", () => {
    const row = standingRow({ ...WATCH, status: "over-budget", queued: 2, lastError: "Could not list pull requests", lastOutcome: "", lastCheckAt: 0 }, NOW);
    expect(row).toEqual({
      title: "Watch for new pull requests · over budget",
      lines: ["every 2 min · not checked yet", "$0.20 of $2.00 today · 2 waiting for a slot", "Could not list pull requests"],
      paused: false,
      alert: true,
    });
    expect(standingRow({ ...WATCH, status: "paused" }, NOW).paused).toBe(true);
    expect(standingRow({ ...WATCH, kind: "schedule", trigger: "weekdays 09:00", lastRunPr: 0, lastOutcome: "completed" }, NOW).lines.slice(0, 2)).toEqual([
      "weekdays 09:00 · fired 3 min ago",
      "Last: done",
    ]);
  });
});

describe("standingAccessFor", () => {
  it("lets the CEO, and says why everyone else may not", () => {
    expect(standingAccessFor({ id: "a", kind: OCCUPANT_KIND.human, isCeo: true }, "Dana")).toEqual({ mayManage: true, reason: "" });
    expect(standingAccessFor({ id: "b", kind: OCCUPANT_KIND.human, isCeo: false }, "Dana")).toEqual({
      mayManage: false,
      reason: "Only the CEO, Dana, can pause, resume, remove or check a standing task.",
    });
    expect(standingRejectionText("forbidden")).toBe("Only the CEO can pause, resume, remove or check a standing task.");
  });
});

describe("agoText", () => {
  it("says how long ago, roughly", () => {
    expect(agoText(NOW - 10_000, NOW)).toBe("just now");
    expect(agoText(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(agoText(NOW - 3 * 60 * 60_000, NOW)).toBe("3 h ago");
  });
});
