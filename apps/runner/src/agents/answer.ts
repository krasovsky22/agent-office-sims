/**
 * An idle agent's answer to a direction the CEO gave at a standup.
 *
 * A direction is typed into the agent's session, but an agent free between
 * tasks has none, so rather than refuse it the slot asks the agent to answer
 * it: one short headless run (`../standing/headless.ts`) with its profile as
 * its system prompt and its status as the office sees it, whose final message
 * is its answer. It is read-only whatever `RUNNER_AGENT_PERMISSIONS` says: no
 * tools at all, `--restricted` so the user's and the project's settings are
 * ignored, no MCP servers, no GitHub identity, in a directory of the runner's
 * own. It is capped by {@link ANSWER_MAX_USD} and {@link ANSWER_TIMEOUT_MS},
 * and its spend is booked by the slot, as any run's is.
 *
 * The mock's answer is its status, read back, and costs nothing.
 */

import { childEnv } from "./childEnv.js";
import { CLAUDE_CREDENTIAL_ENV, CLAUDE_SCRUB_ENV } from "./claude.js";
import { type HeadlessOptions, type HeadlessResult, runHeadless } from "../standing/headless.js";

/** Longest an answer runs before it is given up on: an answer, not a task. */
export const ANSWER_TIMEOUT_MS = 60_000;

/** Most an answer may spend, in US dollars. */
export const ANSWER_MAX_USD = 0.25;

export interface AnswerRequest {
  /** Its system prompt, from its slot's profile; see `./prompt.ts`. */
  readonly systemPrompt: string;
  /** Its status as the office sees it; `""` from a server that sends none. */
  readonly context: string;
  /** The CEO's direction. */
  readonly question: string;
  readonly askedBy: string;
  readonly signal: AbortSignal;
  /** All it has cost so far, in US dollars. */
  readonly spent: (totalUsd: number) => void;
}

export interface AnswerResult {
  readonly ok: boolean;
  /** What it said, when it answered. */
  readonly text: string;
  /** Why it did not answer; `""` when it did. */
  readonly why: string;
}

/** How the slots have an idle agent answer a direction. */
export interface Answerer {
  answer(request: AnswerRequest): Promise<AnswerResult>;
}

/** The answer run's one message: the direction, who gave it, and what the agent knows of itself. */
export function answerPrompt(request: Pick<AnswerRequest, "context" | "question" | "askedBy">): string {
  const lines = [
    `You are at the office's standup, free between tasks, and ${request.askedBy}, the CEO, said this to you:`,
    "",
    ...request.question.split("\n").map((line) => `> ${line}`.trimEnd()),
    "",
  ];
  const context = request.context.trim();
  if (context !== "") {
    lines.push("What the office knows of you right now:", "", context, "");
  }
  lines.push(
    "Answer in the first person, as yourself, in plain text: one to three short sentences, since it is said aloud at the standup. Say only what you know from the above; if it asks for something you cannot know, say so. You cannot read files or run anything, and you start no work yourself: an issue the CEO wants done is assigned from the board.",
  );
  return lines.join("\n");
}

export interface ClaudeAnswererOptions {
  /** Claude Code's absolute path. */
  readonly command: string;
  /** Where it runs: a directory of the runner's own, never a checkout. */
  readonly cwd: string;
  readonly model?: string | undefined;
  /** Kept out of its environment as well as Claude Code's own: the agents' GitHub identity. */
  readonly scrub?: readonly string[];
  /** The environment its own is picked from; the runner's by default. */
  readonly env?: NodeJS.ProcessEnv;
  /** Injected so a test can stand in for Claude Code. */
  readonly headless?: (options: HeadlessOptions) => Promise<HeadlessResult>;
  readonly timeoutMs?: number;
}

export function createClaudeAnswerer(options: ClaudeAnswererOptions): Answerer {
  const headless = options.headless ?? runHeadless;
  return {
    async answer(request) {
      const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config"];
      if (options.model !== undefined) {
        args.push("--model", options.model);
      }
      // No tools at all: it answers from what it is told, and changes nothing.
      args.push("--restricted", "--tools", "", "--permission-mode", "dontAsk", "--max-budget-usd", ANSWER_MAX_USD.toFixed(2));
      if (request.systemPrompt !== "") {
        args.push("--append-system-prompt", request.systemPrompt);
      }
      const result = await headless({
        command: options.command,
        // `--` so a direction can never be read as an option.
        args: [...args, "--", answerPrompt(request)],
        cwd: options.cwd,
        env: childEnv({ credentials: CLAUDE_CREDENTIAL_ENV, scrub: [...CLAUDE_SCRUB_ENV, ...(options.scrub ?? [])] }, options.env),
        signal: request.signal,
        timeoutMs: options.timeoutMs ?? ANSWER_TIMEOUT_MS,
        maxUsd: ANSWER_MAX_USD,
        // Its slot's screen keeps the last run's; an answer has nothing to show there.
        output: () => undefined,
        activity: () => undefined,
        spent: request.spent,
      });
      const text = result.text.trim();
      if (!result.ok) {
        return { ok: false, text: "", why: result.why };
      }
      return text === "" ? { ok: false, text: "", why: "it said nothing" } : { ok: true, text, why: "" };
    },
  };
}

/** The mock's answer: its status, read back, for nothing. */
export function createMockAnswerer(): Answerer {
  return {
    answer(request) {
      const status = request.context.split("\n")[0]?.replace(/^Your update at this standup: /, "") ?? "";
      return Promise.resolve({ ok: true, text: `(Simulated answer.) ${status === "" ? "I'm free between tasks." : status}`, why: "" });
    },
  };
}
