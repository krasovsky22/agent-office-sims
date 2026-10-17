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
 * The command reaches the runner exactly once, by the runner link's ids; the
 * runner's report of it is taken once here, by the same id, and forgotten.
 *
 * One per room, holding only that room's prompts, and synchronous, so the
 * room's tick can feed it what the runners reported.
 */

import {
  AGENT_PROMPT_REJECTION,
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

/** Prompts one room keeps waiting on at once; one more is refused as if the runner were offline. */
const MAX_PENDING = 16;

/** Typed prompts a room remembers, for a client that joins later. */
const HISTORY_LIMIT = 20;

const REFUSAL: Readonly<Record<Exclude<RunnerPromptOutcomeKind, "delivered">, AgentPromptRejection>> = {
  [RUNNER_PROMPT_OUTCOME.busy]: AGENT_PROMPT_REJECTION.busy,
  [RUNNER_PROMPT_OUTCOME.needsInput]: AGENT_PROMPT_REJECTION.needsInput,
  [RUNNER_PROMPT_OUTCOME.unavailable]: AGENT_PROMPT_REJECTION.unavailable,
};

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
}

interface Pending {
  readonly runnerId: string;
  readonly slotId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly text: string;
  readonly sentAt: number;
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
    const agent = this.options.state.occupants.get(message.agentId);
    const slot = slotOf(message.agentId);
    const sender = this.options.state.occupants.get(senderId);
    if (agent === undefined || !isLiveAgent(agent) || slot === undefined || sender === undefined) {
      return AGENT_PROMPT_REJECTION.noAgent;
    }
    if (this.options.runner === undefined) {
      return AGENT_PROMPT_REJECTION.noAgent;
    }
    if (this.pending.size >= MAX_PENDING) {
      return AGENT_PROMPT_REJECTION.offline;
    }
    const command = this.options.runner.enqueue(slot.runnerId, {
      kind: RUNNER_COMMAND_KIND.prompt,
      slotId: slot.slotId,
      text: message.text,
      requestedBy: sender.name,
      fromCeo: true,
    });
    this.options.log?.(command === undefined ? "agent-prompt-refused" : "agent-prompt", {
      agent: message.agentId,
      by: sender.name,
    });
    if (command === undefined || command.kind !== RUNNER_COMMAND_KIND.prompt) {
      return AGENT_PROMPT_REJECTION.offline;
    }
    this.pending.set(command.id, {
      runnerId: slot.runnerId,
      slotId: slot.slotId,
      senderId,
      senderName: sender.name,
      agentId: message.agentId,
      agentName: agent.name,
      // As the runner was given it, which is what was typed.
      text: command.text,
      sentAt: this.options.now(),
    });
    return undefined;
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
      this.pending.delete(outcome.commandId);
      if (outcome.outcome === RUNNER_PROMPT_OUTCOME.delivered) {
        this.delivered(prompt);
      } else {
        this.refused(prompt, REFUSAL[outcome.outcome]);
      }
    }
  }

  /** Gives up on every prompt whose runner has not answered in time. */
  public expire(): void {
    const cutoff = this.options.now() - (this.options.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS);
    for (const [id, prompt] of this.pending) {
      if (prompt.sentAt <= cutoff) {
        this.pending.delete(id);
        this.options.runner?.withdraw(prompt.runnerId, id);
        this.refused(prompt, AGENT_PROMPT_REJECTION.unanswered);
      }
    }
  }

  private delivered(prompt: Pending): void {
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
    this.options.log?.("agent-prompt-not-typed", { agent: prompt.agentId, by: prompt.senderName, why: rejection });
    this.options.refuse(prompt.senderId, { agentId: prompt.agentId, rejection });
  }
}
