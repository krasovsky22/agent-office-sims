/**
 * One room's manager, against a real office and project board and a planner
 * the test controls:
 * who it listens to, what it says, what it does, and that it writes nothing
 * once stopped.
 *
 * The answers themselves are `rulePlanner.test.ts`'s and the assignments
 * `assign.test.ts`'s; what only the manager can show is the order of things —
 * the instruction recorded and the badge raised at once, the answer later,
 * judged against the office as it is then — and its updates.
 */

import {
  type BoardIssue,
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  IssueWork,
  LIVE_AGENT_REPORT_STATUS,
  LiveAgent,
  MANAGER_ENTRY_KIND,
  MANAGER_OCCUPANT_ID,
  MANAGER_REJECTION,
  MANAGER_STATUS,
  type ManagerEntry,
  OFFICE_LAYOUT,
  OCCUPANT_KIND,
  OfficeState,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  WORK_STATUS,
  employManager,
  isAiManager,
  workKey,
} from "@sim/shared";
import { afterEach, describe, expect, it } from "vitest";

import { type LiveAgentRecord, LiveAgentRegistry, type LiveAgentSource } from "../agents/registry.js";
import type { WorkHost } from "../rooms/workHandlers.js";
import { type ManagerAdvisor, type ManagerPlan, type ManagerPlanner, createManagerAdvisor } from "./advisor.js";
import { LiveAssignmentQueue } from "./liveAssignments.js";
import { MAX_WAITING_MESSAGES, OfficeManager } from "./officeManager.js";
import { ADVICE_FAILURE } from "./plannerError.js";
import { planFromRules } from "./rulePlanner.js";

function player(id: string, name: string, ceo: boolean): HumanPlayer {
  const occupant = new HumanPlayer();
  occupant.id = id;
  occupant.name = name;
  occupant.kind = OCCUPANT_KIND.human;
  occupant.role = ceo ? PLAYER_ROLE.ceo : PLAYER_ROLE.exec;
  return occupant;
}

function issue(number: number, title: string): BoardIssue {
  return { number, title, body: "", labels: [], assignees: [], pullRequests: [], closedAt: null };
}

const BOARD: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  repository: "o/r",
  updatedAt: 1,
  stale: false,
  open: [issue(10, "Fix the login redirect loop"), issue(11, "Write the onboarding email")],
  counts: { open: 2, inProgress: 0, pullRequests: 0 },
};

const running: OfficeManager[] = [];

afterEach(() => {
  for (const manager of running.splice(0)) {
    manager.stop();
  }
});

/** A planner the test answers by hand, one question at a time. */
function heldPlanner() {
  const waiting: { readonly resolve: (plan: ManagerPlan) => void; readonly signal: AbortSignal }[] = [];
  const planner: ManagerPlanner = (_request, signal) =>
    new Promise((resolve) => {
      waiting.push({ resolve, signal });
    });
  return { planner, waiting };
}

function setUp(
  advisor: ManagerAdvisor,
  updateIntervalMs = 60_000,
  floor?: LiveAgentSource,
  /** What the office already holds when the manager arrives. */
  arrival?: (state: OfficeState) => void,
) {
  const state = new OfficeState();
  const dana = player("session-dana", "Dana", true);
  const milo = player("session-milo", "Milo", false);
  state.occupants.set(dana.id, dana);
  state.occupants.set(milo.id, milo);
  const manager = employManager(OFFICE_LAYOUT);
  if (manager === undefined) {
    throw new Error("the shipped layout has no manager's desk");
  }
  state.occupants.set(manager.id, manager);
  const crewmate = new LiveAgent();
  crewmate.id = "crew-1";
  crewmate.name = "Crewmate";
  state.occupants.set(crewmate.id, crewmate);
  const work: WorkHost = { state, now: () => 5000, board: () => BOARD };

  const registry = new LiveAgentRegistry({ timeoutMs: 60_000, maxAgents: 4 });
  registry.report({ id: crewmate.id, name: crewmate.name, status: LIVE_AGENT_REPORT_STATUS.idle, task: undefined });
  const queue = new LiveAssignmentQueue({ agents: registry });

  arrival?.(state);

  const published: ManagerEntry[] = [];
  const managerOfRoom = new OfficeManager({
    work,
    advisor,
    liveAgents: queue,
    assignments: queue,
    ...(floor === undefined ? {} : { floor }),
    origin: "room-a",
    publish: (entry) => published.push(entry),
    updateIntervalMs,
  });
  running.push(managerOfRoom);
  managerOfRoom.start();
  const status = () => {
    const occupant = state.occupants.get(MANAGER_OCCUPANT_ID);
    return occupant !== undefined && isAiManager(occupant) ? occupant.status : undefined;
  };
  return { state, dana, milo, queue, office: managerOfRoom, published, status };
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const rules = () => createManagerAdvisor({ planner: async (request) => planFromRules(request), mode: "rules" });

describe("OfficeManager", () => {
  it("takes instructions from the CEO alone, and records nothing from anyone else", () => {
    const { milo, office, published } = setUp(rules());
    expect(office.instruct(milo, "put Crewmate on #10")).toBe(MANAGER_REJECTION.forbidden);
    expect(published).toEqual([]);
    expect(office.history()).toEqual([]);
  });

  it("records the CEO's message and shows it thinking at once, then answers from the live board", async () => {
    const held = heldPlanner();
    const { dana, office, published, status } = setUp(createManagerAdvisor({ planner: held.planner, mode: "model" }));

    expect(office.instruct(dana, "what's the status of #10?")).toBeUndefined();
    expect(published).toEqual([
      expect.objectContaining({ id: 1, kind: MANAGER_ENTRY_KIND.instruction, authorName: "Dana", text: "what's the status of #10?" }),
    ]);
    expect(status()).toBe(MANAGER_STATUS.thinking);

    await until(() => held.waiting.length === 1);
    held.waiting[0]?.resolve({ reply: "Nobody is on #10 yet.", assignments: [], tokensUsed: 0 });
    await until(() => published.length === 2);
    expect(published[1]).toMatchObject({ kind: MANAGER_ENTRY_KIND.reply, authorName: "Firstmate", text: "Nobody is on #10 yet." });
    expect(status()).toBe(MANAGER_STATUS.idle);
    expect(office.history()).toHaveLength(2);
  });

  it("carries out the assignments in its plan, and says how each went", async () => {
    const { dana, queue, office, published } = setUp(rules());
    office.instruct(dana, "put Crewmate on #10");
    await until(() => published.length === 2);
    expect(published[1]?.text).toBe(
      "Here's how that went:\n✓ #10 “Fix the login redirect loop” → Crewmate; queued for the orchestrator to hand over.",
    );
    expect(queue.collect()).toEqual([expect.objectContaining({ agentId: "crew-1", requestedBy: "Dana" })]);
  });

  it("hands nothing out for a CEO who lost the role while it was thinking", async () => {
    const held = heldPlanner();
    const { dana, milo, queue, office, published } = setUp(createManagerAdvisor({ planner: held.planner, mode: "model" }));
    office.instruct(dana, "put Crewmate on #10");
    await until(() => held.waiting.length === 1);
    dana.role = PLAYER_ROLE.exec;
    milo.role = PLAYER_ROLE.ceo;
    held.waiting[0]?.resolve({ reply: "On it.", assignments: [{ work: "#10", agent: "crew-1" }], tokensUsed: 0 });
    await until(() => published.length === 2);
    expect(published[1]?.text).toContain("You are no longer the CEO");
    expect(queue.collect()).toEqual([]);
  });

  it("holds a few messages while it answers one, and turns away more", async () => {
    const held = heldPlanner();
    const { dana, office } = setUp(createManagerAdvisor({ planner: held.planner, mode: "model" }));
    office.instruct(dana, "first");
    await until(() => held.waiting.length === 1);
    for (let index = 0; index < MAX_WAITING_MESSAGES; index += 1) {
      expect(office.instruct(dana, `waiting ${index}`)).toBeUndefined();
    }
    expect(office.instruct(dana, "one too many")).toBe(MANAGER_REJECTION.busy);
  });

  it("answers by rule, and says so, when its model fails", async () => {
    const advisor: ManagerAdvisor = {
      mode: "model",
      advise: async () => ({ ok: false, reason: ADVICE_FAILURE.timeout, message: "no answer within 60s", attempts: 2, tokensUsed: 0 }),
    };
    const { dana, office, published } = setUp(advisor);
    office.instruct(dana, "status of #11?");
    await until(() => published.length === 2);
    expect(published[1]?.text).toBe(
      "(I couldn't reach my model — no answer within 60s — so this is my quick answer from the board.)\n" +
        "#11 “Write the onboarding email” is open. Nobody in the office is on it yet.",
    );
  });

  it("posts an update when work is handed in, but not about what it found on arrival", async () => {
    const entry = new IssueWork();
    entry.issueNumber = 10;
    entry.title = "Fix the login redirect loop";
    entry.status = WORK_STATUS.in_progress;
    entry.assigneeId = "crew-1";
    const { published } = setUp(rules(), 10, undefined, (state) => state.work.set(workKey(10), entry));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(published).toEqual([]);

    entry.status = WORK_STATUS.review;
    await until(() => published.length === 1);
    expect(published[0]).toMatchObject({
      kind: MANAGER_ENTRY_KIND.update,
      text: "Crewmate handed in #10 “Fix the login redirect loop” for your review.",
    });
  });

  it("posts once when a runner's slot on the floor needs someone, and nothing else about that slot", async () => {
    const slot = (status: LiveAgentRecord["status"], activity: string): LiveAgentRecord => ({
      id: "runner:runner-1:slot-1",
      name: "Claude 1",
      status,
      activity,
      task: { title: "Night shift", url: "https://github.com/o/r/issues/39" },
    });
    let records: readonly LiveAgentRecord[] = [];
    const floor: LiveAgentSource = { current: () => records, subscribe: () => () => undefined };
    const { published } = setUp(rules(), 10, floor);
    await new Promise((resolve) => setTimeout(resolve, 40));
    records = [slot("idle", "")];
    await new Promise((resolve) => setTimeout(resolve, 40));
    records = [slot("working", "Bash: pnpm install")];
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(published).toEqual([]);

    records = [slot("needs-input", "Permission: Bash pnpm test")];
    await until(() => published.length === 1);
    expect(published[0]).toMatchObject({
      kind: MANAGER_ENTRY_KIND.update,
      text: "Claude 1 needs you on #39: Permission: Bash pnpm test",
    });
    records = [slot("needs-input", "Permission: Edit src/index.ts")];
    await new Promise((resolve) => setTimeout(resolve, 40));
    records = [slot("working", "Bash: pnpm test")];
    await new Promise((resolve) => setTimeout(resolve, 40));
    records = [slot("idle", "")];
    await new Promise((resolve) => setTimeout(resolve, 40));
    records = [];
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(published).toHaveLength(1);
  });

  it("posts for a slot already waiting on its first look, and only once", async () => {
    const records: readonly LiveAgentRecord[] = [
      {
        id: "runner:runner-1:slot-1",
        name: "Claude 1",
        status: "needs-input",
        activity: "Permission: Bash pnpm test",
        task: { title: "Night shift", url: "https://github.com/o/r/issues/39" },
      },
    ];
    const floor: LiveAgentSource = { current: () => records, subscribe: () => () => undefined };
    const { published } = setUp(rules(), 10, floor);
    await until(() => published.length === 1);
    expect(published[0]?.text).toBe("Claude 1 needs you on #39: Permission: Bash pnpm test");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(published).toHaveLength(1);
  });

  it("posts news it is told as an update, and nothing once stopped", () => {
    const { office, published } = setUp(rules());
    office.report("Mock 1 couldn't start on #39: the runner's daily budget of $5.00 is spent.");
    expect(published).toEqual([
      expect.objectContaining({
        kind: MANAGER_ENTRY_KIND.update,
        text: "Mock 1 couldn't start on #39: the runner's daily budget of $5.00 is spent.",
      }),
    ]);
    office.stop();
    office.report("too late");
    expect(published).toHaveLength(1);
  });

  it("aborts the call in flight when stopped, and writes nothing after", async () => {
    const held = heldPlanner();
    const { dana, office, published } = setUp(createManagerAdvisor({ planner: held.planner, mode: "model" }));
    office.instruct(dana, "anything");
    await until(() => held.waiting.length === 1);
    office.stop();
    expect(held.waiting[0]?.signal.aborted).toBe(true);
    held.waiting[0]?.resolve({ reply: "too late", assignments: [], tokensUsed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(published).toHaveLength(1);
    expect(office.instruct(dana, "again")).toBe(MANAGER_REJECTION.busy);
  });
});
