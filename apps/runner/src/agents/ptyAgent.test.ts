/**
 * The terminal agent end to end, with a fake Claude: a shell script in a real
 * PTY that fires the hooks from the settings file it is given, as Claude
 * Code does, prints what Claude prints, and exits.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claudeAdapter } from "./claude.js";
import { HookServer } from "./hookServer.js";
import { type AgentGithubEnv, createPtyAgent, findOnPath } from "./ptyAgent.js";
import type { Agent, AgentReporter, AgentRun, AgentTask } from "./types.js";

let root: string;
let hooks: HookServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pty-agent-"));
  hooks = await HookServer.start();
});

afterAll(async () => {
  await hooks.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * A fake `claude`: reads `--settings` and the prompt after `--` as Claude
 * does, writes the prompt to its working directory, then runs `body`, where
 * `hook <Event> <json>` fires a hook the way Claude would.
 */
function fakeClaude(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(
    path,
    `#!/bin/sh
settings=""
while [ $# -gt 0 ]; do
  case "$1" in
    --settings) settings="$2"; shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
printf '%s' "$1" > prompt.txt
hook() {
  command=$(node -e 'const s = require(process.argv[1]); process.stdout.write(s.hooks[process.argv[2]][0].hooks[0].command)' "$settings" "$1")
  printf '%s' "$2" | sh -c "$command"
}
${body}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function agentFor(
  command: string,
  extra: { bootHintMs?: number; stopGraceMs?: number; github?: AgentGithubEnv; repo?: string } = {},
): Agent {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const { repo, ...options } = extra;
  return createPtyAgent({ adapter: claudeAdapter(repo === undefined ? {} : { repo }), dataDir, hooks, command, ...options });
}

let tasks = 0;

function task(): AgentTask {
  tasks += 1;
  const workdir = join(root, `work-${tasks}`);
  mkdirSync(workdir);
  return { issueNumber: 39, title: "Fix the lift", url: "https://github.com/o/r/issues/39", note: "", requestedBy: "Dana", workdir };
}

/** A reporter that records what it is told, keeps what it prints apart, and resolves `waitFor` once a line matching it arrives. */
function recorder(): AgentReporter & { readonly seen: string[]; readonly printed: () => string; waitFor(pattern: RegExp): Promise<void> } {
  const seen: string[] = [];
  let printed = "";
  const waiting: { pattern: RegExp; resolve: () => void }[] = [];
  const record = (line: string): void => {
    seen.push(line);
    for (const wait of waiting.filter((candidate) => candidate.pattern.test(line))) {
      waiting.splice(waiting.indexOf(wait), 1);
      wait.resolve();
    }
  };
  return {
    seen,
    printed: () => printed,
    waitFor: (pattern) =>
      seen.some((line) => pattern.test(line))
        ? Promise.resolve()
        : new Promise((resolve) => {
            waiting.push({ pattern, resolve });
          }),
    started: () => record("started"),
    progress: (activity) => record(`working: ${activity}`),
    needsInput: (reason) => record(`needs-input: ${reason}`),
    turnDone: () => record("turn done"),
    output: (data) => {
      printed += data;
    },
    prOpened: (pr) => record(`pr-opened: ${pr.url}`),
    failed: (message) => record(`failed: ${message}`),
    exited: (message, clean) => record(`exited${clean ? "" : " (error)"}: ${message}`),
    spent: (totalUsd) => record(`spent: $${totalUsd.toFixed(2)}`),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("createPtyAgent", () => {
  it("goes from start to working to turn done to exited, through the CLI's own hooks", async () => {
    const command = fakeClaude(
      "turn.sh",
      `hook SessionStart '{"hook_event_name":"SessionStart","source":"startup"}'
hook UserPromptSubmit '{"hook_event_name":"UserPromptSubmit","prompt":"Work on GitHub issue #39"}'
hook PreToolUse '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"pnpm test"}}'
hook Stop '{"hook_event_name":"Stop","stop_hook_active":false}'
echo "all done"
exit 0`,
    );
    const work = task();
    const reporter = recorder();
    agentFor(command).start(work, reporter);
    await reporter.waitFor(/^exited/);
    expect(reporter.seen).toEqual([
      "started",
      "working: Work on GitHub issue #39",
      "working: Bash: pnpm test",
      "turn done",
      "exited: Claude exited with code 0",
    ]);
    // What it printed reached the slot's screen.
    expect(reporter.printed()).toContain("all done");
    // It ran in the task's worktree, its prompt after `--`.
    expect(readFileSync(join(work.workdir, "prompt.txt"), "utf8")).toMatch(/^Work on GitHub issue #39: "Fix the lift"\./);
  });

  it("reports an exit with an error, and the last thing it printed", async () => {
    const command = fakeClaude("crash.sh", `echo "error: unknown option '--settings'"\nexit 2`);
    const reporter = recorder();
    agentFor(command).start(task(), reporter);
    await reporter.waitFor(/^exited/);
    expect(reporter.seen).toEqual(["exited (error): Claude exited with code 2: error: unknown option '--settings'"]);
  });

  it("gives it only the allowlisted environment, and its own hook route", async () => {
    const command = fakeClaude("env.sh", "env > env.txt\nexit 0");
    const work = task();
    const reporter = recorder();
    process.env["RUNNER_SECRET_FOR_TEST"] = "never-passed";
    try {
      agentFor(command).start(work, reporter);
      await reporter.waitFor(/^exited/);
    } finally {
      delete process.env["RUNNER_SECRET_FOR_TEST"];
    }
    const names = readFileSync(join(work.workdir, "env.txt"), "utf8")
      .split("\n")
      .map((line) => line.split("=")[0]);
    expect(names).not.toContain("RUNNER_SECRET_FOR_TEST");
    expect(names).toEqual(expect.arrayContaining(["PATH", "HOME", "TERM", "SIMS_HOOK_URL", "SIMS_HOOK_RUN", "SIMS_HOOK_TOKEN"]));
  });

  it("acts as the runner's GitHub App when given one: its environment set, any other token never passed", async () => {
    const command = fakeClaude("app-env.sh", "env > env.txt\nexit 0");
    const work = task();
    const reporter = recorder();
    process.env["GH_TOKEN"] = "ghp_the_operators_own_token";
    try {
      agentFor(command, { github: { env: { GH_CONFIG_DIR: "/runner/gh" }, scrub: ["GH_TOKEN"] } }).start(work, reporter);
      await reporter.waitFor(/^exited/);
    } finally {
      delete process.env["GH_TOKEN"];
    }
    const lines = readFileSync(join(work.workdir, "env.txt"), "utf8").split("\n");
    expect(lines).toContain("GH_CONFIG_DIR=/runner/gh");
    expect(lines.some((line) => line.startsWith("GH_TOKEN="))).toBe(false);
  });

  it("reports the pull request its `gh pr create` printed, and keeps going", async () => {
    const command = fakeClaude(
      "pr.sh",
      `hook SessionStart '{"source":"startup"}'
hook PostToolUse '{"tool_name":"Bash","tool_input":{"command":"gh pr create --fill"},"tool_response":{"stdout":"https://github.com/o/r/pull/7","stderr":""}}'
hook Stop '{}'
exit 0`,
    );
    const reporter = recorder();
    agentFor(command, { repo: "o/r" }).start(task(), reporter);
    await reporter.waitFor(/^exited/);
    expect(reporter.seen).toEqual(["started", "pr-opened: https://github.com/o/r/pull/7", "turn done", "exited: Claude exited with code 0"]);
  });

  it("meters what its session spent off the transcript its hooks name, before saying it exited", async () => {
    const command = fakeClaude(
      "spend.sh",
      `t="$PWD/session.jsonl"
printf '%s\\n' '{"type":"assistant","timestamp":"2026-10-16T10:00:00Z","message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":1000000,"output_tokens":0}}}' > "$t"
hook SessionStart '{"source":"startup"}'
hook Stop "{\\"transcript_path\\":\\"$t\\"}"
exit 0`,
    );
    const reporter = recorder();
    agentFor(command).start(task(), reporter);
    await reporter.waitFor(/^exited/);
    expect(reporter.seen).toEqual(["started", "turn done", "spent: $3.00", "exited: Claude exited with code 0"]);
  });

  it("types a prompt into its terminal as one paste, and submits it", async () => {
    const command = fakeClaude(
      "prompt.sh",
      `stty -echo
hook SessionStart '{"source":"startup"}'
IFS= read -r line
printf '%s' "$line" > typed.txt
exit 0`,
    );
    const work = task();
    const reporter = recorder();
    const run = agentFor(command).start(work, reporter);
    await reporter.waitFor(/^started/);
    run.prompt?.("  Rework it.  ");
    await reporter.waitFor(/^exited/);
    // Pasted whole, then Enter, which is what ends the line it read.
    expect(readFileSync(join(work.workdir, "typed.txt"), "utf8")).toBe("\u001b[200~Rework it.\u001b[201~");
  });

  it("follows OSC 9;4 progress: busy is working, idle again is turn done", async () => {
    const command = fakeClaude(
      "progress.sh",
      `hook SessionStart '{"source":"startup"}'
printf '\\033]9;4;3;\\007'
sleep 0.3
printf '\\033]9;4;0;\\007'
sleep 30`,
    );
    const reporter = recorder();
    const run = agentFor(command).start(task(), reporter);
    await reporter.waitFor(/^turn done/);
    run.stop();
    expect(reporter.seen).toEqual(["started", "working: ", "turn done"]);
  });

  it("reports the sign-in screen as needing a person, with the reason", async () => {
    const command = fakeClaude("signin.sh", `printf '\\033[2GNot\\033[6Glogged\\033[13Gin · Run /login\\r\\n'\nsleep 30`);
    const reporter = recorder();
    const run = agentFor(command).start(task(), reporter);
    await reporter.waitFor(/^needs-input/);
    run.stop();
    expect(reporter.seen).toEqual(["needs-input: Claude isn't signed in on the runner's machine: run claude there and /login"]);
  });

  it("reports the trust screen as needing a person", async () => {
    const command = fakeClaude("trust.sh", `printf ' Quick safety check\\r\\n ❯ No, exit\\r\\n   Yes, I trust this folder\\r\\n'\nsleep 30`);
    const reporter = recorder();
    const run = agentFor(command).start(task(), reporter);
    await reporter.waitFor(/^needs-input/);
    run.stop();
    expect(reporter.seen).toEqual(["needs-input: Waiting on a setup screen (trust / login) on the runner's machine"]);
  });

  it("takes a CLI silent past its boot hint to be waiting on a person", async () => {
    const command = fakeClaude("silent.sh", "sleep 30");
    const reporter = recorder();
    const run = agentFor(command, { bootHintMs: 200 }).start(task(), reporter);
    await reporter.waitFor(/^needs-input/);
    run.stop();
    expect(reporter.seen).toEqual(["needs-input: Waiting on a setup screen (trust / login) on the runner's machine"]);
  });

  it("stops its whole process group, and reports nothing after", async () => {
    const command = fakeClaude(
      "group.sh",
      `sleep 300 &
echo $! > child.pid
echo $$ > leader.pid
trap '' TERM
hook SessionStart '{"source":"startup"}'
while true; do sleep 1; done`,
    );
    const work = task();
    const reporter = recorder();
    const run: AgentRun = agentFor(command, { stopGraceMs: 300 }).start(work, reporter);
    await reporter.waitFor(/^started/);
    await until(() => existsSync(join(work.workdir, "child.pid")));
    const leader = Number(readFileSync(join(work.workdir, "leader.pid"), "utf8"));
    const child = Number(readFileSync(join(work.workdir, "child.pid"), "utf8"));
    expect(alive(leader) && alive(child)).toBe(true);
    run.stop();
    // The leader ignores SIGTERM, so it takes the SIGKILL after the grace.
    await until(() => !alive(leader) && !alive(child));
    expect(reporter.seen).toEqual(["started"]);
  });

  it("refuses a hook that carries another run's token", async () => {
    const command = fakeClaude(
      "spoof.sh",
      `hook SessionStart '{"source":"startup"}'
SIMS_HOOK_TOKEN=not-mine hook Stop '{}'
sleep 30`,
    );
    const reporter = recorder();
    const run = agentFor(command).start(task(), reporter);
    await reporter.waitFor(/^started/);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    run.stop();
    expect(reporter.seen).toEqual(["started"]);
  });

  it("will not be made when its CLI is not on PATH", () => {
    expect(() => createPtyAgent({ adapter: claudeAdapter(), dataDir: root, hooks, command: "no-such-cli-anywhere" })).toThrow(
      /no-such-cli-anywhere is not on PATH/,
    );
    expect(findOnPath("sh")).toMatch(/\/sh$/);
  });
});
