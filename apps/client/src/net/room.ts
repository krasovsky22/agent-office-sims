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
 * every change. The company's numbers do not: they are state, and are copied out
 * of each patch.
 */

import {
  ANIMATION_STATE,
  type AnimationState,
  type ChatEvent,
  type ChatMessage,
  CLIENT_MESSAGE,
  type Company,
  type CompanyStatus,
  type Emote,
  type EmoteEvent,
  type EmoteMessage,
  INTERPOLATION_DELAY_MS,
  type InteractMessage,
  OFFICE_ROOM_NAME,
  type Occupant,
  type OccupantKind,
  type OfficeState,
  POSE_BUFFER_SIZE,
  POSE_SEND_INTERVAL_MS,
  type PoseMessage,
  type ProjectBoardSnapshot,
  type ReportedAnimation,
  SERVER_MESSAGE,
  type ThrottledEvent,
  isHumanPlayer,
  normalizeYaw,
  shortestYawDelta,
} from "@sim/shared";
import { Client, type Room, getStateCallbacks } from "colyseus.js";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "failed";

/** One pose as received, stamped with local arrival time. */
interface PoseSample {
  t: number;
  x: number;
  z: number;
  yaw: number;
  animation: AnimationState;
}

/**
 * What the HUD and the avatar layer need to know about an occupant.
 *
 * Mutated in place as patches arrive rather than replaced, so the game loop can
 * read one every frame without allocating. Only the fields the HUD renders
 * trigger an `onOccupantsChanged`; `interactableId` changes far too often for
 * that and is read from the loop instead.
 */
export interface OccupantView {
  readonly id: string;
  name: string;
  kind: OccupantKind;
  isCeo: boolean;
  readonly isLocal: boolean;
  /** Interactable this occupant is engaged with, or `""` when free. */
  interactableId: string;
}

/**
 * The company's numbers as of the latest patch.
 *
 * A plain copy rather than the schema instance, so the HUD holds a value that
 * cannot change underneath a render.
 */
export interface CompanyView {
  readonly cash: number;
  readonly morale: number;
  readonly productivity: number;
  readonly day: number;
  readonly minuteOfDay: number;
  readonly status: CompanyStatus;
}

/** The local pose as reported to the server: only states a client may claim. */
export interface ReportedPose {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly animation: ReportedAnimation;
}

/** A pose written by {@link RoomConnection.sampleRemote}. */
export interface RemotePose {
  x: number;
  z: number;
  yaw: number;
  animation: AnimationState;
}

export interface RoomConnectionEvents {
  /** An occupant arrived, left, was renamed, or became CEO. */
  onOccupantsChanged?: () => void;
  onStatusChanged?: (status: ConnectionStatus, detail?: string) => void;
  /** The local player's starting pose, as the server assigned it. */
  onLocalSpawn?: (x: number, z: number, yaw: number) => void;
  /** An occupant emoted. Fired for the local player too, via the server. */
  onEmote?: (event: EmoteEvent) => void;
  /** An occupant said something. Fired for the local player too. */
  onChat?: (event: ChatEvent) => void;
  /** The local client's own emote or chat was dropped by the rate limiter. */
  onThrottled?: (event: ThrottledEvent) => void;
  /** The project board's snapshot, on joining and whenever the server's feed replaces it. */
  onProjectBoard?: (snapshot: ProjectBoardSnapshot) => void;
  /**
   * The company's numbers changed — which, with the clock among them, is several
   * times a second. The caller decides what is worth re-rendering.
   */
  onCompanyChanged?: (company: CompanyView) => void;
}

export class RoomConnection {
  /** Authoritative pose of the local player, for reconciliation. */
  public readonly localServerPose = { x: 0, z: 0, yaw: 0, known: false };

  private room: Room<OfficeState> | undefined;
  private readonly views = new Map<string, OccupantView>();
  private readonly buffers = new Map<string, PoseSample[]>();

  private lastSentAt = Number.NEGATIVE_INFINITY;
  private readonly lastSent = {
    x: Number.NaN,
    z: Number.NaN,
    yaw: Number.NaN,
    animation: ANIMATION_STATE.idle as ReportedAnimation,
  };

  public constructor(private readonly events: RoomConnectionEvents = {}) {}

  public get sessionId(): string {
    return this.room?.sessionId ?? "";
  }

  public async connect(serverUrl: string, name: string): Promise<void> {
    this.events.onStatusChanged?.("connecting");
    try {
      const client = new Client(serverUrl);
      const room = await client.joinOrCreate<OfficeState>(OFFICE_ROOM_NAME, { name });
      this.room = room;
      this.bind(room);
      this.events.onStatusChanged?.("connected");
    } catch (error) {
      this.events.onStatusChanged?.("failed", describeError(error));
      throw error;
    }
  }

  public async leave(): Promise<void> {
    await this.room?.leave();
    this.room = undefined;
    this.views.clear();
    this.buffers.clear();
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

  /** Asks to use an interactable. The server decides; there is no reply. */
  public sendInteract(target: string): void {
    this.room?.send(CLIENT_MESSAGE.interact, { target } satisfies InteractMessage);
  }

  /** Asks to be let go of whatever the local player is engaged with. */
  public sendRelease(): void {
    this.room?.send(CLIENT_MESSAGE.release, {});
  }

  /**
   * Reports the local pose, at most once per {@link POSE_SEND_INTERVAL_MS}.
   *
   * A pose identical to the last one sent is skipped: a player standing still
   * has nothing to report, and the server already shows them idle.
   */
  public sendPose(pose: ReportedPose, nowMs: number): void {
    const room = this.room;
    if (room === undefined || nowMs - this.lastSentAt < POSE_SEND_INTERVAL_MS) {
      return;
    }
    if (
      pose.x === this.lastSent.x &&
      pose.z === this.lastSent.z &&
      pose.yaw === this.lastSent.yaw &&
      pose.animation === this.lastSent.animation
    ) {
      return;
    }

    this.lastSent.x = pose.x;
    this.lastSent.z = pose.z;
    this.lastSent.yaw = pose.yaw;
    this.lastSent.animation = pose.animation;
    this.lastSentAt = nowMs;
    room.send(CLIENT_MESSAGE.pose, {
      x: pose.x,
      z: pose.z,
      yaw: pose.yaw,
      animation: pose.animation,
    } satisfies PoseMessage);
  }

  /**
   * Fires an emote.
   *
   * Nothing is drawn locally in response: the emote is drawn when the server
   * broadcasts it back, which is the same path every other client sees. An
   * emote the server rate-limited away therefore does not appear above the
   * sender's own head either, which is the honest thing to show.
   */
  public sendEmote(emote: Emote): void {
    this.room?.send(CLIENT_MESSAGE.emote, { emote } satisfies EmoteMessage);
  }

  /** Says something out loud. Echoed back by the server, like an emote. */
  public sendChat(text: string): void {
    this.room?.send(CLIENT_MESSAGE.chat, { text } satisfies ChatMessage);
  }

  /**
   * Interpolates a remote occupant's pose for the current frame.
   *
   * @param nowMs the frame's timestamp, from the same clock the samples use.
   * @returns whether `out` was written; `false` means nothing has arrived yet.
   */
  public sampleRemote(id: string, nowMs: number, out: RemotePose): boolean {
    const buffer = this.buffers.get(id);
    if (buffer === undefined || buffer.length === 0) {
      return false;
    }

    const renderTime = nowMs - INTERPOLATION_DELAY_MS;
    const oldest = buffer[0];
    const newest = buffer[buffer.length - 1];
    if (oldest === undefined || newest === undefined) {
      return false;
    }

    // Outside the buffered window there is nothing to interpolate between, so
    // hold the nearest sample rather than extrapolating into a guess.
    if (renderTime <= oldest.t) {
      copySample(oldest, out);
      return true;
    }
    if (renderTime >= newest.t) {
      copySample(newest, out);
      return true;
    }

    for (let i = buffer.length - 1; i > 0; i -= 1) {
      const after = buffer[i];
      const before = buffer[i - 1];
      if (after === undefined || before === undefined || before.t > renderTime) {
        continue;
      }
      const span = after.t - before.t;
      const alpha = span <= 0 ? 1 : (renderTime - before.t) / span;
      out.x = before.x + (after.x - before.x) * alpha;
      out.z = before.z + (after.z - before.z) * alpha;
      out.yaw = normalizeYaw(before.yaw + shortestYawDelta(before.yaw, after.yaw) * alpha);
      out.animation = after.animation;
      return true;
    }

    copySample(newest, out);
    return true;
  }

  private bind(room: Room<OfficeState>): void {
    const $ = getStateCallbacks(room);

    $(room.state).occupants.onAdd((occupant, sessionId) => {
      const isLocal = sessionId === room.sessionId;
      const view: OccupantView = {
        id: sessionId,
        name: occupant.name,
        kind: occupant.kind,
        isCeo: isHumanPlayer(occupant) && occupant.isCeo,
        isLocal,
        interactableId: occupant.interactableId,
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

    // Replicated like the occupants, so every client reads the same numbers off
    // the same patch. The company instance is created once with the room, so a
    // single change listener on it is enough; `listen` fires for the instance the
    // first patch carries.
    $(room.state).listen("company", (company) => {
      this.events.onCompanyChanged?.(companyViewOf(company));
      $(company).onChange(() => {
        this.events.onCompanyChanged?.(companyViewOf(company));
      });
    });

    $(room.state).occupants.onRemove((_occupant, sessionId) => {
      this.views.delete(sessionId);
      this.buffers.delete(sessionId);
      this.events.onOccupantsChanged?.();
    });

    // Expression arrives as events rather than state, so there is nothing to
    // diff here: the server has already validated and sanitized each one, and
    // the handler's job is only to pass it on.
    room.onMessage<EmoteEvent>(SERVER_MESSAGE.emote, (event) => {
      this.events.onEmote?.(event);
    });

    room.onMessage<ChatEvent>(SERVER_MESSAGE.chat, (event) => {
      this.events.onChat?.(event);
    });

    room.onMessage<ThrottledEvent>(SERVER_MESSAGE.throttled, (event) => {
      this.events.onThrottled?.(event);
    });

    room.onMessage<ProjectBoardSnapshot>(SERVER_MESSAGE.projectBoard, (snapshot) => {
      this.events.onProjectBoard?.(snapshot);
    });

    room.onError((code, message) => {
      this.events.onStatusChanged?.("failed", message ?? `error ${code}`);
    });

    room.onLeave(() => {
      this.views.clear();
      this.buffers.clear();
      this.events.onOccupantsChanged?.();
      this.events.onStatusChanged?.("disconnected");
    });
  }

  private handleOccupantChange(
    sessionId: string,
    occupant: Occupant,
    isLocal: boolean,
    view: OccupantView,
  ): void {
    const isCeo = isHumanPlayer(occupant) && occupant.isCeo;
    if (view.name !== occupant.name || view.isCeo !== isCeo || view.kind !== occupant.kind) {
      view.name = occupant.name;
      view.kind = occupant.kind;
      view.isCeo = isCeo;
      this.events.onOccupantsChanged?.();
    }

    // Deliberately outside that notification: this changes as often as
    // someone sits down, and the HUD has no business re-rendering for it.
    view.interactableId = occupant.interactableId;

    if (isLocal) {
      this.readLocalPose(occupant);
      return;
    }

    const buffer = this.buffers.get(sessionId);
    if (buffer === undefined) {
      return;
    }
    const sample = sampleOf(occupant);
    const previous = buffer[buffer.length - 1];
    if (previous !== undefined && previous.t === sample.t) {
      // Two changes decoded in the same frame describe one moment in time.
      buffer[buffer.length - 1] = sample;
      return;
    }
    buffer.push(sample);
    if (buffer.length > POSE_BUFFER_SIZE) {
      buffer.shift();
    }
  }

  private readLocalPose(occupant: Occupant): void {
    this.localServerPose.x = occupant.x;
    this.localServerPose.z = occupant.z;
    this.localServerPose.yaw = occupant.yaw;
    this.localServerPose.known = true;
  }
}

/**
 * Turns whatever the socket threw into something worth putting on screen.
 *
 * A refused WebSocket rejects with a bare `Event`, whose default string form is
 * `[object ProgressEvent]` — true, and useless to the reader.
 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  if (typeof Event !== "undefined" && error instanceof Event) {
    return "the server refused the connection";
  }
  const described = String(error);
  return described === "" || described.startsWith("[object ") ? "unknown error" : described;
}

function companyViewOf(company: Company): CompanyView {
  return {
    cash: company.cash,
    morale: company.morale,
    productivity: company.productivity,
    day: company.day,
    minuteOfDay: company.minuteOfDay,
    status: company.status,
  };
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

function copySample(sample: PoseSample, out: RemotePose): void {
  out.x = sample.x;
  out.z = sample.z;
  out.yaw = sample.yaw;
  out.animation = sample.animation;
}
