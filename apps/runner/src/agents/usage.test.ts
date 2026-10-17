/**
 * The transcript meter against transcripts written the way Claude Code writes
 * them: assistant messages logged once per content block, subagents in a
 * folder beside the session, a half-written last line, and the session's own
 * tally at its end.
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TranscriptMeter, priceOf, usageOfMessage } from "./usage.js";

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-"));
  transcript = join(dir, "session-1.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function assistant(id: string, model: string, usage: Record<string, unknown>, at = "2026-10-16T10:00:00Z"): string {
  return `${JSON.stringify({ type: "assistant", timestamp: at, message: { id, model, usage } })}\n`;
}

describe("priceOf", () => {
  it("prices a newer generation before the family it belongs to, and an unknown model as Opus", () => {
    expect(priceOf("claude-sonnet-4-5")).toEqual([3, 15, 0.3]);
    expect(priceOf("claude-sonnet-5-5")).toEqual([2, 10, 0.2]);
    expect(priceOf("claude-opus-5-5")).toEqual([4, 20, 0.2]);
    expect(priceOf("claude-haiku-4-5-20251001")).toEqual([1, 5, 0.1]);
    expect(priceOf("something-else")).toEqual([5, 25, 0.5]);
  });
});

describe("usageOfMessage", () => {
  it("prices input, output, both kinds of cache write, cache reads and web searches", () => {
    const usage = usageOfMessage("claude-sonnet-4-5", {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_creation_input_tokens: 300_000,
      cache_creation: { ephemeral_1h_input_tokens: 100_000 },
      cache_read_input_tokens: 1_000_000,
      server_tool_use: { web_search_requests: 2 },
    });
    // 3 + 1.5 + 200k at 3.75/M + 100k at 6/M + 0.3 + 0.02
    expect(usage.costUsd).toBeCloseTo(3 + 1.5 + 0.75 + 0.6 + 0.3 + 0.02);
    expect(usage).toMatchObject({ input: 1_000_000, output: 100_000, cacheWrite: 300_000, cacheRead: 1_000_000, calls: 1 });
  });

  it("counts nothing it cannot read", () => {
    expect(usageOfMessage("claude-sonnet-4-5", { input_tokens: -5, output_tokens: "many" }).costUsd).toBe(0);
    expect(usageOfMessage("claude-sonnet-4-5", null).costUsd).toBe(0);
  });
});

describe("TranscriptMeter", () => {
  it("reads nothing until a hook names an absolute .jsonl transcript", () => {
    writeFileSync(transcript, assistant("m1", "claude-sonnet-4-5", { input_tokens: 1_000_000 }));
    const meter = new TranscriptMeter();
    expect(meter.scan()).toBe(false);
    meter.follow("relative/session.jsonl");
    meter.follow(join(dir, "notes.txt"));
    expect(meter.scan()).toBe(false);
    meter.follow(transcript);
    expect(meter.scan()).toBe(true);
    expect(meter.usage().costUsd).toBeCloseTo(3);
  });

  it("counts a message logged once per content block once, and reads only what was appended since", () => {
    const meter = new TranscriptMeter();
    meter.follow(transcript);
    writeFileSync(
      transcript,
      assistant("m1", "claude-sonnet-4-5", { input_tokens: 1_000_000 }) + assistant("m1", "claude-sonnet-4-5", { input_tokens: 1_000_000 }),
    );
    meter.scan();
    expect(meter.usage()).toMatchObject({ calls: 1 });
    expect(meter.usage().costUsd).toBeCloseTo(3);
    expect(meter.scan()).toBe(false);

    appendFileSync(transcript, assistant("m2", "claude-sonnet-4-5", { output_tokens: 1_000_000 }));
    expect(meter.scan()).toBe(true);
    expect(meter.usage().costUsd).toBeCloseTo(18);
  });

  it("leaves a half-written last line for the next read, and skips lines it cannot parse", () => {
    const meter = new TranscriptMeter();
    meter.follow(transcript);
    const line = assistant("m1", "claude-sonnet-4-5", { input_tokens: 1_000_000 });
    writeFileSync(transcript, `not json\n${JSON.stringify({ type: "user" })}\n${line.slice(0, 20)}`);
    expect(meter.scan()).toBe(false);
    appendFileSync(transcript, line.slice(20));
    expect(meter.scan()).toBe(true);
    expect(meter.usage().costUsd).toBeCloseTo(3);
  });

  it("adds what the session's subagents spent", () => {
    const meter = new TranscriptMeter();
    meter.follow(transcript);
    writeFileSync(transcript, assistant("m1", "claude-sonnet-4-5", { input_tokens: 1_000_000 }));
    const subagents = join(dir, "session-1", "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, "agent-a.jsonl"), assistant("s1", "claude-haiku-4-5", { input_tokens: 1_000_000 }));
    meter.scan();
    expect(meter.usage().costUsd).toBeCloseTo(4);
  });

  it("snaps to the session's own tally at its end, and estimates what is logged after on top", () => {
    const meter = new TranscriptMeter();
    meter.follow(transcript);
    writeFileSync(
      transcript,
      assistant("m1", "claude-sonnet-4-5", { input_tokens: 1_000_000 }, "2026-10-16T10:00:00Z") +
        `${JSON.stringify({
          type: "cost-state",
          timestamp: "2026-10-16T10:01:00Z",
          totalCostUSD: 3.4,
          modelUsage: { "claude-sonnet-4-5": { inputTokens: 1_000_000, outputTokens: 10_000 } },
        })}\n`,
    );
    meter.scan();
    expect(meter.usage().costUsd).toBeCloseTo(3.4);

    appendFileSync(transcript, assistant("m2", "claude-sonnet-4-5", { input_tokens: 1_000_000 }, "2026-10-16T10:02:00Z"));
    meter.scan();
    expect(meter.usage().costUsd).toBeCloseTo(6.4);
  });

  it("starts the file over when it is shorter than last read", () => {
    const meter = new TranscriptMeter();
    meter.follow(transcript);
    writeFileSync(transcript, assistant("m1", "claude-sonnet-4-5", { input_tokens: 1_000_000 }));
    meter.scan();
    writeFileSync(transcript, assistant("m9", "claude-haiku-4-5", { input_tokens: 1_000 }));
    meter.scan();
    expect(meter.usage().costUsd).toBeCloseTo(3.001);
  });
});
