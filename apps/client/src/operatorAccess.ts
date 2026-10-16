/**
 * What the local player may tell the real coding agents to do, in words the
 * HUD can show.
 *
 * The decision is not made here: `mayCommandRealAgents` in `@sim/shared` is
 * the rule the server enforces wherever an operator passphrase is configured,
 * and this module only asks it about the local player, so the manager's panel
 * says why work for a live agent would be refused before the server refuses
 * it, and offers the passphrase only to someone it would change things for.
 * Like `managerAccess.ts` for the manager's composer.
 */

import { MANAGER_NAME, OPERATOR_REJECTION, type OfficeActor, type OperatorRejection, mayCommandRealAgents } from "@sim/shared";

/** The local player's standing with the real coding agents. */
export interface OperatorAccess {
  /** Whether Firstmate will send work to a live agent on this player's word. */
  readonly mayCommand: boolean;
  /** Whether the panel offers the passphrase form. */
  readonly mayVerify: boolean;
  /** One sentence on what this player may do, and why, for the panel. */
  readonly summary: string;
}

/**
 * The local player's access, or `undefined` in an office with no operator
 * passphrase, where the CEO commands the real agents as they do everything
 * else and there is nothing more to say.
 */
export function operatorAccessFor(actor: OfficeActor, operatorRequired: boolean): OperatorAccess | undefined {
  if (!operatorRequired) {
    return undefined;
  }
  if (mayCommandRealAgents(actor)) {
    return {
      mayCommand: true,
      mayVerify: false,
      summary: `You are the verified operator: ${MANAGER_NAME} sends work to the live coding agents on your word.`,
    };
  }
  return {
    mayCommand: false,
    mayVerify: true,
    summary: actor.isCeo
      ? `Sending work to the live coding agents takes a verified operator. Enter the operator passphrase to verify.`
      : actor.isOperator
        ? `Another operator has taken the CEO role. Verify again to take it back and command the live coding agents.`
        : `Only a verified operator can send work to the live coding agents. Verifying makes you the CEO.`,
  };
}

const REJECTION_TEXT: Readonly<Record<OperatorRejection, string>> = {
  [OPERATOR_REJECTION.wrong]: "That is not the operator passphrase.",
  [OPERATOR_REJECTION.throttled]: "Too many tries at the operator passphrase — wait a few minutes.",
  [OPERATOR_REJECTION.locked]: "Too many wrong operator passphrases on this server — wait a few minutes.",
  [OPERATOR_REJECTION.unavailable]: "This office has no operator passphrase to verify.",
};

/** What to tell the player when the office turns down their passphrase. */
export function operatorRejectionText(rejection: OperatorRejection): string {
  return REJECTION_TEXT[rejection];
}
