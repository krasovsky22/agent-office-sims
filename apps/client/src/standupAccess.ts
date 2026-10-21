/**
 * What the local player may do about the standup, and how the standup reads,
 * in words the HUD can show.
 *
 * The decision is not made here: `mayRunStandup` in `@sim/shared` is the rule
 * the server enforces, and this module only asks it about the local player, so
 * the HUD's standup controls are enabled exactly when the server would take
 * them, and everyone else is told why. Like `managerAccess.ts` for the
 * manager's composer.
 */

import {
  CLIENT_MESSAGE,
  type OfficeActor,
  STANDUP_DIRECTION_STATUS,
  STANDUP_REJECTION,
  type StandupData,
  type StandupDirectionData,
  type StandupRejectedEvent,
  mayRunStandup,
} from "@sim/shared";

/** The local player's standing at the standup. */
export interface StandupAccess {
  /** Whether the HUD offers calling, ending and directing that the server will take. */
  readonly mayRun: boolean;
  /** One sentence on what this player may do, and why. */
  readonly summary: string;
}

/**
 * The local player's access.
 *
 * @param ceoName `undefined` while the roster has not shown who holds the role.
 */
export function standupAccessFor(actor: OfficeActor, ceoName: string | undefined): StandupAccess {
  if (mayRunStandup(actor)) {
    return {
      mayRun: true,
      summary: "You are the CEO: answer blockers and give directions, then end the standup when you are done.",
    };
  }
  const who = ceoName === undefined ? "the CEO" : `the CEO, ${ceoName},`;
  return {
    mayRun: false,
    summary: `Only ${who} can call a standup, end it or give directions at it. You can follow along.`,
  };
}

/** What to tell the player when the office does not take their standup command. */
export function standupRejectionText(event: StandupRejectedEvent): string {
  switch (event.rejection) {
    case STANDUP_REJECTION.forbidden:
      return event.command === CLIENT_MESSAGE.standupDirect
        ? "Only the CEO can give directions at a standup."
        : "Only the CEO can call or end a standup.";
    case STANDUP_REJECTION.running:
      return "A standup is already on.";
    case STANDUP_REJECTION.notRunning:
      return event.command === CLIENT_MESSAGE.standupDirect ? "The standup is over, so that direction was not given." : "There is no standup on.";
    case STANDUP_REJECTION.noAgents:
      return "There are no agents on the floor to gather for a standup.";
    case STANDUP_REJECTION.noAgent:
      return "That agent is not at the standup any more.";
  }
}

/** How a direction's fate reads on its record. */
export function directionStatusText(direction: StandupDirectionData): string {
  switch (direction.status) {
    case STANDUP_DIRECTION_STATUS.sending:
      return "sending…";
    case STANDUP_DIRECTION_STATUS.typed:
      return "typed into its terminal";
    case STANDUP_DIRECTION_STATUS.queued:
      return "kept for when it is next at its prompt, after the standup";
    case STANDUP_DIRECTION_STATUS.delivered:
      return "typed after the standup";
    case STANDUP_DIRECTION_STATUS.noted:
      return "noted; this agent takes no prompts from the office";
    case STANDUP_DIRECTION_STATUS.failed:
      return direction.reason === "" ? "not typed" : `not typed: ${direction.reason}`;
    case STANDUP_DIRECTION_STATUS.answering:
      return "no session to type it into, so it is answering…";
    case STANDUP_DIRECTION_STATUS.answered:
      return "answered";
    case STANDUP_DIRECTION_STATUS.unanswered:
      return direction.reason === "" ? "could not answer" : `could not answer: ${direction.reason}`;
    default:
      return direction.status;
  }
}

/** What the standup is doing right now, in a few words for its header. */
export function standupPhaseText(standup: StandupData, nameOf: (id: string) => string | undefined): string {
  if (!standup.active) {
    return "Over";
  }
  if (standup.speakerId !== "") {
    return `${nameOf(standup.speakerId) ?? "An agent"} is giving an update`;
  }
  return standup.updates.length === 0 ? "Gathering in the conference room…" : "Updates done";
}
