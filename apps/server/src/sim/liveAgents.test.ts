/**
 * The live agents' bodies, driven tick by tick against the shipped floor plan.
 *
 * Each acceptance claim about the world side is checked here without a socket:
 * a working agent reaches a free chair and sits in it, never one somebody else
 * holds; an idle one stands up and wanders between rooms; two idle ones that
 * meet trade lines; one that leaves frees its chair; one that starts an issue
 * fetches its sticky note first, and one that hands it in pins the note on the
 * pull requests board. Time is passed in, and
 * the wandering is driven by a seeded random source, so every run walks the
 * same route.
 */

import { MapSchema } from "@colyseus/schema";
import {
  ANIMATION_STATE,
  HumanPlayer,
  INTERACTION_KIND,
  ISSUES_STICKER_BOARD_ID,
  IssueWork,
  LIVE_AGENT_STATUS,
  LiveAgent,
  OCCUPANT_RADIUS,
  OFFICE_LAYOUT,
  type Occupant,
  PULL_REQUESTS_STICKER_BOARD_ID,
  SIDEWALK_ROOM_ID,
  TICK_INTERVAL_MS,
  WORK_STATUS,
  type WorkStatus,
  interactableById,
  isBlocked,
  liveAgentSeats,
  liveAgentKey,
  roomAt,
  standupSpots,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import type { LiveAgentRecord } from "../agents/registry.js";
import { HoldRegistry, type InteractionHost } from "./interaction.js";
import {
  CONVERSATIONS,
  LINE_GAP_MS,
  LiveAgentCrew,
  MEET_DISTANCE,
  NOTE_HANDLING_MS,
} from "./liveAgents.js";

const STEP_SECONDS = TICK_INTERVAL_MS / 1000;

/** A small linear congruential generator, so a wander is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface Office {
  readonly occupants: Map<string, Occupant>;
  readonly interaction: InteractionHost;
  readonly work: MapSchema<IssueWork>;
  readonly crew: LiveAgentCrew;
  readonly said: { occupantId: string; text: string; at: number }[];
  now: number;
}

function createOffice(seed = 1): Office {
  const occupants = new Map<string, Occupant>();
  const interaction: InteractionHost = {
    layout: OFFICE_LAYOUT,
    occupants,
    motions: new Map(),
    holds: new HoldRegistry(),
    lastUsedAt: new Map(),
  };
  const said: Office["said"] = [];
  const work = new MapSchema<IssueWork>();
  const office: Office = {
    occupants,
    interaction,
    work,
    said,
    now: 0,
    crew: new LiveAgentCrew({
      layout: OFFICE_LAYOUT,
      occupants,
      interaction,
      work,
      say: (occupantId, text) => {
        said.push({ occupantId, text, at: office.now });
      },
      random: seeded(seed),
    }),
  };
  return office;
}

function record(id: string, status: LiveAgentRecord["status"], title?: string): LiveAgentRecord {
  return {
    id,
    name: id,
    status,
    task: title === undefined ? undefined : { title, url: "https://github.com/o/r/issues/33" },
  };
}

/** Runs ticks until `done` holds or the time runs out. @returns the seconds it took, or `undefined`. */
function runUntil(office: Office, seconds: number, done: () => boolean): number | undefined {
  const start = office.now;
  for (let t = 0; t < seconds * 1000; t += TICK_INTERVAL_MS) {
    office.now += TICK_INTERVAL_MS;
    office.crew.step(office.now, STEP_SECONDS);
    if (done()) {
      return (office.now - start) / 1000;
    }
  }
  return undefined;
}

function agent(office: Office, id: string): Occupant {
  const occupant = office.occupants.get(liveAgentKey(id));
  if (occupant === undefined) {
    throw new Error(`agent ${id} is not on the floor`);
  }
  return occupant;
}

/** Sits a player in a chair the way the room would, so the crew sees it as taken. */
function seatPlayer(office: Office, id: string, seatId: string): void {
  const spec = interactableById(OFFICE_LAYOUT, seatId);
  if (spec === undefined) {
    throw new Error(`no seat ${seatId}`);
  }
  const player = new HumanPlayer();
  player.id = id;
  player.x = spec.anchor.x;
  player.z = spec.anchor.z;
  player.interactableId = seatId;
  office.occupants.set(id, player);
  office.interaction.holds.take(id, spec, office.now);
}

const SEATS = liveAgentSeats(OFFICE_LAYOUT);

describe("the chairs live agents may take", () => {
  it("are the open floor's workstations, and only those", () => {
    expect(SEATS.length).toBeGreaterThan(12);
    for (const seat of SEATS) {
      expect(seat.kind).toBe(INTERACTION_KIND.seat);
      expect(roomAt(OFFICE_LAYOUT, seat.anchor)?.id).toBe("open-floor");
    }
    expect(SEATS.map((seat) => seat.id)).not.toContain("seat-desk-ceo-1");
  });
});

describe("a working agent", () => {
  it("walks in and sits at a free workstation within a few seconds, typing", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working, "Live agents")], office.now);
    const body = agent(office, "alpha");

    const seconds = runUntil(office, 10, () => body.interactableId !== "");
    expect(seconds).toBeDefined();
    // From a doorway to the nearest open-floor chair is about five seconds'
    // walk; the slack is for a layout change that lengthens it a little.
    expect(seconds).toBeLessThan(8);
    expect(SEATS.map((seat) => seat.id)).toContain(body.interactableId);
    expect(office.interaction.holds.holderOf(body.interactableId)).toBe(liveAgentKey("alpha"));
    expect(body.animation).toBe(ANIMATION_STATE.typing);
    const anchor = interactableById(OFFICE_LAYOUT, body.interactableId)?.anchor;
    expect(body.x).toBeCloseTo(anchor?.x ?? Number.NaN, 5);
    expect(body.z).toBeCloseTo(anchor?.z ?? Number.NaN, 5);
  });

  it("never takes a chair a player is sitting in", () => {
    const office = createOffice();
    const free = SEATS[SEATS.length - 1];
    if (free === undefined) {
      throw new Error("no seats");
    }
    SEATS.slice(0, -1).forEach((seat, index) => {
      seatPlayer(office, `player-${index}`, seat.id);
    });
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working)], office.now);

    expect(runUntil(office, 30, () => agent(office, "alpha").interactableId !== "")).toBeDefined();
    expect(agent(office, "alpha").interactableId).toBe(free.id);
  });

  it("goes somewhere else when a player sits in its chair first", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working)], office.now);
    // One tick to pick a chair, then a player takes it while the agent walks.
    runUntil(office, STEP_SECONDS, () => true);
    const body = agent(office, "alpha");
    const nearest = SEATS.reduce((best, seat) =>
      Math.hypot(seat.anchor.x - body.x, seat.anchor.z - body.z) <
      Math.hypot(best.anchor.x - body.x, best.anchor.z - body.z)
        ? seat
        : best,
    );
    seatPlayer(office, "player", nearest.id);

    expect(runUntil(office, 15, () => body.interactableId !== "")).toBeDefined();
    expect(body.interactableId).not.toBe(nearest.id);
    expect(office.interaction.holds.holderOf(nearest.id)).toBe("player");
  });

  it("does not share a chair with another agent", () => {
    const office = createOffice();
    office.crew.sync(
      ["a", "b", "c", "d"].map((id) => record(id, LIVE_AGENT_STATUS.working)),
      office.now,
    );
    const bodies = ["a", "b", "c", "d"].map((id) => agent(office, id));
    expect(runUntil(office, 20, () => bodies.every((body) => body.interactableId !== ""))).toBeDefined();
    expect(new Set(bodies.map((body) => body.interactableId)).size).toBe(4);
  });

  it("stands and waits when every chair is taken, and sits as soon as one frees", () => {
    const office = createOffice();
    SEATS.forEach((seat, index) => {
      seatPlayer(office, `player-${index}`, seat.id);
    });
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working)], office.now);
    runUntil(office, 3, () => false);
    expect(agent(office, "alpha").interactableId).toBe("");

    office.interaction.holds.release("player-0");
    office.occupants.delete("player-0");
    expect(runUntil(office, 30, () => agent(office, "alpha").interactableId !== "")).toBeDefined();
    expect(agent(office, "alpha").interactableId).toBe(SEATS[0]?.id);
  });

  // The route to every chair from every entrance is walked for real, through
  // the resolver, so a desk moved into a spot the waypoint graph cannot reach
  // fails here rather than leaving an agent pacing in front of a wall.
  it.each(SEATS.map((seat) => seat.id))("can reach %s from either doorway", (seatId) => {
    for (const entrance of [0, 1]) {
      const office = createOffice();
      for (const [index, seat] of SEATS.entries()) {
        if (seat.id !== seatId) {
          seatPlayer(office, `player-${index}`, seat.id);
        }
      }
      // Arrivals alternate doorways, so a first agent that leaves at once
      // sends the second through the other one.
      if (entrance === 1) {
        office.crew.sync([record("warmup", LIVE_AGENT_STATUS.idle)], office.now);
        office.crew.sync([], office.now);
      }
      office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working)], office.now);
      const body = agent(office, "alpha");
      expect(runUntil(office, 20, () => body.interactableId !== "")).toBeDefined();
      expect(body.interactableId).toBe(seatId);
    }
  });
});

describe("an agent that needs input", () => {
  it("keeps its chair, and keeps it when it resumes", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working)], office.now);
    const body = agent(office, "alpha");
    runUntil(office, 10, () => body.interactableId !== "");
    const seat = body.interactableId;

    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.needsInput)], office.now);
    runUntil(office, 5, () => false);
    expect(body.interactableId).toBe(seat);
    expect(office.interaction.holds.holderOf(seat)).toBe(body.id);

    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working)], office.now);
    runUntil(office, 1, () => false);
    expect(body.interactableId).toBe(seat);
  });

  it("walks to a chair when it arrives already waiting", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.needsInput)], office.now);
    const body = agent(office, "alpha");
    expect(runUntil(office, 20, () => body.interactableId !== "")).toBeDefined();
  });
});

describe("an idle agent", () => {
  it("stands up, frees its chair and wanders into other rooms", () => {
    const office = createOffice(7);
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working)], office.now);
    const body = agent(office, "alpha");
    runUntil(office, 10, () => body.interactableId !== "");
    const seat = body.interactableId;

    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle)], office.now);
    runUntil(office, STEP_SECONDS, () => true);
    expect(body.interactableId).toBe("");
    expect(office.interaction.holds.holderOf(seat)).toBeUndefined();
    expect(body.animation).not.toBe(ANIMATION_STATE.typing);

    const rooms = new Set<string>();
    runUntil(office, 180, () => {
      const room = roomAt(OFFICE_LAYOUT, body)?.id;
      if (room !== undefined) {
        rooms.add(room);
      }
      // Wherever the wander takes it, it is never inside anything solid.
      expect(isBlocked(body, OCCUPANT_RADIUS * 0.99, OFFICE_LAYOUT)).toBe(false);
      return rooms.size >= 3;
    });
    expect(rooms.size).toBeGreaterThanOrEqual(3);
  });

  it("stays indoors, never wandering out of the main entrance onto the pavement", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const office = createOffice(seed);
      office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle)], office.now);
      const body = agent(office, "alpha");
      const outside = runUntil(office, 600, () => roomAt(OFFICE_LAYOUT, body)?.id === SIDEWALK_ROOM_ID);
      expect(outside, `seed ${seed}`).toBeUndefined();
    }
  });

  it("goes back to a chair when it picks up a task", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle)], office.now);
    runUntil(office, 5, () => false);
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working, "Next issue")], office.now);
    const body = agent(office, "alpha");
    expect(runUntil(office, 20, () => body.interactableId !== "")).toBeDefined();
    expect(body).toMatchObject({ taskTitle: "Next issue" });
  });

  it("heads for a chair at once when it picks up a task while resting", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle)], office.now);
    const body = agent(office, "alpha");
    let moved = false;
    let last = { x: body.x, z: body.z };
    const rested = runUntil(office, 60, () => {
      const still = body.x === last.x && body.z === last.z;
      last = { x: body.x, z: body.z };
      moved ||= !still;
      return moved && still;
    });
    expect(rested).toBeDefined();

    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working)], office.now);
    runUntil(office, STEP_SECONDS * 2, () => false);
    expect({ x: body.x, z: body.z }).not.toEqual(last);
  });
});

describe("two idle agents that meet", () => {
  it("stop, face each other and take turns saying canned lines", () => {
    const office = createOffice();
    office.crew.sync(
      [record("alpha", LIVE_AGENT_STATUS.idle), record("beta", LIVE_AGENT_STATUS.idle)],
      office.now,
    );
    const alpha = agent(office, "alpha");
    const beta = agent(office, "beta");

    // Half of all wander stops head for the other agent, so they meet well
    // inside the first minute.
    expect(runUntil(office, 60, () => office.said.length >= 4)).toBeDefined();

    const [first, second, third, fourth] = office.said;
    expect(first?.occupantId).not.toBe(second?.occupantId);
    expect(first?.occupantId).toBe(third?.occupantId);
    expect(second?.occupantId).toBe(fourth?.occupantId);
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(LINE_GAP_MS);
    const lines = office.said.slice(0, 4).map((line) => line.text);
    expect(CONVERSATIONS).toContainEqual(lines);

    // They are still standing together, turned towards each other.
    expect(Math.hypot(alpha.x - beta.x, alpha.z - beta.z)).toBeLessThanOrEqual(MEET_DISTANCE);
    const facing = (from: Occupant, to: Occupant) => {
      const towardX = to.x - from.x;
      const towardZ = to.z - from.z;
      // Yaw 0 faces -Z, so the forward vector is (-sin, -cos).
      return (-Math.sin(from.yaw) * towardX - Math.cos(from.yaw) * towardZ) / Math.hypot(towardX, towardZ);
    };
    expect(facing(alpha, beta)).toBeGreaterThan(0.99);
    expect(facing(beta, alpha)).toBeGreaterThan(0.99);
    expect(alpha.animation).toBe(ANIMATION_STATE.idle);
  });

  it("break off when one picks up a task, which heads for a chair at once", () => {
    const office = createOffice();
    office.crew.sync(
      [record("alpha", LIVE_AGENT_STATUS.idle), record("beta", LIVE_AGENT_STATUS.idle)],
      office.now,
    );
    const alpha = agent(office, "alpha");
    expect(runUntil(office, 60, () => office.said.length >= 1)).toBeDefined();

    const before = { x: alpha.x, z: alpha.z };
    office.crew.sync(
      [record("alpha", LIVE_AGENT_STATUS.working), record("beta", LIVE_AGENT_STATUS.idle)],
      office.now,
    );
    runUntil(office, STEP_SECONDS * 2, () => false);
    expect({ x: alpha.x, z: alpha.z }).not.toEqual(before);
  });

  it("do not talk while one of them is working", () => {
    const office = createOffice();
    office.crew.sync(
      [record("alpha", LIVE_AGENT_STATUS.working), record("beta", LIVE_AGENT_STATUS.idle)],
      office.now,
    );
    runUntil(office, 60, () => false);
    expect(office.said).toEqual([]);
  });
});

describe("an agent that leaves", () => {
  it("is taken off the floor and frees its chair on the same sync", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working)], office.now);
    const body = agent(office, "alpha");
    runUntil(office, 10, () => body.interactableId !== "");
    const seat = body.interactableId;

    office.crew.sync([], office.now);
    expect(office.occupants.has(liveAgentKey("alpha"))).toBe(false);
    expect(office.interaction.holds.holderOf(seat)).toBeUndefined();
    expect(office.crew.size).toBe(0);
  });

  it("ends a conversation it was in, leaving the other agent free", () => {
    const office = createOffice();
    office.crew.sync(
      [record("alpha", LIVE_AGENT_STATUS.idle), record("beta", LIVE_AGENT_STATUS.idle)],
      office.now,
    );
    runUntil(office, 120, () => office.said.length >= 1);
    office.crew.sync([record("beta", LIVE_AGENT_STATUS.idle)], office.now);
    const spoken = office.said.length;
    runUntil(office, 10, () => false);
    expect(office.said.length).toBe(spoken);
  });
});

describe("issue work", () => {
  function workAt(office: Office, issueNumber: number, status: WorkStatus): IssueWork {
    const work = new IssueWork();
    work.issueNumber = issueNumber;
    work.status = status;
    work.assigneeId = liveAgentKey("alpha");
    office.work.set(workKey(issueNumber), work);
    return work;
  }

  it("can be given to an agent only when its feed says so", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle)], office.now);
    const body = agent(office, "alpha");
    expect(body instanceof LiveAgent && body.canTakeIssues).toBe(false);
    office.crew.sync([{ ...record("alpha", LIVE_AGENT_STATUS.idle), canTakeIssues: true }], office.now);
    expect(body instanceof LiveAgent && body.canTakeIssues).toBe(true);
  });

  it("is put down when its agent leaves, except a review already handed in", () => {
    const office = createOffice();
    office.crew.sync([{ ...record("alpha", LIVE_AGENT_STATUS.idle), canTakeIssues: true }], office.now);
    workAt(office, 1, WORK_STATUS.assigned);
    workAt(office, 2, WORK_STATUS.in_progress);
    workAt(office, 3, WORK_STATUS.review);
    office.crew.sync([], office.now);
    expect([...office.work.keys()]).toEqual(["3"]);
  });
});

describe("labels", () => {
  it("carry the name, status and task the feed reported", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working, "Live agents")], office.now);
    const body = agent(office, "alpha");
    expect(body.name).toBe("alpha");
    expect(body.kind).toBe("live-agent");
    expect(body).toMatchObject({
      status: LIVE_AGENT_STATUS.working,
      taskTitle: "Live agents",
      taskUrl: "https://github.com/o/r/issues/33",
    });

    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle)], office.now);
    expect(body).toMatchObject({ status: LIVE_AGENT_STATUS.idle, taskTitle: "", taskUrl: "" });
  });

  it("carry what the agent is doing, or waits on, while the feed says so", () => {
    const office = createOffice();
    office.crew.sync([{ ...record("alpha", LIVE_AGENT_STATUS.needsInput), activity: "Permission: Bash" }], office.now);
    const body = agent(office, "alpha");
    expect(body).toMatchObject({ status: LIVE_AGENT_STATUS.needsInput, activity: "Permission: Bash" });

    office.crew.sync([{ ...record("alpha", LIVE_AGENT_STATUS.working), activity: "Bash: pnpm test" }], office.now);
    expect(body).toMatchObject({ status: LIVE_AGENT_STATUS.working, activity: "Bash: pnpm test" });

    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle)], office.now);
    expect(body).toMatchObject({ activity: "" });
  });

  it("carry what the manager assigned it next, until the feed stops saying so", () => {
    const office = createOffice();
    const assignment = { title: "Night shift", url: "https://github.com/o/r/issues/39" };
    office.crew.sync([{ ...record("alpha", LIVE_AGENT_STATUS.idle), assignment }], office.now);
    const body = agent(office, "alpha");
    expect(body).toMatchObject({ assignedTitle: "Night shift", assignedUrl: assignment.url });

    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working, "Night shift")], office.now);
    expect(body).toMatchObject({ assignedTitle: "", assignedUrl: "" });
  });
});

describe("sticky notes", () => {
  const ISSUE = 33;

  function startedWork(office: Office, assignee = "alpha"): IssueWork {
    const work = new IssueWork();
    work.issueNumber = ISSUE;
    work.title = "Sticker boards";
    work.status = WORK_STATUS.in_progress;
    work.assigneeId = liveAgentKey(assignee);
    office.work.set(workKey(ISSUE), work);
    return work;
  }

  function carried(office: Office, id: string): number {
    return (agent(office, id) as LiveAgent).carriedIssue;
  }

  function atBoard(office: Office, id: string, boardId: string): boolean {
    const spot = interactableById(OFFICE_LAYOUT, boardId)?.anchor;
    const body = agent(office, id);
    return spot !== undefined && Math.hypot(spot.x - body.x, spot.z - body.z) < 0.1;
  }

  /** Brings an agent in on the issue and runs until it is at its desk with the note. */
  function seatedWithNote(office: Office): IssueWork {
    const work = startedWork(office);
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working, "Sticker boards")], office.now);
    const seated = runUntil(office, 60, () => agent(office, "alpha").interactableId !== "" && carried(office, "alpha") === ISSUE);
    expect(seated).toBeDefined();
    return work;
  }

  it("are fetched from the issues board by an agent starting the issue, then carried to its desk", () => {
    const office = createOffice();
    startedWork(office);
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working, "Sticker boards")], office.now);

    expect(runUntil(office, 30, () => atBoard(office, "alpha", ISSUES_STICKER_BOARD_ID))).toBeDefined();
    // It stands there a moment, and only then does the note leave the board.
    expect(carried(office, "alpha")).toBe(0);
    expect(agent(office, "alpha").interactableId).toBe("");
    const tookAfter = runUntil(office, 5, () => carried(office, "alpha") === ISSUE);
    expect(tookAfter).toBeDefined();
    expect((tookAfter ?? 0) * 1000).toBeGreaterThanOrEqual(NOTE_HANDLING_MS - TICK_INTERVAL_MS);

    expect(runUntil(office, 30, () => agent(office, "alpha").interactableId !== "")).toBeDefined();
    expect(carried(office, "alpha")).toBe(ISSUE);
  });

  it("are not fetched for work only assigned, which has not started", () => {
    const office = createOffice();
    startedWork(office).status = WORK_STATUS.assigned;
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working, "Sticker boards")], office.now);
    expect(runUntil(office, 30, () => agent(office, "alpha").interactableId !== "")).toBeDefined();
    expect(carried(office, "alpha")).toBe(0);
  });

  it("are pinned on the pull requests board once the work is handed in, and the agent wanders off", () => {
    const office = createOffice();
    const work = seatedWithNote(office);
    work.status = WORK_STATUS.review;
    work.outputArtifact = "PR #41: Sticker boards, https://github.com/o/r/pull/41";
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle)], office.now);

    expect(runUntil(office, 40, () => atBoard(office, "alpha", PULL_REQUESTS_STICKER_BOARD_ID))).toBeDefined();
    expect(carried(office, "alpha")).toBe(ISSUE);
    expect(runUntil(office, 5, () => carried(office, "alpha") === 0)).toBeDefined();
    expect(runUntil(office, 20, () => !atBoard(office, "alpha", PULL_REQUESTS_STICKER_BOARD_ID))).toBeDefined();
  });

  it("are put back on the issues board when the work stops with a note saying why", () => {
    const office = createOffice();
    const work = seatedWithNote(office);
    work.note = "Timed out after 30 minutes";
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle)], office.now);

    expect(runUntil(office, 40, () => atBoard(office, "alpha", ISSUES_STICKER_BOARD_ID))).toBeDefined();
    expect(runUntil(office, 5, () => carried(office, "alpha") === 0)).toBeDefined();
  });

  it("are put back when the work is taken back, even by an agent still working", () => {
    const office = createOffice();
    seatedWithNote(office);
    office.work.delete(workKey(ISSUE));

    expect(runUntil(office, 40, () => carried(office, "alpha") === 0)).toBeDefined();
    expect(atBoard(office, "alpha", ISSUES_STICKER_BOARD_ID)).toBe(true);
  });

  it("are left on the board when the work is taken back before the agent gets there", () => {
    const office = createOffice();
    startedWork(office);
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working, "Sticker boards")], office.now);
    runUntil(office, 1, () => false);
    office.work.delete(workKey(ISSUE));

    expect(runUntil(office, 30, () => agent(office, "alpha").interactableId !== "")).toBeDefined();
    expect(carried(office, "alpha")).toBe(0);
  });

  it("are never copied: an agent given work whose note another still holds waits for it to come back", () => {
    const office = createOffice();
    const work = seatedWithNote(office);
    office.crew.sync(
      [record("alpha", LIVE_AGENT_STATUS.working, "Sticker boards"), record("beta", LIVE_AGENT_STATUS.working)],
      office.now,
    );
    work.assigneeId = liveAgentKey("beta");

    let both = false;
    const handedOver = runUntil(office, 90, () => {
      both ||= carried(office, "alpha") === ISSUE && carried(office, "beta") === ISSUE;
      return carried(office, "beta") === ISSUE;
    });
    expect(handedOver).toBeDefined();
    expect(both).toBe(false);
    expect(carried(office, "alpha")).toBe(0);
  });
});

describe("a standup", () => {
  const SPOTS = standupSpots(OFFICE_LAYOUT);
  const atSpot = (body: Occupant) => SPOTS.some((spot) => Math.hypot(spot.x - body.x, spot.z - body.z) < 0.1);

  it("gets every agent out of its chair and to a place of its own in the manager's room, facing the desk", () => {
    const office = createOffice();
    office.crew.sync(
      [record("alpha", LIVE_AGENT_STATUS.working, "Live agents"), record("bravo", LIVE_AGENT_STATUS.idle)],
      office.now,
    );
    const alpha = agent(office, "alpha");
    const bravo = agent(office, "bravo");
    expect(runUntil(office, 30, () => alpha.interactableId !== "")).toBeDefined();

    office.crew.gather(SPOTS, office.now);
    expect(runUntil(office, 60, () => office.crew.isGathered(alpha.id) && office.crew.isGathered(bravo.id))).toBeDefined();
    for (const body of [alpha, bravo]) {
      expect(body.interactableId).toBe("");
      expect(atSpot(body)).toBe(true);
      expect(roomAt(OFFICE_LAYOUT, body)?.id).toBe("lobby");
      expect(body.animation).toBe(ANIMATION_STATE.idle);
    }
    expect(Math.hypot(alpha.x - bravo.x, alpha.z - bravo.z)).toBeGreaterThan(0.5);
    expect(alpha.yaw).toBeCloseTo(SPOTS.find((spot) => Math.hypot(spot.x - alpha.x, spot.z - alpha.z) < 0.1)?.yaw ?? Number.NaN);
  });

  it("takes in an agent that arrives while it is on, and nobody stops to chat", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle)], office.now);
    office.crew.gather(SPOTS, office.now);
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.idle), record("bravo", LIVE_AGENT_STATUS.idle)], office.now);
    const bravo = agent(office, "bravo");
    expect(runUntil(office, 60, () => office.crew.isGathered(bravo.id) && office.crew.isGathered(agent(office, "alpha").id))).toBeDefined();
    runUntil(office, 10, () => false);
    expect(office.said).toEqual([]);
  });

  it("sends a working agent back to the chair it left once it ends, and an idle one off wandering", () => {
    const office = createOffice();
    office.crew.sync(
      [record("alpha", LIVE_AGENT_STATUS.working, "Live agents"), record("bravo", LIVE_AGENT_STATUS.idle)],
      office.now,
    );
    const alpha = agent(office, "alpha");
    const bravo = agent(office, "bravo");
    expect(runUntil(office, 30, () => alpha.interactableId !== "")).toBeDefined();
    const desk = alpha.interactableId;

    office.crew.gather(SPOTS, office.now);
    expect(runUntil(office, 60, () => office.crew.isGathered(alpha.id) && office.crew.isGathered(bravo.id))).toBeDefined();
    office.crew.dismiss(office.now);
    expect(office.crew.isGathered(alpha.id)).toBe(false);
    expect(runUntil(office, 60, () => alpha.interactableId !== "")).toBeDefined();
    expect(alpha.interactableId).toBe(desk);
    expect(alpha.animation).toBe(ANIMATION_STATE.typing);
    expect(runUntil(office, 30, () => !atSpot(bravo))).toBeDefined();
  });

  it("finds another chair when somebody took the one it left", () => {
    const office = createOffice();
    office.crew.sync([record("alpha", LIVE_AGENT_STATUS.working, "Live agents")], office.now);
    const alpha = agent(office, "alpha");
    expect(runUntil(office, 30, () => alpha.interactableId !== "")).toBeDefined();
    const desk = alpha.interactableId;

    office.crew.gather(SPOTS, office.now);
    expect(runUntil(office, 60, () => office.crew.isGathered(alpha.id))).toBeDefined();
    seatPlayer(office, "player-1", desk);
    office.crew.dismiss(office.now);
    expect(runUntil(office, 60, () => alpha.interactableId !== "")).toBeDefined();
    expect(alpha.interactableId).not.toBe(desk);
  });
});
