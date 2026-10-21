/**
 * The CEO's prompts to the runner's coding agents, from being sent to being
 * typed or turned down.
 *
 * A prompt the gate let through (`../rooms/agentPromptHandlers.ts`) is queued
 * for the agent's runner as a `prompt` command marked `fromCeo`, and waits
 * here, by command id, until the runner says what came of it. Only the runner
 * knows whether its agent sits at its prompt, so it decides: typed, and every
 * client is told, so each tab watching that terminal shows who said what to
 * it; or refused as busy, waiting on a permission, or not at work, and only
 * the CEO who sent it is told, with the reason. A runner that never says is
 * taken to have lost it after {@link DEFAULT_ANSWER_TIMEOUT_MS}, and the CEO is
 * told that too, so no prompt is left looking sent; one it has not yet picked
 * up is taken back, so it cannot be typed after the CEO was told it was lost.
 *
 * A key the CEO pressed on the agent's choice screen travels the same way, as
 * a `key` command: the runner presses it only while the agent waits on a
 * person. One pressed is not announced, since the agent's terminal shows what
 * it did; one refused is told to the CEO who pressed it, as a prompt's is.
 *
 * A direction the CEO gave at a standup (`../sim/standup.ts`) is a prompt
 * marked `queue`: the runner types it if its agent waits at its prompt, and
 * otherwise keeps it, reports it `queued`, and types it the next time the
 * agent does with the standup over, reporting it `delivered` then. Whatever
 * comes of one goes to the standup rather than to the CEO's terminal panel, so
 * a refusal is shown on the standup's record and not as a refused prompt. A
 * queued one is waited on for as long as its agent is on the floor. One for
 * an agent with no session at all is answered rather than typed: the runner
 * reports it `answering`, waited on as a queued one is, and then `answered`
 * with what the agent said, or `not-answered` with why, for the standup's
 * record; the status it reads comes with the direction, as `context`.
 *
 * The command reaches the runner exactly once, by the runner link's ids; the
 * runner's report of it is taken once here, by the same id, and forgotten.
 *
 * One per room, holding only that room's prompts, and synchronous, so the
 * room's tick can feed it what the runners reported.
 */

import {
  AGENT_PROMPT_REJECTION,
  type AgentKey,
  type AgentKeyMessage,
  type AgentPromptEntry,
  type AgentPromptMessage,
  type AgentPromptRejectedEvent,
  type AgentPromptRejection,
  type OfficeState,
  RUNNER_COMMAND_KIND,
  RUNNER_PROMPT_OUTCOME,
  type RunnerPromptOutcomeKind,
  isLiveAgent,
} from "@sim/shared";

import type { RunnerPromptRecord } from "./runnerLink.js";
import { type RunnerCommands, slotOf } from "./runnerWork.js";

/** How long a runner has to say what came of a prompt. It syncs about once a second. */
const DEFAULT_ANSWER_TIMEOUT_MS = 30_000;

/**
 * Prompts and keys one room keeps waiting on at once; one more is refused as
 * if the runner were offline. Keys come a few at a time, to reach an option.
 * Directions a runner holds for after a standup count apart, against
 * {@link MAX_QUEUED}: a standup gives every agent one or two.
 */
const MAX_PENDING = 32;
const MAX_QUEUED = 64;

/** Typed prompts a room remembers, for a client that joins later. */
const HISTORY_LIMIT = 20;

const REFUSAL: Readonly<Record<Exclude<RunnerPromptOutcomeKind, "delivered" | "queued">, AgentPromptRejection>> = {
  [RUNNER_PROMPT_OUTCOME.busy]: AGENT_PROMPT_REJECTION.busy,
  [RUNNER_PROMPT_OUTCOME.needsInput]: AGENT_PROMPT_REJECTION.needsInput,
  [RUNNER_PROMPT_OUTCOME.unavailable]: AGENT_PROMPT_REJECTION.unavailable,
  [RUNNER_PROMPT_OUTCOME.notWaiting]: AGENT_PROMPT_REJECTION.notWaiting,
  // Only a direction is ever answered; any other prompt reported so was not typed.
  [RUNNER_PROMPT_OUTCOME.answering]: AGENT_PROMPT_REJECTION.unavailable,
  [RUNNER_PROMPT_OUTCOME.answered]: AGENT_PROMPT_REJECTION.unavailable,
  [RUNNER_PROMPT_OUTCOME.notAnswered]: AGENT_PROMPT_REJECTION.unavailable,
};

/** What came of a standup's direction: typed, kept for later, answered by an idle agent, or why it never will be. */
export type DirectionOutcome =
  | { readonly kind: "typed" }
  | { readonly kind: "queued" }
  | { readonly kind: "answering" }
  | { readonly kind: "answered"; readonly reply: string }
  | { readonly kind: "unanswered"; readonly why: string }
  | { readonly kind: "failed"; readonly rejection: AgentPromptRejection };

export interface AgentPromptsOptions {
  readonly state: OfficeState;
  /** Where the prompt is queued for the agent's runner; absent when the server has no runner. */
  readonly runner: Pick<RunnerCommands, "enqueue" | "withdraw"> | undefined;
  /** Epoch milliseconds, for an entry's time and the answer timeout. */
  readonly now: () => number;
  /** Tells one client, by session id, that its prompt was not typed. */
  readonly refuse: (sessionId: string, event: AgentPromptRejectedEvent) => void;
  /** Tells every client a prompt was typed. */
  readonly publish: (entry: AgentPromptEntry) => void;
  readonly log?: (name: string, detail: Record<string, string | number>) => void;
  readonly answerTimeoutMs?: number;
  /** Hears what came of each standup direction, by the id {@link AgentPrompts.submitDirection} gave it. */
  readonly directed?: (commandId: string, outcome: DirectionOutcome) => void;
}

interface Pending {
  readonly runnerId: string;
  readonly slotId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly agentId: string;
  readonly agentName: string;
  /** `""` for a key. */
  readonly text: string;
  /** Set for a key, which one; absent for a prompt. */
  readonly key?: AgentKey;
  readonly sentAt: number;
  /** A standup's direction, whose outcome goes to the standup. */
  readonly direction?: boolean;
  /** Its runner keeps it for later: no answer is overdue while its agent is here. */
  queued?: boolean;
}

/** Who a prompt or key is for, once it is known to be one of a runner's agents. */
interface Target {
  readonly runnerId: string;
  readonly slotId: string;
  readonly senderName: string;
  readonly agentName: string;
}

export class AgentPrompts {
  private readonly pending = new Map<string, Pending>();
  private readonly entries: AgentPromptEntry[] = [];
  private nextId = 1;

  public constructor(private readonly options: AgentPromptsOptions) {}

  /** The prompts typed lately, oldest first. */
  public history(): readonly AgentPromptEntry[] {
    return this.entries;
  }

  /**
   * Queues a prompt the gate has let through for the agent's runner.
   *
   * @returns `undefined` once it is on its way, else why it cannot be.
   */
  public submit(senderId: string, message: AgentPromptMessage): AgentPromptRejection | undefined {
    const target = this.target(senderId, message.agentId);
    if (typeof target === "string") {
      return target;
    }
    const command = this.options.runner?.enqueue(target.runnerId, {
      kind: RUNNER_COMMAND_KIND.prompt,
      slotId: target.slotId,
      text: message.text,
      requestedBy: target.senderName,
      fromCeo: true,
    });
    this.options.log?.(command === undefined ? "agent-prompt-refused" : "agent-prompt", {
      agent: message.agentId,
      by: target.senderName,
    });
    if (command === undefined || command.kind !== RUNNER_COMMAND_KIND.prompt) {
      return AGENT_PROMPT_REJECTION.offline;
    }
    this.pending.set(command.id, {
      ...target,
      senderId,
      agentId: message.agentId,
      // As the runner was given it, which is what was typed.
      text: command.text,
      sentAt: this.options.now(),
    });
    return undefined;
  }

  /**
   * Queues a standup's direction the gate has let through for the agent's
   * runner, typed now, kept for after the standup, or answered by an agent
   * with no session from `context`, its status; see the module comment.
   *
   * @returns the command's id once it is on its way, else why it cannot be.
   */
  public submitDirection(
    senderId: string,
    agentId: string,
    text: string,
    context = "",
  ): { readonly commandId: string } | AgentPromptRejection {
    const target = this.target(senderId, agentId);
    if (typeof target === "string") {
      return target;
    }
    const command = this.options.runner?.enqueue(target.runnerId, {
      kind: RUNNER_COMMAND_KIND.prompt,
      slotId: target.slotId,
      text,
      requestedBy: target.senderName,
      fromCeo: true,
      queue: true,
      context,
    });
    this.options.log?.(command === undefined ? "standup-direction-refused" : "standup-direction", { agent: agentId, by: target.senderName });
    if (command === undefined || command.kind !== RUNNER_COMMAND_KIND.prompt) {
      return AGENT_PROMPT_REJECTION.offline;
    }
    this.pending.set(command.id, {
      ...target,
      senderId,
      agentId,
      text: command.text,
      sentAt: this.options.now(),
      direction: true,
    });
    return { commandId: command.id };
  }

  /**
   * Queues a key the gate has let through for the agent's runner, to press on
   * the choice screen its agent waits on.
   *
   * @returns `undefined` once it is on its way, else why it cannot be.
   */
  public submitKey(senderId: string, message: AgentKeyMessage): AgentPromptRejection | undefined {
    const target = this.target(senderId, message.agentId);
    if (typeof target === "string") {
      return target;
    }
    const command = this.options.runner?.enqueue(target.runnerId, {
      kind: RUNNER_COMMAND_KIND.key,
      slotId: target.slotId,
      key: message.key,
      requestedBy: target.senderName,
    });
    this.options.log?.(command === undefined ? "agent-key-refused" : "agent-key", {
      agent: message.agentId,
      by: target.senderName,
      key: message.key,
    });
    if (command === undefined || command.kind !== RUNNER_COMMAND_KIND.key) {
      return AGENT_PROMPT_REJECTION.offline;
    }
    this.pending.set(command.id, {
      ...target,
      senderId,
      agentId: message.agentId,
      text: "",
      key: command.key,
      sentAt: this.options.now(),
    });
    return undefined;
  }

  /** The runner's agent a prompt or key is for, and who sent it, or why it cannot go to it. */
  private target(senderId: string, agentId: string): Target | AgentPromptRejection {
    const agent = this.options.state.occupants.get(agentId);
    const slot = slotOf(agentId);
    const sender = this.options.state.occupants.get(senderId);
    if (agent === undefined || !isLiveAgent(agent) || slot === undefined || sender === undefined) {
      return AGENT_PROMPT_REJECTION.noAgent;
    }
    if (this.options.runner === undefined) {
      return AGENT_PROMPT_REJECTION.noAgent;
    }
    let queued = 0;
    for (const prompt of this.pending.values()) {
      queued += prompt.queued === true ? 1 : 0;
    }
    if (this.pending.size - queued >= MAX_PENDING || queued >= MAX_QUEUED) {
      return AGENT_PROMPT_REJECTION.offline;
    }
    return { runnerId: slot.runnerId, slotId: slot.slotId, senderName: sender.name, agentName: agent.name };
  }

  /**
   * Settles each prompt of this room's that a runner reported on, the first
   * time, and only from the runner and slot it was sent to.
   */
  public receive(records: readonly RunnerPromptRecord[]): void {
    for (const { runnerId, outcome } of records) {
      const prompt = this.pending.get(outcome.commandId);
      if (prompt === undefined || prompt.runnerId !== runnerId || prompt.slotId !== outcome.slotId) {
        continue;
      }
      const waits = outcome.outcome === RUNNER_PROMPT_OUTCOME.queued || outcome.outcome === RUNNER_PROMPT_OUTCOME.answering;
      if (waits && prompt.direction === true) {
        // Not the last word, and only a direction is ever kept or answered.
        if (prompt.queued !== true) {
          prompt.queued = true;
          this.options.directed?.(outcome.commandId, { kind: outcome.outcome === RUNNER_PROMPT_OUTCOME.queued ? "queued" : "answering" });
        }
        continue;
      }
      if (outcome.outcome === RUNNER_PROMPT_OUTCOME.queued) {
        continue;
      }
      this.pending.delete(outcome.commandId);
      if (prompt.direction === true && outcome.outcome === RUNNER_PROMPT_OUTCOME.answered) {
        this.options.log?.("standup-direction-answered", { agent: prompt.agentId });
        this.options.directed?.(outcome.commandId, { kind: "answered", reply: outcome.text ?? "" });
      } else if (prompt.direction === true && outcome.outcome === RUNNER_PROMPT_OUTCOME.notAnswered) {
        this.options.log?.("standup-direction-not-answered", { agent: prompt.agentId });
        this.options.directed?.(outcome.commandId, { kind: "unanswered", why: outcome.text ?? "" });
      } else if (outcome.outcome === RUNNER_PROMPT_OUTCOME.delivered) {
        this.delivered(prompt);
        if (prompt.direction === true) {
          this.options.directed?.(outcome.commandId, { kind: "typed" });
        }
      } else if (prompt.direction === true) {
        this.options.log?.("standup-direction-not-typed", { agent: prompt.agentId, why: outcome.outcome });
        this.options.directed?.(outcome.commandId, { kind: "failed", rejection: REFUSAL[outcome.outcome] });
      } else {
        this.refused(prompt, REFUSAL[outcome.outcome]);
      }
    }
  }

  /**
   * Gives up on every prompt whose runner has not answered in time, and on
   * every direction kept for an agent that has since left the floor.
   */
  public expire(): void {
    const cutoff = this.options.now() - (this.options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS);
    for (const [id, prompt] of this.pending) {
      const overdue = prompt.queued === true ? !this.options.state.occupants.has(prompt.agentId) : prompt.sentAt <= cutoff;
      if (!overdue) {
        continue;
      }
      this.pending.delete(id);
      this.options.runner?.withdraw(prompt.runnerId, id);
      if (prompt.direction === true) {
        this.options.directed?.(id, { kind: "failed", rejection: AGENT_PROMPT_REJECTION.unanswered });
      } else {
        this.refused(prompt, AGENT_PROMPT_REJECTION.unanswered);
      }
    }
  }

  private delivered(prompt: Pending): void {
    if (prompt.key !== undefined) {
      this.options.log?.("agent-key-pressed", { agent: prompt.agentId, by: prompt.senderName, key: prompt.key });
      return;
    }
    const entry: AgentPromptEntry = {
      id: this.nextId,
      agentId: prompt.agentId,
      agentName: prompt.agentName,
      authorId: prompt.senderId,
      authorName: prompt.senderName,
      text: prompt.text,
      at: this.options.now(),
    };
    this.nextId += 1;
    this.entries.push(entry);
    if (this.entries.length > HISTORY_LIMIT) {
      this.entries.shift();
    }
    this.options.log?.("agent-prompt-delivered", { agent: prompt.agentId, by: prompt.senderName });
    this.options.publish(entry);
  }

  private refused(prompt: Pending, rejection: AgentPromptRejection): void {
    if (prompt.key === undefined) {
      this.options.log?.("agent-prompt-not-typed", { agent: prompt.agentId, by: prompt.senderName, why: rejection });
      this.options.refuse(prompt.senderId, { agentId: prompt.agentId, rejection });
      return;
    }
    this.options.log?.("agent-key-not-pressed", {
      agent: prompt.agentId,
      by: prompt.senderName,
      key: prompt.key,
      why: rejection,
    });
    this.options.refuse(prompt.senderId, { agentId: prompt.agentId, rejection, key: prompt.key });
  }
}
