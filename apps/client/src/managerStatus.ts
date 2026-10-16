/**
 * How the AI manager's status looks on its badge and in the roster.
 *
 * Presentation, so it lives on the client, as the emote table does. The badge
 * above the manager's head and the chip beside its name in the roster read
 * this one table, so it cannot be "thinking" on the floor and "ready" in the
 * HUD.
 *
 * Colour carries the status from across the room, and the label carries it
 * for anyone who cannot tell the colours apart: every badge spells its state
 * out. There is no glyph, for the reason `emotes.ts` gives about emoji.
 */

import { MANAGER_STATUS, type ManagerStatus } from "@sim/shared";

export interface BadgeAppearance {
  readonly label: string;
  /** CSS colour of the badge's dot and the roster chip. */
  readonly colour: string;
}

export const MANAGER_STATUS_APPEARANCE: Readonly<Record<ManagerStatus, BadgeAppearance>> = {
  [MANAGER_STATUS.idle]: { label: "Ready", colour: "#ff8a96" },
  [MANAGER_STATUS.thinking]: { label: "Thinking…", colour: "#ffd166" },
};
