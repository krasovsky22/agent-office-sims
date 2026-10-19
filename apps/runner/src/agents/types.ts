/**
 * What a slot needs from an agent, whatever runs it: start it on an issue, or
 * at its prompt for a desk session, hear what it does, see what it prints, and
 * stop it.
 *
 * A slot owns the bookkeeping (status, events, the task timeout, the runner's
 * spend), so an agent only says what happened. Once it has said how the work ended, or been
 * stopped, the slot stops listening. A pull request is not an end: the agent
 * keeps its task, waiting at its prompt, until the server stops it or sends
 * its work back with a prompt.
 */

import type { AgentKey, RunnerPullRequest } from "@sim/shared";

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
  /** Its system prompt, from its slot's profile as the task starts; see `./prompt.ts`. */
  readonly systemPrompt: string;
}

/**
 * A desk session a start command did not make: the CEO sitting at a desk in
 * the office is lent the slot's agent, with no issue and no first prompt, to
 * prompt from there.
 */
export interface AgentSession {
  /** The CEO at the desk, by name. */
  readonly requestedBy: string;
  /** A scratch worktree of the default branch: where the agent works. */
  readonly workdir: string;
  /** Its system prompt, from its slot's profile as the session starts; see `./prompt.ts`. */
  readonly systemPrompt: string;
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
  /**
   * What its work has cost so far, in US dollars, all of it rather than since
   * last said. Heard even once the work is over, since a stopped agent's last
   * turn is still paid for.
   */
  spent(totalUsd: number): void;
}

/** One agent working one task. */
export interface AgentRun {
  /** Ends the work now. The agent reports nothing more; the slot says why it stopped. */
  stop(): void;
  /** Says something to it at its prompt, starting another turn; left out by an agent that takes no prompts. */
  prompt?(text: string): void;
  /**
   * Whether a prompt answers what it waits on while it needs a person, as the
   * mock's does, so the CEO can answer it from the office. Left out by an agent
   * whose waits a prompt cannot answer safely: a real agent's permission
   * dialog takes a keypress, and the Enter after a pasted prompt would choose
   * whatever the dialog has selected, whatever the prompt said.
   */
  readonly promptAnswersWait?: boolean;
  /**
   * Presses a key on the choice screen it waits on (a permission, a setup or
   * trust screen), as a person at its terminal would. The slot presses one
   * only while it waits on a person. Left out by an agent with no screen to press it on.
   */
  key?(key: AgentKey): void;
  /**
   * Pauses it at a safe point, for a standup: before its next step, with
   * nothing it has done undone. Left out by an agent that cannot pause, as a
   * real one cannot mid-turn; it finishes its turn and waits at its prompt.
   */
  pause?(): void;
  /** Lets it carry on from where {@link pause} stopped it. */
  resume?(): void;
  /** The process it runs as, for the runner's log; left out by an agent that runs inside the runner, as the mock does. */
  readonly process?: { readonly command: string; readonly pid: number };
}

export interface Agent {
  /** Which agent it is, e.g. `Mock`, for the runner's log; the slots' names are their profiles'. */
  readonly label: string;
  /** It only pretends to work, as the mock does: nothing it does reaches GitHub, so the runner's log says so of every task. */
  readonly simulated?: boolean;
  start(task: AgentTask, reporter: AgentReporter): AgentRun;
  /**
   * Starts it at its prompt with no task, for a desk session, and waits there
   * for the prompts the CEO types. Left out by an agent that only works issues.
   */
  startSession?(session: AgentSession, reporter: AgentReporter): AgentRun;
}
