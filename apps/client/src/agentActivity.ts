/**
 * How each agent activity looks.
 *
 * Presentation, so it lives on the client, as the emote table does. The badge
 * above an agent's head and the chip beside its name in the roster read this
 * one table, so an agent cannot be "working" on the floor and "stuck" in the
 * HUD.
 *
 * Colour carries the activity from across the room, and the label carries it
 * for anyone who cannot tell the colours apart: every badge spells its state
 * out. There is no glyph, for the reason `emotes.ts` gives about emoji.
 */

import { AGENT_ACTIVITY, type AgentActivity } from "@sim/shared";

export interface AgentActivityAppearance {
  readonly label: string;
  /** CSS colour of the badge's dot and the roster chip. */
  readonly colour: string;
}

export const AGENT_ACTIVITY_APPEARANCE: Readonly<Record<AgentActivity, AgentActivityAppearance>> =
  {
    [AGENT_ACTIVITY.idle]: { label: "Idle", colour: "#a7adb8" },
    [AGENT_ACTIVITY.walking]: { label: "Walking", colour: "#6fa8ff" },
    [AGENT_ACTIVITY.working]: { label: "Working", colour: "#5fd38d" },
    [AGENT_ACTIVITY.meeting]: { label: "In a meeting", colour: "#b994ff" },
    [AGENT_ACTIVITY.blocked]: { label: "Blocked", colour: "#ff7a66" },
  };
