/**
 * What a slot needs from an agent, whatever runs it: start it on an issue,
 * hear what it does, see what it prints, and stop it.
 *
 * A slot owns the bookkeeping (status, events, the task timeout), so an agent
 * only says what happened. Once it has said how the work ended, or been
 * stopped, the slot stops listening. A pull request is not an end: the agent
 * keeps its task, waiting at its prompt, until the server stops it or sends
 * its work back with a prompt.
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

/**
 * How an agent tells its slot what it is doing. The slot reports `started`
 * once, on the first of these, whichever it is.
 */
export interface AgentReporter {
  /** It is up, and has not started on anything yet. */
  started(): void;
  /** It is working; what it is doing now, e.g. `Bash: pnpm test`. */
  progress(activity: string): void;
  /** What it printed to its terminal, escape sequences and all; the slot's screen shows it. */
  output(data: string): void;
  /** It is waiting on a person: a permission, a question, a sign-in. */
  needsInput(reason: string): void;
  /** Its turn ended and it waits at its prompt, still holding the task. */
  turnDone(): void;
  /** It opened a pull request, handing its work in; it keeps the task for any rework. */
  prOpened(pr: RunnerPullRequest): void;
  /** It gave up or broke; the work is over. */
  failed(message: string): void;
  /** Its process ended on its own; the work is over, `clean` when it exited without an error. */
  exited(message: string, clean: boolean): void;
}

/** One agent working one task. */
export interface AgentRun {
  /** Ends the work now. The agent reports nothing more; the slot says why it stopped. */
  stop(): void;
  /** Says something to it at its prompt, starting another turn; left out by an agent that takes no prompts. */
  prompt?(text: string): void;
}

export interface Agent {
  /** Names the slots, e.g. `Mock` for `Mock 1`; short, since a name is at most 18 bytes. */
  readonly label: string;
  start(task: AgentTask, reporter: AgentReporter): AgentRun;
}
