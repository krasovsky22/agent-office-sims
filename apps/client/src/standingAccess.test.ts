/**
 * The roster's standing tasks and the recurring tasks' wall board: each row
 * reads as the office's state says, the board's schedule choices read a
 * task's cron and give one back, and the buttons are the CEO's alone,
 * disabled with the reason for anyone else.
 */

import { OCCUPANT_KIND } from "@sim/shared";
import { describe, expect, it } from "vitest";

import {
  type StandingTaskData,
  agoText,
  cronOfChoice,
  recurringRow,
  scheduleChoice,
  standingAccessFor,
  standingRejectionText,
  standingRow,
} from "./standingAccess.js";

const NOW = 1_792_320_000_000;

const WATCH: StandingTaskData = {
  id: "st-abcd",
  runnerId: "box",
  kind: "pr-review",
  name: "Watch for new pull requests",
  status: "active",
  trigger: "every 2 min",
  cron: "",
  intervalSeconds: 120,
  agentId: "",
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
      reason: "Only the CEO, Dana, can pause, resume, remove, check or reschedule a standing task.",
    });
    expect(standingRejectionText("forbidden")).toBe("Only the CEO can pause, resume, remove, check or reschedule a standing task.");
  });
});

describe("agoText", () => {
  it("says how long ago, roughly", () => {
    expect(agoText(NOW - 10_000, NOW)).toBe("just now");
    expect(agoText(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(agoText(NOW - 3 * 60 * 60_000, NOW)).toBe("3 h ago");
  });
});

describe("recurringRow", () => {
  it("reads a task on the wall board: what it does, how often, its last run and how it stands", () => {
    expect(recurringRow({ ...WATCH, kind: "pr-steward", name: "Review, fix and merge pull requests", lastOutcome: "merged" }, NOW, "Leo")).toEqual({
      name: "Review, fix and merge pull requests",
      schedule: "Reviews, resolves and merges new pull requests · every 2 min · Leo's",
      lastRun: "Last run 1 min ago: merged PR #112",
      status: "active",
      tone: "good",
    });
    expect(recurringRow({ ...WATCH, lastRunAt: 0, status: "error" }, NOW, undefined)).toMatchObject({ lastRun: "Not run yet", tone: "bad" });
  });
});

describe("the wall board's schedules", () => {
  it("read a task's cron into the board's choices, and give a cron back", () => {
    expect(scheduleChoice("0 * * * *")).toEqual({ kind: "hourly" });
    expect(scheduleChoice("30 9 * * *")).toEqual({ kind: "daily", time: "09:30" });
    expect(scheduleChoice("0 17 * * 1-5")).toEqual({ kind: "weekdays", time: "17:00" });
    expect(scheduleChoice("*/15 * * * *")).toEqual({ kind: "custom", cron: "*/15 * * * *" });
    expect(cronOfChoice({ kind: "daily", time: "08:05" })).toBe("5 8 * * *");
    expect(cronOfChoice({ kind: "weekdays", time: "17:00" })).toBe("0 17 * * 1-5");
    expect(cronOfChoice({ kind: "custom", cron: " 0  9 * * 1 " })).toBe("0 9 * * 1");
    expect(cronOfChoice({ kind: "daily", time: "25:00" })).toBeUndefined();
  });
});
