/**
 * A headless run, with a small shell script standing in for Claude Code's
 * stream: its steps reach the screen, its spend is booked, its final message
 * is kept, and it is stopped, process group and all, at its minutes or its
 * signal.
 */

import { describe, expect, it } from "vitest";

import { type HeadlessOptions, describeToolUse, runHeadless, screenLine } from "./headless.js";

/** Runs `script` in `/bin/sh` as the CLI would run, printing stream events. */
function options(script: string, overrides: Partial<HeadlessOptions> = {}): HeadlessOptions & { lines: string[]; activities: string[]; spends: number[] } {
  const lines: string[] = [];
  const activities: string[] = [];
  const spends: number[] = [];
  return {
    command: "/bin/sh",
    args: ["-c", script],
    cwd: process.cwd(),
    env: { PATH: process.env["PATH"] ?? "" },
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    maxUsd: 0.5,
    output: (data) => lines.push(data),
    activity: (text) => activities.push(text),
    spent: (total) => spends.push(total),
    stopGraceMs: 200,
    lines,
    activities,
    spends,
    ...overrides,
  };
}

const say = (event: unknown): string => `printf '%s\\n' '${JSON.stringify(event).replace(/'/g, `'\\''`)}'\n`;

const USAGE = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

describe("runHeadless", () => {
  it("shows each step, books its spend, and keeps its final message", async () => {
    const run = options(
      [
        say({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }),
        say({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5-5", usage: USAGE, content: [{ type: "tool_use", name: "Read", input: { file_path: ".sims-review/pr.diff" } }] } }),
        say({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5-5", usage: USAGE, content: [{ type: "text", text: "Looking.\nMore" }] } }),
        say({ type: "result", subtype: "success", is_error: false, result: "LGTM", total_cost_usd: 0.03 }),
      ].join(""),
    );
    const result = await runHeadless(run);
    expect(result).toEqual({ ok: true, text: "LGTM", costUsd: 0.03, why: "" });
    expect(run.activities).toEqual(["Read: .sims-review/pr.diff"]);
    expect(run.lines.join("")).toContain("●\u001b[0m Read: .sims-review/pr.diff");
    expect(run.lines.join("")).toContain("Looking.");
    // One message's usage once, however many blocks it was logged in.
    expect(run.spends[0]).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6);
    expect(run.spends.at(-1)).toBe(0.03);
  });

  it("says why when it stopped short of success", async () => {
    const result = await runHeadless(options(say({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "", total_cost_usd: 0.51 })));
    expect(result).toMatchObject({ ok: false, why: "it reached its spending cap", costUsd: 0.51 });
  });

  it("is stopped at its minutes, and when its signal aborts", async () => {
    const timedOut = await runHeadless(options("sleep 60", { timeoutMs: 150 }));
    expect(timedOut).toMatchObject({ ok: false, why: expect.stringMatching(/^it ran past its/) });

    const controller = new AbortController();
    const stopping = runHeadless(options("sleep 60", { signal: controller.signal }));
    setTimeout(() => controller.abort("preempted"), 50);
    expect(await stopping).toMatchObject({ ok: false, why: "it was stopped" });
  });

  it("is stopped once its own estimate passes its cap by a margin", async () => {
    const big = { input_tokens: 10_000_000, output_tokens: 0 };
    const result = await runHeadless(
      options(`${say({ type: "assistant", message: { id: "m1", model: "claude-sonnet-5-5", usage: big, content: [] } })}sleep 60`),
    );
    expect(result).toMatchObject({ ok: false, why: "it passed its spending cap of $0.50" });
  });

  it("says when the agent ended without a result", async () => {
    const result = await runHeadless(options("echo 'Not logged in' >&2; exit 2"));
    expect(result).toMatchObject({ ok: false, why: "the agent exited with code 2 without finishing: Not logged in" });
  });
});

describe("what a step reads as", () => {
  it("names the tool and what it is on, on one clean line", () => {
    expect(describeToolUse({ name: "Grep", input: { pattern: "TODO" } })).toBe("Grep: TODO");
    expect(describeToolUse({ name: "Glob" })).toBe("Glob");
    expect(screenLine("a\u001b[31m\nb")).toBe("a [31m b");
  });
});
