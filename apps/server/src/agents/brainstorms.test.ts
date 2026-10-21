/**
 * Brainstorm tickets on the server, against a real runner link: the CEO
 * hands an idea to several agents, their write-ups come in as the runner's
 * events and are merged into a design document the runner posts, a meeting
 * walks them to the meeting room and passes the talking round, and anyone
 * reviews and converts it into issues the runner creates.
 */

import {
  BRAINSTORM_ACTION,
  BRAINSTORM_MODE,
  BRAINSTORM_REJECTION,
  BRAINSTORM_STATUS,
  type BrainstormData,
  EMPTY_BOARD_LISTS,
  HumanPlayer,
  IssueWork,
  LiveAgent,
  OCCUPANT_KIND,
  OFFICE_LAYOUT,
  OfficeState,
  PLAYER_ROLE,
  type ProjectBoardSnapshot,
  RUNNER_COMMAND_KIND,
  type RunnerCommand,
  type RunnerEvent,
  type RunnerSync,
  WORK_STATUS,
  designDocument,
  liveAgentKey,
  standupSpots,
  workKey,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { Brainstorms, MEETING_LINE_GAP_MS, MEETING_LINE_WAIT_MS, RESEARCH_START_GRACE_MS, meetingPrompt } from "./brainstorms.js";
import { RunnerLink, runnerSlotAgentId } from "./runnerLink.js";
import { RunnerWork } from "./runnerWork.js";

const REPO = "krasovsky22/agent-office-sims";
const MAYA = liveAgentKey(runnerSlotAgentId("box", "slot-1"));
const LEO = liveAgentKey(runnerSlotAgentId("box", "slot-2"));
const ADA = liveAgentKey(runnerSlotAgentId("box", "slot-3"));

function issue(number: number, ...labels: string[]) {
  return { number, title: number === 191 ? "Idea tasks" : `Issue ${number}`, body: "", labels: labels.map((name) => ({ name, color: "" })), assignees: [], pullRequests: [], closedAt: null };
}

const BOARD: ProjectBoardSnapshot = {
  ...EMPTY_BOARD_LISTS,
  repository: REPO,
  updatedAt: 1,
  stale: false,
  open: [issue(191, "brainstorm"), issue(40), issue(192, "brainstorm", "agent-restricted")],
  counts: { open: 3, inProgress: 0, pullRequests: 0 },
};

function setup() {
  let nextId = 1;
  const link = new RunnerLink({ repository: REPO, timeoutMs: 30_000, commandId: () => `command-${nextId++}` });
  const state = new OfficeState();
  state.agentRestrictLabel = "agent-restricted";
  for (const [id, name, role] of [
    ["dana", "Dana", PLAYER_ROLE.ceo],
    ["milo", "Milo", PLAYER_ROLE.exec],
  ] as const) {
    const player = new HumanPlayer();
    player.id = id;
    player.name = name;
    player.role = role;
    state.occupants.set(id, player);
  }
  for (const [id, name] of [
    [MAYA, "Maya"],
    [LEO, "Leo"],
    [ADA, "Ada"],
  ] as const) {
    const agent = new LiveAgent();
    agent.id = id;
    agent.name = name;
    agent.kind = OCCUPANT_KIND.liveAgent;
    agent.canTakeIssues = true;
    agent.profileEditable = true;
    state.occupants.set(id, agent);
  }
  const clock = { now: 1000 };
  const said: Array<{ occupantId: string; text: string }> = [];
  const announced: string[] = [];
  const crew: string[] = [];
  const gathered = new Set<string>();
  let standup = false;
  const brainstorms = new Brainstorms({
    state,
    layout: OFFICE_LAYOUT,
    board: () => BOARD,
    runner: link,
    github: link,
    crew: {
      gather: (_spots, _now, only) => {
        crew.push(`gather ${[...(only ?? [])].join(",")}`);
      },
      dismiss: () => {
        crew.push("dismiss");
      },
      isGathered: (key) => gathered.has(key),
    },
    standupOn: () => standup,
    say: (occupantId, text) => said.push({ occupantId, text }),
    announce: (text) => announced.push(text),
    now: () => clock.now,
    clock: () => clock.now,
  });
  /** One sync from the runner: its slots holding what it says, its events, and every command it was sent acked. */
  const sync = (holding: Partial<Record<string, number>> = {}, events: RunnerEvent[] = [], acked: string[] = []): readonly RunnerCommand[] => {
    const body: RunnerSync = {
      runnerId: "box",
      repo: REPO,
      acked,
      slots: ["slot-1", "slot-2", "slot-3"].map((id) => ({
        id,
        name: id,
        title: "",
        description: "",
        status: holding[id] === undefined ? "idle" : "working",
        issueNumber: holding[id],
        activity: "",
        pr: undefined,
      })),
      events,
      changesIssues: true,
    };
    const outcome = link.sync(body);
    const commands = outcome.kind === "accepted" ? outcome.commands : [];
    // What the room's tick would hand on.
    brainstorms.receive(events.map((event) => ({ runnerId: "box", event })));
    return commands;
  };
  sync();
  let eventId = 1;
  const write = (slotId: string, part: "take" | "synthesis" | "line" | "summary" | "unanswered", text: string): RunnerEvent => ({
    id: `event-${eventId++}`,
    kind: "brainstorm",
    issueNumber: 191,
    part,
    slotId,
    text,
    created: [],
  });
  const github = (part: "posted" | "converted", created: { number: number; url: string }[] = []): RunnerEvent => ({
    id: `event-${eventId++}`,
    kind: "brainstorm",
    issueNumber: 191,
    part,
    slotId: undefined,
    text: "",
    created,
  });
  const failed = (slotId: string, message: string): RunnerEvent => ({ id: `event-${eventId++}`, kind: "failed", slotId, issueNumber: 191, pr: undefined, message });
  const dana = state.occupants.get("dana") as HumanPlayer;
  const milo = state.occupants.get("milo") as HumanPlayer;
  const idea = () => state.brainstorms.get(workKey(191));
  const data = () => idea()?.toJSON() as BrainstormData;
  /** Every command not yet acked, and acks them on the next sync. */
  const flush = (holding: Partial<Record<string, number>> = {}) => {
    const pending = sync(holding);
    sync(holding, [], pending.map((command) => command.id));
    return pending;
  };
  return {
    state,
    link,
    brainstorms,
    sync,
    flush,
    write,
    github,
    failed,
    dana,
    milo,
    idea,
    data,
    said,
    announced,
    crew,
    gathered,
    clock,
    setStandup: (on: boolean) => {
      standup = on;
    },
  };
}

function starts(commands: readonly RunnerCommand[]) {
  return commands.flatMap((command) =>
    command.kind === RUNNER_COMMAND_KIND.start ? [{ slotId: command.slotId, issueNumber: command.issueNumber, ...command.brainstorm }] : [],
  );
}

describe("Brainstorms: research", () => {
  it("in the critics' mode starts the researcher, then the critics on its write-up, then a synthesis of them all", () => {
    const office = setup();
    expect(office.brainstorms.assign(office.dana, { issueNumber: 191, agentIds: [MAYA, LEO, ADA], mode: BRAINSTORM_MODE.critics })).toBeUndefined();
    expect(office.idea()).toMatchObject({ status: BRAINSTORM_STATUS.researching, requestedBy: "Dana", title: "Idea tasks" });
    expect(office.data().takes.map((take) => [take.agentName, take.role, take.status])).toEqual([
      ["Maya", "researcher", "working"],
      ["Leo", "critic", "waiting"],
      ["Ada", "critic", "waiting"],
    ]);
    expect(starts(office.flush())).toEqual([{ slotId: "slot-1", issueNumber: 191, role: "researcher", prior: "" }]);
    expect(office.announced[0]).toContain("no branch and no pull request");

    office.sync({ "slot-1": 191 }, [office.write("slot-1", "take", "Verdict: doable with caveats\n\nBuild it.")]);
    expect(office.data().takes[0]).toMatchObject({ status: "done", verdict: "doable with caveats" });
    const critics = starts(office.flush());
    expect(critics.map((start) => [start.slotId, start.role])).toEqual([
      ["slot-2", "critic"],
      ["slot-3", "critic"],
    ]);
    expect(critics[0]?.prior).toBe("## Maya (researcher)\n\nVerdict: doable with caveats\n\nBuild it.");

    office.sync({}, [office.write("slot-2", "take", "Verdict: doable\n\nIt misses the client.")]);
    office.sync({}, [office.failed("slot-3", "The research stopped: it reached its spending cap")]);
    expect(office.data().takes[2]).toMatchObject({ status: "failed", note: "The research stopped: it reached its spending cap" });
    expect(office.idea()?.status).toBe(BRAINSTORM_STATUS.synthesizing);
    const synthesis = starts(office.flush());
    expect(synthesis).toEqual([
      {
        slotId: "slot-1",
        issueNumber: 191,
        role: "synthesis",
        prior: "## Maya (researcher)\n\nVerdict: doable with caveats\n\nBuild it.\n\n## Leo (critic)\n\nVerdict: doable\n\nIt misses the client.",
      },
    ]);
  });

  it("writes the design document once the recommendation is in, and has a runner that writes to GitHub post it", () => {
    const office = setup();
    office.brainstorms.assign(office.dana, { issueNumber: 191, agentIds: [MAYA, LEO], mode: BRAINSTORM_MODE.takes });
    expect(starts(office.flush()).map((start) => [start.slotId, start.role])).toEqual([
      ["slot-1", "take"],
      ["slot-2", "take"],
    ]);
    office.sync({}, [office.write("slot-1", "take", "Verdict: doable\n\nA.")]);
    office.sync({}, [office.write("slot-2", "take", "Verdict: not doable\n\nB.")]);
    const synthesizer = starts(office.flush())[0];
    expect(synthesizer?.role).toBe("synthesis");
    office.sync({}, [office.write(synthesizer?.slotId ?? "", "synthesis", "**Recommended features**\n1. Ideas.")]);
    expect(office.idea()).toMatchObject({ status: BRAINSTORM_STATUS.ready, synthesis: "**Recommended features**\n1. Ideas.", synthesizedBy: "Maya", postStatus: "sending" });
    const post = office.flush().find((command) => command.kind === RUNNER_COMMAND_KIND.brainstormPost);
    expect(post).toEqual({ id: expect.any(String), kind: "brainstorm-post", issueNumber: 191, body: designDocument(office.data()), requestedBy: "Dana" });
    office.sync({}, [office.github("posted")]);
    expect(office.idea()?.postStatus).toBe("done");
  });

  it("keeps the recommendation of the agent chosen to write it when its take and its run's end come last, in one sync", () => {
    const office = setup();
    office.brainstorms.assign(office.dana, { issueNumber: 191, agentIds: [MAYA, LEO], mode: BRAINSTORM_MODE.takes });
    office.flush();
    office.sync({}, [office.write("slot-2", "take", "Verdict: doable\n\nB.")]);
    office.sync({}, [
      office.write("slot-1", "take", "Verdict: doable\n\nA."),
      { id: "event-end", kind: "finished", slotId: "slot-1", issueNumber: 191, pr: undefined, message: "Wrote its write-up" },
    ]);
    expect(office.idea()).toMatchObject({ status: BRAINSTORM_STATUS.synthesizing, note: "" });
    expect(starts(office.flush())).toMatchObject([{ slotId: "slot-1", role: "synthesis" }]);
    office.sync({ "slot-1": 191 }, [office.write("slot-1", "synthesis", "Build the board first.")]);
    expect(office.idea()).toMatchObject({ status: BRAINSTORM_STATUS.ready, synthesis: "Build the board first.", note: "" });
  });

  it("fails an idea none of whose research came back, which can then be handed out again", () => {
    const office = setup();
    office.brainstorms.assign(office.dana, { issueNumber: 191, agentIds: [MAYA, LEO], mode: BRAINSTORM_MODE.takes });
    office.sync({}, [office.failed("slot-1", "#191 is not labelled brainstorm on GitHub, so it is not researched as an idea")]);
    office.sync({}, [office.failed("slot-2", "The research stopped: it said nothing")]);
    expect(office.idea()?.status).toBe(BRAINSTORM_STATUS.failed);
    expect(office.data().takes.map((take) => take.note)).toEqual([
      "#191 is not labelled brainstorm on GitHub, so it is not researched as an idea",
      "The research stopped: it said nothing",
    ]);
    expect(office.brainstorms.assign(office.dana, { issueNumber: 191, agentIds: [MAYA, ADA], mode: BRAINSTORM_MODE.takes })).toBeUndefined();
    expect(office.data().takes.map((take) => take.agentName)).toEqual(["Maya", "Ada"]);
  });

  it("refuses anyone but the CEO, an issue that is no idea, too few agents, and agents with work in hand", () => {
    const office = setup();
    const ask = (mode = BRAINSTORM_MODE.takes, agentIds = [MAYA, LEO], issueNumber = 191) => ({ issueNumber, agentIds, mode });
    expect(office.brainstorms.assign(office.milo, ask())).toBe(BRAINSTORM_REJECTION.forbidden);
    expect(office.brainstorms.assign(office.dana, ask(BRAINSTORM_MODE.takes, [MAYA, LEO], 40))).toBe(BRAINSTORM_REJECTION.notBrainstorm);
    expect(office.brainstorms.assign(office.dana, ask(BRAINSTORM_MODE.takes, [MAYA, LEO], 192))).toBe(BRAINSTORM_REJECTION.restricted);
    expect(office.brainstorms.assign(office.dana, ask(BRAINSTORM_MODE.takes, [MAYA]))).toBe(BRAINSTORM_REJECTION.agentCount);
    expect(office.brainstorms.assign(office.dana, ask(BRAINSTORM_MODE.takes, [MAYA, "milo"]))).toBe(BRAINSTORM_REJECTION.unknownAgent);
    const work = new IssueWork();
    work.issueNumber = 40;
    work.status = WORK_STATUS.in_progress;
    work.assigneeId = LEO;
    office.state.work.set(workKey(40), work);
    expect(office.brainstorms.assign(office.dana, ask())).toBe(BRAINSTORM_REJECTION.busy);
    expect(office.state.brainstorms.size).toBe(0);
    expect(office.brainstorms.assign(office.dana, ask(BRAINSTORM_MODE.takes, [MAYA, ADA]))).toBeUndefined();
    // Now Maya and Ada are held by the idea: neither takes a second one.
    expect(office.brainstorms.assign(office.dana, ask(BRAINSTORM_MODE.takes, [MAYA, ADA]))).toBe(BRAINSTORM_REJECTION.running);
  });

  it("is what the runner's reconciling leaves a researching slot alone for, and gives research its runner lost up", () => {
    const office = setup();
    office.brainstorms.assign(office.dana, { issueNumber: 191, agentIds: [MAYA, LEO], mode: BRAINSTORM_MODE.takes });
    office.flush();
    const stops = (researching: boolean) => {
      const work = new RunnerWork({
        host: { state: office.state, now: () => 1, board: () => BOARD },
        runner: office.link,
        ...(researching ? { researching: (agentId: string, issueNumber: number) => office.brainstorms.holds(agentId, issueNumber) } : {}),
      });
      office.sync({ "slot-1": 191 });
      work.reconcile();
      const sent = office.sync({ "slot-1": 191 }).filter((command) => command.kind === RUNNER_COMMAND_KIND.stop);
      office.sync({ "slot-1": 191 }, [], sent.map((command) => command.id));
      return sent.length;
    };
    expect(stops(true)).toBe(0);
    expect(stops(false)).toBe(1);

    // Leo's slot never said it held the idea: once the grace is up, its research is given up on.
    office.clock.now += RESEARCH_START_GRACE_MS + 1;
    office.sync({ "slot-1": 191 });
    office.brainstorms.reconcile();
    expect(office.data().takes.map((take) => take.status)).toEqual(["working", "failed"]);
    expect(office.data().takes[1]?.note).toBe("Its runner is no longer researching it.");
  });
});

/** An idea with its design document written, from Maya's and Leo's takes. */
function ready() {
  const office = setup();
  office.brainstorms.assign(office.dana, { issueNumber: 191, agentIds: [MAYA, LEO], mode: BRAINSTORM_MODE.takes });
  office.sync({}, [office.write("slot-1", "take", "Verdict: doable\n\nA.")]);
  office.sync({}, [office.write("slot-2", "take", "Verdict: doable\n\nB.")]);
  office.sync({}, [office.write("slot-1", "synthesis", "Build the board first.")]);
  office.flush();
  return office;
}

describe("Brainstorms: the meeting", () => {
  it("gathers only the idea's agents, takes turns, hears the people in the room, and saves the summary", () => {
    const office = ready();
    expect(office.brainstorms.act(office.milo, BRAINSTORM_ACTION.meet, 191)).toBe(BRAINSTORM_REJECTION.forbidden);
    office.setStandup(true);
    expect(office.brainstorms.act(office.dana, BRAINSTORM_ACTION.meet, 191)).toBe(BRAINSTORM_REJECTION.roomTaken);
    office.setStandup(false);
    expect(office.brainstorms.act(office.dana, BRAINSTORM_ACTION.meet, 191)).toBeUndefined();
    expect(office.idea()?.status).toBe(BRAINSTORM_STATUS.meeting);
    expect(office.brainstorms.meetingOn).toBe(true);
    expect(office.crew).toEqual([`gather ${MAYA},${LEO}`]);

    // Nobody speaks until both are in the room.
    office.brainstorms.step();
    expect(office.flush()).toEqual([]);
    office.gathered.add(MAYA);
    office.gathered.add(LEO);
    office.brainstorms.step();
    const first = office.flush();
    expect(first).toEqual([expect.objectContaining({ kind: "brainstorm-speak", slotId: "slot-1", part: "line" })]);
    expect(first[0]?.kind === "brainstorm-speak" ? first[0].text : "").toContain("Nothing yet: you open the discussion.");

    office.sync({}, [office.write("slot-1", "line", "We should build the board first.")]);
    expect(office.said).toEqual([{ occupantId: MAYA, text: "We should build the board first." }]);
    // Dana, in the meeting room, joins in; Milo, elsewhere, is not heard.
    const spot = standupSpots(OFFICE_LAYOUT)[0] ?? { x: 0, z: 0 };
    Object.assign(office.dana, { x: spot.x, z: spot.z });
    office.brainstorms.heard("dana", "What about the wall board?");
    office.brainstorms.heard("milo", "Not in the room.");
    office.brainstorms.step();
    expect(office.flush()).toEqual([]);
    office.clock.now += MEETING_LINE_GAP_MS;
    office.brainstorms.step();
    const second = office.flush()[0];
    const heard = second?.kind === "brainstorm-speak" ? second.text : "";
    expect(second).toMatchObject({ slotId: "slot-2", part: "line" });
    expect(heard).toContain("Maya: We should build the board first.");
    expect(heard).toContain("Dana (a person in the room): What about the wall board?");
    expect(heard).not.toContain("Not in the room.");

    // Leo never answers: the meeting moves on without him.
    office.clock.now += MEETING_LINE_WAIT_MS;
    office.brainstorms.step();
    expect(office.flush()[0]).toMatchObject({ slotId: "slot-1", part: "line" });
    office.sync({}, [office.write("slot-1", "unanswered", "the runner's daily budget is spent")]);
    office.clock.now += MEETING_LINE_GAP_MS;
    office.brainstorms.step();
    expect(office.flush()[0]).toMatchObject({ slotId: "slot-2", part: "line" });
    office.sync({}, [office.write("slot-2", "line", "The wall board can wait.")]);
    office.clock.now += MEETING_LINE_GAP_MS;
    office.brainstorms.step();
    expect(office.flush()[0]).toMatchObject({ slotId: "slot-1", part: "summary" });
    office.sync({}, [office.write("slot-1", "summary", "Board first; the wall board later.")]);

    expect(office.idea()).toMatchObject({ status: BRAINSTORM_STATUS.ready, meetingSummary: "Board first; the wall board later.", note: "" });
    expect(office.crew.at(-1)).toBe("dismiss");
    expect(office.brainstorms.meetingOn).toBe(false);
    const post = office.flush().find((command) => command.kind === RUNNER_COMMAND_KIND.brainstormPost);
    expect(post?.kind === "brainstorm-post" ? post.body : "").toContain("## Meeting summary\n\nBoard first; the wall board later.");
  });

  it("ends early, back where it was, when its agents leave", () => {
    const office = ready();
    office.brainstorms.act(office.dana, BRAINSTORM_ACTION.meet, 191);
    office.state.occupants.delete(MAYA);
    office.state.occupants.delete(LEO);
    office.brainstorms.step();
    expect(office.idea()).toMatchObject({ status: BRAINSTORM_STATUS.ready, note: "The meeting ended early: its agents left the office." });
    expect(office.crew.at(-1)).toBe("dismiss");
  });

  it("is refused while the idea's conversion is sending or done, and never sets a converted idea back", () => {
    const office = ready();
    office.brainstorms.act(office.milo, BRAINSTORM_ACTION.review, 191);
    office.brainstorms.convert(office.milo, { issueNumber: 191, drafts: [{ title: "Board", body: "" }] });
    expect(office.brainstorms.act(office.dana, BRAINSTORM_ACTION.meet, 191)).toBe(BRAINSTORM_REJECTION.wrongStep);
    office.sync({}, [office.github("converted", [{ number: 200, url: `https://github.com/${REPO}/issues/200` }])]);
    expect(office.brainstorms.act(office.dana, BRAINSTORM_ACTION.meet, 191)).toBe(BRAINSTORM_REJECTION.wrongStep);

    const other = ready();
    other.brainstorms.act(other.dana, BRAINSTORM_ACTION.meet, 191);
    const idea = other.idea();
    if (idea !== undefined) {
      idea.status = BRAINSTORM_STATUS.converted;
    }
    other.state.occupants.delete(MAYA);
    other.state.occupants.delete(LEO);
    other.brainstorms.step();
    expect(other.idea()?.status).toBe(BRAINSTORM_STATUS.converted);
  });

  it("tells each speaker the idea, its recommendation and its own write-up", () => {
    const office = ready();
    const prompt = meetingPrompt(office.data(), office.state, LEO, [MAYA, LEO], [], "line");
    expect(prompt).toContain("#191, “Idea tasks”");
    expect(prompt).toContain("as its take");
    expect(prompt).toContain("With you: Maya.");
    expect(prompt).toContain("Build the board first.");
    expect(prompt).toContain("Verdict: doable\n\nB.");
  });
});

describe("Brainstorms: review and conversion", () => {
  it("lets any player review the document and convert it, and links and closes the idea once the issues are created", () => {
    const office = ready();
    expect(office.brainstorms.convert(office.milo, { issueNumber: 191, drafts: [{ title: "Board", body: "" }] })).toBe(BRAINSTORM_REJECTION.wrongStep);
    expect(office.brainstorms.act(office.milo, BRAINSTORM_ACTION.review, 191)).toBeUndefined();
    expect(office.idea()).toMatchObject({ status: BRAINSTORM_STATUS.reviewed, reviewedBy: "Milo" });

    const drafts = [
      { title: "Ideas on the board", body: "Build the board first." },
      { title: "Meeting room", body: "Then the meeting." },
    ];
    expect(office.brainstorms.convert(office.milo, { issueNumber: 191, drafts })).toBeUndefined();
    expect(office.idea()?.convertStatus).toBe("sending");
    expect(office.brainstorms.convert(office.milo, { issueNumber: 191, drafts })).toBe(BRAINSTORM_REJECTION.running);
    expect(office.flush()).toEqual([{ id: expect.any(String), kind: "brainstorm-convert", issueNumber: 191, drafts, requestedBy: "Milo" }]);

    const created = [
      { number: 200, url: `https://github.com/${REPO}/issues/200` },
      { number: 201, url: `https://github.com/${REPO}/issues/201` },
    ];
    office.sync({}, [office.github("converted", created)]);
    expect(office.idea()).toMatchObject({ status: BRAINSTORM_STATUS.converted, convertStatus: "done" });
    expect(office.data().created).toEqual(created);
    expect(office.announced.at(-1)).toContain("converted into #200, #201");
  });

  it("refuses a conversion with no runner that writes to GitHub", () => {
    const office = ready();
    office.brainstorms.act(office.milo, BRAINSTORM_ACTION.review, 191);
    office.link.sync({ runnerId: "box", repo: REPO, acked: [], slots: [], events: [], changesIssues: false });
    expect(office.brainstorms.convert(office.milo, { issueNumber: 191, drafts: [{ title: "Board", body: "" }] })).toBe(BRAINSTORM_REJECTION.noRunner);
  });
});
