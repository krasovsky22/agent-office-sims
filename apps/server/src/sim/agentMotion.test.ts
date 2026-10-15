/**
 * The locomotion layer is tested the way the room drives it: real schema
 * occupants on the shipped floor plan, a hold registry shared with players, and
 * the tick stepped by hand with time passed in. Every acceptance criterion that
 * can be checked without a browser is checked here — the route to a far room,
 * never inside a wall or a desk, giving up against geometry, and an empty queue
 * costing nothing.
 */

import { Encoder } from "@colyseus/schema";
import {
  AGENT_ACTIVITY,
  ANIMATION_STATE,
  type AgentEmployee,
  HumanPlayer,
  MAX_AGENT_COUNT,
  OCCUPANT_RADIUS,
  OFFICE_LAYOUT,
  type Occupant,
  type OfficeLayout,
  OfficeState,
  TICK_INTERVAL_MS,
  type Vec2,
  WALK_SPEED,
  isBlocked,
  planAgentHires,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import {
  ARRIVAL_TOLERANCE,
  AgentMotion,
  BLOCKED_REASON,
  INTENT_OUTCOME,
  type IntentReport,
  MAX_QUEUED_INTENTS,
  STUCK_AFTER_MS,
  intent,
} from "./agentMotion.js";
import { hireAgentEmployees } from "./agents.js";
import { HoldRegistry, type InteractionHost, requestInteract } from "./interaction.js";
import { type OccupantMotion, applyPose, createMotion, recordPose } from "./movement.js";

interface Office {
  readonly state: OfficeState;
  readonly host: InteractionHost;
  readonly motion: AgentMotion;
  readonly agents: AgentEmployee[];
  now: number;
}

function createOffice(agentCount = 1, layout: OfficeLayout = OFFICE_LAYOUT): Office {
  const state = new OfficeState();
  const agents = hireAgentEmployees(state.occupants, layout, agentCount);
  const host: InteractionHost = {
    layout,
    occupants: state.occupants,
    motions: new Map<string, OccupantMotion>(),
    holds: new HoldRegistry(),
    lastUsedAt: new Map(),
  };
  return { state, host, motion: new AgentMotion(host), agents, now: 0 };
}

function firstAgent(office: Office): AgentEmployee {
  const agent = office.agents[0];
  if (agent === undefined) {
    throw new Error("the office hired nobody");
  }
  return agent;
}

function waypoint(id: string): Vec2 {
  const node = OFFICE_LAYOUT.waypoints.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`the layout has no waypoint ${id}`);
  }
  return node;
}

/** Advances one tick and returns the reports it produced. */
function tick(office: Office): IntentReport[] {
  office.now += TICK_INTERVAL_MS;
  office.motion.step(office.now);
  return office.motion.drainReports();
}

/**
 * Ticks until an agent's queue is empty or `limitMs` passes, watching every
 * position on the way.
 */
function runUntilIdle(office: Office, agentId: string, limitMs = 60_000) {
  const reports: IntentReport[] = [];
  const trail: Vec2[] = [];
  const startedAt = office.now;
  const agent = office.state.occupants.get(agentId);
  while (office.motion.pending(agentId) > 0 && office.now - startedAt < limitMs) {
    reports.push(...tick(office));
    if (agent !== undefined) {
      trail.push({ x: agent.x, z: agent.z });
    }
  }
  return { reports, trail, elapsedMs: office.now - startedAt };
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe("the intent queue", () => {
  it("treats an empty queue as the normal case, and writes nothing", () => {
    const office = createOffice(MAX_AGENT_COUNT);
    const encoder = new Encoder(office.state);
    encoder.encodeAll();
    encoder.discardChanges();

    for (let i = 0; i < 40; i += 1) {
      expect(tick(office)).toEqual([]);
    }
    expect(encoder.encode().length).toBe(0);
  });

  it("refuses an intent that could never be carried out, when it is queued", () => {
    const office = createOffice();
    const agent = firstAgent(office);

    expect(office.motion.enqueue("agent-99", intent.stand()).accepted).toBe(false);
    expect(office.motion.enqueue(agent.id, intent.goto("wp-nowhere")).accepted).toBe(false);
    expect(office.motion.enqueue(agent.id, intent.goto({ x: -1.8, z: 0.5 })).accepted).toBe(false);
    expect(office.motion.enqueue(agent.id, intent.goto({ x: 40, z: 0 })).accepted).toBe(false);
    expect(office.motion.enqueue(agent.id, intent.goto({ x: Number.NaN, z: 0 })).accepted).toBe(
      false,
    );
    expect(office.motion.enqueue(agent.id, intent.sitAt("desk-nowhere")).accepted).toBe(false);
    expect(office.motion.enqueue(agent.id, intent.wait(-1)).accepted).toBe(false);
    expect(office.motion.pending(agent.id)).toBe(0);
  });

  it("refuses to queue for a player, whom only their own browser moves", () => {
    const office = createOffice();
    const player = new HumanPlayer();
    player.id = "player-1";
    office.state.occupants.set(player.id, player);
    expect(office.motion.enqueue(player.id, intent.goto("wp-ceo-desk")).accepted).toBe(false);
  });

  it("caps how far ahead an agent can be told", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    for (let i = 0; i < MAX_QUEUED_INTENTS; i += 1) {
      expect(office.motion.enqueue(agent.id, intent.wait(10)).accepted).toBe(true);
    }
    expect(office.motion.enqueue(agent.id, intent.wait(10)).accepted).toBe(false);
  });

  it("runs intents in order, and reports each one", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    office.motion.enqueue(agent.id, intent.face({ x: agent.x + 5, z: agent.z }));
    office.motion.enqueue(agent.id, intent.wait(500));
    office.motion.enqueue(agent.id, intent.face({ x: agent.x, z: agent.z - 5 }));

    const first = tick(office);
    expect(first.map((report) => report.intent.kind)).toEqual(["face"]);
    // Facing +X is a quarter turn clockwise from -Z.
    expect(agent.yaw).toBeCloseTo(-Math.PI / 2);

    const { reports, elapsedMs } = runUntilIdle(office, agent.id);
    expect(reports.map((report) => [report.intent.kind, report.outcome])).toEqual([
      ["wait", INTENT_OUTCOME.done],
      ["face", INTENT_OUTCOME.done],
    ]);
    expect(elapsedMs).toBeGreaterThanOrEqual(500 - TICK_INTERVAL_MS);
    expect(elapsedMs).toBeLessThanOrEqual(500 + TICK_INTERVAL_MS);
    expect(agent.yaw).toBeCloseTo(0);
  });

  it("faces another occupant by id", () => {
    const office = createOffice(2);
    const [ada, bo] = office.agents;
    if (ada === undefined || bo === undefined) {
      throw new Error("expected two agents");
    }
    office.motion.enqueue(ada.id, intent.face(bo.id));
    tick(office);
    const dx = bo.x - ada.x;
    const dz = bo.z - ada.z;
    expect(ada.yaw).toBeCloseTo(Math.atan2(-dx, -dz));
  });

  it("can be cleared, reporting everything it dropped", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    office.motion.enqueue(agent.id, intent.goto("wp-ceo-desk"));
    office.motion.enqueue(agent.id, intent.wait(100));
    tick(office);
    expect(agent.animation).toBe(ANIMATION_STATE.walking);

    office.motion.clear(agent.id, office.now);
    expect(office.motion.drainReports().map((report) => report.outcome)).toEqual([
      INTENT_OUTCOME.cancelled,
      INTENT_OUTCOME.cancelled,
    ]);
    expect(office.motion.pending(agent.id)).toBe(0);
    expect(agent.animation).toBe(ANIMATION_STATE.idle);
    expect(agent.activity).toBe(AGENT_ACTIVITY.idle);
  });
});

describe("walking", () => {
  it("walks a sensible route from a desk to a far room, through its doorway", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    const start = { x: agent.x, z: agent.z };
    const goal = waypoint("wp-meeting-table");

    office.motion.enqueue(agent.id, intent.goto("wp-meeting-table"));
    tick(office);
    expect(agent.animation).toBe(ANIMATION_STATE.walking);
    expect(agent.activity).toBe(AGENT_ACTIVITY.walking);

    const { reports, trail, elapsedMs } = runUntilIdle(office, agent.id);
    expect(reports).toEqual([
      expect.objectContaining({ agentId: agent.id, outcome: INTENT_OUTCOME.done }),
    ]);
    expect(distance(agent, goal)).toBeLessThanOrEqual(ARRIVAL_TOLERANCE);
    expect(agent.animation).toBe(ANIMATION_STATE.idle);
    expect(agent.activity).toBe(AGENT_ACTIVITY.idle);

    // Through the meeting room's door rather than through its wall.
    const door = waypoint("wp-meeting-door");
    expect(Math.min(...trail.map((point) => distance(point, door)))).toBeLessThan(0.5);
    // At walking pace, and not wandering: no slower than half again the
    // length of the route the graph gives.
    const crowFlies = distance(start, goal);
    expect(elapsedMs).toBeGreaterThan(((crowFlies / WALK_SPEED) * 1000) * 0.95);
    expect(elapsedMs).toBeLessThan(((crowFlies * 2.5) / WALK_SPEED) * 1000);
  });

  it("never stands inside a wall or a desk, on any tick of any route", () => {
    for (const target of OFFICE_LAYOUT.waypoints) {
      const office = createOffice(MAX_AGENT_COUNT);
      for (const agent of office.agents) {
        office.motion.enqueue(agent.id, intent.goto(target.id));
      }
      for (let elapsed = 0; elapsed < 30_000; elapsed += TICK_INTERVAL_MS) {
        tick(office);
        for (const agent of office.agents) {
          expect(isBlocked(agent, OCCUPANT_RADIUS, OFFICE_LAYOUT)).toBe(false);
        }
        if (office.agents.every((agent) => office.motion.pending(agent.id) === 0)) {
          break;
        }
      }
      // And every one of them got there: no route on the shipped floor blocks.
      for (const agent of office.agents) {
        expect(office.motion.pending(agent.id)).toBe(0);
        expect(distance(agent, target)).toBeLessThanOrEqual(ARRIVAL_TOLERANCE);
      }
    }
  });

  it("walks to a floor position, not only to a waypoint", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    const goal = { x: 10.5, z: -10.5 };
    office.motion.enqueue(agent.id, intent.goto(goal));
    const { reports } = runUntilIdle(office, agent.id);
    expect(reports.map((report) => report.outcome)).toEqual([INTENT_OUTCOME.done]);
    expect(distance(agent, goal)).toBeLessThanOrEqual(ARRIVAL_TOLERANCE);
  });

  it("reports a position no waypoint can see as blocked, after trying", () => {
    // Behind the CEO's desk: clear floor, but the last leg from the office's
    // only node runs into the desk, and nothing routes round it.
    const office = createOffice();
    const agent = firstAgent(office);
    office.motion.enqueue(agent.id, intent.goto({ x: -9.5, z: -9.5 }));
    const { reports } = runUntilIdle(office, agent.id);
    expect(reports.map((report) => report.reason)).toEqual([BLOCKED_REASON.stuck]);
    expect(isBlocked(agent, OCCUPANT_RADIUS, OFFICE_LAYOUT)).toBe(false);
    // It made it into the office before the desk stopped it.
    expect(agent.z).toBeLessThan(-5);
  });

  it("faces the way it walks", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    office.motion.enqueue(agent.id, intent.goto("wp-ceo-desk"));
    tick(office);
    const before = { x: agent.x, z: agent.z };
    tick(office);
    const dx = agent.x - before.x;
    const dz = agent.z - before.z;
    expect(agent.yaw).toBeCloseTo(Math.atan2(-dx, -dz), 1);
  });

  it("gives up against geometry and says so, rather than walking on the spot", () => {
    // The shipped floor with its west doorway bricked up: the waypoint graph
    // still believes in the door, so the route walks straight into the plug.
    const bricked: OfficeLayout = {
      ...OFFICE_LAYOUT,
      walls: [
        ...OFFICE_LAYOUT.walls,
        {
          id: "wall-bricked-door",
          footprint: { minX: -6.7, minZ: -2.7, maxX: -5.3, maxZ: -2.4 },
          height: 3,
        },
      ],
    };
    const office = createOffice(1, bricked);
    const agent = firstAgent(office);
    office.motion.enqueue(agent.id, intent.goto("wp-ceo-desk"));
    office.motion.enqueue(agent.id, intent.wait(100));

    const { reports, trail, elapsedMs } = runUntilIdle(office, agent.id);
    expect(reports).toEqual([
      expect.objectContaining({
        intent: intent.goto("wp-ceo-desk"),
        outcome: INTENT_OUTCOME.blocked,
        reason: BLOCKED_REASON.stuck,
      }),
      expect.objectContaining({ intent: intent.wait(100), outcome: INTENT_OUTCOME.cancelled }),
    ]);
    // The walk to the plug, then the stuck allowance, and not much more.
    expect(elapsedMs).toBeLessThan(15_000);
    // But the whole allowance: it pressed on for STUCK_AFTER_MS after it
    // reached the plug — creeping along it by millimetres — before calling it.
    const settledAt = trail.findIndex((point) => distance(point, agent) < 0.2);
    expect((trail.length - settledAt) * TICK_INTERVAL_MS).toBeGreaterThanOrEqual(STUCK_AFTER_MS);
    expect(agent.activity).toBe(AGENT_ACTIVITY.blocked);
    expect(agent.animation).toBe(ANIMATION_STATE.idle);
    expect(isBlocked(agent, OCCUPANT_RADIUS, bricked)).toBe(false);
    // Still north of nothing: it never got through.
    expect(agent.z).toBeGreaterThan(-2.4);

    // A later walk that works clears the badge.
    office.motion.enqueue(agent.id, intent.goto("wp-floor-back"));
    const recovered = runUntilIdle(office, agent.id);
    expect(recovered.reports.map((report) => report.outcome)).toEqual([INTENT_OUTCOME.done]);
    expect(agent.activity).toBe(AGENT_ACTIVITY.idle);
  });

  it("walks round its desk to the far side of it", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    const desk = OFFICE_LAYOUT.desks.find((spec) => spec.id === agent.deskId);
    if (desk === undefined) {
      throw new Error("agent has no desk");
    }
    // The agent stands behind its chair; this is in front of the desk, so the
    // straight line is through it and the route has to go round.
    const goal = { x: desk.x, z: desk.z - 0.9 };
    office.motion.enqueue(agent.id, intent.goto(goal));
    const { reports } = runUntilIdle(office, agent.id);
    expect(reports.map((report) => report.outcome)).toEqual([INTENT_OUTCOME.done]);
    expect(distance(agent, goal)).toBeLessThanOrEqual(ARRIVAL_TOLERANCE);
  });
});

describe("sitting and standing", () => {
  it("sits an agent at its own desk, holding the seat against players", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    office.motion.enqueue(agent.id, intent.sitAt(agent.deskId));
    const { reports } = runUntilIdle(office, agent.id);

    expect(reports.map((report) => report.outcome)).toEqual([INTENT_OUTCOME.done]);
    const seatId = `seat-${agent.deskId}-1`;
    expect(agent.interactableId).toBe(seatId);
    expect(agent.animation).toBe(ANIMATION_STATE.sitting);
    expect(office.host.holds.holderOf(seatId)).toBe(agent.id);
  });

  it("walks to a desk across the floor before sitting at it", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    office.motion.enqueue(agent.id, intent.sitAt("desk-ceo"));
    const { reports } = runUntilIdle(office, agent.id);
    expect(reports.map((report) => report.outcome)).toEqual([INTENT_OUTCOME.done]);
    expect(agent.interactableId).toBe("seat-desk-ceo-1");
    expect(agent.activity).toBe(AGENT_ACTIVITY.idle);
  });

  it("stands up to walk, and stands up when told", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    office.motion.enqueue(agent.id, intent.sitAt(agent.deskId));
    runUntilIdle(office, agent.id);

    office.motion.enqueue(agent.id, intent.goto("wp-kitchen-coffee"));
    tick(office);
    expect(agent.interactableId).toBe("");
    expect(office.host.holds.holderOf(`seat-${agent.deskId}-1`)).toBeUndefined();
    runUntilIdle(office, agent.id);
    expect(distance(agent, waypoint("wp-kitchen-coffee"))).toBeLessThanOrEqual(ARRIVAL_TOLERANCE);

    office.motion.enqueue(agent.id, intent.sitAt(agent.deskId));
    office.motion.enqueue(agent.id, intent.stand());
    const { reports } = runUntilIdle(office, agent.id);
    expect(reports.map((report) => report.outcome)).toEqual([
      INTENT_OUTCOME.done,
      INTENT_OUTCOME.done,
    ]);
    expect(agent.interactableId).toBe("");
    expect(agent.animation).toBe(ANIMATION_STATE.idle);
    expect(isBlocked(agent, OCCUPANT_RADIUS, OFFICE_LAYOUT)).toBe(false);
  });

  it("reports blocked when a player already has the chair", () => {
    const office = createOffice();
    const agent = firstAgent(office);
    const player = new HumanPlayer();
    player.id = "player-1";
    const anchor = { x: -8.7, z: -7.2 };
    player.x = anchor.x;
    player.z = anchor.z;
    office.state.occupants.set(player.id, player);
    expect(requestInteract(office.host, player.id, "seat-desk-ceo-1", 0).result).toBe("held");

    office.motion.enqueue(agent.id, intent.sitAt("desk-ceo"));
    const { reports } = runUntilIdle(office, agent.id);
    expect(reports).toEqual([
      expect.objectContaining({
        outcome: INTENT_OUTCOME.blocked,
        reason: BLOCKED_REASON.seatTaken,
      }),
    ]);
    expect(agent.activity).toBe(AGENT_ACTIVITY.blocked);
  });

  it("will not sit at another agent's desk", () => {
    const office = createOffice(2);
    const [ada, bo] = office.agents;
    if (ada === undefined || bo === undefined) {
      throw new Error("expected two agents");
    }
    office.motion.enqueue(ada.id, intent.sitAt(bo.deskId));
    const { reports } = runUntilIdle(office, ada.id);
    expect(reports.map((report) => report.reason)).toEqual([BLOCKED_REASON.seatTaken]);
  });
});

describe("the tick, with everyone walking", () => {
  it("keeps well inside the tick budget with every agent pathing at once", () => {
    const office = createOffice(MAX_AGENT_COUNT);
    const far = ["wp-ceo-desk", "wp-meeting-north", "wp-kitchen-coffee", "wp-lobby-centre"];
    office.agents.forEach((agent, index) => {
      office.motion.enqueue(agent.id, intent.goto(far[index % far.length] ?? "wp-ceo-desk"));
      office.motion.enqueue(agent.id, intent.goto("wp-floor-back"));
    });

    const ticks = 400;
    const startedAt = performance.now();
    let walking = 0;
    for (let i = 0; i < ticks; i += 1) {
      tick(office);
      walking = Math.max(
        walking,
        office.agents.filter((agent) => agent.animation === ANIMATION_STATE.walking).length,
      );
    }
    const perTickMs = (performance.now() - startedAt) / ticks;

    expect(walking).toBe(MAX_AGENT_COUNT);
    // A tenth of the 50ms budget, which is still far more than it needs.
    expect(perTickMs).toBeLessThan(TICK_INTERVAL_MS / 10);
  });

  it("leaves a player's movement exactly as it would be with nobody walking", () => {
    const movePlayer = (withAgentsWalking: boolean) => {
      const office = createOffice(MAX_AGENT_COUNT);
      if (withAgentsWalking) {
        for (const agent of office.agents) {
          office.motion.enqueue(agent.id, intent.goto("wp-floor-north"));
        }
      }
      const spawn = OFFICE_LAYOUT.spawnPoints[0] ?? { x: 0, z: 2.5, yaw: 0 };
      const player = new HumanPlayer();
      player.id = "player-1";
      player.x = spawn.x;
      player.z = spawn.z;
      office.state.occupants.set(player.id, player);
      const playerMotion = createMotion(spawn.x, spawn.z, spawn.yaw, 0);

      const path: Vec2[] = [];
      for (let i = 1; i <= 60; i += 1) {
        // Straight up the aisle, the way an honest client would report it.
        const reported = { x: spawn.x, z: spawn.z - (WALK_SPEED * i * TICK_INTERVAL_MS) / 1000 };
        recordPose(
          playerMotion,
          { ...reported, yaw: 0, animation: ANIMATION_STATE.walking },
          office.now + TICK_INTERVAL_MS,
        );
        office.now += TICK_INTERVAL_MS;
        applyPose(player as Occupant, playerMotion, office.now, OFFICE_LAYOUT);
        office.motion.step(office.now);
        path.push({ x: player.x, z: player.z });
      }
      return path;
    };

    expect(movePlayer(true)).toEqual(movePlayer(false));
  });

  it("hires agents onto the floor the planner describes", () => {
    // A guard on the fixtures above: they assume the first hire stands
    // behind its chair on the open floor.
    const [first] = planAgentHires(OFFICE_LAYOUT, 1);
    expect(first?.stand.z).toBeGreaterThan(-2.4);
  });
});
