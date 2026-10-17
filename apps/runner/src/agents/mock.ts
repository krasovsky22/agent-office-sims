/**
 * The `mock` agent: a script of progress on a timer, then an outcome, printed
 * to its terminal in colour as a real agent's would be.
 *
 * It costs nothing and needs no credentials, so the runner, the sync loop and
 * the floor can all be developed and tested end to end without a real agent.
 * Partway through it stops to wait on a person for a few steps, as a real
 * agent does for a permission, so the office's needs-you beacon can be seen
 * without one. By default the work fails, which is what a real agent does most
 * often while this is being built; configured to, it opens a pull request that
 * does not exist instead, and then waits at its prompt as a real agent does:
 * sent back for rework, it reads the prompt, commits again, and hands the same
 * pull request in again.
 *
 * It does one real thing, writing a file in its worktree and committing it, so
 * a task's worktree is exercised end to end too: stopped before it writes, its
 * worktree is removed, and from then on kept, first with an uncommitted change
 * and then with a commit nothing pushes yet.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { gitError } from "../worktrees.js";
import type { Agent, AgentReporter, AgentRun, AgentTask } from "./types.js";

export const MOCK_OUTCOMES = ["failed", "pr-opened"] as const;

export type MockOutcome = (typeof MOCK_OUTCOMES)[number];

export interface MockAgentOptions {
  readonly outcome: MockOutcome;
  /** `owner/name`, for the fake pull request's link. */
  readonly repo: string;
  /** Between one scripted step and the next. */
  readonly stepMs?: number;
}

const DEFAULT_STEP_MS = 2000;

/**
 * Added to the issue number for the fake pull request's, so its link is
 * shaped like a real one and still names no pull request that exists.
 */
const FAKE_PR_OFFSET = 1_000_000;

/** Where in its worktree the mock writes, apart from anything the repository has. */
const MOCK_DIR = ".sims-mock";

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

/** How many steps the mock waits on a person before it carries on. */
export const MOCK_NEEDS_INPUT_STEPS = 3;

/** One step of the script: what it is doing, or what it is waiting on. */
interface Step {
  readonly activity: string;
  /** Whether it is waiting on a person rather than working. */
  readonly needsInput?: boolean;
  /** What the step really does, if anything; throws to fail the work. */
  readonly act?: () => void;
}

/** What the mock does when sent back: reads why, and commits again. */
function reworkScript(task: AgentTask, text: string): readonly Step[] {
  const file = join(MOCK_DIR, `issue-${task.issueNumber}.md`);
  return [
    { activity: `Reading: ${text.split("\n")[0] ?? ""}` },
    {
      activity: `Edit: ${file}`,
      act: () => {
        appendFileSync(join(task.workdir, file), `\nReworked: ${text}\n`);
      },
    },
    { activity: "Bash: git commit", act: () => commit(task.workdir, `mock: rework #${task.issueNumber}`) },
    { activity: "Bash: git push" },
  ];
}

/** What the mock does, one step at a time. */
function script(task: AgentTask): readonly Step[] {
  const file = join(MOCK_DIR, `issue-${task.issueNumber}.md`);
  return [
    { activity: `Reading issue #${task.issueNumber}` },
    {
      activity: `Edit: ${file}`,
      act: () => {
        mkdirSync(join(task.workdir, MOCK_DIR), { recursive: true });
        writeFileSync(join(task.workdir, file), `# ${task.title}\n\n${task.url}\n${task.note === "" ? "" : `\n${task.note}\n`}`);
      },
    },
    { activity: "Bash: git commit", act: () => commit(task.workdir, `mock: work on #${task.issueNumber}`) },
    ...Array.from({ length: MOCK_NEEDS_INPUT_STEPS }, (): Step => ({
      activity: "Permission: Bash pnpm test",
      needsInput: true,
    })),
    { activity: "Bash: pnpm test" },
  ];
}

/**
 * Commits everything in `workdir` as the mock, whatever the machine's git
 * identity, signing or hooks, and even when there is nothing new: a task
 * picked up again from its kept worktree writes the same file over. Synchronous:
 * one small commit is milliseconds, and it keeps each step a single timer.
 */
function commit(workdir: string, message: string): void {
  // Only the worktree's own repository: never one git would find above it.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: realpathSync(dirname(workdir)) };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workdir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  git("add", "--all");
  git(
    "-c",
    "user.name=Sims mock agent",
    "-c",
    "user.email=mock-agent@sims.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "--allow-empty",
    "-m",
    message,
  );
}

export function createMockAgent(options: MockAgentOptions): Agent {
  const stepMs = options.stepMs ?? DEFAULT_STEP_MS;
  return {
    label: "Mock",
    start(task: AgentTask, reporter: AgentReporter): AgentRun {
      let steps = script(task);
      let step = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;

      const next = (): void => {
        const current = steps[step];
        step += 1;
        if (current !== undefined) {
          if (current.needsInput === true) {
            reporter.needsInput(current.activity);
            reporter.output(`${CYAN}?${RESET} ${current.activity}\r\n`);
          } else {
            reporter.progress(current.activity);
            reporter.output(`${CYAN}●${RESET} ${current.activity}\r\n`);
          }
          try {
            current.act?.();
          } catch (error) {
            timer = undefined;
            const message = `${current.activity} failed: ${gitError(error)}`;
            reporter.output(`${RED}✗ ${message}${RESET}\r\n`);
            reporter.failed(message);
            return;
          }
          timer = setTimeout(next, stepMs);
          return;
        }
        timer = undefined;
        if (options.outcome === "pr-opened") {
          const number = FAKE_PR_OFFSET + task.issueNumber;
          const url = `https://github.com/${options.repo}/pull/${number}`;
          reporter.output(`${GREEN}✓ Opened ${url}${RESET}\r\n`);
          reporter.prOpened({ number, title: `[mock] ${task.title}`, url });
          reporter.turnDone();
        } else {
          const message = "The mock agent always fails; set RUNNER_MOCK_OUTCOME=pr-opened for a pull request.";
          reporter.output(`${RED}✗ ${message}${RESET}\r\n`);
          reporter.failed(message);
        }
      };

      timer = setTimeout(() => {
        reporter.started();
        reporter.output(`${BOLD}mock agent${RESET} on #${task.issueNumber}: ${task.title}\r\n${DIM}for ${task.requestedBy}${RESET}\r\n\r\n`);
        next();
      }, stepMs);

      return {
        stop() {
          stopped = true;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        },
        prompt(text) {
          if (stopped) {
            return;
          }
          clearTimeout(timer);
          reporter.output(`\r\n${BOLD}>${RESET} ${text}\r\n`);
          steps = reworkScript(task, text);
          step = 0;
          timer = setTimeout(next, stepMs);
        },
      };
    },
  };
}
