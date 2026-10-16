/**
 * The `mock` agent: a script of progress on a timer, then an outcome.
 *
 * It costs nothing and needs no credentials, so the runner, the sync loop and
 * the floor can all be developed and tested end to end without a real agent.
 * By default the work fails, which is what a real agent does most often while
 * this is being built; configured to, it opens a pull request that does not
 * exist instead.
 */

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

/** What the mock says it is doing, one step at a time. */
function script(task: AgentTask): readonly string[] {
  return [`Reading issue #${task.issueNumber}`, "Bash: pnpm install", "Edit: src/index.ts", "Bash: pnpm test"];
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
        const activity = steps[step];
        step += 1;
        if (activity !== undefined) {
          reporter.progress(activity);
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
