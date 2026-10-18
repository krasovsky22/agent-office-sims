/**
 * The live coding agents' bodies: what each one does on the floor, tick by tick.
 *
 * A working agent claims the nearest free workstation on the open floor, walks
 * the waypoint graph to just behind its chair, and sits down through the same
 * interaction a player uses — `requestInteract`, which checks the range and
 * whether anyone already holds the seat. So an agent never takes a chair a
 * player or another agent is in, and a player sees an agent's chair as taken
 * exactly as they would a player's. Once seated it types.
 *
 * An idle agent stands up the same way a player does, then wanders between
 * rooms on the waypoint graph, resting a few seconds at each stop. Two idle
 * agents that come within a few metres of each other in the same room stop,
 * turn to face each other, and trade a short canned exchange, broadcast as
 * ordinary chat so every client draws it with the speech bubbles players get.
 * Half the time a wandering agent heads for wherever another idle agent is,
 * which is what makes those meetings happen at all in an office this size.
 *
 * Every step goes through `resolveMove`, the collision function players are
 * validated with, so an agent cannot walk anywhere a player could not.
 *
 * The sticky notes on the sticker boards are walked about too. An agent that
 * starts an issue first goes to the issues board and takes the issue's note,
 * then carries it to its desk; one that hands in a pull request stands up,
 * takes the note to the pull requests board and pins it there; and one whose
 * work stops, or is taken off it, puts the note back on the issues board. Each
 * errand comes first, before sitting or wandering, and the note only changes
 * hands — `carriedIssue` — once the agent has stood at the board for a moment,
 * so what a client draws matches where the body is. Which note and which board
 * are `stickerNotes.ts`'s rules, shared with the clients that draw them.
 *
 * All of it is synchronous and runs inside the room's tick. What the agents are
 * meant to be doing arrives from the feed as a finished list; the tick reads it
 * through {@link LiveAgentCrew.sync} without waiting on anything.
 */

import { type MapSchema } from "@colyseus/schema";
import {
  ANIMATION_STATE,
  type InteractableSpec,
  ISSUES_STICKER_BOARD_ID,
  type IssueWork,
  LIVE_AGENT_STATUS,
  LiveAgent,
  type LiveAgentStatus,
  OCCUPANT_RADIUS,
  SIDEWALK_ROOM_ID,
  type Occupant,
  type OfficeLayout,
  type Vec2,
  WALK_SPEED,
  distanceToInteractable,
  findPath,
  interactableById,
  isClearLine,
  isLiveAgentOnTask,
  liveAgentKey,
  liveAgentSeats,
  nearestWaypoint,
  noteDestination,
  noteToFetch,
  normalizeYaw,
  releaseWorkOf,
  resolveMove,
  roomAt,
} from "@sim/shared";

import type { LiveAgentRecord } from "../agents/registry.js";
import { type InteractionHost, releaseHold, requestInteract } from "./interaction.js";

/** Closer than this to a point on the route counts as having reached it. */
const ARRIVE_DISTANCE = 0.05;

/**
 * Ticks of making almost no headway before the current route point is given up.
 *
 * The routes are built clear of the geometry, so this is a backstop for a body
 * pushed somewhere unexpected — never a way of steering.
 */
const STUCK_TICKS = 20;

/** A step that covers less than this fraction of its stride is not progress. */
const STUCK_FRACTION = 0.2;

/** How close two idle agents have to come before they stop to talk. */
export const MEET_DISTANCE = 2.5;

/** Gap between one line of a conversation and the reply. */
export const LINE_GAP_MS = 2400;

/** Pause before the first line, once the two have turned to face each other. */
const OPENING_PAUSE_MS = 400;

/** How long after a conversation an agent will not start another. */
export const CHAT_COOLDOWN_MS = 20_000;

/** How long an idle agent rests at each stop, as a range. */
const REST_MIN_MS = 2000;
const REST_MAX_MS = 6000;

/** How long an agent stands beside its chair after getting up, before it wanders off. */
const STAND_UP_PAUSE_MS = 1000;

/** How often a working agent with no free chair looks again. */
const SEAT_RETRY_MS = 1500;

/** Chance a wandering agent heads for another idle agent rather than anywhere. */
const SEEK_COMPANY_CHANCE = 0.5;

/**
 * How long an agent stands at a sticker board taking a note off it or pinning
 * one on, before the note changes hands: long enough to read as doing it.
 */
export const NOTE_HANDLING_MS = 1200;

/** How often an agent waiting for a note another agent still holds looks again. */
const NOTE_RETRY_MS = 1500;

/**
 * What two idle agents say to each other, alternating, first speaker first.
 *
 * Canned on purpose: the point of the exchange is to show two of them are
 * between tasks, not to say anything.
 */
export const CONVERSATIONS: readonly (readonly string[])[] = [
  ["Finally shipped that PR.", "Nice. Green first time?", "Third time. Don't ask.", "Ha. Coffee?"],
  ["Anyone touched state.ts today?", "I'm rebasing on it now.", "Good luck with the conflicts.", "I'll need it."],
  ["Waiting on review again.", "Same. Want to pair on something?", "Sure, grab the next issue.", "On it."],
  ["Between tasks?", "Yep, queue's empty.", "Enjoy it while it lasts.", "It never does."],
  ["Typecheck is clean, finally.", "Strict mode is no joke.", "Worth it, though.", "Every time."],
  ["Lint caught a console.log.", "Classic.", "It was mine.", "We've all been there."],
  ["Did you see the new board?", "The one on the north wall?", "Our issues are all up there.", "Mine's in review!"],
  ["How's the test suite?", "All passing here.", "Even the flaky one?", "Don't jinx it."],
];

interface Conversation {
  readonly first: AgentBody;
  readonly second: AgentBody;
  readonly lines: readonly string[];
  spoken: number;
  nextLineAt: number;
}

/** A walk to a sticker board, to take a note off it or pin the one in hand. */
interface NoteErrand {
  readonly kind: "fetch" | "pin";
  readonly issueNumber: number;
  readonly boardId: string;
  /** Room clock time it reached the board and began handling the note; `undefined` while walking. */
  arrivedAt: number | undefined;
}

interface AgentBody {
  readonly key: string;
  readonly occupant: LiveAgent;
  status: LiveAgentStatus;
  /** Points still to walk, current target first. */
  route: Vec2[];
  /** The seat this agent is walking to or sitting in, or `""`. */
  seatId: string;
  /** Seats it walked to and was refused, skipped until it next sits down. */
  readonly refusedSeats: Set<string>;
  /** Room clock time it next does something, while standing still. */
  restUntil: number;
  stuckTicks: number;
  conversation: Conversation | undefined;
  /** Room clock time it may start another conversation. */
  chatReadyAt: number;
  /** The sticker board it is on its way to or standing at, or `undefined`. */
  errand: NoteErrand | undefined;
  /** Room clock time it next looks for a note it found another agent holding. */
  noteRetryAt: number;
}

/** What the crew needs from the room, named so a test can supply it. */
export interface LiveAgentHost {
  readonly layout: OfficeLayout;
  readonly occupants: {
    get(key: string): Occupant | undefined;
    set(key: string, occupant: Occupant): unknown;
    delete(key: string): unknown;
  };
  readonly interaction: InteractionHost;
  /**
   * The office's issue work, so an agent leaving puts down what it had not
   * finished; see `releaseWorkOf`.
   */
  readonly work: MapSchema<IssueWork>;
  /** Broadcasts a line of chat from an occupant. */
  readonly say: (occupantId: string, text: string) => void;
  /** In [0, 1). Injected so a test can make the wandering repeatable. */
  readonly random: () => number;
}

export class LiveAgentCrew {
  private readonly bodies = new Map<string, AgentBody>();
  private readonly conversations = new Set<Conversation>();
  private readonly entrances: readonly Vec2[];
  private entranceCursor = 0;

  public constructor(private readonly host: LiveAgentHost) {
    // Agents walk in through the open floor's doorways, which is where their
    // desks are; a doorway centre is always clear floor.
    const floorId = roomAt(host.layout, liveAgentSeats(host.layout)[0]?.anchor ?? { x: 0, z: 0 })?.id;
    this.entrances = host.layout.doorways
      .filter((doorway) => floorId !== undefined && doorway.connects.includes(floorId))
      .map((doorway) => doorway.centre);
  }

  /** How many agents are on the floor. */
  public get size(): number {
    return this.bodies.size;
  }

  /**
   * Brings the bodies on the floor in line with the feed's list: arrivals walk
   * in, departures vanish and free their chairs, and everyone else takes on
   * their new status, task, and whatever the manager has assigned them next.
   */
  public sync(records: readonly LiveAgentRecord[], now: number): void {
    const present = new Set<string>();
    for (const record of records) {
      present.add(record.id);
      const body = this.bodies.get(record.id) ?? this.arrive(record, now);
      this.update(body, record, now);
    }
    for (const [id, body] of this.bodies) {
      if (!present.has(id)) {
        this.depart(id, body, now);
      }
    }
  }

  /** One tick. `deltaSeconds` is the time since the last one. */
  public step(now: number, deltaSeconds: number): void {
    for (const body of this.bodies.values()) {
      if (this.stepErrand(body, now, deltaSeconds)) {
        continue;
      }
      if (isLiveAgentOnTask(body.status)) {
        this.stepWorking(body, now, deltaSeconds);
      } else if (body.conversation === undefined) {
        this.stepIdle(body, now, deltaSeconds);
      }
    }
    for (const conversation of this.conversations) {
      this.stepConversation(conversation, now);
    }
    this.startConversations(now);
  }

  private arrive(record: LiveAgentRecord, now: number): AgentBody {
    const entrance = this.entrances[this.entranceCursor % Math.max(this.entrances.length, 1)] ?? {
      x: 0,
      z: 0,
    };
    this.entranceCursor += 1;

    const key = liveAgentKey(record.id);
    const occupant = new LiveAgent();
    occupant.id = key;
    occupant.x = entrance.x;
    occupant.z = entrance.z;
    occupant.animation = ANIMATION_STATE.idle;

    const body: AgentBody = {
      key,
      occupant,
      status: record.status,
      route: [],
      seatId: "",
      refusedSeats: new Set(),
      restUntil: now,
      stuckTicks: 0,
      conversation: undefined,
      chatReadyAt: now,
      errand: undefined,
      noteRetryAt: now,
    };
    this.bodies.set(record.id, body);
    this.host.occupants.set(key, occupant);
    return body;
  }

  private update(body: AgentBody, record: LiveAgentRecord, now: number): void {
    const { occupant } = body;
    const title = record.task?.title ?? "";
    const url = record.task?.url ?? "";
    // Written only when different, so a sync that changes one agent does not
    // put every other agent's label in the next patch.
    if (occupant.name !== record.name) {
      occupant.name = record.name;
    }
    if (occupant.status !== record.status) {
      occupant.status = record.status;
    }
    if (occupant.taskTitle !== title) {
      occupant.taskTitle = title;
    }
    if (occupant.taskUrl !== url) {
      occupant.taskUrl = url;
    }
    const activity = record.activity ?? "";
    if (occupant.activity !== activity) {
      occupant.activity = activity;
    }
    const assignedTitle = record.assignment?.title ?? "";
    const assignedUrl = record.assignment?.url ?? "";
    if (occupant.assignedTitle !== assignedTitle) {
      occupant.assignedTitle = assignedTitle;
    }
    if (occupant.assignedUrl !== assignedUrl) {
      occupant.assignedUrl = assignedUrl;
    }
    const canTakeIssues = record.canTakeIssues === true;
    if (occupant.canTakeIssues !== canTakeIssues) {
      occupant.canTakeIssues = canTakeIssues;
    }
    if (body.status !== record.status) {
      body.status = record.status;
      body.restUntil = now;
    }
  }

  private depart(id: string, body: AgentBody, now: number): void {
    if (body.conversation !== undefined) {
      this.endConversation(body.conversation, now);
    }
    // Before the occupant goes, so the chair is free on the same patch the
    // body disappears in.
    this.host.interaction.holds.release(body.key);
    this.host.interaction.lastUsedAt.delete(body.key);
    releaseWorkOf(body.key, this.host.work);
    this.host.occupants.delete(body.key);
    this.bodies.delete(id);
  }

  /**
   * Runs the agent's sticky-note errand, if it has one or now needs one.
   *
   * Looked at afresh every tick, so an errand whose reason went away — work
   * taken back while the agent walked to fetch it, a fresh start while it
   * walked the note back — is dropped or turned round rather than finished.
   *
   * @returns whether the errand had the body this tick, so it neither sits nor wanders.
   */
  private stepErrand(body: AgentBody, now: number, deltaSeconds: number): boolean {
    const wanted = this.errandFor(body, now);
    if (wanted === undefined) {
      if (body.errand !== undefined) {
        body.errand = undefined;
        body.route = [];
      }
      return false;
    }
    if (
      body.errand === undefined ||
      body.errand.kind !== wanted.kind ||
      body.errand.issueNumber !== wanted.issueNumber ||
      body.errand.boardId !== wanted.boardId
    ) {
      body.errand = wanted;
      body.route = [];
    }
    const errand = body.errand;
    const { occupant } = body;
    const spot = interactableById(this.host.layout, errand.boardId)?.anchor;
    if (spot === undefined) {
      this.handleNote(body, errand, now);
      return false;
    }

    if (body.conversation !== undefined) {
      this.endConversation(body.conversation, now);
    }
    if (occupant.interactableId !== "") {
      // Up from the desk first, the way a player stands, then off to the board.
      releaseHold(this.host.interaction, body.key, now);
      body.seatId = "";
      body.route = [];
      return true;
    }
    body.seatId = "";

    if (errand.arrivedAt === undefined) {
      if (body.route.length === 0) {
        body.route = this.routeTo(occupant, spot);
        if (body.route.length === 0 && Math.hypot(spot.x - occupant.x, spot.z - occupant.z) > ARRIVE_DISTANCE) {
          // No way there: handle the note where it stands rather than never.
          this.handleNote(body, errand, now);
          return false;
        }
      }
      if (!this.walk(body, deltaSeconds)) {
        return true;
      }
      errand.arrivedAt = now;
      occupant.yaw = normalizeYaw(spot.yaw);
    }

    this.standStill(body);
    if (now - errand.arrivedAt < NOTE_HANDLING_MS) {
      return true;
    }
    this.handleNote(body, errand, now);
    return true;
  }

  /**
   * The errand this agent should be on: pinning the note in its hand where the
   * work now says it goes, or fetching the note of work it has started.
   * `undefined` for none, which includes waiting on a note another agent holds.
   */
  private errandFor(body: AgentBody, now: number): NoteErrand | undefined {
    const carried = body.occupant.carriedIssue;
    const current = body.errand;
    if (carried !== 0) {
      const boardId = noteDestination(body.key, carried, this.host.work.values());
      if (boardId === undefined) {
        return undefined;
      }
      return current?.kind === "pin" && current.issueNumber === carried && current.boardId === boardId
        ? current
        : { kind: "pin", issueNumber: carried, boardId, arrivedAt: undefined };
    }
    if (now < body.noteRetryAt) {
      return undefined;
    }
    const issueNumber = noteToFetch(body.key, this.host.work.values());
    if (issueNumber === 0) {
      return undefined;
    }
    return current?.kind === "fetch" && current.issueNumber === issueNumber
      ? current
      : { kind: "fetch", issueNumber, boardId: ISSUES_STICKER_BOARD_ID, arrivedAt: undefined };
  }

  /**
   * Takes the note off the board or pins it on, ending the errand. A note
   * another agent still has in hand — the work changed hands while it was
   * being carried — is not copied: this agent waits and looks again.
   */
  private handleNote(body: AgentBody, errand: NoteErrand, now: number): void {
    body.errand = undefined;
    body.route = [];
    body.restUntil = now;
    if (errand.kind === "pin") {
      body.occupant.carriedIssue = 0;
      return;
    }
    for (const other of this.bodies.values()) {
      if (other !== body && other.occupant.carriedIssue === errand.issueNumber) {
        body.noteRetryAt = now + NOTE_RETRY_MS;
        return;
      }
    }
    body.occupant.carriedIssue = errand.issueNumber;
  }

  private stepWorking(body: AgentBody, now: number, deltaSeconds: number): void {
    if (body.conversation !== undefined) {
      this.endConversation(body.conversation, now);
    }
    const { occupant } = body;
    if (occupant.interactableId !== "") {
      if (occupant.animation !== ANIMATION_STATE.typing) {
        occupant.animation = ANIMATION_STATE.typing;
      }
      return;
    }

    const holder = body.seatId === "" ? undefined : this.host.interaction.holds.holderOf(body.seatId);
    if (body.seatId === "" || (holder !== undefined && holder !== body.key)) {
      if (now < body.restUntil) {
        this.standStill(body);
        return;
      }
      const seat = this.chooseSeat(body);
      if (seat === undefined) {
        // The floor is full. Stand where it is and look again shortly.
        body.seatId = "";
        body.route = [];
        body.restUntil = now + SEAT_RETRY_MS;
        this.standStill(body);
        return;
      }
      body.seatId = seat.id;
      body.route = this.routeTo(occupant, seat.exit ?? seat.anchor);
    }

    if (!this.walk(body, deltaSeconds)) {
      return;
    }

    const outcome = requestInteract(this.host.interaction, body.key, body.seatId, now);
    if (outcome.result === "held") {
      body.refusedSeats.clear();
      occupant.animation = ANIMATION_STATE.typing;
      return;
    }
    // Taken while it walked, or out of reach after a detour: try another chair.
    body.refusedSeats.add(body.seatId);
    body.seatId = "";
    if (body.refusedSeats.size >= liveAgentSeats(this.host.layout).length) {
      body.refusedSeats.clear();
    }
  }

  private stepIdle(body: AgentBody, now: number, deltaSeconds: number): void {
    const { occupant } = body;
    if (occupant.interactableId !== "") {
      releaseHold(this.host.interaction, body.key, now);
      body.seatId = "";
      body.route = [];
      body.restUntil = now + STAND_UP_PAUSE_MS;
      return;
    }
    if (body.seatId !== "") {
      // It went idle on the way to a chair.
      body.seatId = "";
      body.route = [];
    }

    if (body.route.length > 0) {
      if (this.walk(body, deltaSeconds)) {
        body.restUntil = now + this.between(REST_MIN_MS, REST_MAX_MS);
      }
      return;
    }
    if (now < body.restUntil) {
      this.standStill(body);
      return;
    }
    body.route = this.routeTo(occupant, this.chooseStop(body));
    if (body.route.length === 0) {
      body.restUntil = now + this.between(REST_MIN_MS, REST_MAX_MS);
    }
  }

  /**
   * The nearest seat nobody holds and no other agent is heading for.
   *
   * Straight-line distance rather than route length: it is a choice between
   * chairs in one room, and the nearest by either measure is nearly always the
   * same chair.
   */
  private chooseSeat(body: AgentBody): InteractableSpec | undefined {
    const claimed = new Set<string>();
    for (const other of this.bodies.values()) {
      if (other !== body && other.seatId !== "") {
        claimed.add(other.seatId);
      }
    }
    let best: InteractableSpec | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const seat of liveAgentSeats(this.host.layout)) {
      if (
        claimed.has(seat.id) ||
        body.refusedSeats.has(seat.id) ||
        this.host.interaction.holds.holderOf(seat.id) !== undefined
      ) {
        continue;
      }
      const distance = distanceToInteractable(seat, body.occupant);
      if (distance < bestDistance) {
        best = seat;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Where a wandering agent goes next: towards company, or anywhere else. */
  private chooseStop(body: AgentBody): Vec2 {
    const { waypoints } = this.host.layout;
    if (this.host.random() < SEEK_COMPANY_CHANCE) {
      const others = [...this.bodies.values()].filter(
        (other) =>
          other !== body &&
          other.status === LIVE_AGENT_STATUS.idle &&
          other.conversation === undefined &&
          other.errand === undefined &&
          other.occupant.interactableId === "",
      );
      const company = others[Math.floor(this.host.random() * others.length)];
      if (company !== undefined) {
        return company.route[company.route.length - 1] ?? company.occupant;
      }
    }
    const here = nearestWaypoint(body.occupant, this.host.layout)?.id;
    const elsewhere = waypoints.filter(
      (node) => node.id !== here && roomAt(this.host.layout, node)?.id !== SIDEWALK_ROOM_ID,
    );
    return elsewhere[Math.floor(this.host.random() * elsewhere.length)] ?? body.occupant;
  }

  /**
   * The points to walk from `from` to `to`: the waypoint route, then `to`
   * itself, with every waypoint the body can walk straight past left out.
   * Empty when the graph has no route.
   *
   * The graph's links are axis-aligned hops between doorways and aisle ends,
   * which is the right shape for finding a way through the office and the
   * wrong one for walking it: followed node by node, an agent steps back to the
   * nearest node before setting off and squares every corner. So from each
   * point the body aims at the furthest later point it has a clear line to.
   */
  private routeTo(from: Vec2, to: Vec2): Vec2[] {
    const { layout } = this.host;
    const ids = findPath(from, to, layout, OCCUPANT_RADIUS);
    if (ids.length === 0) {
      return [];
    }
    const points: Vec2[] = [];
    for (const id of ids) {
      const node = layout.waypoints.find((candidate) => candidate.id === id);
      if (node !== undefined) {
        points.push({ x: node.x, z: node.z });
      }
    }
    points.push({ x: to.x, z: to.z });

    const route: Vec2[] = [];
    let cursor = from;
    for (let next = 0; next < points.length; ) {
      let furthest = next;
      for (let candidate = points.length - 1; candidate > next; candidate -= 1) {
        const point = points[candidate];
        if (point !== undefined && isClearLine(cursor, point, layout, OCCUPANT_RADIUS)) {
          furthest = candidate;
          break;
        }
      }
      const point = points[furthest];
      if (point === undefined) {
        break;
      }
      route.push(point);
      cursor = point;
      next = furthest + 1;
    }
    return route;
  }

  /**
   * Walks one tick's stride along the route, through the shared resolver.
   *
   * @returns whether the route is finished.
   */
  private walk(body: AgentBody, deltaSeconds: number): boolean {
    const { occupant } = body;
    const stride = WALK_SPEED * deltaSeconds;
    let budget = stride;

    // A stride can pass more than one point when they are close together, so
    // keep spending it rather than pausing on each one for a tick.
    while (budget > 0) {
      const target = body.route[0];
      if (target === undefined) {
        break;
      }
      const deltaX = target.x - occupant.x;
      const deltaZ = target.z - occupant.z;
      const distance = Math.hypot(deltaX, deltaZ);
      if (distance <= ARRIVE_DISTANCE) {
        body.route.shift();
        body.stuckTicks = 0;
        continue;
      }

      const step = Math.min(budget, distance);
      const scale = step / distance;
      const resolved = resolveMove(
        occupant,
        { x: deltaX * scale, z: deltaZ * scale },
        OCCUPANT_RADIUS,
        this.host.layout,
      );
      const moved = Math.hypot(resolved.x - occupant.x, resolved.z - occupant.z);
      occupant.x = resolved.x;
      occupant.z = resolved.z;
      occupant.yaw = normalizeYaw(Math.atan2(-deltaX, -deltaZ));
      if (occupant.animation !== ANIMATION_STATE.walking) {
        occupant.animation = ANIMATION_STATE.walking;
      }

      if (moved < step * STUCK_FRACTION) {
        body.stuckTicks += 1;
        if (body.stuckTicks >= STUCK_TICKS) {
          body.route.shift();
          body.stuckTicks = 0;
        }
        break;
      }
      body.stuckTicks = 0;
      budget -= moved;
    }

    if (body.route.length > 0) {
      return false;
    }
    this.standStill(body);
    return true;
  }

  private standStill(body: AgentBody): void {
    if (body.occupant.animation !== ANIMATION_STATE.idle) {
      body.occupant.animation = ANIMATION_STATE.idle;
    }
  }

  /** Pairs up idle agents that have come close enough to talk. */
  private startConversations(now: number): void {
    const available: AgentBody[] = [];
    for (const body of this.bodies.values()) {
      if (
        body.status === LIVE_AGENT_STATUS.idle &&
        body.conversation === undefined &&
        body.errand === undefined &&
        body.occupant.interactableId === "" &&
        now >= body.chatReadyAt
      ) {
        available.push(body);
      }
    }

    for (let i = 0; i < available.length; i += 1) {
      const first = available[i];
      if (first === undefined || first.conversation !== undefined) {
        continue;
      }
      for (let j = i + 1; j < available.length; j += 1) {
        const second = available[j];
        if (second === undefined || second.conversation !== undefined || !this.canMeet(first, second)) {
          continue;
        }
        this.startConversation(first, second, now);
        break;
      }
    }
  }

  /** Near each other and in the same room, so not talking through a wall. */
  private canMeet(a: AgentBody, b: AgentBody): boolean {
    const distance = Math.hypot(a.occupant.x - b.occupant.x, a.occupant.z - b.occupant.z);
    if (distance > MEET_DISTANCE) {
      return false;
    }
    const room = roomAt(this.host.layout, a.occupant);
    return room !== undefined && room.id === roomAt(this.host.layout, b.occupant)?.id;
  }

  private startConversation(first: AgentBody, second: AgentBody, now: number): void {
    const lines = CONVERSATIONS[Math.floor(this.host.random() * CONVERSATIONS.length)] ?? [];
    const conversation: Conversation = {
      first,
      second,
      lines,
      spoken: 0,
      nextLineAt: now + OPENING_PAUSE_MS,
    };
    for (const [body, other] of [
      [first, second],
      [second, first],
    ] as const) {
      body.conversation = conversation;
      body.route = [];
      body.occupant.yaw = normalizeYaw(
        Math.atan2(-(other.occupant.x - body.occupant.x), -(other.occupant.z - body.occupant.z)),
      );
      this.standStill(body);
    }
    this.conversations.add(conversation);
  }

  private stepConversation(conversation: Conversation, now: number): void {
    if (now < conversation.nextLineAt) {
      return;
    }
    const line = conversation.lines[conversation.spoken];
    if (line === undefined) {
      this.endConversation(conversation, now);
      return;
    }
    const speaker = conversation.spoken % 2 === 0 ? conversation.first : conversation.second;
    this.host.say(speaker.key, line);
    conversation.spoken += 1;
    conversation.nextLineAt = now + LINE_GAP_MS;
  }

  /** Ends a conversation for both sides, whichever of them it was ended by. */
  private endConversation(conversation: Conversation, now: number): void {
    this.conversations.delete(conversation);
    for (const body of [conversation.first, conversation.second]) {
      if (body.conversation === conversation) {
        body.conversation = undefined;
        body.chatReadyAt = now + CHAT_COOLDOWN_MS;
        if (!isLiveAgentOnTask(body.status)) {
          body.restUntil = now + STAND_UP_PAUSE_MS;
        }
      }
    }
  }

  private between(min: number, max: number): number {
    return min + (max - min) * this.host.random();
  }
}
