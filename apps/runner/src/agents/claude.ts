// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/providers/claude.ts. See THIRD_PARTY_NOTICES.md.
/**
 * Claude Code as a runner agent: its command line, the settings file that
 * points its hooks at the runner, what each hook means for its slot, and the
 * screens it can sit on before it is usable.
 *
 * Nobody watches it at a terminal, so it runs with `acceptEdits` and a short
 * allowlist of commands: editing files in its worktree, reading the issue,
 * committing, the project's checks, pushing its branch and opening its pull
 * request. Anything else stops at a permission prompt, which its slot reports
 * as needing a person. With `RUNNER_AGENT_PERMISSIONS=all` it runs in
 * `bypassPermissions` instead, every command unprompted, and its settings
 * accept that mode's one-time warning so it never stops on it. The pull
 * request it opens is read off its `PostToolUse` hook, by the `gh pr create`
 * it ran, and what it spends off the transcript every hook names
 * (`./usage.ts`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunnerAgentPermissions } from "../config.js";
import { ownPr } from "../github.js";
import { HOOK_ENV, HOOK_PATH } from "./hookServer.js";
import type { ProviderAdapter, RunHandle } from "./provider.js";

/** The hook events the runner listens to. */
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
] as const;

/** Seconds Claude gives a hook before going on without it. */
const HOOK_TIMEOUT_SECONDS = 10;

/**
 * Commands it may run without asking, on top of `acceptEdits`. Reading the
 * issue, looking at and committing its own work, the checks this repository
 * runs, pushing and opening its pull request. Merging is not on it, and the
 * default branch's protection refuses a push there whatever it runs.
 */
export const CLAUDE_ALLOWED_COMMANDS: readonly string[] = [
  "Bash(gh issue view:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git add:*)",
  "Bash(git rm:*)",
  "Bash(git mv:*)",
  "Bash(git restore:*)",
  "Bash(git commit:*)",
  "Bash(pnpm install:*)",
  "Bash(pnpm typecheck:*)",
  "Bash(pnpm lint:*)",
  "Bash(pnpm test:*)",
  "Bash(pnpm build:*)",
  "Bash(ls:*)",
  "Bash(git push:*)",
  "Bash(gh pr create:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr list:*)",
];

/** First-run screens Claude shows before it can take a prompt. */
const SETUP_PROMPT =
  /trust this folder|Do you trust the files|Detected a custom API key|Allow external CLAUDE\.md|Select login method|Choose the text style|Press Enter to continue|Bypass Permissions mode/i;
const NOT_LOGGED_IN = /Not logged in\s*·\s*Run \/login|Please run \/login/i;

/**
 * The end of the output read for a turn refused for want of a sign-in: the
 * refusal and the prompt drawn under it, not a turn's tool output that names
 * an API key.
 */
const TURN_END_TAIL = 1024;

/**
 * Its sign-in: a key or token, or the one `claude /login` saved, which is found
 * through its config dir and, in the macOS keychain, under the user's name.
 */
export const CLAUDE_CREDENTIAL_ENV: readonly string[] = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "USER"];

/** Variables its own sessions set that would make it think it runs inside one. */
export const CLAUDE_SCRUB_ENV: readonly string[] = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
];

export interface ClaudeOptions {
  /** `--model`; Claude's own default when unset. */
  readonly model?: string;
  /** `owner/name`: a pull request it opens anywhere else is not its task's. */
  readonly repo?: string;
  /** `all` runs it in `bypassPermissions`; `allowlist`, the default, in `acceptEdits` with {@link CLAUDE_ALLOWED_COMMANDS}. */
  readonly permissions?: RunnerAgentPermissions;
}

interface ClaudeSetup {
  /** Its `--settings`: the runner's hooks and the allowlist. */
  readonly settings: string;
}

/** Quotes a string for `sh`. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes Claude's `--settings` and the hook helper it runs: each hook event
 * posted to the runner with the run's token, by the runner's own node, which
 * is always there.
 */
function writeSettings(dataDir: string, permissions: RunnerAgentPermissions): string {
  const dir = join(dataDir, "claude");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const helper = join(dir, "hook.cjs");
  writeFileSync(
    helper,
    `// Posts one Claude Code hook event to the runner that started this Claude.
const http = require("node:http");
const event = process.argv[2];
const base = process.env.${HOOK_ENV.url};
const run = process.env.${HOOK_ENV.run};
const token = process.env.${HOOK_ENV.token};
if (!event || !base || !run || !token) process.exit(0);
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (body += chunk));
process.stdin.on("end", () => {
  const url = new URL(base + ${JSON.stringify(HOOK_PATH)});
  url.searchParams.set("run", run);
  url.searchParams.set("event", event);
  const request = http.request(url, {
    method: "POST",
    timeout: 3000,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  }, (response) => response.resume());
  request.on("error", () => undefined);
  request.on("timeout", () => request.destroy());
  request.end(body);
});
`,
    { mode: 0o600 },
  );
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    const command = `${shq(process.execPath)} ${shq(helper)} ${event} >/dev/null 2>&1; true`;
    hooks[event] = [{ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] }];
  }
  const settings = join(dir, "settings.json");
  // Bypass mode otherwise opens on a warning to accept, which nobody is at the terminal to do.
  const bypass = permissions === "all" ? { skipDangerousModePermissionPrompt: true } : {};
  const written = { hooks, permissions: { allow: CLAUDE_ALLOWED_COMMANDS }, ...bypass };
  writeFileSync(settings, `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600 });
  return settings;
}

type Payload = Record<string, unknown>;

function asPayload(value: unknown): Payload {
  return typeof value === "object" && value !== null ? (value as Payload) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One line; the slot masks its secrets, then cuts it to the contract's budget. */
function line(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** `Bash: pnpm test`, `Edit: src/index.ts`. */
export function describeTool(payload: Payload): string {
  const name = text(payload["tool_name"]) || "tool";
  const input = asPayload(payload["tool_input"]);
  const detail = ["command", "file_path", "pattern", "url", "description"].map((key) => text(input[key])).find(Boolean) ?? "";
  return line(detail === "" ? name : `${name}: ${detail}`);
}

/** What a Bash tool call printed, from its `PostToolUse` payload. */
function bashOutput(payload: Payload): string {
  const response = payload["tool_response"];
  if (typeof response === "string") {
    return response;
  }
  const result = asPayload(response);
  return `${text(result["stdout"])}\n${text(result["stderr"])}`;
}

/** What an `AskUserQuestion` asks. */
function question(payload: Payload): string {
  const [first] = Array.isArray(asPayload(payload["tool_input"])["questions"])
    ? (asPayload(payload["tool_input"])["questions"] as unknown[])
    : [];
  const asked = text(asPayload(first)["question"]);
  return line(asked === "" ? "Asks a question" : `Asks: ${asked}`);
}

/**
 * One Claude Code hook event. A malformed payload still counts as the event.
 * The sign-in and trust screens are read off its screen, so only its session
 * starting or a prompt clears `bootBlocked` here.
 *
 * @param repo `owner/name`; with it, a `gh pr create` there is reported as its pull request.
 */
export function claudeHook(run: RunHandle, event: string, body: unknown, repo?: string): void {
  const payload = asPayload(body);
  const transcript = text(payload["transcript_path"]);
  if (transcript !== "") {
    run.transcript(transcript);
  }
  switch (event) {
    case "SessionStart":
      // It also fires mid-work, as a conversation is compacted: only a session that is just up is idle.
      if (run.status === "starting" || run.bootBlocked) {
        run.bootBlocked = false;
        run.setStatus("idle");
      }
      return;
    case "UserPromptSubmit":
      run.bootBlocked = false;
      run.setStatus("working", line(text(payload["prompt"]).split("\n")[0] ?? ""));
      return;
    case "PreToolUse":
      if (payload["tool_name"] === "AskUserQuestion") {
        run.setStatus("needs-input", question(payload));
      } else {
        run.setStatus("working", describeTool(payload));
      }
      return;
    case "PostToolUse":
    case "PostToolUseFailure":
      if (event === "PostToolUse" && repo !== undefined && payload["tool_name"] === "Bash") {
        const pr = ownPr(asPayload(payload["tool_input"])["command"], bashOutput(payload), repo);
        if (pr !== undefined) {
          run.pullRequest(pr);
        }
      }
      // A tool call that was waiting on a person has its answer, and it carries on.
      if (run.status === "needs-input" && !run.bootBlocked) {
        run.setStatus("working", describeTool(payload));
      }
      return;
    case "PermissionRequest":
      // A question is put to the person through a permission prompt too; what it asks says more.
      run.setStatus(
        "needs-input",
        payload["tool_name"] === "AskUserQuestion" ? question(payload) : line(`Wants permission: ${describeTool(payload)}`),
      );
      return;
    case "Notification": {
      const type = text(payload["notification_type"]);
      if (type === "idle_prompt") {
        // Waiting at its prompt: a turn that ended without a Stop hook.
        if (run.status === "working") {
          run.setStatus("turn-done");
        }
      } else if (type !== "auth_success" && run.status !== "needs-input") {
        run.setStatus("needs-input", line(text(payload["message"]) || "Waiting on a person"));
      }
      return;
    }
    case "Stop":
      run.setStatus("turn-done");
      return;
  }
}

/**
 * Claude can sit at its prompt without being usable: stuck on a first-run
 * screen, or not signed in on this machine. That needs a person, until the
 * screen moves on.
 */
export function claudeBlocked(screenText: string, early: boolean): string | undefined {
  if (NOT_LOGGED_IN.test(early ? screenText : screenText.slice(-TURN_END_TAIL))) {
    return "Claude isn't signed in on the runner's machine: run claude there and /login";
  }
  if (SETUP_PROMPT.test(screenText) && early) {
    return "Waiting on a setup screen (trust / login / API key)";
  }
  return undefined;
}

export function claudeAdapter(options: ClaudeOptions = {}): ProviderAdapter<ClaudeSetup> {
  const permissions = options.permissions ?? "allowlist";
  return {
    id: "claude",
    label: "Claude",
    command: "claude",
    credentialEnv: CLAUDE_CREDENTIAL_ENV,
    scrubEnv: CLAUDE_SCRUB_ENV,
    prepare: (dataDir) => ({ settings: writeSettings(dataDir, permissions) }),
    launch({ prompt, systemPrompt, setup }) {
      const mode = permissions === "all" ? "bypassPermissions" : "acceptEdits";
      const args = ["--settings", setup.settings, "--permission-mode", mode];
      if (systemPrompt !== "") {
        // Appended, so Claude Code keeps its own system prompt and its tools' instructions.
        args.push("--append-system-prompt", systemPrompt);
      }
      if (options.model !== undefined) {
        args.push("--model", options.model);
      }
      // `--` so a prompt such as "- fix login" is never read as an option. A desk session has none.
      if (prompt !== "") {
        args.push("--", prompt);
      }
      return { args };
    },
    // SessionStart fires as soon as Claude can take input: still silent, it is waiting on a person.
    bootHint: "Waiting on a setup screen (trust / login / API key)",
    hook: { handle: (run, event, payload) => claudeHook(run, event, payload, options.repo) },
    // OSC 9;4 progress, which Claude Code emits: catches a turn cancelled with Esc, which fires no Stop hook.
    screen: { progress: true, blocked: claudeBlocked },
  };
}
