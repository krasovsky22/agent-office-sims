/**
 * One room's AI manager: the conversation, the questions waiting to be
 * answered, and the loop that answers them.
 *
 * The room's one rule about slow work holds here: **the manager never runs
 * inside the simulation tick, and the tick never waits on it.** A
 * message from the CEO is taken synchronously by a message handler — checked
 * against the one gate, recorded, broadcast and queued — and nothing more. The
 * answer is worked out on the manager's own async loop, which may spend seconds
 * on a model call while the room ticks on at full rate; when it has one, it
 * writes the result between ticks: assignments through the work's rules or
 * into the orchestrator's queue,
 * the reply into the conversation, and its badge back to idle.
 *
 * One question at a time, in order, with a few allowed to wait behind it, so
 * a CEO can ask two things in a row and a stuck model cannot pile up calls.
 * The office is read again when the answer is in, so an assignment is judged
 * against the office and the project board as they are then, not as they were
 * when the question was asked.
 *
 * When a configured model fails — a timeout, a spent budget, an outage — the
 * manager answers by rule instead and says so, so a question about status still
 * gets an answer from the live state.
 *
 * Its updates come from its own timer: a look at the office every couple of
 * seconds, compared with the last (`./updates.ts`), and posted to the same
 * conversation when anything happened.
 *
 * {@link OfficeManager.stop} ends both, aborting a model call in flight, and
 * nothing is written after it.
 */

import {
  MANAGER_ENTRY_KIND,
  MANAGER_NAME,
  MANAGER_OCCUPANT_ID,
  MANAGER_REJECTION,
  MANAGER_STATUS,
  type ManagerEntry,
  type ManagerEntryKind,
  type ManagerRejection,
  type Occupant,
  actorOf,
  isAiManager,
  mayInstructManager,
} from "@sim/shared";

import type { LiveAgentSource } from "../agents/registry.js";
import type { WorkHost } from "../rooms/workHandlers.js";
import { recordOfficeEvent } from "../sim/events.js";
import { type AdviceResult, type ManagerAdvisor, type ManagerRequest } from "./advisor.js";
import { carryOut } from "./assign.js";
import { ManagerConversation } from "./conversation.js";
import type { LiveAssignmentQueue } from "./liveAssignments.js";
import { type OfficeView, readLiveAgents, readOfficeView } from "./officeView.js";
import { ADVICE_FAILURE } from "./plannerError.js";
import { planFromRules } from "./rulePlanner.js";
import { type Observation, describeChanges, observe } from "./updates.js";

/** Messages that may wait behind the one being answered. */
export const MAX_WAITING_MESSAGES = 3;

/** How often the manager looks for news to post. */
export const UPDATE_INTERVAL_MS = 2000;

/** What the manager needs from its room, named so a test can supply it. */
export interface ManagerHost {
  /** The room's state and project board, and how a work command is stamped. */
  readonly work: WorkHost;
  readonly advisor: ManagerAdvisor;
  /** The live agents, with their assignments; absent with no orchestrator. */
  readonly liveAgents: LiveAgentSource | undefined;
  /**
   * Every live agent on the floor, the runners' slots too: the manager watches
   * it only for one that needs someone; all its other news, its work and its
   * answers are about {@link liveAgents}. Defaults to those.
   */
  readonly floor?: LiveAgentSource | undefined;
  /** Where GitHub work for live agents is queued; absent with no orchestrator. */
  readonly assignments: LiveAssignmentQueue | undefined;
  /** This room, as the assignment queue knows it. */
  readonly origin: string;
  /** Sends a new line to every client. */
  readonly publish: (entry: ManagerEntry) => void;
  /** Defaults to {@link UPDATE_INTERVAL_MS}. */
  readonly updateIntervalMs?: number;
}

interface Question {
  readonly ceoId: string;
  readonly ceoName: string;
  readonly text: string;
  /** The conversation before the question, which is what the planner reads. */
  readonly history: readonly ManagerEntry[];
}

export class OfficeManager {
  private readonly conversation: ManagerConversation;
  private readonly waiting: Question[] = [];
  private readonly abort = new AbortController();
  private started = false;
  private stopped = false;
  private answering = false;
  /** Ends the loop's wait for a question. */
  private wake: (() => void) | undefined;
  private updateTimer: ReturnType<typeof setInterval> | undefined;
  private lastLook: Observation | undefined;

  public constructor(private readonly host: ManagerHost) {
    this.conversation = new ManagerConversation(host.work.now);
  }

  /** The conversation so far, oldest first, for a client that has just joined. */
  public history(): readonly ManagerEntry[] {
    return this.conversation.entries();
  }

  /** Starts answering and looking for news. A manager runs once: a stopped one stays stopped. */
  public start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    this.lookForNews();
    this.updateTimer = setInterval(() => this.lookForNews(), this.host.updateIntervalMs ?? UPDATE_INTERVAL_MS);
    this.updateTimer.unref();
    void this.run();
  }

  /** Ends the loop and the updates for good, without writing anything more. */
  public stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearInterval(this.updateTimer);
    this.abort.abort();
    this.waiting.length = 0;
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  /**
   * Takes one message from someone in the office. Synchronous, and the whole
   * of what a message handler does with one.
   *
   * @returns why the message was not taken, or `undefined` when it was:
   * recorded, broadcast, and queued for an answer.
   */
  public instruct(sender: Occupant, text: string): ManagerRejection | undefined {
    if (!mayInstructManager(actorOf(sender))) {
      return MANAGER_REJECTION.forbidden;
    }
    if (this.stopped || this.waiting.length >= MAX_WAITING_MESSAGES) {
      return MANAGER_REJECTION.busy;
    }
    const history = this.conversation.entries();
    const entry = this.say(MANAGER_ENTRY_KIND.instruction, sender.name, text);
    if (entry === undefined) {
      return undefined;
    }
    this.waiting.push({ ceoId: sender.id, ceoName: sender.name, text: entry.text, history });
    this.showThinking(true);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
    return undefined;
  }

  /**
   * Posts news the office cannot read off its state, such as a start the
   * runner refused, to the conversation as an update. Synchronous, so the tick
   * can call it; nothing after {@link stop}.
   */
  public report(text: string): void {
    if (!this.stopped) {
      this.say(MANAGER_ENTRY_KIND.update, MANAGER_NAME, text);
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const question = this.waiting.shift();
      if (question === undefined) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        continue;
      }
      this.answering = true;
      try {
        await this.answer(question);
      } catch (error) {
        // Nothing in an answer should throw; the loop outliving one that did matters more.
        if (!this.stopped) {
          const message = error instanceof Error && error.message !== "" ? error.message : "unexpected error";
          this.say(MANAGER_ENTRY_KIND.reply, MANAGER_NAME, `Something went wrong while I was answering that (${message}). Ask me again?`);
        }
      } finally {
        this.answering = false;
        if (!this.stopped) {
          this.showThinking(this.waiting.length > 0);
        }
      }
    }
  }

  private async answer(question: Question): Promise<void> {
    const request: ManagerRequest = {
      message: question.text,
      ceoName: question.ceoName,
      view: this.look(),
      history: question.history,
    };
    const result = await this.host.advisor.advise(request, this.abort.signal);
    if (this.stopped || (!result.ok && result.reason === ADVICE_FAILURE.cancelled)) {
      return;
    }
    // Read again now the answer is in: the office has moved on while it was thought about.
    const view = this.look();
    const plan = result.ok ? result.plan : planFromRules({ ...request, view });
    const preface = result.ok ? "" : fallbackNote(result);

    let outcomes: string[] = [];
    if (plan.assignments.length > 0) {
      const ceo = this.host.work.state.occupants.get(question.ceoId);
      outcomes =
        ceo === undefined || !mayInstructManager(actorOf(ceo))
          ? ["✗ You are no longer the CEO, so I didn't hand anything out."]
          : carryOut(plan.assignments, {
              work: this.host.work,
              ceo,
              view,
              queue: this.host.assignments,
              origin: this.host.origin,
              note: question.text,
            });
    }
    this.say(MANAGER_ENTRY_KIND.reply, MANAGER_NAME, [preface, plan.reply, ...outcomes].filter((line) => line !== "").join("\n"));
    recordOfficeEvent("manager-answer", {
      ceo: question.ceoName,
      via: result.ok ? this.host.advisor.mode : "rules",
      assignments: outcomes.filter((line) => line.startsWith("✓")).length,
      tokens: result.ok ? result.plan.tokensUsed : result.tokensUsed,
      ...(result.ok ? {} : { failure: result.reason }),
    });
  }

  /** Compares the office with the last look, and posts what changed. */
  private lookForNews(): void {
    if (this.stopped) {
      return;
    }
    try {
      const view = this.look();
      const look = observe(
        view,
        this.host.assignments?.madeBy(this.host.origin) ?? [],
        this.host.floor === undefined ? view.liveAgents : readLiveAgents(this.host.floor.current()),
      );
      const lines = describeChanges(this.lastLook ?? { ...look, waiting: new Map() }, look);
      this.lastLook = look;
      if (lines.length > 0) {
        this.say(MANAGER_ENTRY_KIND.update, MANAGER_NAME, lines.join("\n"));
      }
    } catch {
      // A missed update is not worth a timer that stops firing.
    }
  }

  private look(): OfficeView {
    return readOfficeView({
      state: this.host.work.state,
      project: this.host.work.board(),
      liveAgents: this.host.liveAgents?.current(),
    });
  }

  private say(kind: ManagerEntryKind, authorName: string, text: string): ManagerEntry | undefined {
    const entry = this.conversation.append(kind, authorName, text);
    if (entry !== undefined) {
      this.host.publish(entry);
    }
    return entry;
  }

  /** The badge over the manager's head, written only when it changes. */
  private showThinking(thinking: boolean): void {
    const manager = this.host.work.state.occupants.get(MANAGER_OCCUPANT_ID);
    const status = thinking || this.answering ? MANAGER_STATUS.thinking : MANAGER_STATUS.idle;
    if (manager !== undefined && isAiManager(manager) && manager.status !== status) {
      manager.status = status;
    }
  }
}

/** The line a rules answer opens with when the model it stood in for failed. */
function fallbackNote(result: Extract<AdviceResult, { ok: false }>): string {
  return result.reason === ADVICE_FAILURE.budgetExhausted
    ? `(My model budget is spent — ${result.message} — so this is my quick answer from the board.)`
    : `(I couldn't reach my model — ${result.message} — so this is my quick answer from the board.)`;
}
