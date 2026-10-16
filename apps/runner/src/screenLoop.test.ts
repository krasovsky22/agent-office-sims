/**
 * The screen loop against a stand-in for the server: what it posts, that a
 * slot whose frame may have gone missing is sent whole next, that it holds
 * off when refused, and that every post fits the server's size limit.
 */

import { MAX_RUNNER_SCREENS_BYTES, type RunnerScreens, type ScreenFrame, type SlotScreen } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { createRedactor } from "./redact.js";
import { ScreenLoop, fitBatch } from "./screenLoop.js";
import type { ScreensClient, ScreensReply } from "./screensClient.js";
import { SyncError } from "./syncClient.js";
import { ScreenMirror } from "./terminal.js";

const SECRET = "a-runner-secret-long-enough";

/** A server that answers each post with the next of `answers`, or nothing to resend. */
function server(answers: (ScreensReply | Error)[] = []) {
  const posts: RunnerScreens[] = [];
  const client: ScreensClient = async (screens) => {
    posts.push(JSON.parse(JSON.stringify(screens)) as RunnerScreens);
    const answer = answers.shift() ?? { resend: [] };
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return { posts, client };
}

async function setup(answers: (ScreensReply | Error)[] = []) {
  const clock = { now: 0 };
  const mirrors = new Map([
    ["slot-1", new ScreenMirror(0, 30, 3)],
    ["slot-2", new ScreenMirror(0, 30, 3)],
  ]);
  const { posts, client } = server(answers);
  const logged: string[] = [];
  const loop = new ScreenLoop({
    runnerId: "runner-1",
    screens: () => mirrors,
    redactor: createRedactor([SECRET]),
    client,
    now: () => clock.now,
    log: (line) => logged.push(line),
  });
  const write = async (slotId: string, data: string): Promise<void> => {
    const mirror = mirrors.get(slotId);
    mirror?.write(data);
    await mirror?.written();
  };
  await write("slot-1", "");
  await write("slot-2", "");
  return { clock, mirrors, posts, loop, logged, write };
}

function kinds(post: RunnerScreens | undefined): [string, boolean][] {
  return post?.screens.map((screen) => [screen.slotId, screen.frame.full]) ?? [];
}

describe("ScreenLoop", () => {
  it("posts every screen whole first, then only what changed, and nothing when nothing did", async () => {
    const { posts, loop, write } = await setup();
    expect(await loop.flushOnce()).toBe(true);
    expect(kinds(posts[0])).toEqual([
      ["slot-1", true],
      ["slot-2", true],
    ]);
    expect(posts[0]?.runnerId).toBe("runner-1");

    expect(await loop.flushOnce()).toBe(true);
    expect(posts).toHaveLength(1);

    await write("slot-2", "working");
    await loop.flushOnce();
    expect(kinds(posts[1])).toEqual([["slot-2", false]]);
    expect(posts[1]?.screens[0]?.frame.lines).toEqual({ 0: [["working", -1, -1, 0]] });
  });

  it("sends a slot whole after the server says it could not apply its diff", async () => {
    const { posts, loop, write } = await setup([{ resend: [] }, { resend: ["slot-1"] }]);
    await loop.flushOnce();
    await write("slot-1", "a diff the server lost track of");
    await loop.flushOnce();
    await loop.flushOnce();
    expect(kinds(posts[2])).toEqual([["slot-1", true]]);
  });

  it("sends whole every slot of a post that failed, after backing off", async () => {
    const { clock, posts, loop, logged, write } = await setup([new SyncError("could not reach the server")]);
    expect(await loop.flushOnce()).toBe(false);
    expect(logged).toEqual(["screens not posted: could not reach the server; retrying with backoff"]);

    await write("slot-1", "more");
    clock.now += 100;
    expect(await loop.flushOnce()).toBe(false);
    expect(posts).toHaveLength(1);

    clock.now += 1000;
    expect(await loop.flushOnce()).toBe(true);
    expect(kinds(posts[1])).toEqual([
      ["slot-1", true],
      ["slot-2", true],
    ]);
    expect(logged.at(-1)).toBe("screens reach the server again after 1 failed post");
  });

  it("holds off for a second when rate-limited", async () => {
    const { clock, posts, loop } = await setup([new SyncError("screens refused with HTTP 429: too many screens", 429)]);
    await loop.flushOnce();
    clock.now += 999;
    expect(await loop.flushOnce()).toBe(false);
    clock.now += 1;
    expect(await loop.flushOnce()).toBe(true);
    expect(posts).toHaveLength(2);
    expect(kinds(posts[1])).toEqual([
      ["slot-1", true],
      ["slot-2", true],
    ]);
  });

  it("sends a slot whole again after its frame had to be fitted to the size limit", async () => {
    const mirror = new ScreenMirror(0, 200, 60);
    const row = Array.from({ length: 200 }, (_, index) => `\u001b[38;2;${index};1;2;48;2;3;${index};4;1;7mx`).join("");
    mirror.write(Array.from({ length: 60 }, () => row).join("\r\n"));
    await mirror.written();
    const { posts, client } = server();
    const loop = new ScreenLoop({
      runnerId: "runner-1",
      screens: () => [["slot-1", mirror] as const],
      redactor: createRedactor([SECRET]),
      client,
      now: () => 0,
    });
    await loop.flushOnce();
    expect(posts[0]?.screens[0]?.frame.lines[0]).toEqual([["x".repeat(200), -1, -1, 0]]);
    await loop.flushOnce();
    expect(kinds(posts[1])).toEqual([["slot-1", true]]);
  });

  it("never posts the runner's secret", async () => {
    const { posts, loop, write } = await setup();
    await write("slot-1", `RUNNER_SECRET=${SECRET}\r\n`);
    await write("slot-2", `\u001b[32m${SECRET.slice(0, 10)}\u001b[0m${SECRET.slice(10)}`);
    await loop.flushOnce();
    expect(JSON.stringify(posts)).not.toContain(SECRET.slice(2));
  });
});

describe("fitBatch", () => {
  function frame(lines: ScreenFrame["lines"]): ScreenFrame {
    return { cols: 200, rows: 60, lines, full: true, cursor: [0, 0] };
  }

  /** A row of single-character runs, each a different colour: as heavy as a row gets. */
  function heavyRow(): [string, number, number, number][] {
    return Array.from({ length: 200 }, (_, index) => ["x", 0x1000000 | index, 0x1000000 | (index * 7), 7]);
  }

  it("leaves a batch that fits as it is", () => {
    const screens: SlotScreen[] = [{ slotId: "slot-1", frame: frame({ 0: [["hello", -1, -1, 0]] }) }];
    expect(fitBatch("runner-1", screens)).toEqual(screens);
  });

  it("drops a frame's colours when it is too big to send even alone", () => {
    const lines = Object.fromEntries(Array.from({ length: 60 }, (_, row) => [row, heavyRow()]));
    const [fitted] = fitBatch("runner-1", [{ slotId: "slot-1", frame: frame(lines) }]);
    expect(JSON.stringify({ runnerId: "runner-1", screens: [fitted] }).length).toBeLessThanOrEqual(MAX_RUNNER_SCREENS_BYTES);
    expect(fitted?.frame.lines[0]).toEqual([["x".repeat(200), -1, -1, 0]]);
    expect(fitted?.frame.cursor).toEqual([0, 0]);
  });

  it("cuts a frame's text when even its plain text is too big", () => {
    const wide = "日".repeat(200 * 4);
    const lines = Object.fromEntries(Array.from({ length: 60 }, (_, row) => [row, [[wide, -1, -1, 0]] as [string, number, number, number][]]));
    const [fitted] = fitBatch("runner-1", [{ slotId: "slot-1", frame: frame(lines) }]);
    expect(Buffer.byteLength(JSON.stringify({ runnerId: "runner-1", screens: [fitted] }))).toBeLessThanOrEqual(
      MAX_RUNNER_SCREENS_BYTES,
    );
    expect(fitted?.frame.lines[0]?.[0]?.[0].length).toBeGreaterThan(0);
  });

  it("leaves out the screens that do not fit beside the ones before them", () => {
    const half = Object.fromEntries(Array.from({ length: 60 }, (_, row) => [row, [["y".repeat(200 * 3), -1, -1, 0]] as [string, number, number, number][]]));
    const screens: SlotScreen[] = [
      { slotId: "slot-1", frame: frame(half) },
      { slotId: "slot-2", frame: frame(half) },
      { slotId: "slot-3", frame: frame({ 0: [["small", -1, -1, 0]] }) },
    ];
    expect(fitBatch("runner-1", screens).map((screen) => screen.slotId)).toEqual(["slot-1", "slot-3"]);
  });
});
