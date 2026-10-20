/**
 * Hiring a new coding agent for an issue against a real office and project
 * board, and a hiring desk the test controls: the issue and the office's cap
 * checked first, the profile the plan wrote or the office's own, and the issue
 * given to the new agent through the work's rules once it has walked in.
 */

import {
  type AgentProfile,
  type BoardIssue,
  DEFAULT_AGENT_NAMES,
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  IssueWork,
  LiveAgent,
  OCCUPANT_KIND,
  OfficeState,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  WORK_STATUS,
  liveAgentKey,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { runnerSlotAgentId } from "../agents/runnerLink.js";
import type { WorkHost } from "../rooms/workHandlers.js";
import { type AgentHiring, HIRE_ARRIVAL_MS, HireDesk, hireDescription, hireTitle, isAgentHiring } from "./hire.js";
import { readOfficeView } from "./officeView.js";

const RESTRICTED = "agent-restricted";

function issue(number: number, title: string, labels: readonly string[] = []): BoardIssue {
  return { number, title, body: "", labels: labels.map((name) => ({ name, color: "" })), assignees: [], pullRequests: [], closedAt: null };
}

const SNAPSHOT: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  repository: "o/r",
  updatedAt: 1,
  stale: false,
  open: [issue(15, "Draft the Q3 roadmap"), issue(39, "Night shift", [RESTRICTED]), issue(40, "Keyboard focus on the HUD")],
  closed: [{ ...issue(12, "Old thing"), closedAt: 5 }],
  pullRequests: [{ number: 46, title: "Show live agents", labels: [], author: "crew", draft: false, checks: "unknown" }],
  counts: { open: 3, inProgress: 0, pullRequests: 1 },
};

const NEW_KEY = liveAgentKey(runnerSlotAgentId("runner-1", "hired-1"));

function office(options: { readonly agents?: number; readonly cap?: number; readonly coders?: readonly string[] } = {}) {
  const state = new OfficeState();
  state.agentRestrictLabel = RESTRICTED;
  const ceo = new HumanPlayer();
  ceo.id = "session-dana";
  ceo.name = "Dana";
  ceo.kind = OCCUPANT_KIND.human;
  ceo.role = PLAYER_ROLE.ceo;
  state.occupants.set(ceo.id, ceo);
  for (const name of options.coders ?? []) {
    const coder = new LiveAgent();
    coder.id = liveAgentKey(runnerSlotAgentId("runner-1", name));
    coder.name = name;
    coder.canTakeIssues = true;
    state.occupants.set(coder.id, coder);
  }
  const clock = { now: 1_000 };
  const work: WorkHost = { state, now: () => clock.now, board: () => SNAPSHOT };
  const hired: { profile: AgentProfile; requestedBy: string }[] = [];
  const withdrawn: string[] = [];
  let count = options.agents ?? (options.coders ?? []).length;
  const hiring: AgentHiring = {
    cap: options.cap ?? 4,
    count: () => count,
    hire: (profile, requestedBy) => {
      hired.push({ profile, requestedBy });
      count += 1;
      return { runnerId: "runner-1", slotId: `hired-${hired.length}`, commandId: `command-${hired.length}` };
    },
    withdraw: (_runnerId, commandId) => {
      withdrawn.push(commandId);
      return true;
    },
  };
  const desk = new HireDesk();
  const context = () => ({ work, ceo, view: readOfficeView({ state, project: SNAPSHOT, liveAgents: undefined }), hiring });
  /** The new agent walks onto the floor, as the room's crew puts it there. */
  const arrive = (key = NEW_KEY, name = "Nova") => {
    const agent = new LiveAgent();
    agent.id = key;
    agent.name = name;
    agent.canTakeIssues = true;
    state.occupants.set(key, agent);
  };
  return { state, ceo, clock, work, hiring, hired, withdrawn, desk, context, arrive };
}

const NOVA = { work: "#40", name: "Nova", title: "Accessibility Specialist", description: "Makes the HUD work from the keyboard." };

describe("HireDesk", () => {
  it("hires an agent with the profile the plan wrote, and gives it the issue once it has walked in", () => {
    const { state, desk, context, hired, work, arrive } = office();
    expect(desk.carryOut([NOVA], context())).toEqual([
      "✓ Hired Nova, Accessibility Specialist, for #40 “Keyboard focus on the HUD”; on the way in.",
    ]);
    expect(hired).toEqual([
      { profile: { name: "Nova", title: "Accessibility Specialist", description: "Makes the HUD work from the keyboard." }, requestedBy: "Dana" },
    ]);
    expect(desk.settle(work, context().hiring)).toEqual([]);

    arrive();
    expect(desk.settle(work, context().hiring)).toEqual(["Nova is here and on #40 “Keyboard focus on the HUD”."]);
    expect(state.work.get(workKey(40))).toMatchObject({ assigneeId: NEW_KEY, status: WORK_STATUS.assigned });
    expect(desk.settle(work, context().hiring)).toEqual([]);
  });

  it("writes the profile itself when the plan left it empty, with a name nobody in the office has", () => {
    const first = DEFAULT_AGENT_NAMES[0];
    const { desk, context, hired } = office({ coders: [first] });
    desk.carryOut([{ work: "issue #15", name: "", title: "", description: "" }, { work: "#40", name: "dana", title: "", description: "" }], context());
    expect(hired.map((each) => each.profile)).toEqual([
      { name: DEFAULT_AGENT_NAMES[1], title: hireTitle(15), description: hireDescription(15, "Draft the Q3 roadmap") },
      { name: DEFAULT_AGENT_NAMES[2], title: hireTitle(40), description: hireDescription(40, "Keyboard focus on the HUD") },
    ]);
  });

  it("says the office is full at its cap, hires on their way included, and suggests firing or reusing an agent", () => {
    const { desk, context, hired } = office({ coders: ["Maya"], cap: 2 });
    const lines = desk.carryOut([NOVA, { ...NOVA, name: "Orla", work: "#15" }], context());
    expect(lines[1]).toBe(
      "✗ #15 “Draft the Q3 roadmap”: the office is full, with 2 of 2 coding agents, so I can't hire another. " +
        "Fire one (face it and hold E) or “put Maya on #15” instead.",
    );
    expect(hired).toHaveLength(1);
  });

  it("hires nobody for work a new agent could not be given, or with no runner connected", () => {
    const { state, desk, context, hired } = office({ coders: ["Maya"] });
    const held = new IssueWork();
    held.issueNumber = 15;
    held.status = WORK_STATUS.in_progress;
    held.assigneeId = liveAgentKey(runnerSlotAgentId("runner-1", "Maya"));
    state.work.set(workKey(15), held);
    expect(
      desk.carryOut(
        [
          { ...NOVA, work: "#99" },
          { ...NOVA, work: "PR #46" },
          { ...NOVA, work: "#12" },
          { ...NOVA, work: "#39" },
          { ...NOVA, work: "#15" },
        ],
        context(),
      ),
    ).toEqual([
      "✗ #99: I can't find that on the project board, so I hired nobody for it.",
      "✗ PR #46 “Show live agents”: a new agent is hired for an issue, not a pull request.",
      "✗ #12 “Old thing”: it is closed, so there is nothing to hire anyone for.",
      "✗ #39 “Night shift”: it carries the label that keeps the coding agents off it, so I hired nobody for it.",
      "✗ #15 “Draft the Q3 roadmap”: it is already Maya's; say “put someone on #15” to move it instead.",
    ]);
    expect(desk.carryOut([NOVA], { ...context(), hiring: undefined })).toEqual([
      "✗ #40 “Keyboard focus on the HUD”: no agent runner is connected, so I can't hire anyone.",
    ]);
    expect(hired).toEqual([]);
  });

  it("gives up on an agent that never arrives, taking its hire back", () => {
    const { desk, context, clock, work, withdrawn } = office();
    desk.carryOut([NOVA], context());
    clock.now += HIRE_ARRIVAL_MS;
    expect(desk.settle(work, context().hiring)).toEqual([
      "✗ Nova never arrived for #40 “Keyboard focus on the HUD”: the runner did not take them on. Ask me again?",
    ]);
    expect(withdrawn).toEqual(["command-1"]);
  });

  it("hands nothing to an agent whose hirer is no longer the CEO when it walks in", () => {
    const { state, ceo, desk, context, work, arrive } = office();
    desk.carryOut([NOVA], context());
    ceo.role = PLAYER_ROLE.exec;
    arrive();
    expect(desk.settle(work, context().hiring)).toEqual([
      "Nova is here, but whoever hired them is no longer the CEO, so #40 “Keyboard focus on the HUD” is not theirs yet.",
    ]);
    expect(state.work.get(workKey(40))).toBeUndefined();
  });

  it("is told apart from whatever a client put in its join options", () => {
    expect(isAgentHiring(office().hiring)).toBe(true);
    expect(isAgentHiring({ cap: 4 })).toBe(false);
    expect(isAgentHiring(undefined)).toBe(false);
  });
});
