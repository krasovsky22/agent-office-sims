/**
 * The manager without a model: what it understands, and that every answer is
 * built from the office and the project board it is shown and nothing else.
 */

import { CHECK_STATUS, LIVE_AGENT_STATUS, WORK_STATUS } from "@sim/shared";
import { describe, expect, it } from "vitest";

import type { ManagerRequest } from "./advisor.js";
import { type IssueAgentView, type IssueColumn, type IssueView, NO_STANDUP_VIEW, type OfficeView, type WorkView } from "./officeView.js";
import { HELP_TEXT, REPHRASE_TEXT, planFromRules } from "./rulePlanner.js";

function work(overrides: Partial<WorkView> & Pick<WorkView, "issueNumber" | "title" | "status">): WorkView {
  return {
    assigneeId: "agent-1",
    assignee: "Ada Byrne",
    hasDeliverable: false,
    pullRequest: undefined,
    simulatedPullRequest: false,
    note: undefined,
    ...overrides,
  };
}

const WORK: readonly WorkView[] = [
  work({ issueNumber: 11, title: "Write the onboarding email", status: WORK_STATUS.in_progress }),
  work({
    issueNumber: 12,
    title: "Cut the dashboard load time",
    status: WORK_STATUS.in_progress,
    assigneeId: "agent-3",
    assignee: "Cleo Hart",
    note: "Blocked: no answer within 120s.",
  }),
  work({ issueNumber: 14, title: "Audit the third-party licences", status: WORK_STATUS.review, hasDeliverable: true }),
];

function issue(number: number, title: string, column: IssueColumn, extra: Partial<IssueView> = {}): IssueView {
  return {
    number,
    title,
    url: `https://github.com/o/r/issues/${number}`,
    column,
    labels: [],
    assignees: [],
    pullRequests: [],
    work: WORK.find((entry) => entry.issueNumber === number),
    ...extra,
  };
}

const VIEW: OfficeView = {
  ceo: "Dana",
  liveAgents: [
    {
      id: "crew-1",
      name: "Crewmate",
      status: "working",
      task: { title: "Live agents", url: "https://github.com/o/r/issues/33", reference: "#33" },
      activity: "Bash: pnpm test",
      assigned: undefined,
    },
    { id: "crew-2", name: "Deckhand", status: "idle", task: undefined, activity: "", assigned: undefined },
  ],
  issueAgents: [],
  work: WORK,
  project: {
    repository: "o/r",
    stale: false,
    issues: [
      issue(14, "Audit the third-party licences", "in progress", { assignees: ["milo"] }),
      issue(33, "Live agents", "in progress", { labels: ["wave-2"], pullRequests: [46] }),
      issue(10, "Fix the login redirect loop", "open", { labels: ["bug"] }),
      issue(11, "Write the onboarding email", "open"),
      issue(12, "Cut the dashboard load time", "open"),
      issue(15, "Draft the Q3 roadmap", "open"),
      issue(39, "Night shift", "open", { labels: ["client"] }),
      issue(5, "Old thing", "closed"),
    ],
    pullRequests: [
      {
        number: 46,
        title: "Show live agents",
        url: "https://github.com/o/r/pull/46",
        labels: ["client"],
        author: "crew",
        draft: false,
        checks: CHECK_STATUS.failing,
      },
      {
        number: 47,
        title: "Night shift lighting",
        url: "https://github.com/o/r/pull/47",
        labels: [],
        author: "dana",
        draft: true,
        checks: CHECK_STATUS.unknown,
      },
    ],
    counts: { open: 5, inProgress: 2, pullRequests: 2 },
  },
  orchestrator: true,
  standing: [],
  standup: NO_STANDUP_VIEW,
};

function ask(message: string, view: OfficeView = VIEW) {
  const request: ManagerRequest = { message, ceoName: "Dana", view, history: [] };
  return planFromRules(request);
}

describe("planFromRules: status", () => {
  it("answers for an issue by number, with who in the office is on it", () => {
    expect(ask("what's the status of #11?")).toEqual({
      reply: "#11 “Write the onboarding email” is open. Ada Byrne is working on it.",
      assignments: [],
      tokensUsed: 0,
    });
    expect(ask("status of issue 14").reply).toBe(
      "#14 “Audit the third-party licences” is in progress, assigned on GitHub to milo. Ada Byrne handed in a deliverable; it is waiting for your review.",
    );
    expect(ask("what about #10?").reply).toBe(
      "#10 “Fix the login redirect loop” is open [bug]. Nobody in the office is on it yet.",
    );
  });

  it("finds an issue by its title", () => {
    expect(ask("where are we on the onboarding email?").reply).toContain("#11");
  });

  it("answers for an issue a live agent is on, with its labels and its pull requests", () => {
    expect(ask("what's the status of #33?").reply).toBe(
      "#33 “Live agents” is in progress [wave-2]. PR #46 closes it. Crewmate is working on it.",
    );
    expect(ask("and PR 46?").reply).toBe("PR #46 “Show live agents” [client] by crew is open. Checks are failing.");
  });

  it("says when it cannot find what was named, rather than answering about something else", () => {
    expect(ask("status of #999?").reply).toBe("I can't find #999 on the project board.");
    expect(ask("what about PR 42").reply).toBe("I can't find PR #42 on the project board.");
    expect(ask("status of #11?", { ...VIEW, project: undefined }).reply).toBe(
      "I can't find #11 on the project board (and it hasn't loaded from GitHub yet).",
    );
  });

  it("describes a named agent", () => {
    expect(ask("what is Crewmate doing?").reply).toBe("Crewmate (live coding agent) is working on #33 “Live agents”.");
    expect(ask("and deckhand?").reply).toBe("Deckhand (live coding agent) is idle.");
  });

  it("says a live agent waiting on a person is waiting on the CEO, and on what", () => {
    const [crewmate, deckhand] = VIEW.liveAgents;
    const waiting = { ...VIEW, liveAgents: [{ ...crewmate!, status: "needs-input" as const, activity: "Sign in" }, deckhand!] };
    expect(ask("what is crewmate doing?", waiting).reply).toBe(
      "Crewmate (live coding agent) is waiting on you on #33 “Live agents” (Sign in).",
    );
  });

  it("summarises what everyone is working on, and who is free", () => {
    expect(ask("What is everyone working on?").reply).toBe(
      [
        "Live coding agents:",
        "- Crewmate (live coding agent) is working on #33 “Live agents”.",
        "- Deckhand (live coding agent) is idle.",
        "Free for something new: Deckhand.",
      ].join("\n"),
    );
    expect(ask("What is everyone working on?", { ...VIEW, liveAgents: [] }).reply).toBe(
      "Nobody is on the floor right now: there are no agents to report on.",
    );
  });

  it("says what is open on the project board, with labels and who is on each issue", () => {
    for (const question of ["what's open?", "how's the board?", "any github tickets?"]) {
      const reply = ask(question).reply;
      expect(reply).toContain("o/r: 7 open issues (2 in progress on GitHub), 3 with an agent on them, 2 open pull requests.");
      expect(reply).toContain(
        "Open: #14 “Audit the third-party licences” — Ada Byrne, waiting for your review, #33 “Live agents” [wave-2], #10 “Fix the login redirect loop” [bug], #11 “Write the onboarding email” — Ada Byrne, in progress",
      );
      expect(reply).toContain("Waiting for your review: #14 (Ada Byrne).");
      expect(reply).toContain("Nobody on yet: #10, #15, #39.");
      expect(reply).toContain("Open pull requests: PR #46 (checks failing), PR #47.");
      expect(reply).not.toContain("Old thing");
    }
  });

  it("lists the open pull requests when asked about PRs", () => {
    expect(ask("which PRs are open?").reply).toBe(
      [
        "o/r has 2 open pull requests:",
        "- PR #46 “Show live agents” [client] by crew is open. Checks are failing.",
        "- PR #47 “Night shift lighting” by dana, a draft, is open.",
      ].join("\n"),
    );
    const quiet = { ...VIEW, project: { ...VIEW.project!, pullRequests: [], counts: { ...VIEW.project!.counts, pullRequests: 0 } } };
    expect(ask("any open PRs?", quiet).reply).toBe("o/r has no open pull requests.");
  });

  it("says the project board has not loaded, and when it is stale", () => {
    expect(ask("what's open?", { ...VIEW, project: undefined }).reply).toContain("hasn't loaded from GitHub yet");
    expect(ask("any PRs?", { ...VIEW, project: undefined }).reply).toContain("hasn't loaded from GitHub yet");
    expect(ask("what's open?", { ...VIEW, project: { ...VIEW.project!, stale: true } }).reply).toContain(
      "GitHub was unreachable on the last poll",
    );
  });

  it("says what it can do when it does not understand", () => {
    expect(ask("bananas").reply).toBe(`I didn't catch what you want me to look at. ${HELP_TEXT}`);
    expect(ask("hello").reply).toBe(`Hello, Dana. ${HELP_TEXT}`);
  });
});

describe("planFromRules: assignments", () => {
  it.each<[string, { work: string; agent: string }[]]>([
    ["give me the status of #12", []],
    ["does anyone have #39?", []],
    ["What does Crewmate have on #11?", []],
    ["Did anyone get to #39?", []],
    ["send me an update on #39", []],
    ["hand me the notes on #12", []],
    ["have you put someone on #39?", []],
    ["Put Deckhand on #10", [{ work: "issue #10", agent: "crew-2" }]],
    ["Put Deckhand on issue 10", [{ work: "issue #10", agent: "crew-2" }]],
    ["put someone on #39", [{ work: "issue #39", agent: "" }]],
    ["put someone who's free on #39", [{ work: "issue #39", agent: "" }]],
    ["assign #39 to someone who is idle", [{ work: "issue #39", agent: "" }]],
    ["can you put Deckhand on #10?", [{ work: "issue #10", agent: "crew-2" }]],
    ["AI Manager, put Crewmate on #15", [{ work: "issue #15", agent: "crew-1" }]],
    ["have someone take #39", [{ work: "issue #39", agent: "" }]],
    ["give Deckhand's #10 to Crewmate", [{ work: "issue #10", agent: "crew-1" }]],
    ["reassign #11 to Deckhand", [{ work: "issue #11", agent: "crew-2" }]],
    ["give #10 and #15 to Deckhand", [{ work: "issue #10", agent: "crew-2" }, { work: "issue #15", agent: "crew-2" }]],
    ["put Deckhand on Draft the Q3 roadmap", [{ work: "issue #15", agent: "crew-2" }]],
    ["give PR #46 to Deckhand", [{ work: "PR #46", agent: "crew-2" }]],
    ["assign the login redirect to anyone", [{ work: "issue #10", agent: "" }]],
    ["give #10 to Deckhand, please", [{ work: "issue #10", agent: "crew-2" }]],
    [
      "give #10 to Deckhand, and #15 to Crewmate",
      [
        { work: "issue #10", agent: "crew-2" },
        { work: "issue #15", agent: "crew-1" },
      ],
    ],
    [
      "assign the backlog to Deckhand",
      [
        { work: "#10", agent: "crew-2" },
        { work: "#15", agent: "crew-2" },
        { work: "#39", agent: "crew-2" },
      ],
    ],
    [
      "hand out the backlog",
      [
        { work: "#10", agent: "" },
        { work: "#15", agent: "" },
        { work: "#39", agent: "" },
      ],
    ],
  ])("%s", (message, assignments) => {
    expect(ask(message).assignments).toEqual(assignments);
  });

  it.each([
    "send the #10 notes to Crewmate",
    "put Crewmate on #11 instead of #15",
    "hand out the backlog except #10",
    "reassign #10 from Deckhand to Crewmate",
    "give an update on #12",
    "put together a summary of #11",
  ])("does nothing with %s, and asks to rephrase", (message) => {
    expect(ask(message)).toEqual({ reply: REPHRASE_TEXT, assignments: [], tokensUsed: 0 });
  });

  it("says there is nothing to hand out when every open issue is taken", () => {
    const project = VIEW.project!;
    const taken = { ...VIEW, project: { ...project, issues: project.issues.filter((entry) => entry.column !== "open" || entry.work !== undefined) } };
    expect(ask("hand out the backlog", taken)).toMatchObject({
      reply: "Every open issue nobody is on already has an agent, so there is nothing to hand out.",
      assignments: [],
    });
    expect(ask("hand out the backlog", { ...VIEW, project: undefined }).reply).toContain("hasn't loaded from GitHub yet");
  });

  it("advises rather than assigns when asked who should do it", () => {
    const plan = ask("who should I give #39 to?");
    expect(plan.assignments).toEqual([]);
    expect(plan.reply).toContain("Deckhand is free.");
    expect(ask("who should take PR #46?").reply).toContain("Deckhand is free.");
  });

  it("answers a question that uses an assignment word, and assigns nothing", () => {
    expect(ask("give me the status of #12")).toMatchObject({
      assignments: [],
      reply: expect.stringContaining("Cleo Hart is working on it"),
    });
    expect(ask("does anyone have #39?")).toMatchObject({ assignments: [], reply: expect.stringContaining("#39 “Night shift” is open") });
  });

  it("assigns nothing when the work named does not exist", () => {
    expect(ask("put Deckhand on #999")).toMatchObject({ assignments: [], reply: expect.stringContaining("can't find #999") });
  });
});

/** A runner's coding agent, idle with no issue unless told otherwise. */
function coder(id: string, name: string, extra: Partial<IssueAgentView> = {}): IssueAgentView {
  return { id, name, title: "Software Developer", status: LIVE_AGENT_STATUS.idle, activity: "", issue: undefined, standing: undefined, ...extra };
}

describe("planFromRules: the runners' coding agents", () => {
  const ADA = coder("agent-1", "Ada Byrne", { status: LIVE_AGENT_STATUS.working, issue: WORK[0] });
  const RUNNER_VIEW: OfficeView = {
    ...VIEW,
    liveAgents: [],
    issueAgents: [ADA, coder("agent:runner/2", "Claude 2")],
    orchestrator: false,
    standing: [],
  };
  /** The office with Claude 2 doing something about #39. */
  function claude2(extra: Partial<IssueAgentView>, on: Partial<WorkView> = {}): OfficeView {
    const night = work({
      issueNumber: 39,
      title: "Night shift",
      status: WORK_STATUS.in_progress,
      assigneeId: "agent:runner/2",
      assignee: "Claude 2",
      ...on,
    });
    return { ...RUNNER_VIEW, issueAgents: [ADA, coder("agent:runner/2", "Claude 2", { issue: night, ...extra })] };
  }

  it("reports on them from their work when no orchestrator is connected", () => {
    expect(ask("who's free?", RUNNER_VIEW).reply).toBe(
      [
        "Live coding agents:",
        "- Ada Byrne (coding agent) is working on #11 “Write the onboarding email”.",
        "- Claude 2 (coding agent) is idle.",
        "Free for something new: Claude 2.",
      ].join("\n"),
    );
    expect(ask("what is Claude 2 doing?", RUNNER_VIEW).reply).toBe("Claude 2 (coding agent) is idle.");
  });

  it("says what one is doing right now, what it waits on, and the pull request it opened", () => {
    expect(ask("what is Claude 2 doing?", claude2({}, { status: WORK_STATUS.assigned })).reply).toBe(
      "Claude 2 (coding agent) has #39 “Night shift” and hasn't started yet.",
    );
    expect(
      ask("what is Claude 2 doing?", claude2({ status: LIVE_AGENT_STATUS.working, activity: "Checking #39 on GitHub" }, { status: WORK_STATUS.assigned }))
        .reply,
    ).toBe("Claude 2 (coding agent) is starting on #39 “Night shift” (Checking #39 on GitHub).");
    expect(ask("what is Claude 2 doing?", claude2({ status: LIVE_AGENT_STATUS.working, activity: "Bash: pnpm test" })).reply).toBe(
      "Claude 2 (coding agent) is working on #39 “Night shift” (Bash: pnpm test).",
    );
    expect(ask("what is claude 2 doing?", claude2({ status: LIVE_AGENT_STATUS.needsInput, activity: "Permission: Bash" })).reply).toBe(
      "Claude 2 (coding agent) is waiting on you on #39 “Night shift” (Permission: Bash).",
    );
    const pull = { title: "Night shift", url: "https://github.com/o/r/pull/48", reference: "PR #48" };
    expect(ask("what is Claude 2 doing?", claude2({}, { status: WORK_STATUS.review, hasDeliverable: true, pullRequest: pull })).reply).toBe(
      "Claude 2 (coding agent) opened PR #48 for #39 “Night shift”; it is waiting for your review: https://github.com/o/r/pull/48",
    );
    const reviewed = claude2({}, { status: WORK_STATUS.review, hasDeliverable: true, pullRequest: pull });
    const handedIn = reviewed.issueAgents[1]?.issue;
    const project = { ...VIEW.project!, issues: VIEW.project!.issues.map((entry) => (entry.number === 39 ? { ...entry, work: handedIn } : entry)) };
    expect(ask("status of #39?", { ...reviewed, project }).reply).toBe(
      "#39 “Night shift” is open [client]. Claude 2 opened PR #48 for it (https://github.com/o/r/pull/48); it is waiting for your review.",
    );
    // The mock agent's simulated one has nothing on GitHub to name or link.
    const simulated = claude2({}, { status: WORK_STATUS.review, hasDeliverable: true, simulatedPullRequest: true });
    expect(ask("what is Claude 2 doing?", simulated).reply).toBe(
      "Claude 2 (coding agent) handed in #39 “Night shift” as a simulated pull request, with nothing on GitHub; it is waiting for your review.",
    );
    const simulatedProject = {
      ...VIEW.project!,
      issues: VIEW.project!.issues.map((entry) => (entry.number === 39 ? { ...entry, work: simulated.issueAgents[1]?.issue } : entry)),
    };
    expect(ask("status of #39?", { ...simulated, project: simulatedProject }).reply).toBe(
      "#39 “Night shift” is open [client]. Claude 2 handed it in as a simulated pull request, with nothing on GitHub; it is waiting for your review.",
    );
    expect(ask("what is Claude 2 doing?", claude2({}, { note: "Timed out after 30 minutes" })).reply).toBe(
      "Claude 2 (coding agent) has #39 “Night shift” in progress but isn't running. Its last word on it: Timed out after 30 minutes",
    );
  });

  it("suggests a free one when asked who should do an issue", () => {
    expect(ask("who should I give #39 to?", RUNNER_VIEW).reply).toContain("Claude 2 is free.");
  });

  it.each<[string, { work: string; agent: string }[]]>([
    ["put a coding agent on #39", [{ work: "issue #39", agent: "a coding agent" }]],
    ["Put a coding agent who's free on #39", [{ work: "issue #39", agent: "a coding agent" }]],
    ["have a coding agent take #39", [{ work: "issue #39", agent: "a coding agent" }]],
    ["have Claude 2 do #39", [{ work: "issue #39", agent: "agent:runner/2" }]],
    ["Put Claude 2 on #39", [{ work: "issue #39", agent: "agent:runner/2" }]],
    ["put someone on #39", [{ work: "issue #39", agent: "" }]],
    [
      "hand out the backlog to a coding agent",
      [
        { work: "#10", agent: "a coding agent" },
        { work: "#15", agent: "a coding agent" },
        { work: "#39", agent: "a coding agent" },
      ],
    ],
  ])("plans %s", (message, assignments) => {
    expect(ask(message, RUNNER_VIEW).assignments).toEqual(assignments);
  });

  it("hands the backlog to whoever is free, which the office makes a coding agent", () => {
    expect(ask("hand out the backlog", RUNNER_VIEW).assignments).toEqual([
      { work: "#10", agent: "" },
      { work: "#15", agent: "" },
      { work: "#39", agent: "" },
    ]);
  });

  describe("with an issue named loosely by its title", () => {
    const project = RUNNER_VIEW.project!;
    const JUMP_VIEW: OfficeView = {
      ...RUNNER_VIEW,
      project: {
        ...project,
        issues: [
          ...project.issues,
          issue(62, "Player jumping", "open"),
          issue(63, "Desk lamp flicker", "open"),
          issue(64, "Desk chair height", "open"),
          issue(65, "Jumping jacks emote", "closed"),
        ],
      },
    };

    it.each<[string, { work: string; agent: string }[]]>([
      ["assign jumping ticket", [{ work: "issue #62", agent: "" }]],
      ["assign the jumping issue", [{ work: "issue #62", agent: "" }]],
      ["assign #62", [{ work: "issue #62", agent: "" }]],
      ["assign someone jumping ticket", [{ work: "issue #62", agent: "" }]],
      ["assign someone the player jumping ticket, please", [{ work: "issue #62", agent: "" }]],
      ["give Claude 2 the jumping ticket", [{ work: "issue #62", agent: "agent:runner/2" }]],
      ["put someone on #62", [{ work: "issue #62", agent: "" }]],
      ["get someone on the jumping issue", [{ work: "issue #62", agent: "" }]],
      ["get a coding agent on #62", [{ work: "issue #62", agent: "a coding agent" }]],
      ["put whoever is free on the jump ticket", [{ work: "issue #62", agent: "" }]],
      ["have an agent pick up the desk lamp ticket", [{ work: "issue #63", agent: "" }]],
      ["assign the jumping ticket to Claude 2", [{ work: "issue #62", agent: "agent:runner/2" }]],
    ])("plans %s", (message, assignments) => {
      expect(ask(message, JUMP_VIEW).assignments).toEqual(assignments);
    });

    it("asks to rephrase rather than guess between two issues the words fit", () => {
      expect(ask("assign the desk ticket", JUMP_VIEW)).toEqual({ reply: REPHRASE_TEXT, assignments: [], tokensUsed: 0 });
    });

    it.each(["assign #12 and the jumping ticket", "put someone on jumping and #12", "assign the jumping ticket and issue 12"])(
      "asks to rephrase %s rather than drop the numbered issue",
      (message) => {
        expect(ask(message, JUMP_VIEW)).toEqual({ reply: REPHRASE_TEXT, assignments: [], tokensUsed: 0 });
      },
    );

    it("answers a question that starts like an instruction, and assigns nothing", () => {
      expect(ask("get the status of #62", JUMP_VIEW)).toMatchObject({
        assignments: [],
        reply: expect.stringContaining("#62 “Player jumping” is open"),
      });
    });
  });

  describe("when two slots share a first name", () => {
    const SLOTS_VIEW: OfficeView = {
      ...RUNNER_VIEW,
      issueAgents: [
        coder("agent:runner/1", "Claude 1", {
          issue: work({ issueNumber: 12, title: "Busy", status: WORK_STATUS.assigned, assigneeId: "agent:runner/1" }),
        }),
        coder("agent:runner/2", "Claude 2"),
      ],
    };

    it("suggests the free slot by its full name", () => {
      expect(ask("who should I give #39 to?", SLOTS_VIEW).reply).toContain("Claude 2 is free. Say “put Claude 2 on it”");
    });

    it("describes only the slot asked about", () => {
      expect(ask("what is Claude 2 doing?", SLOTS_VIEW).reply).toBe("Claude 2 (coding agent) is idle.");
    });

    it("does not resolve the shared first name to either slot", () => {
      expect(ask("put Claude on #39", SLOTS_VIEW).assignments).toEqual([]);
    });
  });
});

describe("planFromRules: standups", () => {
  it.each([
    "call a standup",
    "Call a stand-up please",
    "can you call a standup?",
    "let's have a standup",
    "start the standup now",
    "time for standup",
    "standup",
    "AI Manager, gather everyone for a standup",
  ])("calls one for %j", (message) => {
    expect(ask(message)).toEqual({
      reply: "Calling a standup: everyone to my desk, and each of them gives an update in turn.",
      assignments: [],
      standup: "start",
      tokensUsed: 0,
    });
  });

  it.each(["end the standup", "finish standup", "wrap up the stand-up", "the standup's over", "standup is done"])(
    "ends one for %j",
    (message) => {
      expect(ask(message)).toMatchObject({ reply: "Ending the standup.", assignments: [], standup: "end" });
    },
  );

  it.each(["is there a standup on?", "what happened at the standup?", "how did the standup go?"])(
    "acts on no question: %j",
    (message) => {
      expect(ask(message).standup).toBeUndefined();
    },
  );

  it.each([
    "have Claude 1 do #39 after standup",
    "start #39 before the standup",
    "close #39 and end standup",
    "assign #39 after the standup",
    "what's the status of #39 after the standup?",
  ])("neither calls, ends nor summarises one for work that only mentions it: %j", (message) => {
    const plan = ask(message);
    expect(plan.standup).toBeUndefined();
    expect(plan.reply).not.toMatch(/standup/i);
  });

  it("says what each agent said at the last one, and whether its blocker was resolved", () => {
    expect(ask("how did the standup go?").reply).toBe(
      "There hasn't been a standup yet. Say “call a standup” and I'll gather everyone at my desk.",
    );
    const view: OfficeView = {
      ...VIEW,
      standup: {
        active: false,
        calledBy: "Dana",
        order: ["Claude 1", "Crewmate"],
        updates: [
          {
            agent: "Claude 1",
            workedOn: "#39 “Night shift”, in progress",
            blockers: "waiting on you: Permission: Bash git push",
            waitingOnYou: false,
            resolved: true,
          },
          { agent: "Crewmate", workedOn: "#33 “Live agents”", blockers: "", waitingOnYou: false, resolved: false },
        ],
      },
    };
    expect(ask("what came up at the standup?", view).reply).toBe(
      [
        "No standup is on. At the last one, called by Dana:",
        "- Claude 1: #39 “Night shift”, in progress. Blocker: waiting on you: Permission: Bash git push (since resolved).",
        "- Crewmate: #33 “Live agents”. No blockers.",
      ].join("\n"),
    );
    expect(ask("is the standup still going?", { ...view, standup: { ...view.standup, active: true } }).reply).toMatch(
      /^A standup is on, called by Dana: 2 of 2 updates so far\./,
    );
  });

  it("lists standups among what it can do", () => {
    expect(ask("help").reply).toContain("“Call a standup” or “End the standup”");
  });
});
