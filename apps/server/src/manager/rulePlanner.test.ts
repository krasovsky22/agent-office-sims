/**
 * The manager without a model: what it understands, and that every answer is
 * built from the office and the project board it is shown and nothing else.
 */

import { AGENT_ACTIVITY, CHECK_STATUS, WORK_STATUS } from "@sim/shared";
import { describe, expect, it } from "vitest";

import type { ManagerRequest } from "./advisor.js";
import type { IssueColumn, IssueView, OfficeView, WorkView } from "./officeView.js";
import { HELP_TEXT, REPHRASE_TEXT, planFromRules } from "./rulePlanner.js";

function work(overrides: Partial<WorkView> & Pick<WorkView, "issueNumber" | "title" | "status">): WorkView {
  return { assigneeId: "agent-1", assignee: "Ada Byrne", hasDeliverable: false, note: undefined, ...overrides };
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
  agents: [
    { id: "agent-1", name: "Ada Byrne", jobTitle: "Product Manager", activity: AGENT_ACTIVITY.working, issueNumber: 11 },
    { id: "agent-2", name: "Bo Mendes", jobTitle: "Engineer", activity: AGENT_ACTIVITY.idle, issueNumber: undefined },
    { id: "agent-3", name: "Cleo Hart", jobTitle: "Designer", activity: AGENT_ACTIVITY.blocked, issueNumber: 12 },
  ],
  liveAgents: [
    {
      id: "crew-1",
      name: "Crewmate",
      status: "working",
      task: { title: "Live agents", url: "https://github.com/o/r/issues/33", reference: "#33" },
      assigned: undefined,
    },
    { id: "crew-2", name: "Deckhand", status: "idle", task: undefined, assigned: undefined },
  ],
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

  it("says why a stuck agent is stuck", () => {
    expect(ask("how is #12 going?").reply).toBe(
      "#12 “Cut the dashboard load time” is open. Cleo Hart is stuck on it — Blocked: no answer within 120s.",
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
    expect(ask("what is Bo doing?").reply).toBe("Bo Mendes (Engineer) is idle.");
    expect(ask("and deckhand?").reply).toBe("Deckhand (live coding agent) is idle.");
  });

  it("summarises what everyone is working on, and who is free", () => {
    const reply = ask("What is everyone working on?").reply;
    expect(reply).toContain("- Ada Byrne (Product Manager) is working on #11 “Write the onboarding email”.");
    expect(reply).toContain("- Cleo Hart (Designer) is stuck on #12 “Cut the dashboard load time” — Blocked: no answer within 120s.");
    expect(reply).toContain("- Crewmate (live coding agent) is working on #33 “Live agents”.");
    expect(reply).toContain("Free for something new: Bo Mendes, Deckhand.");
  });

  it("says what is open on the project board, with labels and who is on each issue", () => {
    for (const question of ["what's open?", "how's the board?", "any github tickets?"]) {
      const reply = ask(question).reply;
      expect(reply).toContain("o/r: 7 open issues (2 in progress on GitHub), 3 with an agent on them, 2 open pull requests.");
      expect(reply).toContain(
        "Open: #14 “Audit the third-party licences” — Ada Byrne, waiting for your review, #33 “Live agents” [wave-2], #10 “Fix the login redirect loop” [bug], #11 “Write the onboarding email” — Ada Byrne, in progress",
      );
      expect(reply).toContain("Waiting for your review: #14 (Ada Byrne).");
      expect(reply).toContain("- Cleo Hart (Designer) is stuck on #12");
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
    ["What does Ada have on #11?", []],
    ["Did anyone get to #39?", []],
    ["send me an update on #39", []],
    ["hand me the notes on #12", []],
    ["have you put someone on #39?", []],
    ["Put Bo on #10", [{ work: "issue #10", agent: "agent-2" }]],
    ["Put Bo on issue 10", [{ work: "issue #10", agent: "agent-2" }]],
    ["put someone on #39", [{ work: "issue #39", agent: "" }]],
    ["put someone who's free on #39", [{ work: "issue #39", agent: "" }]],
    ["assign #39 to someone who is idle", [{ work: "issue #39", agent: "" }]],
    ["can you put Bo on #10?", [{ work: "issue #10", agent: "agent-2" }]],
    ["Firstmate, put Ada Byrne on #15", [{ work: "issue #15", agent: "agent-1" }]],
    ["have someone take #39", [{ work: "issue #39", agent: "" }]],
    ["give Bo's #10 to Ada", [{ work: "issue #10", agent: "agent-1" }]],
    ["reassign #11 to Bo", [{ work: "issue #11", agent: "agent-2" }]],
    ["give #10 and #15 to Bo", [{ work: "issue #10", agent: "agent-2" }, { work: "issue #15", agent: "agent-2" }]],
    ["put Bo on Draft the Q3 roadmap", [{ work: "issue #15", agent: "agent-2" }]],
    ["give PR #46 to Deckhand", [{ work: "PR #46", agent: "crew-2" }]],
    ["give #10 to Bo, please", [{ work: "issue #10", agent: "agent-2" }]],
    [
      "give #10 to Bo, and #15 to Ada",
      [
        { work: "issue #10", agent: "agent-2" },
        { work: "issue #15", agent: "agent-1" },
      ],
    ],
    [
      "assign the backlog to Bo",
      [
        { work: "#10", agent: "agent-2" },
        { work: "#15", agent: "agent-2" },
        { work: "#39", agent: "agent-2" },
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
    "send the #10 notes to Ada",
    "put Ada on #11 instead of #15",
    "hand out the backlog except #10",
    "reassign #10 from Bo to Ada",
    "assign the login redirect to anyone",
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
    expect(plan.reply).toContain("Bo Mendes is free.");
    expect(ask("who should take PR #46?").reply).toContain("Deckhand is free.");
  });

  it("answers a question that uses an assignment word, and assigns nothing", () => {
    expect(ask("give me the status of #12")).toMatchObject({
      assignments: [],
      reply: expect.stringContaining("Cleo Hart is stuck on it"),
    });
    expect(ask("does anyone have #39?")).toMatchObject({ assignments: [], reply: expect.stringContaining("#39 “Night shift” is open") });
  });

  it("assigns nothing when the work named does not exist", () => {
    expect(ask("put Bo on #999")).toMatchObject({ assignments: [], reply: expect.stringContaining("can't find #999") });
  });
});
