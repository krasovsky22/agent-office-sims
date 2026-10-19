/**
 * Closing and reopening issues on GitHub for the CEO, who drags an issue's
 * card across the office's project board.
 *
 * The game server never writes to GitHub, so it hands the change to a runner
 * as a command, and the runner makes it with the identity its agents already
 * use: its GitHub App, which needs **Issues: Read and write** for this, or a
 * person's own login. A mock runner has neither and takes no such command;
 * it says so on every sync, and the board offers no such drop.
 *
 * What came of each command rides back on the syncs, as a prompt's outcome
 * does: reported until a sync carrying it is answered, and taken once by the
 * server. A change is one `gh issue close` or `gh issue reopen`, and nothing
 * else: no comment, label or assignee.
 */

import {
  ISSUE_STATE,
  type IssueState,
  RUNNER_ISSUE_STATE_OUTCOME,
  type RunnerIssueStateCommand,
  type RunnerIssueStateOutcome,
  type RunnerIssueStateOutcomeKind,
} from "@sim/shared";

import { type RunCommand, runCommand } from "./github.js";

/** Sets an issue's state on GitHub, resolving to what came of it. Never rejects. */
export type SetIssueState = (issueNumber: number, state: IssueState) => Promise<RunnerIssueStateOutcomeKind>;

export interface GhIssueStateOptions {
  /** `owner/name`. */
  readonly repo: string;
  /** The environment for a `gh` call, with the runner's GitHub identity in it. */
  readonly env: () => Promise<NodeJS.ProcessEnv>;
  readonly run?: RunCommand;
}

/**
 * What `gh` prints when GitHub answered and said no, rather than could not be
 * asked: a permission the identity lacks, or an issue it cannot see.
 */
const REFUSED = /HTTP 4\d\d|not accessible|permission|could not resolve to an issue|not found/i;

/** The change as one `gh` call with the runner's GitHub identity. */
export function ghIssueState(options: GhIssueStateOptions): SetIssueState {
  const run = options.run ?? runCommand;
  return async (issueNumber, state) => {
    const verb = state === ISSUE_STATE.closed ? "close" : "reopen";
    try {
      await run("gh", ["issue", verb, String(issueNumber), "--repo", options.repo], { env: await options.env() });
      return RUNNER_ISSUE_STATE_OUTCOME.done;
    } catch (error) {
      const { stderr, message } = error as { stderr?: string; message?: string };
      return REFUSED.test(String(stderr ?? message ?? error))
        ? RUNNER_ISSUE_STATE_OUTCOME.refused
        : RUNNER_ISSUE_STATE_OUTCOME.failed;
    }
  };
}

export interface IssueStateDeskOptions {
  readonly set: SetIssueState;
  readonly log?: (line: string) => void;
}

/** Carries out the server's issue state commands and keeps what came of them for the next syncs. */
export class IssueStateDesk {
  private outcomes: RunnerIssueStateOutcome[] = [];
  private readonly log: (line: string) => void;

  public constructor(private readonly options: IssueStateDeskOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** Starts the change; its outcome joins {@link pending} once GitHub has answered. */
  public handle(command: RunnerIssueStateCommand): Promise<void> {
    const verb = command.state === ISSUE_STATE.closed ? "closing" : "reopening";
    return this.options.set(command.issueNumber, command.state).then((outcome) => {
      this.log(`${verb} #${command.issueNumber} for ${command.requestedBy}: ${outcome}`);
      this.outcomes.push({ commandId: command.id, outcome });
    });
  }

  /** What came of the commands, oldest first, until a sync carrying them is answered. */
  public pending(): readonly RunnerIssueStateOutcome[] {
    return this.outcomes;
  }

  /** Forgets the outcomes an answered sync carried. */
  public delivered(ids: ReadonlySet<string>): void {
    this.outcomes = this.outcomes.filter((outcome) => !ids.has(outcome.commandId));
  }
}
