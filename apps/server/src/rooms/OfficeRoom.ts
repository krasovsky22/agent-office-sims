/**
 * The shared office.
 *
 * One room holds everyone on the floor. It owns four things: who is in the
 * office, where the authoritative version of each of them is, which of them is
 * the CEO, and which of them is sitting at or standing over something.
 *
 * Interactions are server-decided, not client-reported. A client may ask to use
 * an interactable; it may not say that it is in reach of one, that the chair is
 * free, or that it is now seated. Each of those is re-derived here from the
 * shared layout and the pose this room has accepted, because each of them is a
 * check a modified client would simply leave out.
 */

import { type Client, Room } from "@colyseus/core";
import {
  ANIMATION_STATE,
  CLIENT_MESSAGE,
  HumanPlayer,
  INTERACT_RANGE,
  INTERACT_RANGE_TOLERANCE,
  type InteractableSpec,
  OCCUPANT_KIND,
  OFFICE_LAYOUT,
  type Occupant,
  OfficeState,
  TICK_INTERVAL_MS,
  authorizeInteract,
  heldAnimationFor,
  holdsAnchor,
  isHumanPlayer,
  normalizeYaw,
  parseInteractMessage,
  parseJoinOptions,
  parsePoseMessage,
} from "@sim/shared";

import { recordOfficeEvent } from "../sim/events.js";
import { HoldRegistry } from "../sim/interaction.js";
import {
  type OccupantMotion,
  applyPose,
  createMotion,
  discardPending,
  recordPose,
} from "../sim/movement.js";

/**
 * Silence after which an occupant is shown as standing still.
 *
 * A client reports its own animation state, so this only fires when a client
 * stops reporting at all — a backgrounded tab, typically — and exists so such a
 * player is not left walking on the spot in everyone else's view.
 */
const IDLE_AFTER_MS = 400;

/**
 * How far the server will reach when authorising an interaction.
 *
 * Wider than the range the client prompts at, by exactly the documented
 * tolerance, because this room measures from the last pose it accepted rather
 * than from where the client is now.
 */
const SERVER_INTERACT_RANGE = INTERACT_RANGE * INTERACT_RANGE_TOLERANCE;

export class OfficeRoom extends Room<OfficeState> {
  public override maxClients = 16;

  /** Server-only per-occupant bookkeeping, keyed by session id. */
  private readonly motions = new Map<string, OccupantMotion>();

  /** The authoritative answer to who is sitting where. */
  private readonly holds = new HoldRegistry();

  private spawnCursor = 0;
  private hireCount = 0;

  public override onCreate(): void {
    this.state = new OfficeState();
    this.patchRate = TICK_INTERVAL_MS;

    this.onMessage(CLIENT_MESSAGE.pose, (client, raw: unknown) => {
      const pose = parsePoseMessage(raw);
      const motion = this.motions.get(client.sessionId);
      if (pose === undefined || motion === undefined) {
        // A malformed payload is dropped; another pose follows in ~50ms.
        return;
      }
      recordPose(motion, pose, this.clock.currentTime);
    });

    this.onMessage(CLIENT_MESSAGE.interact, (client, raw: unknown) => {
      const message = parseInteractMessage(raw);
      if (message !== undefined) {
        this.handleInteract(client.sessionId, message.target);
      }
    });

    this.onMessage(CLIENT_MESSAGE.release, (client) => {
      this.releaseHold(client.sessionId);
    });

    this.setSimulationInterval(() => {
      this.simulate();
    }, TICK_INTERVAL_MS);
  }

  public override onJoin(client: Client, options?: unknown): void {
    const { name } = parseJoinOptions(options);
    const spawn = this.nextSpawn();
    const now = this.clock.currentTime;

    this.hireCount += 1;
    const player = new HumanPlayer();
    player.id = client.sessionId;
    player.name = name ?? `Employee ${this.hireCount}`;
    player.kind = OCCUPANT_KIND.human;
    player.x = spawn.x;
    player.z = spawn.z;
    player.yaw = normalizeYaw(spawn.yaw);
    player.animation = ANIMATION_STATE.idle;
    player.isCeo = this.findCeo() === undefined;

    this.state.occupants.set(client.sessionId, player);
    this.motions.set(client.sessionId, createMotion(spawn.x, spawn.z, spawn.yaw, now));
  }

  public override onLeave(client: Client): void {
    const departing = this.state.occupants.get(client.sessionId);
    // Before the occupant goes, so a closed tab does not leave its chair
    // reserved for the rest of the session.
    this.holds.release(client.sessionId);
    this.state.occupants.delete(client.sessionId);
    this.motions.delete(client.sessionId);

    // The office should not be left without a CEO just because one tab closed.
    if (departing !== undefined && isHumanPlayer(departing) && departing.isCeo) {
      this.promoteLongestServing();
    }
  }

  /**
   * One simulation step.
   *
   * Synchronous, allocation-light, and with nothing awaited anywhere inside it.
   * That is a deliberate boundary, not an accident of the current scope: agent
   * employees will decide what to do by calling a model, and those calls will
   * land on an intent queue that this tick reads without ever waiting on. If the
   * tick were allowed to await now, that boundary would have to be retrofitted
   * later against a room full of assumptions that it could.
   */
  private simulate(): void {
    const now = this.clock.currentTime;
    this.state.tick = (this.state.tick + 1) % 0xffffffff;

    for (const [sessionId, motion] of this.motions) {
      const occupant = this.state.occupants.get(sessionId);
      if (occupant === undefined) {
        continue;
      }
      const hold = this.holds.heldBy(sessionId);
      if (hold !== undefined) {
        if (now >= hold.endsAt) {
          // A timed interaction running out, checked against the clock rather
          // than awaited on a timer, so this tick stays synchronous.
          this.releaseHold(sessionId);
        } else {
          // Held occupants do not move and do not time out into idle: the
          // position and animation on the state are the server's, and the pose
          // the client is still reporting is not allowed to overwrite either.
          discardPending(motion, now);
        }
        continue;
      }
      if (motion.hasPending) {
        applyPose(occupant, motion, now, OFFICE_LAYOUT);
        motion.hasPending = false;
      } else if (
        occupant.animation !== ANIMATION_STATE.idle &&
        now - motion.lastMessageAt > IDLE_AFTER_MS
      ) {
        occupant.animation = ANIMATION_STATE.idle;
      }
    }
  }

  /**
   * Decides a client's interact request and applies it, or does nothing at all.
   *
   * "Nothing at all" is the whole point of the refusal branch: a request that
   * fails authorisation leaves the room exactly as it was, so an out-of-range
   * interact from a modified client is not a partial success. The client is not
   * told why — it ran the same rule before showing its prompt, so a refusal
   * means either a race it will see resolved in the next patch or a client that
   * was not asking honestly.
   */
  private handleInteract(sessionId: string, target: string): void {
    const occupant = this.state.occupants.get(sessionId);
    if (occupant === undefined) {
      return;
    }

    const decision = authorizeInteract(
      OFFICE_LAYOUT,
      {
        id: sessionId,
        // The pose this room has accepted, never the one the message claims.
        x: occupant.x,
        z: occupant.z,
        interactableId: occupant.interactableId,
      },
      target,
      SERVER_INTERACT_RANGE,
      (interactableId) => this.holds.holderOf(interactableId),
    );
    if (!decision.allowed) {
      return;
    }

    if (holdsAnchor(decision.target)) {
      this.takeHold(sessionId, occupant, decision.target);
      return;
    }

    // An interaction that holds nothing has no state to change, so all it can
    // do for now is leave a trace. The whiteboard is the only one, and it is a
    // placeholder on purpose — see `sim/events.ts`.
    recordOfficeEvent("interact", {
      actor: occupant.name,
      target: decision.target.id,
      kind: decision.target.kind,
    });
  }

  /** Puts an occupant into an interactable's anchor pose and marks it taken. */
  private takeHold(sessionId: string, occupant: Occupant, spec: InteractableSpec): void {
    const now = this.clock.currentTime;
    this.holds.take(sessionId, spec, now);

    occupant.interactableId = spec.id;
    occupant.x = spec.anchor.x;
    occupant.z = spec.anchor.z;
    occupant.yaw = normalizeYaw(spec.anchor.yaw);
    occupant.animation = heldAnimationFor(spec);

    const motion = this.motions.get(sessionId);
    if (motion !== undefined) {
      discardPending(motion, now);
    }
  }

  /**
   * Frees whatever an occupant was holding and hands movement back.
   *
   * The occupant is left standing at the anchor rather than moved anywhere: the
   * client resumes predicting from the same point, so standing up costs no
   * correction. Safe to call on an occupant that holds nothing.
   */
  private releaseHold(sessionId: string): void {
    if (this.holds.heldBy(sessionId) === undefined) {
      return;
    }
    this.holds.release(sessionId);

    const occupant = this.state.occupants.get(sessionId);
    if (occupant !== undefined) {
      occupant.interactableId = "";
      occupant.animation = ANIMATION_STATE.idle;
    }

    const motion = this.motions.get(sessionId);
    if (motion !== undefined) {
      discardPending(motion, this.clock.currentTime);
    }
  }

  /** Cycles the layout's spawn points so arrivals do not stack on one spot. */
  private nextSpawn() {
    const points = OFFICE_LAYOUT.spawnPoints;
    const point = points[this.spawnCursor % points.length];
    this.spawnCursor += 1;
    return point ?? { x: 0, z: 0, yaw: 0 };
  }

  private findCeo(): HumanPlayer | undefined {
    for (const occupant of this.state.occupants.values()) {
      if (isHumanPlayer(occupant) && occupant.isCeo) {
        return occupant;
      }
    }
    return undefined;
  }

  private promoteLongestServing(): void {
    let successor: HumanPlayer | undefined;
    let successorJoinedAt = Number.POSITIVE_INFINITY;

    for (const [sessionId, occupant] of this.state.occupants) {
      if (!isHumanPlayer(occupant)) {
        continue;
      }
      const joinedAt = this.motions.get(sessionId)?.joinedAt ?? Number.POSITIVE_INFINITY;
      if (joinedAt < successorJoinedAt) {
        successor = occupant;
        successorJoinedAt = joinedAt;
      }
    }

    if (successor !== undefined) {
      successor.isCeo = true;
    }
  }
}
