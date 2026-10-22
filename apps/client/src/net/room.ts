/**
 * The Colyseus connection, and the translation from replicated state to what the
 * renderer draws.
 *
 * Remote occupants are **interpolated, not snapped**. Poses arrive 20 times a
 * second, which is well under the frame rate, so drawing each remote avatar at
 * the newest pose received would step it forward in visible jumps and stutter
 * whenever a packet arrived late. Instead every pose is kept in a short
 * per-occupant buffer and each avatar is rendered
 * {@link INTERPOLATION_DELAY_MS} behind the present, between the two samples
 * that straddle that moment. The cost is a fixed fraction of a second of
 * staleness; the gain is that remote movement looks continuous.
 *
 * The local player is not interpolated — it is predicted, by the controller —
 * so its authoritative pose is exposed separately for reconciliation.
 *
 * Expression — emotes, chat — does not come through state at all. It arrives as
 * server events and is handed straight to the caller, including the local
 * player's own: everything renders on the path the server published it on, so
 * what you see above your own head is what everyone else sees above it. The
 * project board's GitHub snapshot arrives the same way, whole, on joining and on
 * every change. The clock that lights the office does not: it is state, and is
 * read off each patch.
 *
 * Riding the lift is changing rooms: each floor of the building is one. The
 * floor being left hands over a seat on the floor chosen; the connection
 * leaves on purpose, clears everything of the floor it left, and takes the
 * seat, and the new floor's state then arrives as a join's does. Which floor
 * the office is comes in the state too, for the scene to draw its plan.
 *
 * A dropped socket is reconnected rather than given up on. The server holds a
 * dropped player's place, and with it their role, for
 * {@link RECONNECT_GRACE_SECONDS}; reconnecting inside that window resumes the
 * same session, so a CEO whose wifi blinks is still the CEO afterwards. A
 * session the server no longer knows — it restarted, as every deploy does — is
 * joined afresh under the same name instead, and anything else ends in a status
 * the HUD offers to {@link RoomConnection.rejoin} from.
 *
 * The agents' work on the project board's issues is state too, and is handed
 * on as a fresh plain copy whenever any of it changes, so the panel re-renders
 * from a value rather than holding a schema object that mutates under it. So
 * are the runners' standing tasks, for the roster, and the standup.
 *
 * The conversation with the AI manager is not: like chat it arrives as events —
 * the lines so far on joining, then each new one — and the manager's own badge
 * is read off its occupant. The prompts the CEO typed into the coding agents'
 * terminals arrive the same way.
 *
 * Nor are the live agents' terminal screens, which change several times a
 * second. Each is kept here, whole, by occupant (`./screens.ts`), and read by
 * the game loop when it is time to repaint one; nothing is notified.
 */

import type { BrainstormData } from "@sim/shared";
import {
  type AnimationState,
  NO_STANDUP,
  type LiftSeatEvent,
  type LiveAgentStatus,
  type ManagerStatus,
  OFFICE_ROOM_NAME,
  type Occupant,
  type OccupantKind,
  type OfficeState,
  type Radio,
  RECONNECT_GRACE_SECONDS,
  type Tv,
  type RunnerSpendTotal,
  SERVER_MESSAGE,
  type ScreenFramesEvent,
  isAiManager,
  isCeo,
  isLiveAgent,
} from "@sim/shared";
import { Client, ErrorCode, MatchMakeError, type Room, type SeatReservation, getStateCallbacks } from "colyseus.js";

import { type PoseSample, type RemotePose, pushPose, samplePoses } from "./poseBuffer.js";
import { RoomCommands } from "./roomCommands.js";
import { type RoomConnectionEvents, forwardServerEvents } from "./roomEvents.js";
import { type TerminalScreen, applyScreenFrame } from "./screens.js";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "full"
  | "failed";

/** Pause between reconnection attempts while the server's grace period lasts. */
const RECONNECT_RETRY_MS = 1000;

/**
 * What the HUD renders of an occupant, read off its replicated state.
 *
 * The one list of these fields: {@link hudFieldsOf} builds them, a change to
 * any of them is what triggers an `onOccupantsChanged`, and the HUD's roster
 * entry is typed from them.
 */
export interface OccupantHudFields {
  name: string;
  kind: OccupantKind;
  isCeo: boolean;
  /** A live coding agent's status, or `undefined` for anyone else. */
  agentStatus: LiveAgentStatus | undefined;
  /** A live agent's task title and link, `""` when it has none. The server only passes `https:` links. */
  taskTitle: string;
  taskUrl: string;
  /** What a live agent is doing, or waits on while it needs input; `""` when unknown. */
  agentActivity: string;
  /** What the manager has assigned a live agent next, `""` when nothing. Only `https:` links. */
  assignedTitle: string;
  assignedUrl: string;
  /** Whether a live agent can be given issue work; `false` for anyone else. */
  canTakeIssues: boolean;
  /** A live agent's title, `""` when it has none and for anyone else. */
  title: string;
  /** A live agent's description, its system prompt with the title; `""` when none. */
  description: string;
  /** Whether the CEO can edit a live agent's profile from the office; `false` for anyone else. */
  profileEditable: boolean;
  /** Whether a live agent was fired and is walking out; `false` for anyone else. */
  fired: boolean;
  /** The issue whose sticky note a live agent has in hand, `0` when none and for anyone else. */
  carriedIssue: number;
  /** The AI manager's status, or `undefined` for anyone else. */
  managerStatus: ManagerStatus | undefined;
  /** What a live agent's runner says it has spent today, in US dollars; `0` for anyone else. */
  agentSpentUsd: number;
}

/** Reads the {@link OccupantHudFields} off an occupant as replicated. */
export function hudFieldsOf(occupant: Occupant): OccupantHudFields {
  const agent = isLiveAgent(occupant) ? occupant : undefined;
  return {
    name: occupant.name,
    kind: occupant.kind,
    isCeo: isCeo(occupant),
    agentStatus: agent?.status,
    taskTitle: agent?.taskTitle ?? "",
    taskUrl: agent?.taskUrl ?? "",
    agentActivity: agent?.activity ?? "",
    assignedTitle: agent?.assignedTitle ?? "",
    assignedUrl: agent?.assignedUrl ?? "",
    canTakeIssues: agent?.canTakeIssues ?? false,
    title: agent?.title ?? "",
    description: agent?.description ?? "",
    profileEditable: agent?.profileEditable ?? false,
    fired: agent?.fired ?? false,
    carriedIssue: agent?.carriedIssue ?? 0,
    managerStatus: isAiManager(occupant) ? occupant.status : undefined,
    agentSpentUsd: agent?.spentTodayUsd ?? 0,
  };
}

/** Copies `fields` onto `view` if any of them differ, and says whether they did. */
export function assignHudFields(view: OccupantHudFields, fields: OccupantHudFields): boolean {
  const changed = (Object.keys(fields) as (keyof OccupantHudFields)[]).some((key) => view[key] !== fields[key]);
  if (changed) {
    Object.assign(view, fields);
  }
  return changed;
}

/**
 * What the HUD and the avatar layer need to know about an occupant.
 *
 * Mutated in place as patches arrive rather than replaced, so the game loop can
 * read one every frame without allocating. Only the {@link OccupantHudFields}
 * trigger an `onOccupantsChanged`; `interactableId` and `animation` change far
 * too often for that and are read from the loop instead.
 */
export interface OccupantView extends OccupantHudFields {
  readonly id: string;
  readonly isLocal: boolean;
  /** Interactable this occupant is engaged with, or `""` when free. */
  interactableId: string;
  /** As replicated, so a seated agent can be drawn typing rather than just sitting. */
  animation: AnimationState;
  /** Sips left in the coffee in hand, `0` for no cup; each drop is a sip. */
  coffeeSips: number;
}

/** The runners' books as the state replicates them, back as one total. */
function runnerSpendOf(state: Pick<OfficeState, "spendRunners" | "spentUsd" | "budgeted" | "budgetUsd" | "budgetSpent">): RunnerSpendTotal {
  return {
    runners: state.spendRunners,
    spentUsd: state.spentUsd,
    budgetUsd: state.budgeted ? state.budgetUsd : undefined,
    budgetSpent: state.budgetSpent,
  };
}

export class RoomConnection extends RoomCommands {
  /** Authoritative pose of the local player, for reconciliation. */
  public readonly localServerPose = { x: 0, z: 0, yaw: 0, known: false };

  private client: Client | undefined;
  /** The name first asked for, which a fresh join after a lost session asks for again. */
  private name = "";
  /** Set while a join is in flight, so a second click on Rejoin cannot seat the player twice. */
  private joining = false;
  /** Set by {@link leave}, so a deliberate exit is never reconnected. */
  private leaving = false;
  /** Set while the lift takes the player from one floor's room to another's, so leaving the first is not a drop. */
  private riding = false;
  /** The room of the floor the player is on, which a fresh join after a lost session joins again. */
  private roomName = OFFICE_ROOM_NAME;
  private readonly views = new Map<string, OccupantView>();
  private readonly buffers = new Map<string, PoseSample[]>();
  private readonly screens = new Map<string, TerminalScreen>();

  /** The publishers already due this patch, by {@link queue}. */
  private readonly queued = new Set<(state: OfficeState) => void>();

  public constructor(private readonly events: RoomConnectionEvents = {}) {
    super();
  }

  public get sessionId(): string {
    return this.room?.sessionId ?? "";
  }

  public async connect(serverUrl: string, name: string): Promise<void> {
    this.client = new Client(serverUrl);
    this.name = name;
    await this.join();
  }

  /** The player's own Rejoin, which overrides an earlier {@link leave}. */
  public async rejoin(): Promise<void> {
    this.leaving = false;
    await this.join();
  }

  /** Joins the office afresh, as a new session; does nothing while one is attached or on its way, or after a leave. */
  private async join(): Promise<void> {
    const client = this.client;
    if (client === undefined || this.room !== undefined || this.joining || this.leaving) {
      return;
    }
    this.joining = true;
    this.events.onStatusChanged?.("connecting");
    try {
      const room = await client.join<OfficeState>(this.roomName, { name: this.name });
      if (this.leaving) {
        void room.leave();
        return;
      }
      this.attach(room);
    } catch (error) {
      if (isOfficeFull(error)) {
        this.events.onStatusChanged?.("full");
      } else {
        this.events.onStatusChanged?.("failed", describeError(error));
      }
      throw error;
    } finally {
      this.joining = false;
    }
  }

  public async leave(): Promise<void> {
    this.leaving = true;
    await this.room?.leave();
    this.room = undefined;
    this.views.clear();
    this.buffers.clear();
    this.screens.clear();
  }

  /** Every occupant currently in the room, in arrival order. */
  public occupants(): OccupantView[] {
    return [...this.views.values()];
  }

  /**
   * The display name of one occupant, for attributing an event to them.
   *
   * `undefined` when the occupant is unknown, which an event can outrun: a
   * message broadcast as its sender disconnects may be decoded after the state
   * patch that removed them.
   */
  public occupantName(id: string): string | undefined {
    return this.views.get(id)?.name;
  }

  /** One occupant, for a game loop that must not allocate. */
  public viewOf(id: string): OccupantView | undefined {
    return this.views.get(id);
  }

  /**
   * A live agent's terminal, as of the latest frame, or `undefined` before the
   * first. Changed in place as frames arrive; its `version` says when.
   */
  public screenOf(id: string): TerminalScreen | undefined {
    return this.screens.get(id);
  }

  /**
   * The occupant holding an interactable, or `undefined` if it is free.
   *
   * Read from replicated state, which makes it the server's answer as of the
   * last patch. Good enough to grey out a prompt; the server decides for real.
   */
  public holderOf(interactableId: string): string | undefined {
    for (const view of this.views.values()) {
      if (view.interactableId === interactableId) {
        return view.id;
      }
    }
    return undefined;
  }

  /**
   * The desk terminals that are on, by seat id, as of the last patch, or
   * `undefined` before the state arrives. Read in place by the game loop, which must not allocate.
   */
  public desks(): OfficeState["desks"] | undefined {
    return this.room?.state.desks;
  }

  /** What the office radio plays as of the last patch, or `undefined` before the state arrives. Read in place, like {@link desks}. */
  public radio(): Radio | undefined {
    return this.room?.state.radio;
  }

  /** What the conference room's TV shows as of the last patch, or `undefined` before the state arrives. Read in place, like {@link radio}. */
  public tv(): Tv | undefined {
    return this.room?.state.tv;
  }

  /** The label that keeps an issue from the live coding agents; `""` before the state arrives. */
  public agentRestrictLabel(): string {
    return this.room?.state.agentRestrictLabel ?? "";
  }

  /** Whether a connected runner can close and reopen issues on GitHub; `false` before the state arrives. */
  public issuesWritable(): boolean {
    return this.room?.state.issuesWritable ?? false;
  }

  /**
   * Interpolates a remote occupant's pose for the current frame.
   *
   * @param nowMs the frame's timestamp, from the same clock the samples use.
   * @returns whether `out` was written; `false` means nothing has arrived yet.
   */
  public sampleRemote(id: string, nowMs: number, out: RemotePose): boolean {
    const buffer = this.buffers.get(id);
    return buffer !== undefined && samplePoses(buffer, nowMs, out);
  }

  private attach(room: Room<OfficeState>): void {
    this.room = room;
    this.roomName = room.name;
    this.bind(room);
    this.events.onStatusChanged?.("connected");
  }

  /**
   * Tries to resume a dropped session until the server's grace period ends,
   * or the server says it no longer has it, then joins afresh.
   *
   * Runs on its own async path, between frames; the game loop keeps drawing
   * the office it last knew, and nothing is sent until a room is attached
   * again.
   */
  private async reconnect(token: string): Promise<void> {
    const client = this.client;
    if (client === undefined) {
      return;
    }
    this.events.onStatusChanged?.("reconnecting");
    const deadline = Date.now() + RECONNECT_GRACE_SECONDS * 1000;
    while (!this.leaving && Date.now() < deadline) {
      try {
        const room = await client.reconnect<OfficeState>(token);
        if (this.leaving) {
          void room.leave();
          return;
        }
        this.attach(room);
        return;
      } catch (error) {
        if (isSessionGone(error)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_RETRY_MS));
      }
    }
    await this.join().catch(() => {
      // The status is already on the HUD, and Rejoin with it.
    });
  }

  private bind(room: Room<OfficeState>): void {
    const $ = getStateCallbacks(room);

    $(room.state).occupants.onAdd((occupant, sessionId) => {
      const isLocal = sessionId === room.sessionId;
      const view: OccupantView = {
        id: sessionId,
        isLocal,
        interactableId: occupant.interactableId,
        animation: occupant.animation,
        coffeeSips: occupant.coffeeSips,
        ...hudFieldsOf(occupant),
      };
      this.views.set(sessionId, view);

      if (isLocal) {
        this.readLocalPose(occupant);
        this.events.onLocalSpawn?.(occupant.x, occupant.z, occupant.yaw);
      } else {
        this.buffers.set(sessionId, [sampleOf(occupant)]);
      }

      $(occupant).onChange(() => {
        this.handleOccupantChange(sessionId, occupant, isLocal, view);
      });

      this.events.onOccupantsChanged?.();
    });

    // Replicated like the occupants, so every client lights the office by the
    // same clock; `listen` fires for the value the first patch carries too.
    $(room.state).listen("minuteOfDay", (minuteOfDay) => {
      this.events.onClockChanged?.(minuteOfDay);
    });

    // Both at once, once a patch: the plan is drawn from the two together.
    const floorChanged = (): void => this.queue(room, this.publishFloor);
    $(room.state).listen("floor", floorChanged);
    $(room.state).listen("floors", floorChanged);

    // What the board offers is worked out with the roster, and a runner that
    // can change issues coming or going changes it.
    $(room.state).listen("issuesWritable", () => {
      this.events.onOccupantsChanged?.();
    });

    // Five fields, one total: whichever of them a patch carries, the HUD hears the whole of it.
    const spendChanged = (): void => {
      this.events.onSpendChanged?.(runnerSpendOf(room.state));
    };
    for (const field of ["spendRunners", "spentUsd", "budgeted", "budgetUsd", "budgetSpent"] as const) {
      $(room.state).listen(field, spendChanged);
    }

    $(room.state).occupants.onRemove((_occupant, sessionId) => {
      this.views.delete(sessionId);
      this.buffers.delete(sessionId);
      this.screens.delete(sessionId);
      this.events.onOccupantsChanged?.();
    });

    const workChanged = (): void => this.queue(room, this.publishWork);
    $(room.state).work.onAdd((work) => {
      $(work).onChange(workChanged);
      workChanged();
    });
    $(room.state).work.onRemove(workChanged);

    // An idea and everything in it, down to one write-up's verdict, comes out as one fresh copy.
    const brainstormsChanged = (): void => this.queue(room, this.publishBrainstorms);
    $(room.state).brainstorms.onAdd((brainstorm) => {
      const idea = $(brainstorm);
      idea.onChange(brainstormsChanged);
      idea.takes.onAdd((take) => {
        $(take).onChange(brainstormsChanged);
        brainstormsChanged();
      });
      idea.takes.onRemove(brainstormsChanged);
      idea.created.onAdd(brainstormsChanged);
      brainstormsChanged();
    });
    $(room.state).brainstorms.onRemove(brainstormsChanged);

    const standingChanged = (): void => this.queue(room, this.publishStanding);
    $(room.state).standing.onAdd((task) => {
      $(task).onChange(standingChanged);
      standingChanged();
    });
    $(room.state).standing.onRemove(standingChanged);

    // Every part of the standup, down to one direction's fate, comes out as one
    // fresh copy. Bound once the standup itself has arrived: the first patch
    // may not have decoded it yet, and Colyseus' callbacks cannot reach a
    // collection inside a schema that is not there.
    const standupChanged = (): void => this.queue(room, this.publishStandup);
    $(room.state).listen("standup", (instance) => {
      const standup = $(instance);
      standup.onChange(standupChanged);
      standup.order.onAdd(standupChanged);
      standup.order.onRemove(standupChanged);
      standup.updates.onAdd((update) => {
        $(update).onChange(standupChanged);
        standupChanged();
      });
      standup.updates.onRemove(standupChanged);
      standup.directions.onAdd((direction) => {
        $(direction).onChange(standupChanged);
        standupChanged();
      });
      standup.directions.onRemove(standupChanged);
      standupChanged();
    });

    forwardServerEvents(room, this.events);

    // Several times a second, so kept rather than passed on: the game loop
    // reads a screen when it is due a repaint.
    room.onMessage<ScreenFramesEvent>(SERVER_MESSAGE.screens, (event) => {
      for (const { occupantId, frame } of event.screens) {
        this.screens.set(occupantId, applyScreenFrame(this.screens.get(occupantId), frame));
      }
    });

    room.onMessage<LiftSeatEvent>(SERVER_MESSAGE.liftSeat, (event) => {
      void this.ride(room, event);
    });

    room.onError((code, message) => {
      this.events.onStatusChanged?.("failed", message ?? `error ${code}`);
    });

    room.onLeave(() => {
      // A room this connection has already moved on from has nothing to clear.
      if (this.room !== room && this.room !== undefined) {
        return;
      }
      this.views.clear();
      this.buffers.clear();
      this.screens.clear();
      this.events.onOccupantsChanged?.();
      this.events.onWorkChanged?.([]);
      this.events.onBrainstormsChanged?.([]);
      this.events.onStandingChanged?.([]);
      this.events.onStandupChanged?.(NO_STANDUP);
      this.room = undefined;
      if (this.leaving) {
        this.events.onStatusChanged?.("disconnected");
        return;
      }
      // Left on purpose, for the floor the lift is taking the player to.
      if (this.riding) {
        return;
      }
      // Even a clean close is reconnected from: the server never sends one
      // player away, so it is shutting down, and its successor needs joining.
      // Rebuilt from the full state the server sends on reconnection, which
      // re-adds every occupant through the handlers above.
      void this.reconnect(room.reconnectionToken);
    });
  }

  /**
   * Takes the player from the floor they are on to the seat the lift kept for
   * them on another: leaves this floor's room, then joins that one's.
   *
   * Left first, so the player is never in two floors at once and nothing of
   * the floor left can arrive after the new one's state. A seat that cannot
   * be taken, kept too long or the floor gone, ends in a fresh join of the
   * floor left, as after a lost session.
   */
  private async ride(from: Room<OfficeState>, event: LiftSeatEvent): Promise<void> {
    const client = this.client;
    if (client === undefined || this.room !== from || this.riding) {
      return;
    }
    this.riding = true;
    this.events.onRide?.(event.floor);
    try {
      await from.leave();
      // The library reads the room's name and ids off a listing; the counts are the server's business.
      const seat: SeatReservation = { sessionId: event.reservation.sessionId, room: { ...event.reservation.room, clients: 0, maxClients: 0 } };
      const next = await client.consumeSeatReservation<OfficeState>(seat);
      if (this.leaving) {
        void next.leave();
        return;
      }
      this.attach(next);
    } catch {
      this.riding = false;
      await this.join().catch(() => {
        // The status is already on the HUD, and Rejoin with it.
      });
    } finally {
      this.riding = false;
    }
  }

  private handleOccupantChange(
    sessionId: string,
    occupant: Occupant,
    isLocal: boolean,
    view: OccupantView,
  ): void {
    if (isLocal) {
      // A later rejoin asks for the name the player has now, not the one they arrived with.
      this.name = occupant.name;
    }
    if (assignHudFields(view, hudFieldsOf(occupant))) {
      this.events.onOccupantsChanged?.();
    }

    // Deliberately outside that notification: these change as often as
    // someone sits down, and the HUD has no business re-rendering for them.
    view.interactableId = occupant.interactableId;
    view.animation = occupant.animation;
    view.coffeeSips = occupant.coffeeSips;

    if (isLocal) {
      this.readLocalPose(occupant);
      return;
    }

    const buffer = this.buffers.get(sessionId);
    if (buffer === undefined) {
      return;
    }
    pushPose(buffer, sampleOf(occupant));
  }

  /**
   * Publishes one part of the state once per patch, however much of it the
   * patch touched.
   *
   * One patch can carry a change to every issue's work — a join decodes all of
   * it at once — and copying it per field would hand React a burst of
   * intermediate states nobody will see.
   */
  private queue(room: Room<OfficeState>, publish: (state: OfficeState) => void): void {
    if (this.queued.has(publish)) {
      return;
    }
    this.queued.add(publish);
    queueMicrotask(() => {
      this.queued.delete(publish);
      if (this.room === room) {
        publish(room.state);
      }
    });
  }

  // Plain copies, so React never holds a schema object that mutates under it.
  private readonly publishWork = (state: OfficeState): void => {
    this.events.onWorkChanged?.([...state.work.values()].map((work) => work.toJSON()));
  };

  private readonly publishBrainstorms = (state: OfficeState): void => {
    this.events.onBrainstormsChanged?.([...state.brainstorms.values()].map((brainstorm) => brainstorm.toJSON() as BrainstormData));
  };

  private readonly publishStanding = (state: OfficeState): void => {
    this.events.onStandingChanged?.([...state.standing.values()].map((task) => task.toJSON()));
  };

  private readonly publishFloor = (state: OfficeState): void => {
    this.events.onFloorChanged?.(state.floor, state.floors);
  };

  private readonly publishStandup = (state: OfficeState): void => {
    this.events.onStandupChanged?.(state.standup.toJSON());
  };

  private readLocalPose(occupant: Occupant): void {
    this.localServerPose.x = occupant.x;
    this.localServerPose.z = occupant.z;
    this.localServerPose.yaw = occupant.yaw;
    this.localServerPose.known = true;
  }
}

/** The server opens one office and lets clients only join it, so a join it cannot seat means the office is full. */
export function isOfficeFull(error: unknown): boolean {
  return error instanceof MatchMakeError && error.code === ErrorCode.MATCHMAKE_INVALID_CRITERIA;
}

/**
 * Whether the server answered a reconnection with "no such session", which no
 * retry will change: its room is gone, as after a restart, or the seat expired.
 */
export function isSessionGone(error: unknown): boolean {
  return (
    error instanceof MatchMakeError &&
    (error.code === ErrorCode.MATCHMAKE_INVALID_ROOM_ID || error.code === ErrorCode.MATCHMAKE_EXPIRED)
  );
}

/**
 * Turns whatever the socket threw into something worth putting on screen.
 *
 * A refused WebSocket rejects with a bare `Event`, whose default string form is
 * `[object ProgressEvent]` — true, and useless to the reader.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  if (typeof Event !== "undefined" && error instanceof Event) {
    return "the server refused the connection";
  }
  const described = String(error);
  return described === "" || described.startsWith("[object ") ? "unknown error" : described;
}

function sampleOf(occupant: Occupant): PoseSample {
  return {
    t: performance.now(),
    x: occupant.x,
    z: occupant.z,
    yaw: occupant.yaw,
    animation: occupant.animation,
  };
}
