/**
 * Agent locomotion, and the queue that keeps slow decisions out of the fast loop.
 *
 * Whatever decides where an agent goes will think at the pace of a language
 * model, in seconds; the simulation tick runs at 20Hz and must never wait. The
 * boundary between the two is a per-agent queue of {@link AgentIntent}s. A
 * decision lands on the queue whenever it lands, and {@link AgentMotion.step},
 * called from the tick, drains it synchronously: it never awaits, never blocks,
 * and an empty queue — the usual case — costs a map lookup and nothing on the
 * wire.
 *
 * Bodies move through the same pieces players do. A route is the shared
 * waypoint graph's (`findPath`), each tick's step goes through the shared
 * collision resolver (`resolveMove`), and sitting down or standing up goes
 * through the room's own interaction rules, so an agent cannot clip a wall, a
 * desk or a taken chair any more than a player can. What it adds is the part a
 * player's hands do: steering at the next node, knowing when it has arrived,
 * and noticing when it is getting nowhere — an agent pressed against geometry
 * for {@link STUCK_AFTER_MS} gives the intent up and reports it `blocked`
 * rather than walking on the spot forever.
 *
 * Outcomes are written to a bounded outbox, {@link AgentMotion.drainReports},
 * rather than a callback, so that nothing reacting to an outcome can run inside
 * the tick.
 */

import {
  AGENT_ACTIVITY,
  ANIMATION_STATE,
  type AgentActivity,
  type AgentEmployee,
  INTERACTION_KIND,
  type InteractableSpec,
  OCCUPANT_RADIUS,
  TICK_INTERVAL_MS,
  type Vec2,
  WALK_SPEED,
  agentAtDesk,
  findPath,
  interactables,
  isAgentEmployee,
  isBlocked,
  isClearLine,
  normalizeYaw,
  resolveMove,
} from "@sim/shared";

import { type InteractionHost, releaseHold, requestInteract } from "./interaction.js";

/**
 * Where a `goto` heads: a waypoint id from the layout, or a floor position.
 *
 * A position is validated when it is queued — inside the floor and clear of
 * every obstacle — so a body is never sent somewhere it could not stand.
 */
export type GotoTarget = string | Vec2;

/** What a `face` turns toward: an occupant's id, or a floor position. */
export type FaceTarget = string | Vec2;

/**
 * The whole vocabulary an agent's body understands.
 *
 * Deliberately small: each one is a thing a body does, not a reason to do it.
 * `sitAt` includes the walk to the chair, because a seat can only be taken from
 * beside it and every caller would otherwise have to queue that walk first.
 */
export type AgentIntent =
  | { readonly kind: "goto"; readonly target: GotoTarget }
  | { readonly kind: "sitAt"; readonly deskId: string }
  | { readonly kind: "stand" }
  | { readonly kind: "face"; readonly target: FaceTarget }
  | { readonly kind: "wait"; readonly ms: number };

/** Builders for each intent, so a caller writes `intent.goto("wp-ceo-desk")`. */
export const intent = {
  goto: (target: GotoTarget): AgentIntent => ({ kind: "goto", target }),
  sitAt: (deskId: string): AgentIntent => ({ kind: "sitAt", deskId }),
  stand: (): AgentIntent => ({ kind: "stand" }),
  face: (target: FaceTarget): AgentIntent => ({ kind: "face", target }),
  wait: (ms: number): AgentIntent => ({ kind: "wait", ms }),
} as const;

export const INTENT_OUTCOME = {
  /** The body did what the intent asked. */
  done: "done",
  /** The body could not, and gave up; the rest of its queue was cancelled. */
  blocked: "blocked",
  /** Dropped before it finished, by {@link AgentMotion.clear} or a blocked intent ahead of it. */
  cancelled: "cancelled",
} as const;

export type IntentOutcome = (typeof INTENT_OUTCOME)[keyof typeof INTENT_OUTCOME];

export const BLOCKED_REASON = {
  /** The waypoint graph has no route between the body and the goal. */
  noRoute: "no-route",
  /** No progress toward the next point on the route for {@link STUCK_AFTER_MS}. */
  stuck: "stuck",
  /** Every seat at the desk is held by someone else, or the desk is another agent's. */
  seatTaken: "seat-taken",
} as const;

export type BlockedReason = (typeof BLOCKED_REASON)[keyof typeof BLOCKED_REASON];

/** How one intent ended, as whatever decides the next one will read it. */
export interface IntentReport {
  readonly agentId: string;
  readonly intent: AgentIntent;
  readonly outcome: IntentOutcome;
  /** Set when {@link outcome} is `blocked`. */
  readonly reason?: BlockedReason;
  /** Room clock time it ended. */
  readonly at: number;
}

export type EnqueueResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string };

/** Intents an agent may have waiting. A brain that plans further ahead than this is not listening. */
export const MAX_QUEUED_INTENTS = 16;

/** Longest single `wait`, so a bad number cannot park an agent for the rest of the session. */
export const MAX_WAIT_MS = 60_000;

/**
 * How long an agent may go without getting closer to the next point on its
 * route before it gives up. Long enough to slide round a corner the resolver is
 * arguing with; short enough that nobody watches it walk into a wall for long.
 */
export const STUCK_AFTER_MS = 3000;

/** How much closer counts as progress. Below a tick's stride, above resolver jitter. */
const PROGRESS_EPSILON = 0.05;

/** How close to a route's last point counts as there. */
export const ARRIVAL_TOLERANCE = 0.1;

/** How close to an intermediate node counts as passing it, so turns are not taken on a pinhead. */
const WAYPOINT_TOLERANCE = 0.25;

/** Intents one agent may finish in a single tick, bounding the tick's work for any queue. */
const MAX_INTENTS_PER_TICK = 8;

/** Longest gap one step will integrate, so a stalled event loop does not fling a body. */
const MAX_STEP_MS = 100;

/** Reports held for a reader before the oldest are dropped. */
const MAX_REPORTS = 64;

/** A position closer than this to a facing target gives no direction to face. */
const FACE_EPSILON = 1e-3;

/** A walk in progress: the points left to visit, and how the current leg is going. */
interface Walk {
  /** Route points in order, ending at the goal. */
  readonly points: readonly Vec2[];
  leg: number;
  /** Closest the body has been to `points[leg]` since the leg began. */
  best: number;
  /** Room clock time {@link best} last improved. */
  progressAt: number;
}

interface ActiveIntent {
  readonly intent: AgentIntent;
  readonly startedAt: number;
  walk: Walk | undefined;
  /** The seat a `sitAt` is walking to. */
  seat: InteractableSpec | undefined;
  /** The badge to restore when the walk ends, captured as it starts. */
  activityBefore: AgentActivity | undefined;
}

interface Body {
  readonly queue: AgentIntent[];
  active: ActiveIntent | undefined;
}

/** Whether an intent is still going after a tick's work, or how it ended. */
type Progress =
  | { readonly status: "running" }
  | { readonly status: "done" }
  | { readonly status: "blocked"; readonly reason: BlockedReason };

const RUNNING: Progress = { status: "running" };
const DONE: Progress = { status: "done" };

function blocked(reason: BlockedReason): Progress {
  return { status: "blocked", reason };
}

/**
 * Every agent's queue and body, for one room.
 *
 * Reads and writes the room's state through the same {@link InteractionHost}
 * the interaction rules use, so a seat an agent takes is held in the room's one
 * registry and a player is refused it exactly as they would be by another
 * player.
 */
export class AgentMotion {
  private readonly bodies = new Map<string, Body>();
  private readonly reports: IntentReport[] = [];
  private lastStepAt: number | undefined;

  public constructor(private readonly host: InteractionHost) {}

  /**
   * Queues an intent behind whatever the agent is already doing.
   *
   * Validation happens here, against the layout, so that an intent which could
   * never be carried out is refused to its caller now rather than reported
   * `blocked` later. Whether a route exists, or a seat is free, can change
   * before the intent runs, and is decided when it does.
   */
  public enqueue(agentId: string, next: AgentIntent): EnqueueResult {
    const occupant = this.host.occupants.get(agentId);
    if (occupant === undefined || !isAgentEmployee(occupant)) {
      return { accepted: false, reason: `no agent ${agentId}` };
    }
    const problem = this.validate(next);
    if (problem !== undefined) {
      return { accepted: false, reason: problem };
    }
    let body = this.bodies.get(agentId);
    if (body === undefined) {
      body = { queue: [], active: undefined };
      this.bodies.set(agentId, body);
    }
    if (body.queue.length >= MAX_QUEUED_INTENTS) {
      return { accepted: false, reason: "queue is full" };
    }
    body.queue.push(next);
    return { accepted: true };
  }

  /**
   * Drops everything an agent was doing or about to do, each reported
   * `cancelled`, and leaves the body standing where it is. A seated agent
   * stays seated: getting up is an intent like any other.
   */
  public clear(agentId: string, now: number): void {
    const body = this.bodies.get(agentId);
    if (body === undefined) {
      return;
    }
    const agent = this.agentOf(agentId);
    if (body.active !== undefined) {
      if (agent !== undefined) {
        this.endWalk(agent, body.active);
      }
      this.report(agentId, body.active.intent, INTENT_OUTCOME.cancelled, undefined, now);
      body.active = undefined;
    }
    this.cancelQueued(agentId, body, now);
  }

  /** How many intents an agent has, the one in progress included. */
  public pending(agentId: string): number {
    const body = this.bodies.get(agentId);
    if (body === undefined) {
      return 0;
    }
    return body.queue.length + (body.active === undefined ? 0 : 1);
  }

  /** Hands over every report since the last drain, oldest first. */
  public drainReports(): IntentReport[] {
    return this.reports.splice(0, this.reports.length);
  }

  /**
   * One tick of every agent's queue.
   *
   * Synchronous, with nothing awaited and nothing that could be. Each agent
   * finishes as many instant intents as it can — up to
   * {@link MAX_INTENTS_PER_TICK} — and stops at the first that needs more
   * time, which then advances by one tick's worth.
   */
  public step(now: number): void {
    const elapsed =
      this.lastStepAt === undefined
        ? TICK_INTERVAL_MS
        : Math.min(Math.max(now - this.lastStepAt, 0), MAX_STEP_MS);
    this.lastStepAt = now;

    for (const [agentId, body] of this.bodies) {
      const agent = this.agentOf(agentId);
      if (agent === undefined) {
        this.bodies.delete(agentId);
        continue;
      }
      for (let done = 0; done < MAX_INTENTS_PER_TICK; done += 1) {
        if (body.active === undefined) {
          const next = body.queue.shift();
          if (next === undefined) {
            break;
          }
          body.active = {
            intent: next,
            startedAt: now,
            walk: undefined,
            seat: undefined,
            activityBefore: undefined,
          };
        }
        const active = body.active;
        const progress = this.advance(agent, active, now, elapsed);
        if (progress.status === "running") {
          break;
        }
        body.active = undefined;
        this.endWalk(agent, active);
        if (progress.status === "done") {
          this.report(agentId, active.intent, INTENT_OUTCOME.done, undefined, now);
        } else {
          agent.activity = AGENT_ACTIVITY.blocked;
          this.report(agentId, active.intent, INTENT_OUTCOME.blocked, progress.reason, now);
          // What came after assumed this succeeded, so none of it still holds.
          this.cancelQueued(agentId, body, now);
          break;
        }
      }
    }
  }

  private validate(next: AgentIntent): string | undefined {
    const { layout } = this.host;
    switch (next.kind) {
      case "goto": {
        if (typeof next.target === "string") {
          return layout.waypoints.some((node) => node.id === next.target)
            ? undefined
            : `no waypoint ${next.target}`;
        }
        const { x, z } = next.target;
        if (!Number.isFinite(x) || !Number.isFinite(z)) {
          return "position is not a number";
        }
        const { floor } = layout;
        if (x <= floor.minX || x >= floor.maxX || z <= floor.minZ || z >= floor.maxZ) {
          return "position is off the floor";
        }
        return isBlocked(next.target, OCCUPANT_RADIUS, layout)
          ? "position is inside an obstacle"
          : undefined;
      }
      case "sitAt":
        return this.seatsAt(next.deskId).length > 0 ? undefined : `no desk ${next.deskId}`;
      case "face":
        return typeof next.target === "string" ||
          (Number.isFinite(next.target.x) && Number.isFinite(next.target.z))
          ? undefined
          : "position is not a number";
      case "wait":
        return Number.isFinite(next.ms) && next.ms >= 0 ? undefined : "wait must be a duration";
      case "stand":
        return undefined;
    }
  }

  private advance(
    agent: AgentEmployee,
    active: ActiveIntent,
    now: number,
    elapsed: number,
  ): Progress {
    const current = active.intent;
    switch (current.kind) {
      case "goto": {
        if (active.walk === undefined) {
          this.standUp(agent, now);
          const goal =
            typeof current.target === "string"
              ? this.host.layout.waypoints.find((node) => node.id === current.target)
              : current.target;
          // Validated on the way in, and a layout does not lose nodes.
          if (goal === undefined) {
            return blocked(BLOCKED_REASON.noRoute);
          }
          const started = this.beginWalk(agent, active, goal, now);
          if (started !== undefined) {
            return started;
          }
        }
        return this.walkStep(agent, active, now, elapsed);
      }

      case "sitAt": {
        if (active.seat === undefined) {
          const seat = this.freeSeat(agent, current.deskId);
          if (seat === undefined) {
            return blocked(BLOCKED_REASON.seatTaken);
          }
          if (agent.interactableId === seat.id) {
            return DONE;
          }
          this.standUp(agent, now);
          active.seat = seat;
          // The exit, not the anchor: the anchor is inside the chair, which is
          // solid, and the exit is where a body takes the seat from.
          if (seat.exit !== undefined) {
            const started = this.beginWalk(agent, active, seat.exit, now);
            if (started?.status === "blocked") {
              return started;
            }
          }
        }
        if (active.walk !== undefined) {
          const walking = this.walkStep(agent, active, now, elapsed);
          if (walking.status !== "done") {
            return walking;
          }
          this.endWalk(agent, active);
          active.walk = undefined;
        }
        // The room's own rule, from the pose the body actually reached: if a
        // player sat down while the agent was walking over, this refuses.
        const outcome = requestInteract(this.host, agent.id, active.seat.id, now);
        return outcome.result === "held" ? DONE : blocked(BLOCKED_REASON.seatTaken);
      }

      case "stand":
        this.standUp(agent, now);
        return DONE;

      case "face": {
        // A seated body faces its desk; the client draws it at the seat's yaw
        // whatever this says, so turning it would only disagree with the picture.
        if (agent.interactableId !== "") {
          return DONE;
        }
        const target =
          typeof current.target === "string"
            ? this.host.occupants.get(current.target)
            : current.target;
        if (target !== undefined) {
          const dx = target.x - agent.x;
          const dz = target.z - agent.z;
          if (Math.abs(dx) > FACE_EPSILON || Math.abs(dz) > FACE_EPSILON) {
            agent.yaw = yawToward(dx, dz);
          }
        }
        return DONE;
      }

      case "wait":
        return now - active.startedAt >= Math.min(current.ms, MAX_WAIT_MS) ? DONE : RUNNING;
    }
  }

  /**
   * Plans a route to `goal` and starts walking it.
   *
   * @returns the intent's outcome when there is nothing to walk — no route, or
   * already there — or `undefined` once a walk is under way.
   */
  private beginWalk(
    agent: AgentEmployee,
    active: ActiveIntent,
    goal: Vec2,
    now: number,
  ): Progress | undefined {
    if (Math.hypot(goal.x - agent.x, goal.z - agent.z) <= ARRIVAL_TOLERANCE) {
      return DONE;
    }
    const route = findPath(agent, goal, this.host.layout, OCCUPANT_RADIUS);
    if (route.length === 0) {
      return blocked(BLOCKED_REASON.noRoute);
    }
    const nodes = new Map(this.host.layout.waypoints.map((node) => [node.id, node]));
    const points: Vec2[] = [];
    for (const id of route) {
      const node = nodes.get(id);
      if (node !== undefined) {
        points.push({ x: node.x, z: node.z });
      }
    }
    points.push({ x: goal.x, z: goal.z });

    active.walk = { points, leg: 0, best: Number.POSITIVE_INFINITY, progressAt: now };
    active.activityBefore = agent.activity;
    agent.activity = AGENT_ACTIVITY.walking;
    return undefined;
  }

  /** One tick's stride along a walk, with arrival and the stuck check. */
  private walkStep(
    agent: AgentEmployee,
    active: ActiveIntent,
    now: number,
    elapsed: number,
  ): Progress {
    const walk = active.walk;
    if (walk === undefined) {
      return DONE;
    }
    const { layout } = this.host;
    const lastLeg = walk.points.length - 1;

    // Cut a corner whenever the point after the next one is in plain sight,
    // so a route reads as a person walking rather than a cursor visiting nodes.
    // The test is conservative, so a cut never runs a body into something.
    let next = walk.points[walk.leg + 1];
    while (next !== undefined && isClearLine(agent, next, layout, OCCUPANT_RADIUS)) {
      this.advanceLeg(walk, now);
      next = walk.points[walk.leg + 1];
    }

    let target = walk.points[walk.leg];
    let distance = target === undefined ? 0 : Math.hypot(target.x - agent.x, target.z - agent.z);
    while (target !== undefined && walk.leg < lastLeg && distance <= WAYPOINT_TOLERANCE) {
      this.advanceLeg(walk, now);
      target = walk.points[walk.leg];
      distance = target === undefined ? 0 : Math.hypot(target.x - agent.x, target.z - agent.z);
    }
    if (target === undefined || distance <= ARRIVAL_TOLERANCE) {
      return DONE;
    }

    const stride = Math.min((WALK_SPEED * elapsed) / 1000, distance);
    const dx = ((target.x - agent.x) / distance) * stride;
    const dz = ((target.z - agent.z) / distance) * stride;
    const resolved = resolveMove(agent, { x: dx, z: dz }, OCCUPANT_RADIUS, layout);
    if (resolved.x !== agent.x || resolved.z !== agent.z) {
      agent.x = resolved.x;
      agent.z = resolved.z;
    }
    if (stride > 0) {
      agent.yaw = yawToward(dx, dz);
    }
    if (agent.animation !== ANIMATION_STATE.walking) {
      agent.animation = ANIMATION_STATE.walking;
    }

    const remaining = Math.hypot(target.x - agent.x, target.z - agent.z);
    if (walk.leg === lastLeg && remaining <= ARRIVAL_TOLERANCE) {
      return DONE;
    }
    if (remaining < walk.best - PROGRESS_EPSILON) {
      walk.best = remaining;
      walk.progressAt = now;
    } else if (now - walk.progressAt >= STUCK_AFTER_MS) {
      return blocked(BLOCKED_REASON.stuck);
    }
    return RUNNING;
  }

  private advanceLeg(walk: Walk, now: number): void {
    walk.leg += 1;
    walk.best = Number.POSITIVE_INFINITY;
    walk.progressAt = now;
  }

  /**
   * Stops a body walking, if it was, and gives its badge back.
   *
   * Back to whatever the badge said before the walk, unless that was itself a
   * walk or a failure, neither of which is true any more. An intent that never
   * walked leaves the badge alone.
   */
  private endWalk(agent: AgentEmployee, active: ActiveIntent): void {
    const before = active.activityBefore;
    if (before === undefined) {
      return;
    }
    active.activityBefore = undefined;
    if (agent.animation === ANIMATION_STATE.walking) {
      agent.animation = ANIMATION_STATE.idle;
    }
    const settled =
      before === AGENT_ACTIVITY.walking || before === AGENT_ACTIVITY.blocked
        ? AGENT_ACTIVITY.idle
        : before;
    if (agent.activity !== settled) {
      agent.activity = settled;
    }
  }

  /** Gets a body out of whatever it holds, through the room's own release. */
  private standUp(agent: AgentEmployee, now: number): void {
    if (agent.interactableId !== "") {
      releaseHold(this.host, agent.id, now);
    }
  }

  private seatsAt(deskId: string): InteractableSpec[] {
    return interactables(this.host.layout).filter(
      (spec) => spec.kind === INTERACTION_KIND.seat && spec.deskId === deskId,
    );
  }

  /**
   * The seat at a desk this agent may take: one it already holds, or the
   * first nobody else holds at a desk that is not another agent's.
   */
  private freeSeat(agent: AgentEmployee, deskId: string): InteractableSpec | undefined {
    const owner = agentAtDesk(this.host.occupants.values(), deskId);
    if (owner !== undefined && owner !== agent.id) {
      return undefined;
    }
    let free: InteractableSpec | undefined;
    for (const seat of this.seatsAt(deskId)) {
      const holder = this.host.holds.holderOf(seat.id);
      if (holder === agent.id) {
        return seat;
      }
      if (holder === undefined && free === undefined) {
        free = seat;
      }
    }
    return free;
  }

  private cancelQueued(agentId: string, body: Body, now: number): void {
    for (const queued of body.queue.splice(0, body.queue.length)) {
      this.report(agentId, queued, INTENT_OUTCOME.cancelled, undefined, now);
    }
  }

  private report(
    agentId: string,
    done: AgentIntent,
    outcome: IntentOutcome,
    reason: BlockedReason | undefined,
    at: number,
  ): void {
    this.reports.push({ agentId, intent: done, outcome, ...(reason === undefined ? {} : { reason }), at });
    if (this.reports.length > MAX_REPORTS) {
      this.reports.splice(0, this.reports.length - MAX_REPORTS);
    }
  }

  private agentOf(agentId: string): AgentEmployee | undefined {
    const occupant = this.host.occupants.get(agentId);
    return occupant !== undefined && isAgentEmployee(occupant) ? occupant : undefined;
  }
}

/** The yaw that faces along a ground-plane direction; yaw 0 faces -Z. */
function yawToward(dx: number, dz: number): number {
  return normalizeYaw(Math.atan2(-dx, -dz));
}
