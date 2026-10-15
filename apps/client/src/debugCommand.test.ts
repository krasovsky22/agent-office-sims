/**
 * The chat box's `/goto` line. What matters is that a debug line is never
 * mistaken for chat, ordinary chat is never mistaken for one, and a malformed
 * one says how to write it rather than being said out loud.
 */

import { describe, expect, it } from "vitest";

import { parseDebugCommand } from "./debugCommand.js";

describe("parseDebugCommand", () => {
  it("reads a waypoint goto", () => {
    expect(parseDebugCommand("/goto ada wp-meeting-table")).toEqual({
      kind: "goto",
      message: { agent: "ada", target: "wp-meeting-table" },
    });
  });

  it.each(["/goto ada -2.85 -6.4", "/goto ada -2.85,-6.4", "  /GOTO ada   -2.85 , -6.4 "])(
    "reads a position goto from %j",
    (line) => {
      expect(parseDebugCommand(line)).toEqual({
        kind: "goto",
        message: { agent: "ada", target: { x: -2.85, z: -6.4 } },
      });
    },
  );

  it.each(["/goto", "/goto ada", "/goto ada 1 2 3", "/goto ada one two"])(
    "answers %j with how to write it",
    (line) => {
      expect(parseDebugCommand(line)?.kind).toBe("usage");
    },
  );

  it.each(["hello", "going /goto later", "/gotoada wp-ceo-desk", "/shrug"])(
    "leaves %j as chat",
    (line) => {
      expect(parseDebugCommand(line)).toBeUndefined();
    },
  );
});
