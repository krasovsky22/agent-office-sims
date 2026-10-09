/**
 * The shared office.
 *
 * One room holds everyone on the floor. It owns four things: who is in the
 * office, where the authoritative version of each of them is, which of them is
 * the CEO, and the ticket board they work from.
 *
 * The board's rules are not here. `ticketHandlers.ts` wires the five commands
 * up and `@sim/shared`'s `tickets.ts` decides what each one is allowed to do.
 */

import { type Client, Room } from "@colyseus/core";
import {
  ANIMATION_STATE,
  CLIENT_MESSAGE,
  HumanPlayer,
  OCCUPANT_KIND,
  OFFICE_LAYOUT,
  OfficeState,
  TICK_INTERVAL_MS,
  isHumanPlayer,
  normalizeYaw,
  parseJoinOptions,
  parsePoseMessage,
} from "@sim/shared";

import { type OccupantMotion, applyPose, createMotion, recordPose } from "../sim/movement.js";
import {
  type TicketHost,
  createTicketIdFactory,
  registerTicketHandlers,
  seedTicketBoard,
} from "./ticketHandlers.js";

/**
 * Silence after which an occupant is shown as standing still.
 *
 * A client reports its own animation state, so this only fires when a client
 * stops reporting at all — a backgrounded tab, typically — and exists so such a
 * player is not left walking on the spot in everyone else's view.
 */
const IDLE_AFTER_MS = 400;

export class OfficeRoom extends Room<OfficeState> {
  public override maxClients = 16;

  /** Server-only per-occupant bookkeeping, keyed by session id. */
  private readonly motions = new Map<string, OccupantMotion>();

  private spawnCursor = 0;
  private hireCount = 0;

  public override onCreate(): void {
    this.state = new OfficeState();
    this.patchRate = TICK_INTERVAL_MS;

    // `Date.now()` rather than `this.clock`, because a ticket timestamp is read
    // as a wall-clock date in a panel, not as an offset from this room's start.
    const ticketHost: TicketHost = {
      state: this.state,
      now: () => Date.now(),
      nextTicketId: createTicketIdFactory(),
    };
    seedTicketBoard(ticketHost);
    registerTicketHandlers(this, ticketHost);

    this.onMessage(CLIENT_MESSAGE.pose, (client, raw: unknown) => {
      const pose = parsePoseMessage(raw);
      const motion = this.motions.get(client.sessionId);
      if (pose === undefined || motion === undefined) {
        // A malformed payload is dropped; another pose follows in ~50ms.
        return;
      }
      recordPose(motion, pose, this.clock.currentTime);
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
