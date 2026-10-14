/**
 * The shared office.
 *
 * One room holds everyone on the floor. It owns six things: who is in the
 * office, where the authoritative version of each of them is, which of them is
 * the CEO, which of them is sitting at or standing over something, what they
 * are expressing, and the ticket board they work from.
 *
 * Interactions are server-decided, not client-reported. A client may ask to use
 * an interactable; it may not say that it is in reach of one, that the chair is
 * free, or that it is now seated. Each of those is re-derived in
 * `sim/interaction.ts` from the shared layout and the pose this room has
 * accepted, because each of them is a check a modified client would simply
 * leave out.
 *
 * Expression — emotes and chat — is relayed rather than replicated. A wave is
 * true for two seconds and a sentence for six, so neither belongs in the
 * schema, where a client joining afterwards would be handed it as though it
 * were still happening. The server validates, sanitizes and rate-limits, then
 * broadcasts; clients draw what they receive and forget it when it expires.
 *
 * The board's rules are not here. `ticketHandlers.ts` wires the five commands
 * up and `@sim/shared`'s `tickets.ts` decides what each one is allowed to do.
 *
 * Nor is the lobby's GitHub board, beyond passing it on. The server's one feed
 * polls GitHub on its own timer and is handed to every room as a room option;
 * `projectBoardDelivery.ts` relays what it publishes. The tick never reads it.
 */

import { type Client, Room } from "@colyseus/core";
import {
  ANIMATION_STATE,
  type ChatEvent,
  CLIENT_MESSAGE,
  type EmoteEvent,
  HumanPlayer,
  OCCUPANT_KIND,
  OFFICE_LAYOUT,
  OfficeState,
  SERVER_MESSAGE,
  TICK_INTERVAL_MS,
  type ThrottledEvent,
  isHumanPlayer,
  normalizeYaw,
  parseChatMessage,
  parseEmoteMessage,
  parseInteractMessage,
  parseJoinOptions,
  parsePoseMessage,
} from "@sim/shared";

import type { ProjectBoardSource } from "../github/feed.js";
import { recordOfficeEvent } from "../sim/events.js";
import { type ExpressionBudget, createExpressionBudget, tryConsume } from "../sim/expression.js";
import {
  HoldRegistry,
  type InteractionHost,
  holdTick,
  releaseHold,
  requestInteract,
} from "../sim/interaction.js";
import { type OccupantMotion, applyPose, createMotion, recordPose } from "../sim/movement.js";
import {
  isProjectBoardSource,
  relayProjectBoard,
  sendProjectBoard,
} from "./projectBoardDelivery.js";
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

/** What `index.ts` hands the room type when it defines it. */
export interface OfficeRoomOptions {
  readonly projectBoard: ProjectBoardSource;
}

export class OfficeRoom extends Room<OfficeState> {
  public override maxClients = 16;

  /** Server-only per-occupant bookkeeping, keyed by session id. */
  private readonly motions = new Map<string, OccupantMotion>();

  /** Per-occupant emote and chat allowances, keyed by session id. */
  private readonly budgets = new Map<string, ExpressionBudget>();

  /** The authoritative answer to who is sitting where. */
  private readonly holds = new HoldRegistry();

  /** Assigned in `onCreate`, once the state it reads exists. */
  private interaction!: InteractionHost;

  private spawnCursor = 0;
  private hireCount = 0;

  private projectBoard: ProjectBoardSource | undefined;
  private stopRelayingProjectBoard: (() => void) | undefined;

  public override onCreate(options?: unknown): void {
    this.state = new OfficeState();
    this.patchRate = TICK_INTERVAL_MS;
    this.interaction = {
      layout: OFFICE_LAYOUT,
      occupants: this.state.occupants,
      motions: this.motions,
      holds: this.holds,
      lastUsedAt: new Map(),
    };

    const source = (options as Partial<OfficeRoomOptions> | undefined)?.projectBoard;
    if (isProjectBoardSource(source)) {
      this.projectBoard = source;
      this.stopRelayingProjectBoard = relayProjectBoard(this, source);
    }

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

    this.onMessage(CLIENT_MESSAGE.interact, (client, raw: unknown) => {
      const message = parseInteractMessage(raw);
      if (message === undefined) {
        return;
      }
      // A refusal is not answered: the client ran the same rule before showing
      // its prompt, so a refusal means either a race it will see resolved in
      // the next patch or a client that was not asking honestly.
      const outcome = requestInteract(
        this.interaction,
        client.sessionId,
        message.target,
        this.clock.currentTime,
      );
      if (outcome.result === "used") {
        // An interaction that holds nothing has no state to change, so all it
        // can do for now is leave a trace. The whiteboard is the only one, and
        // it is a placeholder on purpose — see `sim/events.ts`.
        recordOfficeEvent("interact", {
          actor: this.state.occupants.get(client.sessionId)?.name ?? client.sessionId,
          target: outcome.target.id,
          kind: outcome.target.kind,
        });
      }
    });

    this.onMessage(CLIENT_MESSAGE.release, (client) => {
      releaseHold(this.interaction, client.sessionId, this.clock.currentTime);
    });

    this.onMessage(CLIENT_MESSAGE.emote, (client, raw: unknown) => {
      const message = parseEmoteMessage(raw);
      if (message === undefined || !this.spend(client, "emote")) {
        return;
      }
      this.broadcast(SERVER_MESSAGE.emote, {
        occupantId: client.sessionId,
        emote: message.emote,
      } satisfies EmoteEvent);
    });

    this.onMessage(CLIENT_MESSAGE.chat, (client, raw: unknown) => {
      // The text is sanitized by the parser, so what goes out over the wire is
      // already capped and stripped. No client ever has to re-check it.
      const message = parseChatMessage(raw);
      if (message === undefined || !this.spend(client, "chat")) {
        return;
      }
      this.broadcast(SERVER_MESSAGE.chat, {
        occupantId: client.sessionId,
        text: message.text,
      } satisfies ChatEvent);
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
    this.budgets.set(client.sessionId, createExpressionBudget(now));

    if (this.projectBoard !== undefined) {
      sendProjectBoard(client, this.projectBoard);
    }
  }

  public override onDispose(): void {
    this.stopRelayingProjectBoard?.();
  }

  public override onLeave(client: Client): void {
    const departing = this.state.occupants.get(client.sessionId);
    // Before the occupant goes, so a closed tab does not leave its chair
    // reserved for the rest of the session.
    this.holds.release(client.sessionId);
    this.interaction.lastUsedAt.delete(client.sessionId);
    this.state.occupants.delete(client.sessionId);
    this.motions.delete(client.sessionId);
    this.budgets.delete(client.sessionId);

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
      // Held occupants do not move and do not time out into idle; a timed hold
      // that has run out is released here, against the clock, not a timer.
      if (holdTick(this.interaction, sessionId, now)) {
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
   * Charges one emote or chat message against the sender's budget.
   *
   * Parsing happens before this, so a malformed payload never costs an honest
   * client part of its allowance; it is dropped the way a malformed pose is.
   *
   * A client that is over its budget is told so, and only that client. The
   * alternative — dropping in silence — makes a rate limit indistinguishable
   * from a lost message, and leaves the sender repeating themselves into a
   * limiter they cannot see.
   *
   * @returns whether the message may be relayed.
   */
  private spend(client: Client, command: ThrottledEvent["command"]): boolean {
    const budget = this.budgets.get(client.sessionId);
    if (budget === undefined || !this.state.occupants.has(client.sessionId)) {
      return false;
    }
    if (tryConsume(budget[command], this.clock.currentTime)) {
      return true;
    }
    client.send(SERVER_MESSAGE.throttled, { command } satisfies ThrottledEvent);
    return false;
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
