/**
 * What the project board shows of a brainstorm ticket, and which of its
 * controls are open to the local player, in words the panel can show.
 *
 * The decisions are `@sim/shared`'s `brainstorm.ts`, the rules the server
 * enforces; this asks them the same questions with what the local player can
 * see, so a button is disabled, and says why, exactly when the server would
 * refuse it. Kept apart from the panel so it is plain functions a test can
 * call.
 */

import {
  BRAINSTORM_ACTION,
  BRAINSTORM_GITHUB,
  BRAINSTORM_ROLE,
  BRAINSTORM_STATUS,
  BRAINSTORM_TAKE_STATUS,
  type BoardIssue,
  type BrainstormAction,
  type BrainstormData,
  type BrainstormDraft,
  type BrainstormMode,
  type BrainstormTakeData,
  OCCUPANT_KIND,
  type WorkData,
  brainstormActionRefusal,
  brainstormAssignRefusal,
  brainstormHeld,
  brainstormRejectionText,
  brainstormStatusText,
} from "@sim/shared";

import type { BoardAccess } from "./boardAccess.js";
import { type BoardAgent, type BoardTone, assignOption } from "./projectBoard.js";

/** What the brainstorm controls send; the replicated idea is the reply. */
export interface BrainstormBoardActions {
  readonly assign: (issueNumber: number, agentIds: readonly string[], mode: BrainstormMode) => void;
  readonly meet: (issueNumber: number) => void;
  readonly review: (issueNumber: number) => void;
  readonly convert: (issueNumber: number, drafts: readonly BrainstormDraft[]) => void;
}

/** One agent the assign form offers. */
export interface BrainstormChoice {
  readonly agent: BoardAgent;
  readonly label: string;
  /** It has an issue or another idea in hand, so it is shown but not offered. */
  readonly busy: boolean;
}

/** Every agent that takes issues, each said busy when it has an issue or an idea in hand. */
export function brainstormChoices(
  agents: readonly BoardAgent[],
  work: readonly WorkData[],
  brainstorms: readonly BrainstormData[],
): BrainstormChoice[] {
  return agents.map((agent) => {
    const option = assignOption(agent, work);
    if (option.busy) {
      return { agent, ...option };
    }
    const idea = brainstormHeld(agent.id, brainstorms);
    return idea === undefined ? { agent, ...option } : { agent, label: `${option.label} — on idea #${idea}`, busy: true };
  });
}

/** What the board needs to know of the issue and the office to judge an assignment. */
export interface BrainstormAssignView {
  readonly issue: Pick<BoardIssue, "labels"> | undefined;
  readonly restrictLabel: string;
  readonly existing: BrainstormData | undefined;
  readonly hasWork: boolean;
}

/** Why the assign button is disabled, in the panel's words; `undefined` when the server would take it. */
export function brainstormAssignBlock(
  access: BoardAccess,
  view: BrainstormAssignView,
  picked: readonly string[],
  choices: readonly BrainstormChoice[],
): string | undefined {
  const refused = brainstormAssignRefusal({
    actor: access.actor,
    issue: view.issue,
    restrictLabel: view.restrictLabel,
    existing: view.existing,
    hasWork: view.hasWork,
    agents: picked.map((id) => {
      const choice = choices.find((each) => each.agent.id === id);
      return choice === undefined ? undefined : { kind: OCCUPANT_KIND.liveAgent, canTakeIssues: true, busy: choice.busy };
    }),
  });
  return refused === undefined ? undefined : brainstormRejectionText(refused);
}

/** What the board needs to know of the office to judge a meeting, a review or a conversion. */
export interface BrainstormActionView {
  readonly standupActive: boolean;
  /** Every idea in the office, for another one's meeting. */
  readonly brainstorms: readonly BrainstormData[];
  readonly choices: readonly BrainstormChoice[];
}

/** How many of an idea's agents are free on the floor to meet, as the board can see. */
export function freeMeetingAgents(brainstorm: BrainstormData, choices: readonly BrainstormChoice[]): number {
  return brainstorm.takes.filter((take) => choices.some((choice) => choice.agent.id === take.agentId && !choice.busy)).length;
}

/** Why a meeting, review or conversion button is disabled, in the panel's words; `undefined` when the server would take it. */
export function brainstormActionBlock(
  action: BrainstormAction,
  access: BoardAccess,
  brainstorm: BrainstormData,
  view: BrainstormActionView,
): string | undefined {
  if (action === BRAINSTORM_ACTION.convert && brainstorm.convertStatus === BRAINSTORM_GITHUB.sending) {
    return "The issues are being created.";
  }
  const refused = brainstormActionRefusal(action, access.actor, brainstorm, {
    roomTaken: view.standupActive || view.brainstorms.some((each) => each.status === BRAINSTORM_STATUS.meeting),
    freeAgents: freeMeetingAgents(brainstorm, view.choices),
    writable: access.issuesWritable,
  });
  return refused === undefined ? undefined : brainstormRejectionText(refused);
}

/** The line an idea's card carries: that it is one, and how far the office has got with it. */
export function brainstormBadge(brainstorm: BrainstormData | undefined): { text: string; tone: BoardTone } {
  if (brainstorm === undefined) {
    return { text: "Idea · not handed out yet", tone: "plain" };
  }
  const tone: BoardTone =
    brainstorm.status === BRAINSTORM_STATUS.failed
      ? "bad"
      : brainstorm.status === BRAINSTORM_STATUS.converted || brainstorm.status === BRAINSTORM_STATUS.reviewed
        ? "good"
        : "pending";
  return { text: `Idea · ${brainstormStatusText(brainstorm)}`, tone };
}

const ROLE_NAMES: Readonly<Record<string, string>> = {
  [BRAINSTORM_ROLE.take]: "own take",
  [BRAINSTORM_ROLE.researcher]: "researcher",
  [BRAINSTORM_ROLE.critic]: "critic",
};

/** One agent's write-up in a line: who, in what role, and how it stands or what it judged. */
export function takeLine(take: BrainstormTakeData): string {
  const who = `${take.agentName} · ${ROLE_NAMES[take.role] ?? take.role}`;
  switch (take.status) {
    case BRAINSTORM_TAKE_STATUS.waiting:
      return `${who} · waiting for the researcher's write-up`;
    case BRAINSTORM_TAKE_STATUS.working:
      return `${who} · researching…`;
    case BRAINSTORM_TAKE_STATUS.failed:
      return `${who} · no write-up: ${take.note || "it did not finish"}`;
    default:
      return take.verdict === "" ? `${who} · no verdict given` : `${who} · ${take.verdict}`;
  }
}

/** Where the design document stands on GitHub, in a line; `undefined` before there is one to post. */
export function postLine(brainstorm: BrainstormData): string | undefined {
  switch (brainstorm.postStatus) {
    case BRAINSTORM_GITHUB.sending:
      return "Posting it on the issue…";
    case BRAINSTORM_GITHUB.done:
      return "Posted on the issue.";
    case BRAINSTORM_GITHUB.failed:
      return "Not on the issue: see the note above.";
    default:
      return undefined;
  }
}
