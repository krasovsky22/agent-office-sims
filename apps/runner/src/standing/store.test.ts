/**
 * The standing store's reading of caps: a task stored when every task got the
 * same caps is read with the caps the CEO never chose left out.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StandingStore } from "./store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sim-standing-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function loaded(caps: Record<string, number>) {
  const file = join(dir, "standing.json");
  const spec = { id: "st-prwatch1", kind: "pr-review", name: "", paused: false, note: "", version: 1, caps, intervalSeconds: 120, authors: "collaborators" };
  writeFileSync(file, JSON.stringify({ day: "2026-10-20", spentTodayUsd: 0, tasks: [{ spec, ledger: {}, runStarts: [] }], unsent: [] }));
  return new StandingStore({ file }).load("2026-10-20").tasks[0]?.spec.caps;
}

describe("the standing store", () => {
  it("reads the caps every task was given before caps were optional as unset", () => {
    expect(loaded({ perRunUsd: 0.5, runMinutes: 10, maxRunsPerHour: 6 })).toEqual({ runMinutes: 10 });
    expect(loaded({ perRunUsd: 0.25, runMinutes: 10, maxRunsPerHour: 6 })).toEqual({ runMinutes: 10 });
  });

  it("keeps caps that are not those", () => {
    expect(loaded({ perRunUsd: 1, runMinutes: 10, maxRunsPerHour: 6 })).toEqual({ perRunUsd: 1, runMinutes: 10, maxRunsPerHour: 6 });
    expect(loaded({ runMinutes: 20, maxRunsPerHour: 3 })).toEqual({ runMinutes: 20, maxRunsPerHour: 3 });
  });

  it("keeps a steward resolve's ledger entry, keyed by head and base, through a save and a load", () => {
    const file = join(dir, "standing.json");
    const spec = { id: "st-prwatch1", kind: "pr-review", name: "", paused: false, note: "", version: 1, caps: { runMinutes: 10 }, intervalSeconds: 120, authors: "collaborators" };
    const entry = { state: "failed", attempts: 3, at: 5 };
    const ledger = { "fix:189@abc1234+def5678": entry, "fix:190@abc1234+": entry };
    writeFileSync(file, JSON.stringify({ day: "2026-10-20", spentTodayUsd: 0, tasks: [{ spec, ledger, runStarts: [] }], unsent: [] }));
    const store = new StandingStore({ file });
    store.save(store.load("2026-10-20"));
    expect(Object.keys(new StandingStore({ file }).load("2026-10-20").tasks[0]?.ledger ?? {})).toEqual(Object.keys(ledger));
  });
});
