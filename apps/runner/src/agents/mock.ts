/**
 * The `mock` agent: a script of progress on a timer, then an outcome.
 *
 * It costs nothing and needs no credentials, so the runner, the sync loop and
 * the floor can all be developed and tested end to end without a real agent.
 * By default the work fails, which is what a real agent does most often while
 * this is being built; configured to, it opens a pull request that does not
 * exist instead.
 *
 * It does one real thing, writing a file in its worktree and committing it, so
 * a task's worktree is exercised end to end too: stopped before it writes, its
 * worktree is removed, and from then on kept, first with an uncommitted change
 * and then with a commit nothing pushes yet.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

interface Step {
  readonly activity: string;
  /** What the step really does, if anything; throws to fail the work. */
  readonly act?: () => void;
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
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workdir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
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
      const steps = script(task);
      let step = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const next = (): void => {
        const current = steps[step];
        step += 1;
        if (current !== undefined) {
          reporter.progress(current.activity);
          try {
            current.act?.();
          } catch (error) {
            timer = undefined;
            reporter.failed(`${current.activity} failed: ${gitError(error)}`);
            return;
          }
          timer = setTimeout(next, stepMs);
          return;
        }
        timer = undefined;
        if (options.outcome === "pr-opened") {
          const number = FAKE_PR_OFFSET + task.issueNumber;
          reporter.prOpened({
            number,
            title: `[mock] ${task.title}`,
            url: `https://github.com/${options.repo}/pull/${number}`,
          });
        } else {
          reporter.failed("The mock agent always fails; set RUNNER_MOCK_OUTCOME=pr-opened for a pull request.");
        }
      };

      timer = setTimeout(() => {
        reporter.started();
        next();
      }, stepMs);

      return {
        stop() {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        },
      };
    },
  };
}
