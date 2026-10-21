/**
 * The standup, run against a real office state with the crew, the runner and
 * the conversation stood in for: who may call it, the order the agents speak
 * in and what each says, directions and blockers, and ending it.
 */

import {
  AGENT_PROMPT_REJECTION,
  HumanPlayer,
  IssueWork,
  LIVE_AGENT_STATUS,
  LiveAgent,
  type LiveAgentStatus,
  MAX_CHAT_LENGTH,
  OFFICE_LAYOUT,
  OfficeState,
  PLAYER_ROLE,
  STANDUP_DIRECTION_STATUS,
  STANDUP_EVERYONE,
  STANDUP_REJECTION,
  StandingTask,
  WORK_STATUS,
  type WorkStatus,
  liveAgentKey,
  simulatedPullRequestArtifact,
  standupSpots,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { runnerSlotAgentId } from "../agents/runnerLink.js";
import { GATHER_TIMEOUT_MS, StandupMeeting, UPDATE_GAP_MS, directionContext, standupSpokenLine, standupUpdateOf } from "./standup.js";

const CLAUDE_1 = liveAgentKey(runnerSlotAgentId("runner-1", "slot-1"));
const CLAUDE_2 = liveAgentKey(runnerSlotAgentId("runner-1", "slot-2"));
const CREWMATE = liveAgentKey("crew-1");

function player(id: string, name: string, role: (typeof PLAYER_ROLE)[keyof typeof PLAYER_ROLE]): HumanPlayer {
  const occupant = new HumanPlayer();
  occupant.id = id;
  occupant.name = name;
  occupant.role = role;
  return occupant;
}

function liveAgent(id: string, name: string, status: LiveAgentStatus, extra: Partial<LiveAgent> = {}): LiveAgent {
  const occupant = new LiveAgent();
  occupant.id = id;
  occupant.name = name;
  occupant.status = status;
  occupant.canTakeIssues = id !== CREWMATE;
  Object.assign(occupant, extra);
  return occupant;
}

function work(issueNumber: number, assigneeId: string, status: WorkStatus, extra: Partial<IssueWork> = {}): IssueWork {
  const entry = new IssueWork();
  entry.issueNumber = issueNumber;
  entry.title = `Issue ${issueNumber}`;
  entry.assigneeId = assigneeId;
  entry.status = status;
  Object.assign(entry, extra);
  return entry;
}

interface Setup {
  readonly state: OfficeState;
  readonly meeting: StandupMeeting;
  readonly dana: HumanPlayer;
  readonly milo: HumanPlayer;
  readonly said: Array<{ occupantId: string; text: string }>;
  readonly reported: string[];
  readonly holds: boolean[];
  readonly gathered: Set<string>;
  readonly crewCalls: string[];
  readonly directions: Array<{ senderId: string; agentId: string; text: string }>;
  /** The status each direction carried, for an answer from an agent with no session. */
  readonly contexts: string[];
  now: number;
  /** What the next direction is answered with: a command id, or a refusal. */
  answer: string | typeof AGENT_PROMPT_REJECTION.offline;
}

function setup(agents: readonly LiveAgent[] = [liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.working)]): Setup {
  const state = new OfficeState();
  const dana = player("dana", "Dana", PLAYER_ROLE.ceo);
  const milo = player("milo", "Milo", PLAYER_ROLE.exec);
  state.occupants.set(dana.id, dana);
  state.occupants.set(milo.id, milo);
  for (const agent of agents) {
    state.occupants.set(agent.id, agent);
  }
  let commands = 0;
  const holder: { s?: Setup } = {};
  const said: Setup["said"] = [];
  const reported: string[] = [];
  const holds: boolean[] = [];
  const gathered = new Set<string>();
  const crewCalls: string[] = [];
  const directions: Setup["directions"] = [];
  const contexts: string[] = [];
  const meeting = new StandupMeeting({
    state,
    layout: OFFICE_LAYOUT,
    crew: {
      gather: (spots) => {
        crewCalls.push(`gather ${spots.length}`);
      },
      dismiss: () => {
        crewCalls.push("dismiss");
      },
      isGathered: (key) => gathered.has(key),
    },
    now: () => holder.s?.now ?? 0,
    clock: () => 0,
    prompts: {
      submitDirection: (senderId, agentId, text, context = "") => {
        directions.push({ senderId, agentId, text });
        contexts.push(context);
        const answer = holder.s?.answer ?? "command";
        if (answer === AGENT_PROMPT_REJECTION.offline) {
          return answer;
        }
        commands += 1;
        return { commandId: `${answer}-${commands}` };
      },
    },
    say: (occupantId, text) => {
      said.push({ occupantId, text });
    },
    report: (text) => {
      reported.push(text);
    },
    hold: (on) => {
      holds.push(on);
    },
  });
  holder.s = { state, meeting, dana, milo, said, reported, holds, gathered, crewCalls, directions, contexts, now: 1_000, answer: "command" };
  return holder.s;
}

/** Steps the meeting through `ms` of time, a tick at a time. */
function pass(s: Setup, ms: number): void {
  const end = s.now + ms;
  while (s.now < end) {
    s.now += 50;
    s.meeting.step();
  }
}

describe("calling a standup", () => {
  it("is the CEO's alone, and gathers every agent, holds the runners and says so", () => {
    const s = setup([liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.working), liveAgent(CREWMATE, "Crewmate", LIVE_AGENT_STATUS.idle)]);
    expect(s.meeting.start(s.milo)).toBe(STANDUP_REJECTION.forbidden);
    expect(s.state.standup.active).toBe(false);
    expect(s.crewCalls).toEqual([]);

    expect(s.meeting.start(s.dana)).toBeUndefined();
    expect(s.state.standup).toMatchObject({ active: true, calledBy: "Dana", startedAt: 1_000, speakerId: "" });
    expect(s.state.standup.order.toArray()).toEqual([CLAUDE_1, CREWMATE]);
    expect(s.crewCalls).toEqual([`gather ${standupSpots(OFFICE_LAYOUT).length}`]);
    expect(s.holds).toEqual([true]);
    expect(s.reported).toEqual(["Dana called a standup: 2 agents to the conference room, and each gives an update in turn."]);
  });

  it("is refused while one is on, and with nobody on the floor to gather", () => {
    const s = setup();
    expect(s.meeting.start(s.dana)).toBeUndefined();
    expect(s.meeting.start(s.dana)).toBe(STANDUP_REJECTION.running);
    const empty = setup([]);
    expect(empty.meeting.start(empty.dana)).toBe(STANDUP_REJECTION.noAgents);
    expect(empty.holds).toEqual([]);
  });

  it("starts each one with a clean record", () => {
    const s = setup();
    s.meeting.start(s.dana);
    pass(s, GATHER_TIMEOUT_MS + 100);
    s.meeting.direct(s.dana, { agentId: CLAUDE_1, text: "Open the PR." });
    s.meeting.end(s.dana);
    expect(s.state.standup.updates.length).toBe(1);

    s.meeting.start(s.dana);
    expect(s.state.standup.updates.length).toBe(0);
    expect(s.state.standup.directions.length).toBe(0);
  });
});

describe("the updates", () => {
  it("wait for everyone to arrive, then go round in the order the agents were in the office, one at a time", () => {
    const s = setup([
      liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.working),
      liveAgent(CLAUDE_2, "Claude 2", LIVE_AGENT_STATUS.idle),
      liveAgent(CREWMATE, "Crewmate", LIVE_AGENT_STATUS.working, { taskTitle: "Live agents", taskUrl: "https://github.com/o/r/issues/33" }),
    ]);
    s.meeting.start(s.dana);
    pass(s, 2_000);
    expect(s.state.standup.updates.length).toBe(0);

    s.gathered.add(CLAUDE_1).add(CLAUDE_2).add(CREWMATE);
    pass(s, 50);
    expect(s.state.standup.updates.map((update) => update.agentName)).toEqual(["Claude 1"]);
    expect(s.state.standup.speakerId).toBe(CLAUDE_1);

    pass(s, UPDATE_GAP_MS - 100);
    expect(s.state.standup.updates.length).toBe(1);
    pass(s, 100);
    expect(s.state.standup.updates.map((update) => update.agentName)).toEqual(["Claude 1", "Claude 2"]);
    pass(s, UPDATE_GAP_MS);
    expect(s.state.standup.updates.map((update) => update.agentName)).toEqual(["Claude 1", "Claude 2", "Crewmate"]);

    // Each said in its own bubble and in the conversation.
    expect(s.said.map((line) => line.occupantId)).toEqual([CLAUDE_1, CLAUDE_2, CREWMATE]);
    expect(s.reported.slice(1, 4).map((line) => line.split(":")[0])).toEqual(["Claude 1", "Claude 2", "Crewmate"]);

    pass(s, UPDATE_GAP_MS);
    expect(s.state.standup.speakerId).toBe("");
    expect(s.reported.at(-1)).toBe(
      "That's everyone's update. Nobody is waiting on you. Answer their screens or give directions from the standup panel, then end the standup.",
    );
    pass(s, UPDATE_GAP_MS * 3);
    expect(s.reported.filter((line) => line.startsWith("That's everyone's update")).length).toBe(1);
  });

  it("start without a slow walker once the gathering time is up", () => {
    const s = setup([liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.working)]);
    s.meeting.start(s.dana);
    pass(s, GATHER_TIMEOUT_MS - 100);
    expect(s.state.standup.updates.length).toBe(0);
    pass(s, 200);
    expect(s.state.standup.updates.length).toBe(1);
  });

  it("take in an agent that arrives meanwhile, last, and skip one that left", () => {
    const s = setup([liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.working), liveAgent(CLAUDE_2, "Claude 2", LIVE_AGENT_STATUS.idle)]);
    s.meeting.start(s.dana);
    s.state.occupants.delete(CLAUDE_1);
    s.state.occupants.set(CREWMATE, liveAgent(CREWMATE, "Crewmate", LIVE_AGENT_STATUS.idle));
    pass(s, GATHER_TIMEOUT_MS + UPDATE_GAP_MS * 3);
    expect(s.state.standup.order.toArray()).toEqual([CLAUDE_1, CLAUDE_2, CREWMATE]);
    expect(s.state.standup.updates.map((update) => update.agentName)).toEqual(["Claude 2", "Crewmate"]);
  });

  it("are read off the agent's real work: its issue, how far it got, its pull request, and what holds it up", () => {
    const working = liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.working, { activity: "Bash: pnpm test" });
    expect(standupUpdateOf(working, [work(39, CLAUDE_1, WORK_STATUS.in_progress)])).toEqual({
      workedOn: "#39 “Issue 39”, in progress, last step Bash: pnpm test",
      blockers: "",
      needsYou: false,
    });

    const waiting = liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.needsInput, { activity: "Permission: Bash git push" });
    expect(standupUpdateOf(waiting, [work(39, CLAUDE_1, WORK_STATUS.in_progress)])).toEqual({
      workedOn: "#39 “Issue 39”, in progress",
      blockers: "waiting on you: Permission: Bash git push",
      needsYou: true,
    });

    const reviewed = work(39, CLAUDE_1, WORK_STATUS.review, { outputArtifact: "PR #40: Night shift, https://github.com/o/r/pull/40" });
    expect(standupUpdateOf(liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.idle), [reviewed])).toEqual({
      workedOn: "#39 “Issue 39”, opened PR #40 https://github.com/o/r/pull/40",
      blockers: "waiting on your review",
      needsYou: false,
    });

    const simulated = work(39, CLAUDE_1, WORK_STATUS.review, { outputArtifact: simulatedPullRequestArtifact("[mock] Night shift") });
    expect(standupUpdateOf(liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.idle), [simulated]).workedOn).toBe(
      "#39 “Issue 39”, handed in as a simulated pull request, nothing on GitHub",
    );

    const refused = work(39, CLAUDE_1, WORK_STATUS.assigned, { note: "The runner's daily budget is spent" });
    expect(standupUpdateOf(liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.idle), [refused])).toEqual({
      workedOn: "#39 “Issue 39”, not started yet",
      blockers: "The runner's daily budget is spent",
      needsYou: false,
    });

    expect(standupUpdateOf(liveAgent(CLAUDE_2, "Claude 2", LIVE_AGENT_STATUS.idle), [reviewed]).workedOn).toBe(
      "No issue in hand, free for one",
    );
    const crewmate = liveAgent(CREWMATE, "Crewmate", LIVE_AGENT_STATUS.working, {
      taskTitle: "Live agents",
      taskUrl: "https://github.com/o/r/issues/33",
      activity: "Edit: state.ts",
    });
    expect(standupUpdateOf(crewmate, []).workedOn).toBe("#33 “Live agents”, last step Edit: state.ts");
    expect(
      standupUpdateOf(liveAgent(CREWMATE, "Crewmate", LIVE_AGENT_STATUS.idle, { assignedTitle: "Night shift" }), []).workedOn,
    ).toBe("Between tasks; next up “Night shift”");
  });

  it("shorten the title rather than the blocker when the update is longer than a chat line", () => {
    const blocked = liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.needsInput, { activity: "Permission: Bash pnpm test --filter @sim/server" });
    const title = `Standup call: ${"report progress and blockers, ".repeat(4)}take directions`;
    const line = standupSpokenLine(blocked, [work(39, CLAUDE_1, WORK_STATUS.in_progress, { title })]);
    expect(Array.from(line).length).toBeLessThanOrEqual(MAX_CHAT_LENGTH);
    expect(line).toMatch(/^#39 “Standup call: .+…”, in progress\. Blocker: waiting on you: Permission: Bash pnpm test --filter @sim\/server\.$/);
    expect(standupSpokenLine(blocked, [work(39, CLAUDE_1, WORK_STATUS.in_progress)])).toBe(
      "#39 “Issue 39”, in progress. Blocker: waiting on you: Permission: Bash pnpm test --filter @sim/server.",
    );
  });

  it("say a blocker in the bubble without its link, and mark it resolved once the agent carries on", () => {
    const s = setup([liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.needsInput, { activity: "Permission: Bash git push" })]);
    s.state.work.set(workKey(39), work(39, CLAUDE_1, WORK_STATUS.in_progress));
    s.meeting.start(s.dana);
    pass(s, GATHER_TIMEOUT_MS + 100);
    expect(s.said[0]?.text).toBe("#39 “Issue 39”, in progress. Blocker: waiting on you: Permission: Bash git push.");
    expect(s.state.standup.updates.at(0)).toMatchObject({ needsYou: true, resolved: false });
    pass(s, UPDATE_GAP_MS);
    expect(s.reported.at(-1)).toContain("Waiting on you: Claude 1.");

    const agent = s.state.occupants.get(CLAUDE_1) as LiveAgent;
    agent.status = LIVE_AGENT_STATUS.working;
    pass(s, 50);
    expect(s.state.standup.updates.at(0)?.resolved).toBe(true);
    expect(s.reported.at(-1)).toBe("Claude 1 is unblocked.");
  });
});

describe("directions", () => {
  function started(): Setup {
    const s = setup([liveAgent(CLAUDE_1, "Claude 1", LIVE_AGENT_STATUS.working), liveAgent(CREWMATE, "Crewmate", LIVE_AGENT_STATUS.working)]);
    s.meeting.start(s.dana);
    return s;
  }

  it("are the CEO's alone, and only while a standup is on", () => {
    const s = setup();
    expect(s.meeting.direct(s.dana, { agentId: CLAUDE_1, text: "Go." })).toBe(STANDUP_REJECTION.notRunning);
    s.meeting.start(s.dana);
    expect(s.meeting.direct(s.milo, { agentId: CLAUDE_1, text: "Go." })).toBe(STANDUP_REJECTION.forbidden);
    expect(s.meeting.direct(s.dana, { agentId: "agent:nobody", text: "Go." })).toBe(STANDUP_REJECTION.noAgent);
    expect(s.directions).toEqual([]);
    expect(s.state.standup.directions.length).toBe(0);
  });

  it("go to a runner's coding agent as a prompt, and are on the record for an agent that takes none", () => {
    const s = started();
    expect(s.meeting.direct(s.dana, { agentId: STANDUP_EVERYONE, text: "Wrap up and open your PRs." })).toBeUndefined();
    expect(s.directions).toEqual([{ senderId: "dana", agentId: CLAUDE_1, text: "Wrap up and open your PRs." }]);
    expect(s.state.standup.directions.map((direction) => [direction.agentName, direction.status, direction.everyone])).toEqual([
      ["Claude 1", STANDUP_DIRECTION_STATUS.sending, true],
      ["Crewmate", STANDUP_DIRECTION_STATUS.noted, true],
    ]);
    expect(s.reported.at(-1)).toBe("Dana → everyone: Wrap up and open your PRs.");
  });

  it("follow what the runner says came of them: typed now, or kept and typed after", () => {
    const s = started();
    s.meeting.direct(s.dana, { agentId: CLAUDE_1, text: "Skip the server part." });
    s.meeting.direct(s.dana, { agentId: CLAUDE_1, text: "Then open the PR." });
    const [first, second] = s.state.standup.directions.toArray();

    s.meeting.settle("command-1", { kind: "typed" });
    expect(first?.status).toBe(STANDUP_DIRECTION_STATUS.typed);

    s.meeting.settle("command-2", { kind: "queued" });
    expect(second?.status).toBe(STANDUP_DIRECTION_STATUS.queued);
    s.meeting.end(s.dana);
    expect(s.reported.at(-1)).toBe(
      "Standup over: everyone back to work. One direction is kept for when its agent is next at the prompt.",
    );
    s.meeting.settle("command-2", { kind: "typed" });
    expect(second?.status).toBe(STANDUP_DIRECTION_STATUS.delivered);
    // Settled once: a repeat changes nothing.
    s.meeting.settle("command-2", { kind: "failed", rejection: AGENT_PROMPT_REJECTION.unavailable });
    expect(second?.status).toBe(STANDUP_DIRECTION_STATUS.delivered);
  });

  it("are answered by an agent with no session, from its status, on the record, in its bubble and in the conversation", () => {
    const s = setup([liveAgent(CLAUDE_1, "Lena", LIVE_AGENT_STATUS.idle)]);
    s.state.work.set(workKey(38), work(38, CLAUDE_1, WORK_STATUS.done, { outputArtifact: "PR #91: Fix it, https://github.com/o/r/pull/91" }));
    s.meeting.start(s.dana);
    s.meeting.direct(s.dana, { agentId: STANDUP_EVERYONE, text: "what the status" });
    expect(s.contexts[0]).toContain("Your update at this standup: No issue in hand, free for one. No blockers.");
    expect(s.contexts[0]).toContain("#38 “Issue 38”: done; PR #91: Fix it, https://github.com/o/r/pull/91");

    const direction = s.state.standup.directions.at(0);
    s.meeting.settle("command-1", { kind: "answering" });
    expect(direction?.status).toBe(STANDUP_DIRECTION_STATUS.answering);
    const reply = `Free for one: I last fixed #38 in https://github.com/o/r/pull/91.\n${"More detail. ".repeat(20)}`;
    s.meeting.settle("command-1", { kind: "answered", reply });
    expect(direction).toMatchObject({ status: STANDUP_DIRECTION_STATUS.answered, reply });
    expect(s.reported.at(-1)).toBe(`Lena: ${reply}`);
    const bubble = s.said.at(-1);
    expect(bubble?.occupantId).toBe(CLAUDE_1);
    expect(bubble?.text.startsWith("Free for one: I last fixed #38 in More detail.")).toBe(true);
    expect(Array.from(bubble?.text ?? "").length).toBeLessThanOrEqual(MAX_CHAT_LENGTH);
  });

  it("say why an agent with no session could not answer", () => {
    const s = started();
    s.meeting.direct(s.dana, { agentId: CLAUDE_1, text: "what the status" });
    s.meeting.settle("command-1", { kind: "answering" });
    s.meeting.settle("command-1", { kind: "unanswered", why: "it ran past its 1 minute" });
    expect(s.state.standup.directions.at(0)).toMatchObject({
      status: STANDUP_DIRECTION_STATUS.unanswered,
      reason: "it ran past its 1 minute",
      reply: "",
    });
  });

  it("say why one was not typed", () => {
    const s = started();
    s.answer = AGENT_PROMPT_REJECTION.offline;
    s.meeting.direct(s.dana, { agentId: CLAUDE_1, text: "Go." });
    expect(s.state.standup.directions.at(0)).toMatchObject({
      status: STANDUP_DIRECTION_STATUS.failed,
      reason: "its runner could not be reached",
    });

    s.answer = "command";
    s.meeting.direct(s.dana, { agentId: CLAUDE_1, text: "Go." });
    s.meeting.settle("command-1", { kind: "failed", rejection: AGENT_PROMPT_REJECTION.unanswered });
    expect(s.state.standup.directions.at(1)).toMatchObject({ status: STANDUP_DIRECTION_STATUS.failed });
  });
});

describe("directionContext", () => {
  it("tells an idle agent its update, its latest issues newest first, and how its standing tasks went", () => {
    const agent = liveAgent(CLAUDE_1, "Lena", LIVE_AGENT_STATUS.idle);
    const entries = [
      work(37, CLAUDE_1, WORK_STATUS.done, { updatedAt: 1 }),
      work(38, CLAUDE_1, WORK_STATUS.review, { updatedAt: 3, outputArtifact: "PR #91: Fix, https://github.com/o/r/pull/91" }),
      work(40, CLAUDE_2, WORK_STATUS.in_progress, { updatedAt: 5 }),
    ];
    const task = new StandingTask();
    Object.assign(task, { name: "Watch PRs", trigger: "every 2 min", agentId: CLAUDE_1, lastRunAt: 9, lastOutcome: "reviewed" });
    const never = new StandingTask();
    Object.assign(never, { name: "Never ran", agentId: CLAUDE_1 });
    expect(directionContext(agent, entries, [task, never]).split("\n")).toEqual([
      "Your update at this standup: #38 “Issue 38”, opened PR #91 https://github.com/o/r/pull/91. Blocker: waiting on your review.",
      "Issues you worked on lately, newest first:",
      "- #38 “Issue 38”: review; PR #91: Fix, https://github.com/o/r/pull/91",
      "- #37 “Issue 37”: done",
      "Standing tasks you run, and how the last run went:",
      "- “Watch PRs” (every 2 min): reviewed",
    ]);
  });
});

describe("ending a standup", () => {
  it("is the CEO's alone, sends everyone back to work and lets the runners carry on", () => {
    const s = setup();
    expect(s.meeting.end(s.dana)).toBe(STANDUP_REJECTION.notRunning);
    s.meeting.start(s.dana);
    expect(s.meeting.end(s.milo)).toBe(STANDUP_REJECTION.forbidden);
    expect(s.state.standup.active).toBe(true);

    s.now = 9_000;
    expect(s.meeting.end(s.dana)).toBeUndefined();
    expect(s.state.standup).toMatchObject({ active: false, endedAt: 9_000, speakerId: "" });
    expect(s.crewCalls).toEqual([`gather ${standupSpots(OFFICE_LAYOUT).length}`, "dismiss"]);
    expect(s.holds).toEqual([true, false]);
    expect(s.reported.at(-1)).toBe("Standup over: everyone back to work.");
  });

  it("touches nobody's work", () => {
    const s = setup();
    const before = work(39, CLAUDE_1, WORK_STATUS.in_progress, { note: "on it" });
    s.state.work.set(workKey(39), before);
    s.meeting.start(s.dana);
    pass(s, GATHER_TIMEOUT_MS + UPDATE_GAP_MS * 2);
    s.meeting.end(s.dana);
    expect(s.state.work.get(workKey(39))).toBe(before);
    expect(before).toMatchObject({ status: WORK_STATUS.in_progress, assigneeId: CLAUDE_1, note: "on it" });
  });
});

describe("the AI Manager's part", () => {
  it("calls and ends a standup for the CEO, without a second announcement, and says how it went", () => {
    const s = setup();
    expect(s.meeting.forManager("start", s.dana)).toBe("✓ Standup called: one agent on the way to the conference room.");
    expect(s.reported).toEqual([]);
    expect(s.meeting.forManager("start", s.dana)).toBe("✗ A standup is already on.");
    expect(s.meeting.forManager("end", s.milo)).toBe("✗ You are no longer the CEO, so I didn't.");
    expect(s.meeting.forManager("end", s.dana)).toBe("✓ Standup over: everyone is going back to work.");
    expect(s.meeting.forManager("end", s.dana)).toBe("✗ There is no standup on to end.");
    expect(s.reported).toEqual([]);
  });
});
