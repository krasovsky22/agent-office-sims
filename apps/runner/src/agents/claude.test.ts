/**
 * Claude Code's command line and settings, and what its hooks mean for its
 * slot, read from hook payloads recorded off Claude Code 2.1 (session ids and
 * paths replaced).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLAUDE_ALLOWED_COMMANDS, claudeAdapter, claudeBlocked, claudeHook } from "./claude.js";
import type { RunHandle, RunStatus } from "./provider.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-adapter-"));
  dirs.push(dir);
  return dir;
}

const SESSION = {
  session_id: "00000000-0000-4000-8000-000000000001",
  transcript_path: "/home/runner/.claude/projects/issue-39/00000000-0000-4000-8000-000000000001.jsonl",
  cwd: "/home/runner/.sim-runner/worktrees/issue-39-slot-1",
};

/** A turn that runs a command, asks a question, and ends, as Claude Code 2.1 reported it. */
const RECORDED_TURN: readonly [string, unknown][] = [
  ["SessionStart", { ...SESSION, hook_event_name: "SessionStart", source: "startup", model: "claude-haiku-4-5-20251001" }],
  [
    "UserPromptSubmit",
    {
      ...SESSION,
      permission_mode: "acceptEdits",
      hook_event_name: "UserPromptSubmit",
      prompt: 'Work on GitHub issue #39: "Fix the lift".\n\nRead it first with `gh issue view 39 --comments`.',
    },
  ],
  [
    "PreToolUse",
    {
      ...SESSION,
      permission_mode: "acceptEdits",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls", description: "List files in current directory" },
    },
  ],
  [
    "PostToolUse",
    {
      ...SESSION,
      permission_mode: "acceptEdits",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls", description: "List files in current directory" },
      tool_response: { stdout: "a.txt", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
      duration_ms: 1478,
    },
  ],
  [
    "PreToolUse",
    {
      ...SESSION,
      permission_mode: "acceptEdits",
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which colour do you prefer?",
            header: "Color",
            options: [
              { label: "Red", description: "The colour red" },
              { label: "Blue", description: "The colour blue" },
            ],
            multiSelect: false,
          },
        ],
      },
    },
  ],
  [
    "PermissionRequest",
    {
      ...SESSION,
      permission_mode: "acceptEdits",
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which colour do you prefer?", header: "Color", options: [], multiSelect: false }] },
    },
  ],
  [
    "PostToolUse",
    {
      ...SESSION,
      permission_mode: "acceptEdits",
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [], answers: { "Which colour do you prefer?": "Red" }, annotations: {} },
      tool_response: { answers: { "Which colour do you prefer?": "Red" } },
      duration_ms: 0,
    },
  ],
  [
    "PreToolUse",
    {
      ...SESSION,
      permission_mode: "acceptEdits",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "touch made-by-bash.txt", description: "Create a new empty file" },
    },
  ],
  [
    "Stop",
    {
      ...SESSION,
      permission_mode: "acceptEdits",
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Done!",
      background_tasks: [],
      session_crons: [],
    },
  ],
  ["Notification", { ...SESSION, hook_event_name: "Notification", message: "Claude is waiting for your input", notification_type: "idle_prompt" }],
];

/** A command off the allowlist, as Claude Code 2.1 reported it. */
const RECORDED_PERMISSION: readonly [string, unknown][] = [
  [
    "PreToolUse",
    {
      ...SESSION,
      permission_mode: "acceptEdits",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "curl -sI https://example.com", description: "Fetch HTTP headers from example.com" },
    },
  ],
  [
    "PermissionRequest",
    {
      ...SESSION,
      permission_mode: "acceptEdits",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "curl -sI https://example.com", description: "Fetch HTTP headers from example.com" },
      permission_suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "curl -sI https://example.com" }], behavior: "allow", destination: "localSettings" },
      ],
    },
  ],
  ["Notification", { ...SESSION, hook_event_name: "Notification", message: "Claude needs your permission", notification_type: "permission_prompt" }],
];

/** A run that records each status it is moved to, with its activity, each pull request it reports, and each transcript named. */
function recordingRun(status: RunStatus = "starting"): RunHandle & { readonly seen: string[]; readonly transcripts: string[] } {
  const seen: string[] = [];
  const transcripts: string[] = [];
  return {
    status,
    bootBlocked: false,
    seen,
    transcripts,
    transcript(path) {
      transcripts.push(path);
    },
    setStatus(next, activity = "") {
      this.status = next;
      seen.push(activity === "" ? next : `${next}: ${activity}`);
    },
    pullRequest(pr) {
      seen.push(`pull request #${pr.number}: ${pr.url}`);
    },
  } as RunHandle & { status: RunStatus; readonly seen: string[]; readonly transcripts: string[] };
}

function play(run: RunHandle, events: readonly [string, unknown][]): void {
  for (const [event, payload] of events) {
    claudeHook(run, event, payload);
  }
}

describe("claudeAdapter", () => {
  it("launches with its settings, acceptEdits, and the prompt after --", () => {
    const adapter = claudeAdapter();
    const setup = adapter.prepare(dataDir());
    const plan = adapter.launch({ prompt: "- fix the lift", cwd: "/work", setup });
    expect(plan.args).toEqual(["--settings", setup.settings, "--permission-mode", "acceptEdits", "--", "- fix the lift"]);
  });

  it("launches a desk session at its prompt, with no prompt and no --", () => {
    const adapter = claudeAdapter();
    const setup = adapter.prepare(dataDir());
    expect(adapter.launch({ prompt: "", cwd: "/work", setup }).args).toEqual(["--settings", setup.settings, "--permission-mode", "acceptEdits"]);
  });

  it("passes RUNNER_MODEL as --model, ahead of the prompt", () => {
    const adapter = claudeAdapter({ model: "sonnet" });
    const setup = adapter.prepare(dataDir());
    const { args } = adapter.launch({ prompt: "go", cwd: "/work", setup });
    expect(args.slice(-4)).toEqual(["--model", "sonnet", "--", "go"]);
  });

  it("writes settings that post every hook through its helper, with the allowlist", () => {
    const dir = dataDir();
    const { settings } = claudeAdapter().prepare(dir);
    const written = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
      permissions: { allow: string[] };
    };
    expect(Object.keys(written.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionRequest",
      "Notification",
      "Stop",
    ]);
    const command = written.hooks["Stop"]?.[0]?.hooks[0]?.command ?? "";
    expect(command).toContain(join(dir, "claude", "hook.cjs"));
    expect(command).toContain(" Stop ");
    expect(written.permissions.allow).toEqual([...CLAUDE_ALLOWED_COMMANDS]);
    // It pushes its branch and opens its pull request; merging is a person's.
    expect(written.permissions.allow).toEqual(expect.arrayContaining(["Bash(git push:*)", "Bash(gh pr create:*)"]));
    expect(written.permissions.allow.some((rule) => /merge/.test(rule))).toBe(false);
    expect(written).not.toHaveProperty("skipDangerousModePermissionPrompt");
  });

  it("with every permission, launches in bypassPermissions past its one-time warning, its hooks kept", () => {
    const adapter = claudeAdapter({ permissions: "all" });
    const setup = adapter.prepare(dataDir());
    const plan = adapter.launch({ prompt: "go", cwd: "/work", setup });
    expect(plan.args).toEqual(["--settings", setup.settings, "--permission-mode", "bypassPermissions", "--", "go"]);
    const written = JSON.parse(readFileSync(setup.settings, "utf8")) as {
      hooks: Record<string, unknown>;
      skipDangerousModePermissionPrompt?: boolean;
    };
    expect(written.skipDangerousModePermissionPrompt).toBe(true);
    expect(Object.keys(written.hooks)).toEqual(expect.arrayContaining(["PreToolUse", "PostToolUse", "Notification", "Stop"]));
  });

  it("keeps acceptEdits and the allowlist when asked for the allowlist", () => {
    const adapter = claudeAdapter({ permissions: "allowlist" });
    const setup = adapter.prepare(dataDir());
    expect(adapter.launch({ prompt: "go", cwd: "/work", setup }).args).toContain("acceptEdits");
  });
});

describe("claudeHook", () => {
  it("maps a recorded turn: idle, working with what it does, needs-input on a question, turn done", () => {
    const run = recordingRun();
    play(run, RECORDED_TURN);
    expect(run.seen).toEqual([
      "idle",
      'working: Work on GitHub issue #39: "Fix the lift".',
      "working: Bash: ls",
      "needs-input: Asks: Which colour do you prefer?",
      "needs-input: Asks: Which colour do you prefer?",
      "working: AskUserQuestion",
      "working: Bash: touch made-by-bash.txt",
      "turn-done",
    ]);
  });

  it("maps a recorded command off the allowlist to needs-input, saying what it wants", () => {
    const run = recordingRun("working");
    play(run, RECORDED_PERMISSION);
    expect(run.seen).toEqual(["working: Bash: curl -sI https://example.com", "needs-input: Wants permission: Bash: curl -sI https://example.com"]);
  });

  it("takes any other notification as waiting on a person", () => {
    const run = recordingRun("working");
    claudeHook(run, "Notification", { notification_type: "elicitation_dialog", message: "The server wants an answer" });
    expect(run.seen).toEqual(["needs-input: The server wants an answer"]);
  });

  it("leaves a session started again mid-work alone, as a compacted conversation is", () => {
    const run = recordingRun("working");
    claudeHook(run, "SessionStart", { source: "compact" });
    expect(run.seen).toEqual([]);
  });

  it("counts a malformed payload as the event", () => {
    const run = recordingRun("working");
    claudeHook(run, "PreToolUse", "not an object");
    claudeHook(run, "Stop", null);
    expect(run.seen).toEqual(["working: tool", "turn-done"]);
  });

  it("reports the pull request a `gh pr create` printed, on its repository only", () => {
    const repo = "krasovsky22/agent-office-sims";
    const ran = (command: string, stdout: string) => ({
      ...SESSION,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command, description: "Open a pull request" },
      tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
    });
    const run = recordingRun("working");
    claudeHook(run, "PostToolUse", ran("gh pr create --title Lift --body 'Closes #39'", `https://github.com/${repo}/pull/95\n`), repo);
    claudeHook(run, "PostToolUse", ran("gh pr create --fill", "https://github.com/someone/else/pull/3"), repo);
    claudeHook(run, "PostToolUse", ran("cat notes.md", `https://github.com/${repo}/pull/96`), repo);
    claudeHook(run, "PostToolUse", ran("gh pr create --fill", `https://github.com/${repo}/pull/97`));
    expect(run.seen).toEqual([`pull request #95: https://github.com/${repo}/pull/95`]);
  });

  it("follows the transcript any hook names, which its spend is read off", () => {
    const run = recordingRun("working");
    claudeHook(run, "PreToolUse", { transcript_path: "/home/me/.claude/projects/w/s.jsonl", tool_name: "Bash", tool_input: { command: "ls" } });
    claudeHook(run, "Stop", { transcript_path: 7 });
    expect(run.transcripts).toEqual(["/home/me/.claude/projects/w/s.jsonl"]);
  });

  it("keeps an activity to one line, whole, for the slot to mask and cut", () => {
    const run = recordingRun("working");
    const long = "x".repeat(200);
    claudeHook(run, "PreToolUse", { tool_name: "Bash", tool_input: { command: `echo one\necho ${long}` } });
    expect(run.seen).toEqual([`working: Bash: echo one echo ${long}`]);
  });
});

describe("claudeBlocked", () => {
  it("spots the sign-in screen at any time", () => {
    expect(claudeBlocked("⎿  Not logged in · Please run /login", false)).toMatch(/signed in/);
  });

  it("once a turn has ended, takes a sign-in error only from the end of its output", () => {
    const turn = `cat claude.ts\nNot logged in · Please run /login\n${"Here is what the file holds. ".repeat(60)}\n> `;
    expect(claudeBlocked(turn, false)).toBeUndefined();
    expect(claudeBlocked(`${turn}\n⎿  API Error: 401 · Please run /login\n> `, false)).toMatch(/signed in/);
  });

  it("takes a reply that names an API key error for no sign-in screen", () => {
    expect(claudeBlocked("⏺ I added handling for the 'Invalid API key' response.\n> ", false)).toBeUndefined();
    expect(claudeBlocked("⎿  API Error: 401 Invalid API key · Please run /login\n> ", false)).toMatch(/signed in/);
  });

  it("spots the trust screen only before it has started", () => {
    const screen = "Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n Yes, I trust this folder";
    expect(claudeBlocked(screen, true)).toMatch(/setup screen/);
    expect(claudeBlocked(screen, false)).toBeUndefined();
  });

  it("spots the custom API key screen before it has started", () => {
    const screen =
      "Detected a custom API key in your environment\nDo you want to use this API key?\n❯ 1. Yes\n  2. No (recommended)\nEnter to confirm · Esc to cancel";
    expect(claudeBlocked(screen, true)).toMatch(/setup screen/);
  });

  it("finds nothing on a screen that is working", () => {
    expect(claudeBlocked("✻ Brewing… (esc to interrupt)", true)).toBeUndefined();
  });
});
