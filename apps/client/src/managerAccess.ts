/**
 * What the local player may say to the AI manager, in words the HUD can show.
 *
 * The decision is not made here: `mayInstructManager` in `@sim/shared` is the
 * rule the server enforces, and this module only asks it about the local
 * player, so the composer is disabled exactly when the server would refuse the
 * message, and says why. Like `boardAccess.ts` for the project board's work.
 */

import {
  MANAGER_NAME,
  MANAGER_REJECTION,
  type ManagerRejection,
  type OfficeActor,
  mayInstructManager,
} from "@sim/shared";

/** The local player's standing with the manager. */
export interface ManagerAccess {
  /** Whether the panel offers a composer that the server will listen to. */
  readonly mayInstruct: boolean;
  /** One sentence on what this player may do, and why, for the panel. */
  readonly summary: string;
}

/**
 * The local player's access, from their actor and the CEO's name.
 *
 * @param ceoName `undefined` while the roster has not shown who holds the role.
 */
export function managerAccessFor(actor: OfficeActor, ceoName: string | undefined): ManagerAccess {
  if (mayInstructManager(actor)) {
    return {
      mayInstruct: true,
      summary: `You are the CEO: ask the ${MANAGER_NAME} for status, or tell it who should take what.`,
    };
  }
  const who = ceoName === undefined ? "the CEO" : `the CEO, ${ceoName},`;
  return {
    mayInstruct: false,
    summary: `Only ${who} can instruct the ${MANAGER_NAME}. You can read the conversation.`,
  };
}

const REJECTION_TEXT: Readonly<Record<ManagerRejection, string>> = {
  [MANAGER_REJECTION.forbidden]: `Only the CEO can instruct the ${MANAGER_NAME}.`,
  [MANAGER_REJECTION.busy]: `The ${MANAGER_NAME} is still working through your last few messages — try again in a moment.`,
};

/** What to tell the player when the manager does not take their message. */
export function managerRejectionText(rejection: ManagerRejection): string {
  return REJECTION_TEXT[rejection];
}
