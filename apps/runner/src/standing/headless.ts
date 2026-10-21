/**
 * One headless agent run for a standing task: `claude -p` with its output as
 * a stream of JSON events, read for what it does, what it spends and what it
 * finally says.
 *
 * Headless rather than in a terminal of its own, as issue work is, because
 * nobody answers a standing run: in `dontAsk` a tool it may not use is
 * refused rather than asked about, so it can never sit waiting on a person.
 * What it does still shows on its slot's screen, one line a step, as the
 * mock's script does, and what it spends is booked as it goes.
 *
 * It runs as the leader of its own process group, and is stopped, group and
 * all, when its minutes are up, when its estimated spend passes its cap by a
 * margin (Claude Code's own `--max-budget-usd` should have stopped it first),
 * or when its run is stopped: the slot taken back, the task removed, the
 * runner shutting down.
 */

import { type ChildProcess, spawn } from "node:child_process";

import { trackGroup } from "../agents/processGroups.js";
import { usageOfMessage } from "../agents/usage.js";

/** How long a stopped run has to exit before its process group is killed outright. */
const STOP_GRACE_MS = 5000;

/** Past its cap by this much, on the runner's own estimate, a run is stopped whatever Claude Code thinks. */
const SPEND_MARGIN = 1.25;

/** A stream line longer than this (a tool result holding a large file, say) is skipped rather than kept. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** Most of a step's line written to the screen. */
const MAX_STEP_CHARS = 160;

const DIM = "\u001b[2m";
const RED = "\u001b[31m";
const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

export interface HeadlessOptions {
  /** The CLI's absolute path. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Its whole environment: nothing of the runner's own passes unless it is here. */
  readonly env: Record<string, string>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Its cap, in US dollars; left out, it is stopped by its minutes alone. */
  readonly maxUsd?: number;
  /** Written to its slot's screen. */
  readonly output: (data: string) => void;
  readonly activity: (text: string) => void;
  /** All it has cost so far. */
  readonly spent: (totalUsd: number) => void;
  /** Injected so a test can stand in for the CLI. */
  readonly spawnProcess?: (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }) => ChildProcess;
  readonly stopGraceMs?: number;
}

export interface HeadlessResult {
  /** It finished on its own and said it succeeded. */
  readonly ok: boolean;
  /** Its final message. */
  readonly text: string;
  readonly costUsd: number;
  /** Why it did not succeed; `""` when it did. */
  readonly why: string;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One line for the screen: no control character an agent's words could carry, and not too long. */
export function screenLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_STEP_CHARS ? `${flat.slice(0, MAX_STEP_CHARS - 1)}…` : flat;
}

/** `Read: src/index.ts`, `Grep: TODO`, `Bash: gh pr list`. */
export function describeToolUse(block: Json): string {
  const name = str(block["name"]) || "tool";
  const input = record(block["input"]) ?? {};
  const detail = ["file_path", "pattern", "path", "command", "description", "url"].map((key) => str(input[key])).find(Boolean) ?? "";
  return screenLine(detail === "" ? name : `${name}: ${detail}`);
}

const FAILURES: Readonly<Record<string, string>> = {
  error_max_budget_usd: "it reached its spending cap",
  error_max_turns: "it ran out of turns",
  error_during_execution: "it broke while it worked",
};

function defaultSpawn(command: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }): ChildProcess {
  // Its own process group, so stopping it stops whatever it started.
  return spawn(command, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

export function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  return new Promise((resolve) => {
    const costs = new Map<string, number>();
    let total = 0;
    let finalText = "";
    let succeeded: boolean | undefined;
    let failure = "";
    let stopped = "";
    let buffer = "";
    let skipping = false;
    let stderrTail = "";
    let settled = false;

    const spend = (value: number): void => {
      if (Number.isFinite(value) && value > total) {
        total = value;
        options.spent(total);
      }
    };

    let child: ChildProcess;
    try {
      child = (options.spawnProcess ?? defaultSpawn)(options.command, options.args, { cwd: options.cwd, env: options.env });
    } catch (error) {
      resolve({ ok: false, text: "", costUsd: 0, why: `the agent did not start: ${(error as Error).message}` });
      return;
    }
    const untrack = child.pid === undefined ? () => false : trackGroup(child.pid);

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (name: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) {
        return;
      }
      try {
        process.kill(-pid, name);
      } catch {
        try {
          child.kill(name);
        } catch {
          // Already gone.
        }
      }
    };
    const stop = (why: string): void => {
      if (stopped !== "" || settled) {
        return;
      }
      stopped = why;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), options.stopGraceMs ?? STOP_GRACE_MS);
    };

    const minutes = Math.round(options.timeoutMs / 60_000);
    const deadline = setTimeout(() => stop(`it ran past its ${minutes} ${minutes === 1 ? "minute" : "minutes"}`), options.timeoutMs);
    deadline.unref();
    const onAbort = (): void => stop("it was stopped");
    if (options.signal.aborted) {
      onAbort();
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const handle = (line: string): void => {
      let event: Json | undefined;
      try {
        event = record(JSON.parse(line));
      } catch {
        return;
      }
      if (event === undefined) {
        return;
      }
      switch (event["type"]) {
        case "system":
          if (event["subtype"] === "init") {
            options.output(`${DIM}session started${str(event["model"]) === "" ? "" : ` on ${screenLine(str(event["model"]))}`}${RESET}\r\n`);
          }
          return;
        case "assistant": {
          const message = record(event["message"]);
          if (message === undefined) {
            return;
          }
          const id = str(message["id"]);
          if (id !== "" && message["usage"] !== undefined) {
            costs.set(id, usageOfMessage(str(message["model"]), message["usage"]).costUsd);
            spend([...costs.values()].reduce((sum, cost) => sum + cost, 0));
            if (options.maxUsd !== undefined && total > options.maxUsd * SPEND_MARGIN) {
              stop(`it passed its spending cap of $${options.maxUsd.toFixed(2)}`);
            }
          }
          const content = Array.isArray(message["content"]) ? (message["content"] as unknown[]) : [];
          for (const raw of content) {
            const block = record(raw);
            if (block?.["type"] === "tool_use") {
              const step = describeToolUse(block);
              options.activity(step);
              options.output(`${CYAN}●${RESET} ${step}\r\n`);
            } else if (block?.["type"] === "text") {
              const said = screenLine(str(block["text"]).split("\n").find((part) => part.trim() !== "") ?? "");
              if (said !== "") {
                options.output(`${DIM}${said}${RESET}\r\n`);
              }
            }
          }
          return;
        }
        case "result": {
          const cost = event["total_cost_usd"];
          // Its own tally; where the runner's estimate ran higher, the higher stands, as a budget should.
          if (typeof cost === "number") {
            spend(cost);
          }
          finalText = str(event["result"]);
          const subtype = str(event["subtype"]);
          succeeded = subtype === "success" && event["is_error"] !== true;
          if (!succeeded) {
            failure = FAILURES[subtype] ?? (finalText.trim() === "" ? `it ended with ${subtype || "an error"}` : screenLine(finalText));
          }
          return;
        }
        default:
          return;
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!skipping && line.trim() !== "") {
          handle(line);
        }
        skipping = false;
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_CHARS) {
        // Too long to keep: drop it, and the rest of it as it arrives.
        buffer = "";
        skipping = true;
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });

    const settle = (code: number | null, killedBy: NodeJS.Signals | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      options.signal.removeEventListener("abort", onAbort);
      // Its work is over: anything it left running in its group goes too.
      signalGroup("SIGKILL");
      untrack();
      if (buffer.trim() !== "" && !skipping) {
        handle(buffer);
      }
      if (stopped !== "") {
        options.output(`${RED}✗ Stopped: ${stopped}${RESET}\r\n`);
        resolve({ ok: false, text: finalText, costUsd: total, why: stopped });
        return;
      }
      if (succeeded === undefined) {
        const last = stderrTail.split("\n").map((part) => part.trim()).filter(Boolean).pop();
        const how = killedBy !== null ? `was killed by signal ${killedBy}` : `exited with code ${code ?? "unknown"}`;
        const why = `the agent ${how} without finishing${last === undefined ? "" : `: ${screenLine(last)}`}`;
        options.output(`${RED}✗ ${why}${RESET}\r\n`);
        resolve({ ok: false, text: "", costUsd: total, why });
        return;
      }
      if (!succeeded) {
        options.output(`${RED}✗ ${failure}${RESET}\r\n`);
      }
      resolve({ ok: succeeded, text: finalText, costUsd: total, why: succeeded ? "" : failure });
    };
    child.on("error", (error) => {
      stderrTail = `${stderrTail}\n${error.message}`;
      settle(null, null);
    });
    child.on("close", (code, killedBy) => settle(code, killedBy));
  });
}
