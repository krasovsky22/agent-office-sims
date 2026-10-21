/**
 * The CEO's words to one of the runners' coding agents, passed on by the AI
 * Manager: a task in a sentence ("tell Maya to add a test for the empty
 * case"), or a question ("ask Marcus what is blocking it").
 *
 * It travels as a standup's direction does (`../agents/agentPrompts.ts`), so
 * the runner decides what comes of it: typed into the agent's session if it
 * waits at its prompt, kept and typed the next time it does if it is busy, or,
 * for an agent with no session, answered in a short read-only run that starts
 * no work. What came of it is posted to the manager's conversation as an
 * update when the runner says.
 *
 * Words for an agent steer a process that runs commands on the runner's host,
 * so they are held to two rules here, whatever a planner wrote: only the CEO's
 * own words are passed on, never an issue's or a pull request's title a model
 * read and took for an order; and only to a runner's coding agent.
 */

import { type OfficeState, type Occupant, isLiveAgent } from "@sim/shared";

import type { AgentPrompts, DirectionOutcome } from "../agents/agentPrompts.js";
import { slotOf } from "../agents/runnerWork.js";
import { directionContext, failureReason } from "../sim/standup.js";
import type { PlannedMessage } from "./advisor.js";
import { fromCeo } from "./hire.js";
import type { OfficeView } from "./officeView.js";
import { resolveAgent } from "./resolve.js";

/** Most messages one plan may pass on, so a runaway model cannot flood every agent. */
const MAX_MESSAGES_PER_PLAN = 4;

export interface AgentMessagesOptions {
  readonly state: OfficeState;
  /** Absent with no runner. */
  readonly prompts: Pick<AgentPrompts, "submitDirection"> | undefined;
  /** Posts to the manager's conversation. */
  readonly report: (text: string) => void;
}

export class AgentMessages {
  /** Each message on its way, by its prompt command's id: the agent's name. */
  private readonly sent = new Map<string, string>();

  public constructor(private readonly options: AgentMessagesOptions) {}

  /**
   * Passes `text` on to the agent for the CEO.
   *
   * @returns a line for the manager's reply saying it is on its way, or why not.
   */
  public send(ceo: Occupant, agentId: string, agentName: string, text: string): string {
    const { prompts, state } = this.options;
    if (prompts === undefined) {
      return `✗ No agent runner is connected, so I can't pass anything to ${agentName}.`;
    }
    const agent = state.occupants.get(agentId);
    const context = agent !== undefined && isLiveAgent(agent) ? directionContext(agent, state.work.values(), state.standing.values()) : "";
    const sent = prompts.submitDirection(ceo.id, agentId, text, context);
    if (typeof sent === "string") {
      return `✗ I couldn't pass that to ${agentName}: ${failureReason(sent)}.`;
    }
    this.sent.set(sent.commandId, agentName);
    return `✓ Passing your words to ${agentName}; I'll say here what comes of it.`;
  }

  /** Posts what came of a message, by its prompt command's id; ignores any other command's. */
  public settle(commandId: string, outcome: DirectionOutcome): void {
    const name = this.sent.get(commandId);
    if (name === undefined) {
      return;
    }
    const { report } = this.options;
    switch (outcome.kind) {
      case "queued":
        report(`${name} is busy, so your message waits until it is next at its prompt.`);
        return;
      case "answering":
        return;
      case "typed":
        this.sent.delete(commandId);
        report(`${name} has your message in its session.`);
        return;
      case "answered":
        this.sent.delete(commandId);
        report(`${name} (nothing in hand, so it answered and started no work): ${outcome.reply}`);
        return;
      case "unanswered":
        this.sent.delete(commandId);
        report(`✗ ${name} couldn't answer your message${outcome.why === "" ? "" : `: ${outcome.why}`}.`);
        return;
      case "failed":
        this.sent.delete(commandId);
        report(`✗ Your message never reached ${name}: ${failureReason(outcome.rejection)}.`);
    }
  }
}

export interface MessageContext {
  /** The CEO's message the plan answers. */
  readonly message: string;
  readonly view: OfficeView;
  /** Passes the words on; absent with no runner. */
  readonly send: ((agentId: string, agentName: string, text: string) => string) | undefined;
}

/**
 * Passes each planned message on, in order.
 *
 * @returns one line per message saying what happened, for the reply.
 */
export function carryOutMessages(messages: readonly PlannedMessage[], context: MessageContext): string[] {
  const { send } = context;
  if (send === undefined) {
    return messages.length === 0 ? [] : ["✗ No agent runner is configured, so there is nobody to pass that to."];
  }
  const lines = messages.slice(0, MAX_MESSAGES_PER_PLAN).map((planned) => {
    const agent = resolveAgent(planned.agent, context.view);
    if (agent === undefined) {
      return `✗ I can't find an agent called “${planned.agent}”.`;
    }
    if (slotOf(agent.id) === undefined) {
      return `✗ ${agent.name} works through its orchestrator, so I can only hand it issues and pull requests, not pass it words.`;
    }
    if (!fromCeo(planned.text, context.message)) {
      return `✗ I only pass your own words on to ${agent.name}, so I didn't send that.`;
    }
    return send(agent.id, agent.name, planned.text.trim());
  });
  if (messages.length > MAX_MESSAGES_PER_PLAN) {
    lines.push(`I stopped after ${MAX_MESSAGES_PER_PLAN} messages; ask again for the rest.`);
  }
  return lines;
}
