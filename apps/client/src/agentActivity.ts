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
 *
 * An agent employee is simulated: it does no real work, whatever its badge
 * says. The nameplate and the roster both say so with {@link SIMULATED_LABEL},
 * keyed on {@link isSimulated} rather than on being an agent, so no one
 * mistakes one for a live coding agent and a live one is never tagged.
 */

import { AGENT_ACTIVITY, type AgentActivity, OCCUPANT_KIND, type OccupantKind } from "@sim/shared";

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

/** The tag every simulated agent employee carries on its nameplate and roster line. */
export const SIMULATED_LABEL = "Simulated";

/** Whether an occupant of this kind is a simulated employee, doing no real work. */
export function isSimulated(kind: OccupantKind): boolean {
  return kind === OCCUPANT_KIND.agent;
}
