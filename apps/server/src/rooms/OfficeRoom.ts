/**
 * The shared office.
 *
 * One room holds everyone on the floor. It owns six things: who is in the
 * office, where the authoritative version of each of them is, which of them is
 * the CEO, which of them is sitting at or standing over something, what they
 * are expressing, and the agents' work on the project board's GitHub issues.
 *
 * "Who is in the office" includes the agent employees, which the room hires
 * itself when it opens — see `sim/agents.ts`. They are occupants like any
 * player, so issues can be assigned to them and every client draws them, but no
 * session drives them: the per-session maps below never see one, and an agent
 * moves only through its intent queue. The one registry an agent shares with
 * players is the hold registry, so a chair an agent sits in is taken for
 * everyone.
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
 * The work's rules are not here. `workHandlers.ts` wires the three commands
 * up and `@sim/shared`'s `work.ts` decides what each one is allowed to do.
 * Hiring and firing are wired the same way, by `staffHandlers.ts` against
 * `staffing.ts`; the tick only asks `staffHandlers.ts`, after each step of the
 * clock, whether a run of bad days has cost the office an agent.
 * Nor are the company's: the tick steps `sim/company.ts`'s clock, and every
 * number that clock moves is decided in `@sim/shared`'s `company.ts`.
 * Who holds the CEO role those rules turn on is `sim/roles.ts`'s call; this
 * room only tells it when someone arrives or leaves.
 *
 * A player whose socket drops without leaving keeps their place, role
 * included, for {@link RECONNECT_GRACE_SECONDS}. Only a player who left on
 * purpose, or did not come back in time, is removed.
 *
 * Nor is how an agent walks. The tick steps `sim/agentMotion.ts`, which drains
 * each agent's intent queue and moves its body through the shared pathfinding
 * and collision; whatever fills those queues — a brain, or the debug command in
 * `agentDebug.ts` — never runs inside the tick.
 *
 * Nor is how an agent works. Each agent hired gets a brain, `sim/agentBrain.ts`,
 * on its own async loop and its own timers rather than the room clock's, which
 * Colyseus ticks from inside the simulation interval. The room starts a brain
 * for every agent it hires, at opening or later, and stops it when the agent
 * leaves or the room closes, and that is all it does with them.
 *
 * Nor is the project board's GitHub feed, beyond passing it on. The server's
 * one feed polls GitHub on its own timer and is handed to every room as a room option;
 * `projectBoardDelivery.ts` relays what it publishes, and each snapshot it
 * publishes releases the work on any issue GitHub has closed. The board is
 * read-only: nothing in the room writes to GitHub. The tick reads the feed
 * only at midnight, when a day's close counts the open issues, and then only
 * the snapshot it already holds in memory.
 *
 * The live coding agents arrive the same way, as a source handed over at
 * definition time. The room only marks itself dirty when the source changes;
 * the tick reads the source's finished list and hands it to the crew in
 * `sim/liveAgents.ts`, which walks, seats and talks the bodies on the floor.
 *
 * Nor is how the AI manager thinks. The room seats it at its desk, hands every
 * message to it through `managerHandlers.ts`, and sends each joining client the
 * conversation so far; the manager in `manager/officeManager.ts` answers on its
 * own loop, and the tick never waits on it.
 */

import { type Client, Room } from "@colyseus/core";
import {
  ANIMATION_STATE,
  type CeoChangedEvent,
  type ChatEvent,
  CLIENT_MESSAGE,
  type EmoteEvent,
  HumanPlayer,
  type ManagerEntry,
  type ManagerHistoryEvent,
  OCCUPANT_KIND,
  OFFICE_LAYOUT,
  OfficeState,
  RECONNECT_GRACE_SECONDS,
  SERVER_MESSAGE,
  TICK_INTERVAL_MS,
  type ThrottledEvent,
  employManager,
  isCeo,
  managerSeat,
  normalizeYaw,
  parseChatMessage,
  parseEmoteMessage,
  parseInteractMessage,
  parseJoinOptions,
  parsePoseMessage,
  releaseGoneWork,
} from "@sim/shared";

import { type LiveAgentSource, isLiveAgentSource } from "../agents/registry.js";
import { type RunnerEventInbox, type RunnerEventSource, isRunnerEventSource } from "../agents/runnerLink.js";
import type { ProjectBoardSource } from "../github/feed.js";
import { AgentBrain, type AgentBrainHost } from "../sim/agentBrain.js";
import { AgentMotion, type IntentReport } from "../sim/agentMotion.js";
import { type CompanyClock, type CompanyOffice, createCompanyClock, stepCompany } from "../sim/company.js";
import { type ManagerAdvisor, isManagerAdvisor } from "../manager/advisor.js";
import { type LiveAssignmentQueue, isLiveAssignmentQueue } from "../manager/liveAssignments.js";
import { OfficeManager } from "../manager/officeManager.js";
import { hireAgentEmployees } from "../sim/agents.js";
import { recordOfficeEvent } from "../sim/events.js";
import { type ExpressionBudget, createExpressionBudget, tryConsume } from "../sim/expression.js";
import {
  HoldRegistry,
  type InteractionHost,
  holdTick,
  releaseHold,
  requestInteract,
} from "../sim/interaction.js";
import { LiveAgentCrew } from "../sim/liveAgents.js";
import { type OccupantMotion, applyPose, createMotion, recordPose } from "../sim/movement.js";
import { appointSuccessor, roleForArrival } from "../sim/roles.js";
import { type WorkExecutor, isWorkExecutor } from "../work/executor.js";
import { registerAgentDebugHandlers } from "./agentDebug.js";
import { registerManagerHandlers } from "./managerHandlers.js";
import {
  isProjectBoardSource,
  relayProjectBoard,
  sendProjectBoard,
} from "./projectBoardDelivery.js";
import { type StaffHost, registerStaffHandlers, resolveStaffQuits } from "./staffHandlers.js";
import { type WorkHost, registerWorkHandlers } from "./workHandlers.js";

/**
 * Silence after which an occupant is shown as standing still.
 *
 * A client reports its own animation state, so this only fires when a client
 * stops reporting at all — a backgrounded tab, typically — and exists so such a
 * player is not left walking on the spot in everyone else's view.
 */
const IDLE_AFTER_MS = 400;

/**
 * How often agents' intent outcomes are written to the event log.
 *
 * On a clock of its own rather than from the tick, because writing a log line
 * is I/O and the tick does none.
 */
const AGENT_REPORT_INTERVAL_MS = 1000;

/**
 * Longest step the live agents are moved in one tick.
 *
 * A tick that runs late — a slow machine, a garbage collection — should not
 * fling an agent further along its route than the collision substep was sized for.
 */
const MAX_AGENT_STEP_MS = TICK_INTERVAL_MS * 4;

/** What `index.ts` hands the room type when it defines it. */
export interface OfficeRoomOptions {
  readonly projectBoard: ProjectBoardSource;
  /** Agent employees to hire on opening, already validated by `config.ts`. */
  readonly agentCount: number;
  /**
   * How long a dropped player's place is held, in seconds. Defaults to
   * {@link RECONNECT_GRACE_SECONDS}, and can only be shortened: a test sets it
   * low to watch a grace period run out without waiting for the real one.
   */
  readonly reconnectGraceSeconds?: number;
  /** Whether the debug goto command is honoured; `AGENT_DEBUG` in `config.ts`. */
  readonly agentDebug: boolean;
  /**
   * How the agents do their issues, shared by every room so one call budget
   * covers the server. A room given none hires agents that never pick up work.
   */
  readonly workExecutor: WorkExecutor;
  /** Absent when neither an orchestrator nor a runner is configured, which leaves the floor to the players. */
  readonly liveAgents?: LiveAgentSource;
  /**
   * How the AI manager thinks, shared by every room so one call budget covers
   * the server. A room given none has no manager.
   */
  readonly manager?: ManagerAdvisor;
  /**
   * Where the manager queues GitHub work for live agents, for the orchestrator
   * to collect. Absent when no orchestrator is configured.
   */
  readonly liveAssignments?: LiveAssignmentQueue;
  /** What the agent runners report happening; absent when no runner is configured. */
  readonly runnerEvents?: RunnerEventSource;
}

/**
 * Reads the grace period off the room's options.
 *
 * Bounded rather than trusted because Colyseus merges the creating client's
 * join options into these. `index.ts` always sets the value, which wins that
 * merge, but a room defined without it must not let a client hold its place
 * open for an hour.
 */
function graceSecondsOf(options: Partial<OfficeRoomOptions> | undefined): number {
  const requested = options?.reconnectGraceSeconds;
  return typeof requested === "number" && requested >= 0 && requested <= RECONNECT_GRACE_SECONDS
    ? requested
    : RECONNECT_GRACE_SECONDS;
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

  /** The server-only half of the company clock; assigned in `onCreate`. */
  private companyClock!: CompanyClock;

  /** What a day's close reads; assigned in `onCreate`. */
  private companyOffice!: CompanyOffice;

  /** Every agent's intent queue and body; assigned in `onCreate`. */
  private agentMotion!: AgentMotion;

  /** One per agent hired, each on its own loop; stopped in `onDispose`. */
  private readonly brains: AgentBrain[] = [];

  /** What every brain works through; unset in a room given no executor. */
  private brainHost: AgentBrainHost | undefined;

  /** What the staff handlers keep between commands; assigned in `onCreate`. */
  private staff!: StaffHost;

  private spawnCursor = 0;
  private hireCount = 0;

  private projectBoard: ProjectBoardSource | undefined;
  private stopRelayingProjectBoard: (() => void) | undefined;
  private stopReleasingWork: (() => void) | undefined;

  private reconnectGraceSeconds = RECONNECT_GRACE_SECONDS;

  /** Session ids whose socket has dropped and whose place is being held. */
  private readonly held = new Set<string>();

  /** Assigned in `onCreate`; the bodies of the live coding agents. */
  private crew!: LiveAgentCrew;
  private liveAgents: LiveAgentSource | undefined;
  private stopWatchingLiveAgents: (() => void) | undefined;
  /** Set by the source, cleared by the tick that reads it. */
  private liveAgentsChanged = true;
  /** This room's share of the runners' events, drained by the tick. */
  private runnerEvents: RunnerEventInbox | undefined;

  /** The AI manager's mind; unset in a room given no advisor. */
  private manager: OfficeManager | undefined;

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
    this.companyClock = createCompanyClock(this.state.company, this.clock.currentTime);
    this.companyOffice = {
      company: this.state.company,
      work: this.state.work,
      occupants: this.state.occupants,
      board: () => this.projectBoard?.current(),
    };
    this.agentMotion = new AgentMotion(this.interaction);

    const roomOptions = options as Partial<OfficeRoomOptions> | undefined;
    this.reconnectGraceSeconds = graceSecondsOf(roomOptions);

    const source = roomOptions?.projectBoard;
    if (isProjectBoardSource(source)) {
      this.projectBoard = source;
      this.stopRelayingProjectBoard = relayProjectBoard(this, source);
      // On the feed's own timer, between ticks: an issue GitHub closed is no
      // longer anyone's to work, and its agent puts it down on its next look.
      this.stopReleasingWork = source.subscribe((snapshot) => {
        releaseGoneWork(this.state.work, snapshot);
      });
    }

    this.crew = new LiveAgentCrew({
      layout: OFFICE_LAYOUT,
      occupants: this.state.occupants,
      interaction: this.interaction,
      say: (occupantId, text) => {
        this.broadcast(SERVER_MESSAGE.chat, { occupantId, text } satisfies ChatEvent);
      },
      random: Math.random,
    });
    const liveAgents = roomOptions?.liveAgents;
    if (isLiveAgentSource(liveAgents)) {
      this.liveAgents = liveAgents;
      this.stopWatchingLiveAgents = liveAgents.subscribe(() => {
        this.liveAgentsChanged = true;
      });
    }
    const runnerEvents = roomOptions?.runnerEvents;
    if (isRunnerEventSource(runnerEvents)) {
      this.runnerEvents = runnerEvents.openEventInbox();
    }

    // `Date.now()` rather than `this.clock`, because a work timestamp is read
    // as a wall-clock date, not as an offset from this room's start.
    const workHost: WorkHost = {
      state: this.state,
      now: () => Date.now(),
      board: () => this.projectBoard?.current(),
    };
    registerWorkHandlers(this, workHost);
    this.openManagersDesk(workHost, roomOptions);

    // Before anyone can join, so nobody's first patch is an empty office.
    const agentCount = roomOptions?.agentCount;
    const hired =
      typeof agentCount === "number"
        ? hireAgentEmployees(this.state.occupants, OFFICE_LAYOUT, agentCount)
        : [];
    const executor = roomOptions?.workExecutor;
    if (isWorkExecutor(executor)) {
      this.brainHost = {
        work: workHost,
        layout: OFFICE_LAYOUT,
        motion: this.agentMotion,
        executor,
        clockNow: () => this.clock.currentTime,
      };
    }
    hired.forEach((agent) => this.startBrain(agent.id));
    this.staff = {
      state: this.state,
      hiresSoFar: hired.length,
      hired: (agentId) => this.startBrain(agentId),
      departed: (agentId) => this.dismissAgent(agentId),
    };
    registerStaffHandlers(this, this.staff);
    registerAgentDebugHandlers(this, {
      enabled: roomOptions?.agentDebug === true,
      motion: this.agentMotion,
      occupants: this.state.occupants,
    });
    this.clock.setInterval(() => {
      this.agentMotion.drainReports().forEach(logIntentReport);
    }, AGENT_REPORT_INTERVAL_MS);

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
        // can do for now is leave a trace — see `sim/events.ts`. A wall board's
        // close-up is the reading client's own view, so it changes nothing here.
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
      if (message === undefined || !this.spend(client, CLIENT_MESSAGE.emote)) {
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
      if (message === undefined || !this.spend(client, CLIENT_MESSAGE.chat)) {
        return;
      }
      this.broadcast(SERVER_MESSAGE.chat, {
        occupantId: client.sessionId,
        text: message.text,
      } satisfies ChatEvent);
    });

    this.setSimulationInterval((deltaMs) => {
      this.simulate(deltaMs);
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
    player.role = roleForArrival(this.state.occupants);

    this.state.occupants.set(client.sessionId, player);
    this.motions.set(client.sessionId, createMotion(spawn.x, spawn.z, spawn.yaw, now));
    this.budgets.set(client.sessionId, createExpressionBudget(now));

    if (this.projectBoard !== undefined) {
      sendProjectBoard(client, this.projectBoard);
    }
    if (this.manager !== undefined) {
      client.send(SERVER_MESSAGE.managerHistory, {
        entries: this.manager.history(),
      } satisfies ManagerHistoryEvent);
    }
  }

  public override onDispose(): void {
    // First, so no brain or manager is left writing to a room that is closing.
    for (const brain of this.brains) {
      brain.stop();
    }
    this.manager?.stop();
    this.stopRelayingProjectBoard?.();
    this.stopReleasingWork?.();
    this.stopWatchingLiveAgents?.();
    this.runnerEvents?.close();
  }

  /**
   * A client's socket closed.
   *
   * `consented` is a deliberate leave — the client called `leave()`, as a
   * closing tab does — and removes the player at once. Anything else is a
   * drop, and the player's place is held for the grace period:
   * their occupant stays in the office, their role with it, and a client that
   * reconnects in time resumes as the same session. The wait is a deferred the
   * room resolves on reconnection; nothing in the simulation tick waits on it.
   */
  public override async onLeave(client: Client, consented?: boolean): Promise<void> {
    if (consented !== true) {
      this.held.add(client.sessionId);
      try {
        await this.allowReconnection(client, this.reconnectGraceSeconds);
        this.held.delete(client.sessionId);
        return;
      } catch {
        // The grace period ran out, or the room is closing: gone for good.
      }
    }
    this.depart(client.sessionId);
  }

  /**
   * One simulation step.
   *
   * Synchronous, allocation-light, and with nothing awaited anywhere inside it.
   * That is a deliberate boundary, not an accident of the current scope: agent
   * employees work their issues by calling a model, on their own loops, and
   * what they decide lands on the intent queue `agentMotion.step` drains here
   * without ever waiting on them. If the tick were allowed to await, a slow
   * model would stall every player in the room.
   */
  private simulate(deltaMs: number): void {
    const now = this.clock.currentTime;
    this.state.tick = (this.state.tick + 1) % 0xffffffff;

    // However many reports arrived since the last tick, this reads the source
    // once: the list it returns is already finished, so nothing here waits.
    if (this.liveAgentsChanged && this.liveAgents !== undefined) {
      this.liveAgentsChanged = false;
      this.crew.sync(this.liveAgents.current(), now);
    }
    this.crew.step(now, Math.min(Math.max(deltaMs, 0), MAX_AGENT_STEP_MS) / 1000);
    // Drained every tick so a room's inbox never holds more than a tick's
    // worth. Turning these into work on the board is #74's; until then the
    // floor shows a runner's progress through its slots alone.
    this.runnerEvents?.drain();

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

    // After the players, and touching none of their bookkeeping, so however
    // many agents are walking a player's pose is validated exactly as before.
    this.agentMotion.step(now);

    stepCompany(this.companyOffice, this.companyClock, now);
    resolveStaffQuits(this, this.staff);
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

  /**
   * Seats the AI manager at its desk and starts it listening, if this room was
   * given an advisor and its floor plan has the desk.
   *
   * The chair is held from the start, through the same registry players use,
   * so nobody can sit in it and every client sees it taken.
   */
  private openManagersDesk(work: WorkHost, options: Partial<OfficeRoomOptions> | undefined): void {
    const advisor = options?.manager;
    const manager = employManager(OFFICE_LAYOUT);
    const seat = managerSeat(OFFICE_LAYOUT);
    if (!isManagerAdvisor(advisor) || manager === undefined || seat === undefined) {
      return;
    }
    this.state.occupants.set(manager.id, manager);
    this.holds.take(manager.id, seat, this.clock.currentTime);

    const assignments = isLiveAssignmentQueue(options?.liveAssignments) ? options.liveAssignments : undefined;
    this.manager = new OfficeManager({
      work,
      advisor,
      // The orchestrator's agents only: the manager hands work out through its
      // queue, which a runner's slot is not on.
      liveAgents: assignments,
      assignments,
      origin: this.roomId,
      publish: (entry) => {
        this.broadcast(SERVER_MESSAGE.managerEntry, entry satisfies ManagerEntry);
      },
    });
    registerManagerHandlers(this, {
      state: this.state,
      manager: this.manager,
      allow: (client) => this.spend(client, CLIENT_MESSAGE.managerSay),
    });
    this.manager.start();
  }

  /** Gives an agent on the floor a brain, if this room's agents work at all. */
  private startBrain(agentId: string): void {
    if (this.brainHost === undefined) {
      return;
    }
    const brain = new AgentBrain(this.brainHost, agentId);
    this.brains.push(brain);
    brain.start();
  }

  /**
   * Clears what the room kept for an agent the staffing rules have just taken
   * off the floor, so a fired agent's chair is free for the next hire at once.
   */
  private dismissAgent(agentId: string): void {
    const index = this.brains.findIndex((brain) => brain.agentId === agentId);
    if (index !== -1) {
      this.brains[index]?.stop();
      this.brains.splice(index, 1);
    }
    this.agentMotion.clear(agentId, this.clock.currentTime);
    this.holds.release(agentId);
    this.interaction.lastUsedAt.delete(agentId);
  }

  /** Cycles the layout's spawn points so arrivals do not stack on one spot. */
  private nextSpawn() {
    const points = OFFICE_LAYOUT.spawnPoints;
    const point = points[this.spawnCursor % points.length];
    this.spawnCursor += 1;
    return point ?? { x: 0, z: 0, yaw: 0 };
  }

  /**
   * Removes a player for good, and passes the CEO role on if they held it.
   *
   * The removal and the promotion happen in this one synchronous call, so they
   * reach every client in the same patch: nobody sees an office with no CEO,
   * or with two.
   */
  private depart(sessionId: string): void {
    const departing = this.state.occupants.get(sessionId);
    // Before the occupant goes, so a closed tab does not leave its chair
    // reserved for the rest of the session.
    this.holds.release(sessionId);
    this.interaction.lastUsedAt.delete(sessionId);
    this.state.occupants.delete(sessionId);
    this.motions.delete(sessionId);
    this.budgets.delete(sessionId);
    this.held.delete(sessionId);

    if (departing === undefined || !isCeo(departing)) {
      return;
    }
    const successor = appointSuccessor(
      this.state.occupants,
      (id) => this.motions.get(id)?.joinedAt,
      (id) => this.held.has(id),
    );
    if (successor !== undefined) {
      this.broadcast(SERVER_MESSAGE.ceoChanged, {
        ceoId: successor.id,
        previousCeoId: sessionId,
      } satisfies CeoChangedEvent);
    }
  }
}

function logIntentReport(report: IntentReport): void {
  recordOfficeEvent("agent-intent", {
    agent: report.agentId,
    intent: report.intent.kind,
    outcome: report.outcome,
    ...(report.reason === undefined ? {} : { reason: report.reason }),
  });
}
