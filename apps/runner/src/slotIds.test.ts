/**
 * The slot stores keep the slots whose agents the CEO fired, or had hired,
 * across a restart, drop an id the contract would not take, and read an
 * unreadable file as holding nobody.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SlotIdStore } from "./slotIds.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fired-"));
  file = join(dir, "fired.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SlotIdStore", () => {
  it("reads back what it saved, in a file only the runner's user can read", () => {
    new SlotIdStore({ list: "fired", file }).save(new Set(["slot-2", "slot-1"]));
    expect(new SlotIdStore({ list: "fired", file }).load()).toEqual(new Set(["slot-1", "slot-2"]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("starts with nobody fired, and drops ids it would not take", () => {
    expect(new SlotIdStore({ list: "fired", file }).load()).toEqual(new Set());
    writeFileSync(file, JSON.stringify({ fired: ["slot-1", 7, "has spaces", ""] }));
    expect(new SlotIdStore({ list: "fired", file }).load()).toEqual(new Set(["slot-1"]));
  });

  it("reads an unreadable file as nobody fired, and says so", () => {
    writeFileSync(file, "{not json");
    const lines: string[] = [];
    expect(new SlotIdStore({ list: "fired", file, log: (line) => lines.push(line) }).load()).toEqual(new Set());
    expect(lines[0]).toMatch(/^could not read .*fired\.json, so no agent is taken to be fired/);
  });

  it("keeps hired slots in the order they were hired, apart from the fired ones", () => {
    const hired = new SlotIdStore({ list: "hired", file: join(dir, "hired.json") });
    hired.save(new Set(["hired-b", "hired-a"]));
    expect([...hired.load()]).toEqual(["hired-b", "hired-a"]);
    expect(new SlotIdStore({ list: "fired", file: join(dir, "hired.json") }).load()).toEqual(new Set());
  });
});
