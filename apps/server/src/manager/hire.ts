/**
 * Hiring a new coding agent for a task, as the CEO asked the AI Manager to.
 *
 * A hired agent is a runner's slot like any other, not a body of the office's
 * own: the manager writes it a profile for the task, the runner link has a
 * runner add a slot with it (`../agents/runnerLink.ts`), and once the new
 * agent is on the floor the task is given to it through the work's rules, with
 * the CEO who asked as the actor, exactly as an assignment is (`./assign.ts`).
 * From then on the board, a cancel, a firing and a restart treat it as they
 * treat every other slot.
 *
 * The office holds at most `MAX_CODING_AGENTS` coding agents, on the floor or
 * hired and on their way; past that the manager says the office is full and
 * suggests firing one or giving the task to one already there.
 *
 * Both halves are synchronous: {@link carryOutHires} as the manager carries a
 * plan out, and {@link HireDesk.settle} on the manager's own timer, which
 * hands each new agent its task once it has walked in, or gives up on one
 * that never came.
 */

import {
  type AgentProfile,
  DEFAULT_AGENT_NAMES,
  type Occupant,
  WORK_ACTION,
  WORK_STATUS,
  actorOf,
  isAgentRestricted,
  isIssueAssignee,
  isLiveAgent,
  liveAgentKey,
  mayInstructManager,
  openBoardIssue,
  parseAgentProfile,
  sanitizeAgentDescription,
  workKey,
} from "@sim/shared";

import { type RunnerHire, runnerSlotAgentId } from "../agents/runnerLink.js";
import { type WorkHost, applyAs } from "../rooms/workHandlers.js";
import type { PlannedHire } from "./advisor.js";
import { REFUSAL_TEXT } from "./assign.js";
import type { OfficeView } from "./officeView.js";
import { describeWork, resolveWork } from "./resolve.js";

/** How long a hired agent has to reach the floor before the manager gives up on it. */
export const HIRE_ARRIVAL_MS = 60_000;

/** Where the manager hires agents: the runner link, with the office's cap. */
export interface AgentHiring {
  /** Most coding agents the office holds, on the floor or on their way. */
  readonly cap: number;
  /** The coding agents now, on the floor or hired and on their way. */
  count(): number;
  /** Queues the hire; where the agent will be, or `undefined` when no runner can take one. */
  hire(profile: AgentProfile, requestedBy: string): RunnerHire | undefined;
  /** Gives up on a hire whose agent never came: the command taken back if it is still waiting, and the slot forgotten. */
  withdraw(hire: RunnerHire): void;
}

/**
 * Whether a room option is the hiring desk the server handed over, rather
 * than whatever a client put in its join options under the same name.
 */
export function isAgentHiring(value: unknown): value is AgentHiring {
  const candidate = value as Partial<Record<keyof AgentHiring, unknown>> | null;
  return (
    typeof value === "object" &&
    candidate !== null &&
    typeof candidate.cap === "number" &&
    typeof candidate.count === "function" &&
    typeof candidate.hire === "function" &&
    typeof candidate.withdraw === "function"
  );
}

/** What a new agent's title is unless the CEO named one: what it was hired for. */
export function hireTitle(issueNumber: number): string {
  return `Specialist for #${issueNumber}`;
}

/**
 * What a new agent's description is unless the CEO wrote it: the issue by its
 * number alone, since its title and body are anyone's words and the
 * description is the agent's system prompt.
 */
export function hireDescription(issueNumber: number): string {
  return sanitizeAgentDescription(
    `Hired for issue #${issueNumber}: implements and tests that change, and opens a pull request for a person to review.`,
  );
}

/** Whether the plan's title or description is the CEO's own words, copied from their message. */
function fromCeo(description: string, message: string): boolean {
  const words = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
  return words(description) !== "" && words(message).includes(words(description));
}

export interface HireContext {
  readonly work: WorkHost;
  /** The CEO the manager is acting for, as the room holds them now. */
  readonly ceo: Occupant;
  /** The CEO's message the plan answers, the only place a description may come from. */
  readonly message: string;
  readonly view: OfficeView;
  /** Absent when no runner is connected to the server. */
  readonly hiring: AgentHiring | undefined;
}

/** A hire on its way, waiting for its agent to walk in and be given its task. */
interface PendingHire {
  readonly hire: RunnerHire;
  /** The new agent's occupant key. */
  readonly key: string;
  readonly name: string;
  readonly issueNumber: number;
  readonly label: string;
  readonly ceoId: string;
  /** Epoch ms after which it is given up on. */
  readonly deadline: number;
}

/** The hires on their way, and what came of them. */
export class HireDesk {
  private readonly pending: PendingHire[] = [];

  /**
   * Makes each hire, in order: the issue checked, the cap, the profile written,
   * and the agent asked for.
   *
   * @returns one line per hire saying what happened, for the reply.
   */
  public carryOut(hires: readonly PlannedHire[], context: HireContext): string[] {
    const named = new Set<string>();
    return hires.map((hire) => this.carryOutOne(hire, context, named));
  }

  private carryOutOne(planned: PlannedHire, context: HireContext, named: Set<string>): string {
    const work = resolveWork(planned.work, context.view);
    if (work === undefined) {
      return `✗ ${planned.work}: I can't find that on the project board, so I hired nobody for it.`;
    }
    const label = describeWork(work);
    if (work.kind === "pull") {
      return `✗ ${label}: a new agent is hired for an issue, not a pull request.`;
    }
    const { issue } = work;
    const { state } = context.work;
    if (issue.column === "closed") {
      return `✗ ${label}: it is closed, so there is nothing to hire anyone for.`;
    }
    const onBoard = openBoardIssue(context.work.board(), issue.number);
    if (onBoard !== undefined && isAgentRestricted(onBoard, state.agentRestrictLabel)) {
      return `✗ ${label}: ${REFUSAL_TEXT.restricted}, so I hired nobody for it.`;
    }
    const held = state.work.get(workKey(issue.number));
    const holder = held === undefined || held.status === WORK_STATUS.done ? undefined : state.occupants.get(held.assigneeId);
    if (holder !== undefined) {
      return `✗ ${label}: it is already ${holder.name}'s; say “put someone on #${issue.number}” to move it instead.`;
    }
    const { hiring } = context;
    if (hiring === undefined) {
      return `✗ ${label}: no agent runner is connected, so I can't hire anyone.`;
    }
    // Counts the hires on their way too, this plan's included, so a burst cannot overfill the office.
    const count = hiring.count();
    if (count >= hiring.cap) {
      return fullOffice(label, issue.number, count, hiring.cap, context.view);
    }
    const profile = parseAgentProfile({
      name: freeName(planned.name, state.occupants.values(), named),
      title: fromCeo(planned.title, context.message) ? planned.title : hireTitle(issue.number),
      description: fromCeo(planned.description, context.message) ? planned.description : hireDescription(issue.number),
    });
    if (profile === undefined) {
      return `✗ ${label}: I couldn't write a profile for a new agent.`;
    }
    const hire = hiring.hire(profile, context.ceo.name);
    if (hire === undefined) {
      return `✗ ${label}: no runner could take a new agent just now; try again shortly.`;
    }
    named.add(profile.name.toLowerCase());
    this.pending.push({
      hire,
      key: liveAgentKey(runnerSlotAgentId(hire.runnerId, hire.slotId)),
      name: profile.name,
      issueNumber: issue.number,
      label,
      ceoId: context.ceo.id,
      deadline: context.work.now() + HIRE_ARRIVAL_MS,
    });
    return `✓ Hired ${profile.name}, ${profile.title}, for ${label}; on the way in.`;
  }

  /**
   * Gives each hired agent that has walked in its task, as the CEO who hired
   * it, and gives up on one that has not come in time.
   *
   * @returns a line for each hire settled, for the manager to post.
   */
  public settle(work: WorkHost, hiring: AgentHiring | undefined): string[] {
    const lines: string[] = [];
    for (const hire of [...this.pending]) {
      const agent = work.state.occupants.get(hire.key);
      const arrived = agent !== undefined && isLiveAgent(agent) && isIssueAssignee(actorOf(agent));
      if (!arrived && work.now() < hire.deadline) {
        continue;
      }
      this.pending.splice(this.pending.indexOf(hire), 1);
      if (!arrived) {
        hiring?.withdraw(hire.hire);
        lines.push(`✗ ${hire.name} never arrived for ${hire.label}: the runner did not take them on. Ask me again?`);
        continue;
      }
      const ceo = work.state.occupants.get(hire.ceoId);
      if (ceo === undefined || !mayInstructManager(actorOf(ceo))) {
        lines.push(`${hire.name} is here, but whoever hired them is no longer the CEO, so ${hire.label} is not theirs yet.`);
        continue;
      }
      const result = applyAs(work, actorOf(ceo), {
        action: WORK_ACTION.assign,
        payload: { issueNumber: hire.issueNumber, assigneeId: hire.key },
      });
      lines.push(
        result.ok
          ? `${hire.name} is here and on ${hire.label}.`
          : `✗ ${hire.name} is here, but I couldn't give them ${hire.label}: ${REFUSAL_TEXT[result.rejection]}.`,
      );
    }
    return lines;
  }
}

/** The manager's answer when the office has no room for another agent. */
function fullOffice(label: string, issueNumber: number, count: number, cap: number, view: OfficeView): string {
  const free = view.issueAgents.find((agent) => agent.issue === undefined);
  const reuse = free === undefined ? `put one of them on #${issueNumber}` : `“put ${free.name} on #${issueNumber}”`;
  return `✗ ${label}: the office is full, with ${count} of ${cap} coding agents, so I can't hire another. Fire one (face it and hold E) or ${reuse} instead.`;
}

/** The planner's name for a new agent if nobody here has it, else the first default name nobody has. */
function freeName(planned: string, occupants: Iterable<Occupant>, named: ReadonlySet<string>): string {
  const taken = new Set(named);
  for (const occupant of occupants) {
    taken.add(occupant.name.toLowerCase());
  }
  const name = planned.trim();
  if (name !== "" && !taken.has(name.toLowerCase())) {
    return name;
  }
  return DEFAULT_AGENT_NAMES.find((candidate) => !taken.has(candidate.toLowerCase())) ?? DEFAULT_AGENT_NAMES[0];
}
