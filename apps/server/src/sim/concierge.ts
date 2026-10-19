/**
 * The concierge at reception, welcoming whoever walks into the lobby.
 *
 * Scripted, not an agent: it reads where the players are on the room's tick
 * and, the moment one steps into the lobby, turns to them, waves and says one
 * line through the chat everyone already reads. Nothing about it is new to
 * the protocol — the wave is an emote broadcast and the line a chat broadcast
 * from the concierge's occupant, and its turn is its replicated yaw — so every
 * tab sees the same welcome from the same body.
 *
 * Entering is a change of room, read off the shared floor plan, not a distance
 * from the desk: whether a player comes in off the street or through the
 * office door, or arrives in the lobby at all, crossing into it is what counts.
 * A doorway belongs to neither room, so standing in one changes nothing, and a
 * player stepping in and out of the lobby is welcomed once per
 * {@link WELCOME_COOLDOWN_MS}, not on every step.
 *
 * Synchronous and checked against the room clock, like a cup's sips, so the
 * tick never waits on it.
 */

import {
  type OfficeLayout,
  type Occupant,
  type SpawnSpec,
  conciergeWelcome,
  isHumanPlayer,
  isInLobby,
  normalizeYaw,
} from "@sim/shared";

/** How long the concierge keeps facing someone it welcomed before turning back to the door. */
export const WELCOME_GAZE_MS = 4_000;

/**
 * Shortest time between two welcomes for the same player.
 *
 * Long enough that dithering on the lobby's threshold is not a stream of
 * greetings; short enough that a player who went out and comes back in is
 * greeted again.
 */
export const WELCOME_COOLDOWN_MS = 20_000;

export interface ConciergeHost {
  readonly layout: OfficeLayout;
  readonly occupants: {
    values(): Iterable<Occupant>;
  };
  /** Broadcasts a line of chat from an occupant. */
  say(occupantId: string, text: string): void;
  /** Broadcasts a wave from an occupant. */
  wave(occupantId: string): void;
}

export class ConciergeDesk {
  /** Whether each player was last seen in the lobby, by occupant id. */
  private readonly inLobby = new Map<string, boolean>();
  /** Room clock time each player was last welcomed, by occupant id. */
  private readonly welcomedAt = new Map<string, number>();
  /** Room clock time the concierge turns back to the door, or `undefined` while it faces it. */
  private turnBackAt: number | undefined;

  public constructor(
    private readonly host: ConciergeHost,
    private readonly concierge: Occupant,
    private readonly post: SpawnSpec,
  ) {}

  /** Welcomes every player who has stepped into the lobby since the last step. */
  public step(now: number): void {
    const present = new Set<string>();
    for (const occupant of this.host.occupants.values()) {
      if (!isHumanPlayer(occupant)) {
        continue;
      }
      present.add(occupant.id);
      const inside = isInLobby(this.host.layout, occupant);
      if (inside === undefined) {
        continue;
      }
      // Someone not seen before counts as arriving from outside, so a player
      // who joins already standing in the lobby is welcomed too.
      const wasInside = this.inLobby.get(occupant.id) ?? false;
      this.inLobby.set(occupant.id, inside);
      if (inside && !wasInside) {
        this.welcome(occupant, now);
      }
    }
    for (const id of this.inLobby.keys()) {
      if (!present.has(id)) {
        this.inLobby.delete(id);
        this.welcomedAt.delete(id);
      }
    }

    if (this.turnBackAt !== undefined && now >= this.turnBackAt) {
      this.turnBackAt = undefined;
      this.concierge.yaw = this.post.yaw;
    }
  }

  private welcome(player: Occupant, now: number): void {
    const last = this.welcomedAt.get(player.id);
    if (last !== undefined && now - last < WELCOME_COOLDOWN_MS) {
      return;
    }
    this.welcomedAt.set(player.id, now);
    // Yaw 0 faces -Z, so the yaw that faces a point is the angle of the
    // reversed offset to it.
    this.concierge.yaw = normalizeYaw(
      Math.atan2(-(player.x - this.concierge.x), -(player.z - this.concierge.z)),
    );
    this.turnBackAt = now + WELCOME_GAZE_MS;
    this.host.wave(this.concierge.id);
    this.host.say(this.concierge.id, conciergeWelcome(player.name));
  }
}
