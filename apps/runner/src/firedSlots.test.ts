/**
 * The fired-slot store keeps the slots whose agents the CEO fired across a
 * restart, drops an id the contract would not take, and reads an unreadable
 * file as nobody fired.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FiredSlotStore } from "./firedSlots.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fired-"));
  file = join(dir, "fired.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FiredSlotStore", () => {
  it("reads back what it saved, in a file only the runner's user can read", () => {
    new FiredSlotStore({ file }).save(new Set(["slot-2", "slot-1"]));
    expect(new FiredSlotStore({ file }).load()).toEqual(new Set(["slot-1", "slot-2"]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("starts with nobody fired, and drops ids it would not take", () => {
    expect(new FiredSlotStore({ file }).load()).toEqual(new Set());
    writeFileSync(file, JSON.stringify({ fired: ["slot-1", 7, "has spaces", ""] }));
    expect(new FiredSlotStore({ file }).load()).toEqual(new Set(["slot-1"]));
  });

  it("reads an unreadable file as nobody fired, and says so", () => {
    writeFileSync(file, "{not json");
    const lines: string[] = [];
    expect(new FiredSlotStore({ file, log: (line) => lines.push(line) }).load()).toEqual(new Set());
    expect(lines[0]).toMatch(/^could not read .*fired\.json, so no agent is taken to be fired/);
  });
});
