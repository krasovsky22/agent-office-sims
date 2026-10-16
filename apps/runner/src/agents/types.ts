/**
 * What a slot needs from an agent, whatever runs it: start it on an issue,
 * hear what it does, see what it prints, and stop it.
 *
 * A slot owns the bookkeeping (status, events, the task timeout), so an agent
 * only says what happened. Once it has said how the work ended, or been
 * stopped, the slot stops listening.
 */

import type { RunnerPullRequest } from "@sim/shared";

/** The issue a start command hands a slot. */
export interface AgentTask {
  readonly issueNumber: number;
  readonly title: string;
  readonly url: string;
  /** The CEO's words. */
  readonly note: string;
  readonly requestedBy: string;
  /** The task's own git worktree, on a branch of its own: where the agent works. */
  readonly workdir: string;
}

/** How an agent tells its slot what it is doing. */
export interface AgentReporter {
  /** It is up and working on the task. */
  started(): void;
  /** What it is doing now, e.g. `Bash: pnpm test`. */
  progress(activity: string): void;
  /** What it printed to its terminal, escape sequences and all; the slot's screen shows it. */
  output(data: string): void;
  /** It opened a pull request; the work is over. */
  prOpened(pr: RunnerPullRequest): void;
  /** It gave up or broke; the work is over. */
  failed(message: string): void;
}

/** One agent working one task. */
export interface AgentRun {
  /** Ends the work now. The agent reports nothing more; the slot says why it stopped. */
  stop(): void;
}

export interface Agent {
  /** Names the slots, e.g. `Mock` for `Mock 1`; short, since a name is at most 18 bytes. */
  readonly label: string;
  start(task: AgentTask, reporter: AgentReporter): AgentRun;
}
