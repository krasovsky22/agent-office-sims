/**
 * The manager planner that asks a language model through the `claude` CLI on
 * the server's host, so it plans on whatever login that CLI has (`/login` with
 * a Claude subscription) and the server needs no `ANTHROPIC_API_KEY`.
 *
 * Everything but the transport is `./modelPlanner.ts`'s: the same system
 * prompt, the same office-as-data user turn, the same output schema, and the
 * same reading of the answer into a plan. One `claude -p` per message from the
 * CEO, answering with `--json-schema` structured output and no tools, sessions,
 * MCP servers, settings or slash commands of the host's, run in the system's
 * temporary directory so no project's `CLAUDE.md` is read either. The user
 * turn goes in on stdin, so the office's state is never on a command line.
 *
 * It runs on the server's host rather than through the runner: the runner may
 * be offline while the CEO is talking, and a server on a platform with no
 * `claude` installed keeps the direct API (`ANTHROPIC_API_KEY`) instead.
 *
 * The advisor's abort kills the process, so a timeout or a withdrawn question
 * never leaves one running.
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { type ManagerPlan, type ManagerPlanner } from "./advisor.js";
import { OUTPUT_SCHEMA, planFrom, systemPrompt, userPrompt } from "./modelPlanner.js";
import { PlannerError } from "./plannerError.js";

/** What one run of the CLI left behind. */
export interface ClaudeRun {
  /** `null` when it was killed. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI with `args` and `input` on stdin; rejects when it cannot start or `signal` aborts. */
export type RunClaude = (args: readonly string[], input: string, signal: AbortSignal) => Promise<ClaudeRun>;

export interface CliPlannerOptions {
  readonly model: string;
  /** Replaces the real CLI, for tests. */
  readonly run?: RunClaude;
}

/** Variables a Claude Code session sets that would make the CLI think it runs inside one, and a key that would bypass the login. */
const SCRUB_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_EXECPATH", "CLAUDE_PID", "CLAUDE_EFFORT", "ANTHROPIC_API_KEY"];

const NOT_SIGNED_IN = /not logged in|run \/login|invalid api key|oauth token/i;

/** How much of a failed run's own words reach the CEO's notice. */
const MAX_DETAIL_CHARS = 200;

export function cliArgs(model: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    // Low, as through the API: an answer is a lookup over a few kilobytes of state.
    "--effort",
    "low",
    "--system-prompt",
    systemPrompt(),
    "--json-schema",
    JSON.stringify(OUTPUT_SCHEMA),
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
}

function runClaude(args: readonly string[], input: string, signal: AbortSignal): Promise<ClaudeRun> {
  const env = { ...process.env };
  for (const name of SCRUB_ENV) {
    delete env[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn("claude", [...args], { cwd: tmpdir(), env, signal, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    // A CLI that exits before reading its input is reported by its exit, not by the broken pipe.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

function detail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}…` : trimmed;
}

function notSignedIn(): PlannerError {
  return new PlannerError("the claude CLI on the server's host is not signed in: run claude and /login there", { retryable: false });
}

function tokensOf(usage: unknown): number {
  const counts = (usage ?? {}) as Record<string, unknown>;
  return ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((sum, key) => {
    const count = counts[key];
    return sum + (typeof count === "number" ? count : 0);
  }, 0);
}

/** Turns one run of the CLI into a plan, or says why it is not one. */
export function readRun(run: ClaudeRun): ManagerPlan {
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    const said = `${run.stderr}\n${run.stdout}`;
    if (NOT_SIGNED_IN.test(said)) {
      throw notSignedIn();
    }
    throw new PlannerError(`the claude CLI failed (exit ${run.code ?? "killed"})${said.trim() === "" ? "" : `: ${detail(said)}`}`, { retryable: false });
  }
  if (typeof result !== "object" || result === null) {
    throw new PlannerError("the claude CLI's output was not the expected JSON", { retryable: false });
  }
  const tokensUsed = tokensOf(result["usage"]);
  const text = typeof result["result"] === "string" ? result["result"] : "";
  if (result["is_error"] === true) {
    if (NOT_SIGNED_IN.test(text)) {
      throw notSignedIn();
    }
    const status = typeof result["api_error_status"] === "number" ? result["api_error_status"] : undefined;
    // As through the API: a rate limit, an overload or an outage may clear on a retry.
    const retryable = status === 429 || (status !== undefined && status >= 500);
    throw new PlannerError(`the claude CLI reported an error${status === undefined ? "" : ` (${status})`}${text === "" ? "" : `: ${detail(text)}`}`, {
      retryable,
      tokensUsed,
    });
  }
  if (result["structured_output"] === undefined) {
    throw new PlannerError("the model's reply was not the expected JSON", { retryable: false, tokensUsed });
  }
  return planFrom(result["structured_output"], tokensUsed);
}

export function createCliPlanner(options: CliPlannerOptions): ManagerPlanner {
  const run = options.run ?? runClaude;
  return async (request, signal) => {
    let outcome: ClaudeRun;
    try {
      outcome = await run(cliArgs(options.model), userPrompt(request), signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PlannerError("the claude CLI is not installed on the server's host", { retryable: false });
      }
      throw error;
    }
    return readRun(outcome);
  };
}
