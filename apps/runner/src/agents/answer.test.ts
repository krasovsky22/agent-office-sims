/**
 * An idle agent's answer to a standup's direction: Claude Code run with no
 * tools and no GitHub identity, its final message the answer, and why not
 * when there is none; and the mock's, its status read back.
 */

import { describe, expect, it } from "vitest";

import type { HeadlessOptions, HeadlessResult } from "../standing/headless.js";
import { ANSWER_MAX_USD, type AnswerRequest, answerPrompt, createClaudeAnswerer, createMockAnswerer } from "./answer.js";

const REQUEST: AnswerRequest = {
  systemPrompt: "In this office your name is Lena and your title is Software Developer.",
  context: "Your update at this standup: No issue in hand, free for one. No blockers.",
  question: "what the status",
  askedBy: "Dana",
  signal: new AbortController().signal,
  spent: () => undefined,
};

function answerer(result: HeadlessResult) {
  const runs: HeadlessOptions[] = [];
  const answers = createClaudeAnswerer({
    command: "/usr/local/bin/claude",
    cwd: "/data/answers",
    scrub: ["GH_TOKEN"],
    env: { PATH: "/usr/bin", HOME: "/home/runner", GH_TOKEN: "ghs_secret", ANTHROPIC_API_KEY: "sk-test", CLAUDECODE: "1" },
    headless: (options) => {
      runs.push(options);
      return Promise.resolve(result);
    },
  });
  return { answers, runs };
}

describe("createClaudeAnswerer", () => {
  it("runs Claude Code once with no tools, as the agent, and answers with its final message", async () => {
    const { answers, runs } = answerer({ ok: true, text: "  I'm free, give me an issue.\n", costUsd: 0.01, why: "" });
    expect(await answers.answer(REQUEST)).toEqual({ ok: true, text: "I'm free, give me an issue.", why: "" });

    const run = runs[0];
    expect(run?.cwd).toBe("/data/answers");
    expect(run?.maxUsd).toBe(ANSWER_MAX_USD);
    const args = run?.args ?? [];
    expect(args.slice(0, 2)).toEqual(["-p", "--output-format"]);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(REQUEST.systemPrompt);
    // The direction comes last, after `--`, so it is never read as an option.
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe(answerPrompt(REQUEST));
    // Its sign-in passes; the agents' GitHub identity and the runner's own session do not.
    expect(run?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/runner", ANTHROPIC_API_KEY: "sk-test" });
    expect(run?.spent).toBe(REQUEST.spent);
  });

  it("says why when it did not answer", async () => {
    expect(await answerer({ ok: false, text: "", costUsd: 0.2, why: "it ran past its 1 minute" }).answers.answer(REQUEST)).toEqual({
      ok: false,
      text: "",
      why: "it ran past its 1 minute",
    });
    expect(await answerer({ ok: true, text: " ", costUsd: 0, why: "" }).answers.answer(REQUEST)).toEqual({ ok: false, text: "", why: "it said nothing" });
  });
});

describe("answerPrompt", () => {
  it("quotes the direction and gives the agent its status", () => {
    const prompt = answerPrompt({ ...REQUEST, question: "what the status\nand next?" });
    expect(prompt).toContain("Dana, the CEO, said this to you:\n\n> what the status\n> and next?");
    expect(prompt).toContain(REQUEST.context);
    expect(answerPrompt({ ...REQUEST, context: "" })).not.toContain("What the office knows of you");
  });
});

describe("createMockAnswerer", () => {
  it("reads its status back, for nothing", async () => {
    expect(await createMockAnswerer().answer(REQUEST)).toEqual({
      ok: true,
      text: "(Simulated answer.) No issue in hand, free for one. No blockers.",
      why: "",
    });
  });
});
