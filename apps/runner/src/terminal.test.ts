/**
 * A slot's mirrored terminal, fed real escape sequences: what its frames
 * carry, when it sends a row, when it sends the whole screen, and that no
 * secret survives into a frame however it was printed.
 */

import { SCREEN_FLAG_BOLD, SCREEN_RGB_FLAG, type ScreenFrame, parseScreenFrame } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { createRedactor } from "./redact.js";
import { KEYFRAME_MS, ScreenMirror, flushScreens } from "./terminal.js";

const SECRET = "a-runner-secret-long-enough";
const NO_SECRETS = createRedactor([]);

async function mirrorWith(data: string, cols = 30, rows = 4): Promise<ScreenMirror> {
  const mirror = new ScreenMirror(0, cols, rows);
  mirror.write(data);
  await mirror.written();
  return mirror;
}

function rowText(frame: ScreenFrame | undefined, row: number): string | undefined {
  return frame?.lines[row]?.map((run) => run[0]).join("");
}

describe("ScreenMirror", () => {
  it("sends the whole screen first, as styled runs with trailing blanks trimmed", async () => {
    const mirror = await mirrorWith("\u001b[1mbold\u001b[0m \u001b[31mred\u001b[0m\r\n\u001b[38;2;1;2;3mrgb\u001b[0m");
    const frame = mirror.flush(0, NO_SECRETS);
    expect(frame).toEqual({
      cols: 30,
      rows: 4,
      lines: {
        0: [
          ["bold", -1, -1, SCREEN_FLAG_BOLD],
          [" ", -1, -1, 0],
          ["red", 1, -1, 0],
        ],
        1: [["rgb", SCREEN_RGB_FLAG | 0x010203, -1, 0]],
        2: [],
        3: [],
      },
      full: true,
      cursor: [3, 1],
    });
    // What the runner sends is what the server's parser takes, unchanged.
    expect(parseScreenFrame(JSON.parse(JSON.stringify(frame)))).toEqual(frame);
  });

  it("sends nothing while the screen is unchanged, then only the rows that changed", async () => {
    const mirror = await mirrorWith("first\r\nsecond\r\n");
    mirror.flush(0, NO_SECRETS);
    expect(mirror.flush(100, NO_SECRETS)).toBeUndefined();

    mirror.write("third");
    await mirror.written();
    expect(mirror.flush(200, NO_SECRETS)).toEqual({
      cols: 30,
      rows: 4,
      lines: { 2: [["third", -1, -1, 0]] },
      full: false,
      cursor: [5, 2],
    });
  });

  it("sends the whole screen again every keyframe, and when asked", async () => {
    const mirror = await mirrorWith("steady");
    mirror.flush(0, NO_SECRETS);
    expect(mirror.flush(KEYFRAME_MS, NO_SECRETS)).toBeUndefined();
    expect(mirror.flush(KEYFRAME_MS + 1, NO_SECRETS)?.full).toBe(true);
    expect(mirror.flush(KEYFRAME_MS + 2, NO_SECRETS)).toBeUndefined();

    mirror.sendWhole();
    const frame = mirror.flush(KEYFRAME_MS + 3, NO_SECRETS);
    expect(frame?.full).toBe(true);
    expect(rowText(frame, 0)).toBe("steady");
  });

  it("clears the screen on reset, in order with what was written before and after", async () => {
    const mirror = await mirrorWith("old run");
    mirror.flush(0, NO_SECRETS);
    mirror.reset();
    mirror.write("new run");
    await mirror.written();
    expect(mirror.flush(1, NO_SECRETS)?.lines).toEqual({ 0: [["new run", -1, -1, 0]] });
  });

  it("is not marked changed until what was written has been parsed", async () => {
    const mirror = await mirrorWith("");
    mirror.flush(0, NO_SECRETS);
    mirror.write("late");
    expect(mirror.flush(1, NO_SECRETS)).toBeUndefined();
    await mirror.written();
    expect(rowText(mirror.flush(2, NO_SECRETS), 0)).toBe("late");
  });

  it("masks a secret printed in colour", async () => {
    const redactor = createRedactor([SECRET]);
    const mirror = await mirrorWith(`key \u001b[33ma-runner-\u001b[1msecret\u001b[0m-long-enough`, 60);
    const frame = mirror.flush(0, redactor);
    expect(rowText(frame, 0)).toBe(`key ${"*".repeat(SECRET.length)}`);
    expect(JSON.stringify(frame)).not.toContain("secret");
  });

  it("masks a secret the terminal wrapped onto the next row", async () => {
    const redactor = createRedactor([SECRET]);
    const mirror = await mirrorWith(`export RUNNER_SECRET=${SECRET}`, 30);
    const frame = mirror.flush(0, redactor);
    expect(JSON.stringify(frame)).not.toMatch(/runner-|secret-|long-enough/);
    expect(rowText(frame, 0)).toBe(`export RUNNER_SECRET=${"*".repeat(9)}`);
    expect(rowText(frame, 1)).toBe("*".repeat(SECRET.length - 9));
  });

  it("masks the rest of a secret whose start has scrolled off the top", async () => {
    const redactor = createRedactor([SECRET]);
    // Two columns short of the secret, so its last two characters wrap onto
    // the next row, and three more lines push its first row off the screen.
    const mirror = await mirrorWith(`${SECRET.slice(0, -2)}${SECRET.slice(-2)}\r\none\r\ntwo\r\nthree`, SECRET.length - 2, 4);
    const frame = mirror.flush(0, redactor);
    expect(rowText(frame, 0)).toBe("**");
    expect(JSON.stringify(frame)).not.toContain("gh");
  });
});

describe("flushScreens", () => {
  it("gives a frame for each screen that changed, by slot", async () => {
    const changed = await mirrorWith("busy");
    const still = await mirrorWith("idle");
    still.flush(0, NO_SECRETS);
    const screens = flushScreens(
      [
        ["slot-1", changed],
        ["slot-2", still],
      ],
      1,
      NO_SECRETS,
    );
    expect(screens.map((screen) => [screen.slotId, rowText(screen.frame, 0)])).toEqual([["slot-1", "busy"]]);
  });
});
