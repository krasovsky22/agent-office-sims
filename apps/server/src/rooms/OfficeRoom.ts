/**
 * The shared office.
 *
 * One room holds everyone on the floor. It owns six things: who is in the
 * office, where the authoritative version of each of them is, which of them is
 * the CEO, which of them is sitting at or standing over something, what they
 * are expressing, and the agents' work on the project board's GitHub issues.
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
 * Nor is the clock that lights the office: the tick steps `sim/clock.ts`, at
 * the rate `@sim/shared`'s `clock.ts` sets.
 * Who holds the CEO role those rules turn on is `sim/roles.ts`'s call; this
 * room only tells it when someone arrives or leaves.
 *
 * A player whose socket drops without leaving keeps their place, role
 * included, for {@link RECONNECT_GRACE_SECONDS}. Only a player who left on
 * purpose, or did not come back in time, is removed.
 *
 * Nor is the project board's GitHub feed, beyond passing it on. The server's
 * one feed polls GitHub on its own timer and is handed to every room as a room option;
 * `projectBoardDelivery.ts` relays what it publishes, and each snapshot it
 * publishes releases the work on any issue GitHub has closed. The board is
 * read-only: nothing in the room writes to GitHub, and the tick never reads
 * the feed.
 *
 * The live coding agents arrive the same way, as a source handed over at
 * definition time. The room only marks itself dirty when the source changes;
 * the tick reads the source's finished list and hands it to the crew in
 * `sim/liveAgents.ts`, which walks, seats and talks the bodies on the floor.
 * The work a runner's agents do goes through `agents/runnerWork.ts`, which
 * turns each change to the work into a command for the runner and each event
 * the runner reports into the agent's own move on the work. What the runners
 * report spending today is copied into the state on the tick, for every
 * client's HUD. The CEO's prompts to those agents, and keys for their choice
 * screens, go out through `agents/agentPrompts.ts`, and what the runner says came of each comes
 * back on the same tick as its events.
 *
 * The runners' standing tasks arrive as a source handed over at definition
 * time too: a process-wide mirror (`agents/standingMirror.ts`) the tick
 * copies into the state whenever it changes, so every tab's roster lists
 * them. The roster's buttons for them go through `standingHandlers.ts`, and
 * the AI Manager announces what each of their runs came to
 * (`agents/standingAnnouncer.ts`), from the same events the work's come in.
 *
 * Nor is how the AI manager thinks. The room seats it at its desk, hands every
 * message to it through `managerHandlers.ts`, and sends each joining client the
 * conversation so far; the manager in `manager/officeManager.ts` answers on its
 * own loop, and the tick never waits on it. Nor is when the concierge at
 * reception welcomes someone: the room stands it at its post, and
 * `sim/concierge.ts` watches the lobby on the tick.
 *
 * Nor is the standup, beyond its handlers and its step on the tick: the
 * meeting in `sim/standup.ts` gathers the crew in the manager's room, takes
 * the agents' updates in turn and passes the CEO's directions on as prompts,
 * and tells the runners a standup is on so they pause their agents for it.
 *
 * Nor is the CEO's desk terminal, beyond its step on the tick: the CEO
 * sitting at a desk with a computer is lent a runner's slot to prompt there,
 * and given it back on standing up, by `agents/deskTerminal.ts`.
 *
 * Nor are the runner slots' terminal screens, beyond passing them on: the
 * store in `agents/screens.ts` hands the room each batch of frames it accepts,
 * which goes straight out to every client, and the room sends each joining
 * client every screen in full. The tick never sees a screen.
 */

import { type Client, Room } from "@colyseus/core";
import {
  type AgentPromptHistoryEvent,
  ANIMATION_STATE,
  type CeoChangedEvent,
  type ChatEvent,
  CLIENT_MESSAGE,
  DEFAULT_AGENT_RESTRICT_LABEL,
  EMOTE,
  type EmoteEvent,
  HumanPlayer,
  type IssueWork,
  type RunnerSpendTotal,
  MAX_CHAT_LENGTH,
  MAX_LABEL_LENGTH,
  type ManagerEntry,
  type ManagerHistoryEvent,
  OCCUPANT_KIND,
  OFFICE_LAYOUT,
  OfficeState,
  RECONNECT_GRACE_SECONDS,
  SERVER_MESSAGE,
  type ScreenFramesEvent,
  TICK_INTERVAL_MS,
  TICK_RATE_HZ,
  type ThrottledEvent,
  conciergePost,
  employConcierge,
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

import { AgentPrompts } from "../agents/agentPrompts.js";
import { DeskTerminal, isDeskRunner } from "../agents/deskTerminal.js";
import { type LiveAgentSource, isLiveAgentSource } from "../agents/registry.js";
import {
  type RunnerEventInbox,
  type RunnerEventSource,
  type RunnerSpendSource,
  type RunnerStandupHold,
  isRunnerEventSource,
  isRunnerSpendSource,
  isRunnerStandupHold,
} from "../agents/runnerLink.js";
import { type RunnerCommands, RunnerWork, isRunnerCommands } from "../agents/runnerWork.js";
import { type ScreenSource, isScreenSource } from "../agents/screens.js";
import { StandingAnnouncer } from "../agents/standingAnnouncer.js";
import { StandingControl } from "../agents/standingControl.js";
import { type StandingMirror, copyStandingTasks, isStandingSource } from "../agents/standingMirror.js";
import type { ProjectBoardSource } from "../github/feed.js";
import { type SimClock, createSimClock, stepClock } from "../sim/clock.js";
import { type ManagerAdvisor, isManagerAdvisor } from "../manager/advisor.js";
import { type LiveAssignmentQueue, isLiveAssignmentQueue } from "../manager/liveAssignments.js";
import { OfficeManager } from "../manager/officeManager.js";
import { CoffeeCups } from "../sim/coffee.js";
import { ConciergeDesk } from "../sim/concierge.js";
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
import { StandupMeeting } from "../sim/standup.js";
import { registerAgentProfileHandlers } from "./agentProfileHandlers.js";
import { registerAgentPromptHandlers } from "./agentPromptHandlers.js";
import { registerManagerHandlers } from "./managerHandlers.js";
import { registerStandingHandlers } from "./standingHandlers.js";
import {
  isProjectBoardSource,
  relayProjectBoard,
  sendProjectBoard,
} from "./projectBoardDelivery.js";
import { registerStandupHandlers } from "./standupHandlers.js";
import { type IssueStates, isIssueStates, registerIssueStateHandler } from "./issueStateHandlers.js";
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
 * Longest step the live agents are moved in one tick.
 *
 * A tick that runs late — a slow machine, a garbage collection — should not
 * fling an agent further along its route than the collision substep was sized for.
 */
const MAX_AGENT_STEP_MS = TICK_INTERVAL_MS * 4;

/** What `index.ts` hands the room type when it defines it. */
export interface OfficeRoomOptions {
  readonly projectBoard: ProjectBoardSource;
  /**
   * How long a dropped player's place is held, in seconds. Defaults to
   * {@link RECONNECT_GRACE_SECONDS}, and can only be shortened: a test sets it
   * low to watch a grace period run out without waiting for the real one.
   */
  readonly reconnectGraceSeconds?: number;
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
  /** Where commands for the runners' slots are queued; absent when no runner is configured. */
  readonly runnerCommands?: RunnerCommands;
  /** What the runners' agents have spent today; absent when no runner is configured. */
  readonly runnerSpend?: RunnerSpendSource;
  /**
   * The label that keeps an issue from the live coding agents.
   * Defaults to {@link DEFAULT_AGENT_RESTRICT_LABEL}; never none, since Colyseus
   * merges a client's join options into these.
   */
  readonly agentRestrictLabel?: string;
  /** Where the CEO's drops on Closed and Open go: the runner link; absent when no runner is configured. */
  readonly issueStates?: IssueStates;
  /** The runner slots' terminal screens; absent when no runner is configured. */
  readonly screens?: ScreenSource;
  /** Every runner's standing tasks, mirrored; absent when no runner is configured. */
  readonly standing?: StandingMirror;
  /** Where a standup is said to be on, so the runners pause their agents; absent when no runner is configured. */
  readonly runnerStandup?: RunnerStandupHold;
}

/** Reads the restriction label off the room's options, bounded for the same reason as the grace period. */
function restrictLabelOf(options: Partial<OfficeRoomOptions> | undefined): string {
  const label = options?.agentRestrictLabel;
  return typeof label === "string" && label.trim() !== "" && label.length <= MAX_LABEL_LENGTH
    ? label
    : DEFAULT_AGENT_RESTRICT_LABEL;
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

  /** The server-only half of the clock; assigned in `onCreate`. */
  private simClock!: SimClock;

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
  /** The runners' side of the work; unset in a room given no runner. */
  private runnerWork: RunnerWork | undefined;
  /** Read every tick into the state's books; unset in a room given no runner. */
  private runnerSpend: RunnerSpendSource | undefined;
  private issueStates: IssueStates | undefined;
  /** The CEO's prompts to the runners' agents; assigned in `onCreate`. */
  private agentPrompts!: AgentPrompts;
  private screens: ScreenSource | undefined;
  private stopRelayingScreens: (() => void) | undefined;

  /** The AI manager's mind; unset in a room given no advisor. */
  private manager: OfficeManager | undefined;
  /** The concierge's welcomes; unset in a layout with no reception desk. */
  private concierge: ConciergeDesk | undefined;

  /** The runners' standing tasks, copied into the state when they change; unset in a room given no runner. */
  private standing: StandingMirror | undefined;
  private standingVersion = -1;
  /** The CEO's say over the standing tasks, for the roster's buttons and the manager alike. */
  private standingControl: StandingControl | undefined;
  private standingAnnouncer: StandingAnnouncer | undefined;

  /** The CEO's standup; assigned in `onCreate`. */
  private standup!: StandupMeeting;
  /** The CEO's desk terminal; assigned in `onCreate`. */
  private deskTerminal!: DeskTerminal;
  private runnerStandup: RunnerStandupHold | undefined;

  public override onCreate(options?: unknown): void {
    this.state = new OfficeState();
    this.patchRate = TICK_INTERVAL_MS;
    this.interaction = {
      layout: OFFICE_LAYOUT,
      occupants: this.state.occupants,
      motions: this.motions,
      holds: this.holds,
      lastUsedAt: new Map(),
      cups: new CoffeeCups(),
    };
    this.simClock = createSimClock(this.state, this.clock.currentTime);

    const roomOptions = options as Partial<OfficeRoomOptions> | undefined;
    this.reconnectGraceSeconds = graceSecondsOf(roomOptions);
    this.state.agentRestrictLabel = restrictLabelOf(roomOptions);

    const source = roomOptions?.projectBoard;
    if (isProjectBoardSource(source)) {
      this.projectBoard = source;
      this.stopRelayingProjectBoard = relayProjectBoard(this, source);
      // On the feed's own timer, between ticks: an issue GitHub closed is no
      // longer anyone's to work, unless it was a live agent's review, which
      // the closure shipped.
      this.stopReleasingWork = source.subscribe((snapshot) => {
        const shipped: IssueWork[] = [];
        const released = releaseGoneWork(this.state.work, snapshot, shipped);
        for (const work of released) {
          this.runnerWork?.ended(work, `#${work.issueNumber} was closed on GitHub`);
        }
        for (const work of shipped) {
          this.runnerWork?.ended(work, "the work shipped");
          this.announceShipped(work);
        }
      });
    }

    this.crew = new LiveAgentCrew({
      layout: OFFICE_LAYOUT,
      occupants: this.state.occupants,
      interaction: this.interaction,
      work: this.state.work,
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
    const runnerSpend = roomOptions?.runnerSpend;
    if (isRunnerSpendSource(runnerSpend)) {
      this.runnerSpend = runnerSpend;
    }
    const screens = roomOptions?.screens;
    if (isScreenSource(screens)) {
      this.screens = screens;
      // Called from the screens route as each batch is accepted, between ticks.
      this.stopRelayingScreens = screens.onScreens((event) => {
        this.broadcast(SERVER_MESSAGE.screens, event satisfies ScreenFramesEvent);
      });
    }

    // `Date.now()` rather than `this.clock`, because a work timestamp is read
    // as a wall-clock date, not as an offset from this room's start.
    const workHost: WorkHost = {
      state: this.state,
      now: () => Date.now(),
      board: () => this.projectBoard?.current(),
      observe: (change) => {
        this.runnerWork?.changed(change);
      },
    };
    const runnerCommands = isRunnerCommands(roomOptions?.runnerCommands) ? roomOptions.runnerCommands : undefined;
    if (runnerCommands !== undefined) {
      this.runnerWork = new RunnerWork({
        host: workHost,
        runner: runnerCommands,
        log: recordOfficeEvent,
        announce: (text) => this.manager?.report(text),
      });
    }
    registerWorkHandlers(this, workHost);
    this.issueStates = isIssueStates(roomOptions?.issueStates) ? roomOptions.issueStates : undefined;
    registerIssueStateHandler(this, {
      state: this.state,
      board: () => this.projectBoard?.current(),
      issues: this.issueStates,
    });
    const standing = roomOptions?.standing;
    if (isStandingSource(standing) && runnerCommands !== undefined) {
      this.standing = standing;
      this.standingControl = new StandingControl({ directory: standing, commands: runnerCommands });
      this.standingAnnouncer = new StandingAnnouncer({
        // GitHub answers an issue's link for a pull request's number by going to the pull request.
        pullUrl: (number) => runnerCommands.issueUrl(number).replace(/\/issues\/(\d+)$/, "/pull/$1"),
        taskName: (taskId) => standing.standingTasks().find((record) => record.report.id === taskId)?.report.name,
        occupantName: (occupantId) => this.state.occupants.get(occupantId)?.name,
        announce: (text) => this.manager?.report(text),
        refused: (taskId) => standing.refused(taskId),
      });
      registerStandingHandlers(this, {
        state: this.state,
        control: this.standingControl,
        allow: (client, command) => this.spend(client, command),
      });
    }
    this.agentPrompts = new AgentPrompts({
      state: this.state,
      runner: runnerCommands,
      now: () => Date.now(),
      refuse: (sessionId, event) => {
        this.clients.getById(sessionId)?.send(SERVER_MESSAGE.agentPromptRejected, event);
      },
      publish: (entry) => {
        this.broadcast(SERVER_MESSAGE.agentPrompted, entry);
      },
      log: recordOfficeEvent,
      directed: (commandId, outcome) => {
        this.standup.settle(commandId, outcome);
      },
    });
    registerAgentPromptHandlers(this, {
      state: this.state,
      prompts: this.agentPrompts,
      allow: (client) => this.spend(client, CLIENT_MESSAGE.agentPrompt),
      allowKey: (client) => this.spend(client, CLIENT_MESSAGE.agentKey),
    });
    registerAgentProfileHandlers(this, {
      state: this.state,
      runner: runnerCommands,
      allow: (client) => this.spend(client, CLIENT_MESSAGE.agentProfile),
      log: recordOfficeEvent,
    });
    const runnerStandup = roomOptions?.runnerStandup;
    if (isRunnerStandupHold(runnerStandup)) {
      this.runnerStandup = runnerStandup;
    }
    this.standup = new StandupMeeting({
      state: this.state,
      layout: OFFICE_LAYOUT,
      crew: this.crew,
      now: () => Date.now(),
      clock: () => this.clock.currentTime,
      prompts: runnerCommands === undefined ? undefined : this.agentPrompts,
      say: (occupantId, text) => {
        this.broadcast(SERVER_MESSAGE.chat, { occupantId, text } satisfies ChatEvent);
      },
      report: (text) => this.manager?.report(text),
      hold: (on) => this.runnerStandup?.holdForStandup(this.roomId, on),
      log: recordOfficeEvent,
    });
    registerStandupHandlers(this, {
      state: this.state,
      standup: this.standup,
      allowCall: (client) => this.spend(client, CLIENT_MESSAGE.standupStart),
      allowDirection: (client) => this.spend(client, CLIENT_MESSAGE.standupDirect),
    });
    this.deskTerminal = new DeskTerminal({
      state: this.state,
      layout: OFFICE_LAYOUT,
      runner: isDeskRunner(roomOptions?.runnerCommands) ? roomOptions.runnerCommands : undefined,
      log: recordOfficeEvent,
    });
    this.openManagersDesk(workHost, roomOptions);
    this.openReception();

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
    this.sendScreens(client);
    const prompts = this.agentPrompts.history();
    if (prompts.length > 0) {
      client.send(SERVER_MESSAGE.agentPromptHistory, { entries: prompts } satisfies AgentPromptHistoryEvent);
    }
  }

  /** Every screen whole, since the diffs broadcast while this client was away are not repeated. */
  private sendScreens(client: Client): void {
    const screens = this.screens?.fullScreens();
    if (screens !== undefined && screens.screens.length > 0) {
      client.send(SERVER_MESSAGE.screens, screens satisfies ScreenFramesEvent);
    }
  }

  public override onDispose(): void {
    // First, so no manager is left writing to a room that is closing.
    this.manager?.stop();
    this.stopRelayingProjectBoard?.();
    this.stopReleasingWork?.();
    this.stopWatchingLiveAgents?.();
    this.runnerEvents?.close();
    this.stopRelayingScreens?.();
    this.deskTerminal.dispose();
    // A room closing mid-standup must not leave the runners' agents paused.
    this.runnerStandup?.holdForStandup(this.roomId, false);
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
        const reconnected = await this.allowReconnection(client, this.reconnectGraceSeconds);
        this.held.delete(client.sessionId);
        this.sendScreens(reconnected);
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
   * That is a deliberate boundary: the manager answers by calling a model, on
   * its own loop, and the live agents' reports arrive on their own timers; the
   * tick reads what they left without ever waiting on them. If the tick were
   * allowed to await, a slow model would stall every player in the room.
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
    this.standup.step();
    // A runner comes and goes; the board offers its drops only while one is here.
    this.state.issuesWritable = this.issueStates?.canChangeIssues() === true;
    // Drained every tick so a room's inbox never holds more than a tick's
    // worth, after the crew has seated any slot the same sync brought, so
    // each event finds the agent it is about.
    const events = this.runnerEvents?.drain();
    if (events !== undefined && events.length > 0) {
      this.runnerWork?.receive(events);
      this.standingAnnouncer?.receive(events);
      this.deskTerminal.receive(events);
    }
    // Every tick, so standing up hands the desk's agent back at once.
    this.deskTerminal.step();
    if (this.standing !== undefined && this.standing.standingVersion() !== this.standingVersion) {
      this.standingVersion = this.standing.standingVersion();
      copyStandingTasks(this.state.standing, this.standing.standingTasks());
    }
    const prompts = this.runnerEvents?.drainPrompts();
    if (prompts !== undefined && prompts.length > 0) {
      this.agentPrompts.receive(prompts);
    }
    // Once a second: a slot still holding work this room has no record of,
    // as after the room was closed and opened again, is stopped, and a prompt
    // its runner never answered is given up on.
    if (this.state.tick % TICK_RATE_HZ === 0) {
      this.runnerWork?.reconcile();
      this.agentPrompts.expire();
    }
    if (this.runnerSpend !== undefined) {
      this.showRunnerSpend(this.runnerSpend.spend());
    }

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

    this.interaction.cups.step(now, this.state.occupants);
    this.concierge?.step(now);
    stepClock(this.state, this.simClock, now);
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
   * Stands the concierge at reception, to welcome everyone who walks into the
   * lobby, if the floor plan has a reception desk.
   */
  private openReception(): void {
    const concierge = employConcierge(OFFICE_LAYOUT);
    const post = conciergePost(OFFICE_LAYOUT);
    if (concierge === undefined || post === undefined) {
      return;
    }
    this.state.occupants.set(concierge.id, concierge);
    this.concierge = new ConciergeDesk(
      {
        layout: OFFICE_LAYOUT,
        occupants: this.state.occupants,
        say: (occupantId, text) => {
          this.broadcast(SERVER_MESSAGE.chat, { occupantId, text } satisfies ChatEvent);
        },
        wave: (occupantId) => {
          this.broadcast(SERVER_MESSAGE.emote, { occupantId, emote: EMOTE.wave } satisfies EmoteEvent);
        },
      },
      concierge,
      post,
    );
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
      // queue, which a runner's slot is not on. It watches the whole floor only
      // for one that needs someone, so a waiting slot is announced all the same.
      liveAgents: assignments,
      floor: this.liveAgents,
      assignments,
      ...(this.standingControl === undefined ? {} : { standing: this.standingControl }),
      origin: this.roomId,
      publish: (entry) => {
        this.broadcast(SERVER_MESSAGE.managerEntry, entry satisfies ManagerEntry);
      },
      standup: (action, ceo) => this.standup.forManager(action, ceo),
    });
    registerManagerHandlers(this, {
      state: this.state,
      manager: this.manager,
      allow: (client) => this.spend(client, CLIENT_MESSAGE.managerSay),
    });
    this.manager.start();
  }

  /**
   * Copies the runners' books into the state, field by field, so a tick on
   * which nothing was spent sends nothing.
   */
  private showRunnerSpend(total: RunnerSpendTotal): void {
    const { state } = this;
    if (state.spendRunners !== total.runners) {
      state.spendRunners = total.runners;
    }
    if (state.spentUsd !== total.spentUsd) {
      state.spentUsd = total.spentUsd;
    }
    const budgeted = total.budgetUsd !== undefined;
    if (state.budgeted !== budgeted) {
      state.budgeted = budgeted;
    }
    const budgetUsd = total.budgetUsd ?? 0;
    if (state.budgetUsd !== budgetUsd) {
      state.budgetUsd = budgetUsd;
    }
    if (state.budgetSpent !== total.budgetSpent) {
      state.budgetSpent = total.budgetSpent;
    }
  }

  /**
   * Says that a live agent's review shipped, in the agent's own voice, through
   * the chat everyone already reads: the work's move to `done` is state, and
   * this is the why that state cannot carry.
   */
  private announceShipped(work: IssueWork): void {
    recordOfficeEvent("work-shipped", { agent: work.assigneeId, issue: work.issueNumber });
    const text = `Shipped #${work.issueNumber}: ${work.title}`.slice(0, MAX_CHAT_LENGTH);
    this.broadcast(SERVER_MESSAGE.chat, { occupantId: work.assigneeId, text } satisfies ChatEvent);
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
