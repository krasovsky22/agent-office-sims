/**
 * A slot's mirrored terminal, fed real escape sequences: what its frames
 * carry, when it sends a row, when it sends the whole screen, and that no
 * secret survives into a frame however it was printed.
 */

import {
  MAX_SCREEN_HISTORY_PER_FRAME,
  SCREEN_FLAG_BOLD,
  SCREEN_RGB_FLAG,
  type ScreenFrame,
  parseScreenFrame,
} from "@sim/shared";
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

function historyText(frame: ScreenFrame | undefined): string[] | undefined {
  return frame?.history?.map((runs) => runs.map((run) => run[0]).join(""));
}

async function print(mirror: ScreenMirror, data: string): Promise<void> {
  mirror.write(data);
  await mirror.written();
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

  it("sends each row that scrolls off the top once, as history", async () => {
    const mirror = await mirrorWith("one\r\ntwo\r\nthree\r\nfour\r\nfive", 30, 4);
    const first = mirror.flush(0, NO_SECRETS);
    expect(historyText(first)).toEqual(["one"]);
    expect(first?.historyCleared).toBeUndefined();
    expect(parseScreenFrame(JSON.parse(JSON.stringify(first)))).toEqual(first);

    await print(mirror, "\r\nsix\r\nseven");
    expect(historyText(mirror.flush(1, NO_SECRETS))).toEqual(["two", "three"]);

    // Changing the screen, or sending it whole, sends no history again.
    await print(mirror, " more");
    expect(mirror.flush(2, NO_SECRETS)?.history).toBeUndefined();
    mirror.sendWhole();
    const whole = mirror.flush(3, NO_SECRETS);
    expect(whole?.full).toBe(true);
    expect(whole?.history).toBeUndefined();
  });

  it("sends no more history in a frame than the contract allows, the newest of it", async () => {
    const lines = Array.from({ length: MAX_SCREEN_HISTORY_PER_FRAME + 50 }, (_, index) => `line ${index}`);
    const mirror = await mirrorWith(lines.join("\r\n"), 30, 4);
    const history = historyText(mirror.flush(0, NO_SECRETS)) ?? [];
    expect(history).toHaveLength(MAX_SCREEN_HISTORY_PER_FRAME);
    expect(history.at(-1)).toBe(`line ${lines.length - 5}`);
  });

  it("starts the history afresh when the scrollback is cleared or the terminal reset", async () => {
    const mirror = await mirrorWith("a\r\nb\r\nc\r\nd\r\ne", 30, 4);
    mirror.flush(0, NO_SECRETS);

    // Erasing the screen alone leaves the scrollback as it was.
    await print(mirror, "\u001b[2J\u001b[Hnew");
    expect(mirror.flush(1, NO_SECRETS)?.historyCleared).toBeUndefined();

    await print(mirror, "\u001b[3J\r\n1\r\n2\r\n3\r\n4");
    const cleared = mirror.flush(2, NO_SECRETS);
    expect(cleared?.historyCleared).toBe(true);
    expect(historyText(cleared)).toEqual(["new"]);

    mirror.reset();
    await mirror.written();
    const reset = mirror.flush(3, NO_SECRETS);
    expect(reset?.historyCleared).toBe(true);
    expect(reset?.history).toBeUndefined();
    await print(mirror, "x\r\ny\r\nz\r\nw\r\nv");
    expect(historyText(mirror.flush(4, NO_SECRETS))).toEqual(["x"]);
  });

  it("sends no history from the alternate screen, and picks the scrollback up again after it", async () => {
    const mirror = await mirrorWith("a\r\nb\r\nc\r\nd\r\ne", 30, 4);
    mirror.flush(0, NO_SECRETS);
    await print(mirror, "\u001b[?1049h1\r\n2\r\n3\r\n4\r\n5\r\n6");
    expect(mirror.flush(1, NO_SECRETS)?.history).toBeUndefined();
    await print(mirror, "\u001b[?1049l\r\nf\r\ng");
    expect(historyText(mirror.flush(2, NO_SECRETS))).toEqual(["b", "c"]);
  });

  it("masks a secret in the history, wrapped across the screen's top edge", async () => {
    const redactor = createRedactor([SECRET]);
    const mirror = await mirrorWith("", SECRET.length - 2, 4);
    mirror.flush(0, redactor);
    await print(mirror, `${SECRET}\r\none\r\ntwo\r\nthree`);
    const frame = mirror.flush(1, redactor);
    expect(historyText(frame)).toEqual(["*".repeat(SECRET.length - 2)]);
    expect(rowText(frame, 0)).toBe("**");
    expect(JSON.stringify(frame)).not.toContain("runner");
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
