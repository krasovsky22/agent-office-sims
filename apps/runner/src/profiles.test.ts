/**
 * The profile store keeps the CEO's edits to the agents' profiles across a
 * restart, private to the runner's user, and reads a damaged file as none kept.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentProfile } from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProfileStore } from "./profiles.js";

const GRACE: AgentProfile = { name: "Grace", title: "Release Engineer", description: "Keeps the release branch green." };
const LEO: AgentProfile = { name: "Leo", title: "Software Developer", description: "" };

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "profiles-"));
  file = join(dir, "profiles.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ProfileStore", () => {
  it("keeps nothing until something is saved", () => {
    expect(new ProfileStore({ file }).load()).toEqual(new Map());
  });

  it("reads back what it saved, by slot, readable by the runner's user alone", () => {
    const store = new ProfileStore({ file });
    store.save(
      new Map([
        ["slot-1", GRACE],
        ["slot-2", LEO],
      ]),
    );
    expect(new ProfileStore({ file }).load()).toEqual(
      new Map([
        ["slot-1", GRACE],
        ["slot-2", LEO],
      ]),
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ slots: { "slot-1": GRACE, "slot-2": LEO } });
  });

  it("drops a profile the contract would not take, saying so, and keeps the rest sanitised", () => {
    writeFileSync(
      file,
      JSON.stringify({
        slots: {
          "slot-1": { name: "  Grace\u0007 ", title: "Release   Engineer", description: "Keeps it green." },
          "slot-2": { name: "", title: "Nobody" },
          "not a slot!": GRACE,
        },
      }),
    );
    const lines: string[] = [];
    expect(new ProfileStore({ file, log: (line) => lines.push(line) }).load()).toEqual(
      new Map([["slot-1", { name: "Grace", title: "Release Engineer", description: "Keeps it green." }]]),
    );
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith("dropped the profile kept for "))).toBe(true);
  });

  it("reads an unreadable file as nothing kept, and says so", () => {
    writeFileSync(file, "{ not json");
    const lines: string[] = [];
    expect(new ProfileStore({ file, log: (line) => lines.push(line) }).load()).toEqual(new Map());
    expect(lines[0]).toMatch(/^could not read .*profiles\.json, so every agent starts with its default profile/);
  });
});
