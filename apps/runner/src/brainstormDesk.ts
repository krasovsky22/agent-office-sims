/**
 * The runner's own GitHub calls for brainstorm tickets: posting an idea's
 * design document on its issue, and converting the idea into the
 * implementation issues a player drafted, then closing it.
 *
 * The game server never writes to GitHub, so it hands both to a runner as
 * commands, which the runner carries out with the identity its agents already
 * use, as it closes and reopens issues for the CEO (`./issueStates.ts`): its
 * GitHub App, which needs **Issues: Read and write** for them, or a person's
 * own login. A mock runner has neither and takes neither command. What came of
 * each rides back as a `brainstorm` event, reported until a sync carrying it is
 * answered, as any event is.
 */

import {
  BRAINSTORM_PART,
  type BrainstormPart,
  MAX_WORK_NOTE_LENGTH,
  RUNNER_COMMAND_KIND,
  RUNNER_EVENT_KIND,
  type RunnerBrainstormEvent,
  type RunnerBrainstormGithubCommand,
  fitJsonBytes,
  sanitizeBrainstormText,
} from "@sim/shared";

import { EventOutbox } from "./eventOutbox.js";
import { type RunCommand, runCommand } from "./github.js";

/** What the desk asks of GitHub; each rejects with why when GitHub would not. */
export interface BrainstormGithub {
  comment(issueNumber: number, body: string): Promise<void>;
  /** Creates an issue, resolving to its number and link. */
  create(title: string, body: string): Promise<{ readonly number: number; readonly url: string }>;
  /** Closes the idea, saying what it became. */
  close(issueNumber: number, comment: string): Promise<void>;
}

export interface GhBrainstormOptions {
  /** `owner/name`. */
  readonly repo: string;
  /** The environment for a `gh` call, with the runner's GitHub identity in it. */
  readonly env: () => Promise<NodeJS.ProcessEnv>;
  readonly run?: RunCommand;
}

/** Each call as one `gh` command with the runner's GitHub identity. */
export function ghBrainstorm(options: GhBrainstormOptions): BrainstormGithub {
  const run = options.run ?? runCommand;
  const gh = async (args: readonly string[]): Promise<string> => run("gh", args, { env: await options.env() });
  return {
    async comment(issueNumber, body) {
      await gh(["issue", "comment", String(issueNumber), "--repo", options.repo, "--body", body]);
    },
    async create(title, body) {
      const out = await gh(["issue", "create", "--repo", options.repo, "--title", title, "--body", body]);
      const url = out.split("\n").pop() ?? "";
      const number = Number(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)$/.exec(url)?.[1]);
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error("gh did not say which issue it created");
      }
      return { number, url };
    },
    async close(issueNumber, comment) {
      await gh(["issue", "close", String(issueNumber), "--repo", options.repo, "--comment", comment]);
    },
  };
}

/** The last line a failed `gh` printed, which says what went wrong. */
function failure(error: unknown): string {
  const { stderr, message } = error as { stderr?: string; message?: string };
  const said = String(stderr || message || error).trim().split("\n").filter(Boolean).pop() ?? "it failed";
  return fitJsonBytes(sanitizeBrainstormText(said), MAX_WORK_NOTE_LENGTH);
}

export interface BrainstormDeskOptions {
  readonly github: BrainstormGithub;
  /** Event ids; injected so a test can name them. */
  readonly eventId: () => string;
  readonly log?: (line: string) => void;
}

/** Carries out the server's posts and conversions, and keeps what came of them for the next syncs. */
export class BrainstormDesk {
  private readonly events = new EventOutbox<RunnerBrainstormEvent>();
  private readonly log: (line: string) => void;

  public constructor(private readonly options: BrainstormDeskOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** Starts the call; what came of it joins {@link pendingEvents} once GitHub has answered. Never rejects. */
  public handle(command: RunnerBrainstormGithubCommand): Promise<void> {
    return command.kind === RUNNER_COMMAND_KIND.brainstormPost ? this.post(command) : this.convert(command);
  }

  /** What came of the calls, oldest first, until a sync carrying them is answered. */
  public pendingEvents(): readonly RunnerBrainstormEvent[] {
    return this.events.pending();
  }

  /** Forgets the events an answered sync carried. */
  public delivered(ids: ReadonlySet<string>): void {
    this.events.forget((event) => ids.has(event.id));
  }

  private async post(command: Extract<RunnerBrainstormGithubCommand, { kind: typeof RUNNER_COMMAND_KIND.brainstormPost }>): Promise<void> {
    const by = command.requestedBy || "the office";
    try {
      await this.options.github.comment(command.issueNumber, `${command.body}\n\n_Posted from the office by its agent runner for ${by}._`);
      this.log(`posted #${command.issueNumber}'s design document for ${by}`);
      this.emit(command.issueNumber, BRAINSTORM_PART.posted, "", []);
    } catch (error) {
      this.log(`could not post #${command.issueNumber}'s design document: ${failure(error)}`);
      this.emit(command.issueNumber, BRAINSTORM_PART.postFailed, failure(error), []);
    }
  }

  /**
   * Creates every drafted issue in order, then closes the idea with their
   * links. One that fails stops the rest, and says which were created first,
   * so a second try is the player's choice, made knowing what exists.
   */
  private async convert(command: Extract<RunnerBrainstormGithubCommand, { kind: typeof RUNNER_COMMAND_KIND.brainstormConvert }>): Promise<void> {
    const by = command.requestedBy || "the office";
    const created: { number: number; url: string }[] = [];
    try {
      for (const draft of command.drafts) {
        created.push(await this.options.github.create(draft.title, draft.body));
      }
      const links = created.map((issue) => `#${issue.number}`).join(", ");
      await this.options.github.close(
        command.issueNumber,
        `Converted from the office into ${links}, for ${by}. Implementation happens there; this idea is done with.`,
      );
      this.log(`converted #${command.issueNumber} into ${links} for ${by}`);
      this.emit(command.issueNumber, BRAINSTORM_PART.converted, "", created);
    } catch (error) {
      this.log(`could not convert #${command.issueNumber} (${created.length} created): ${failure(error)}`);
      this.emit(command.issueNumber, BRAINSTORM_PART.convertFailed, failure(error), created);
    }
  }

  private emit(issueNumber: number, part: BrainstormPart, text: string, created: RunnerBrainstormEvent["created"]): void {
    this.events.push({ id: this.options.eventId(), kind: RUNNER_EVENT_KIND.brainstorm, issueNumber, part, slotId: undefined, text, created });
  }
}
