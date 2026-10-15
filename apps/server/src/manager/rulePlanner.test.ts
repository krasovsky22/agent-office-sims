/**
 * The manager without a model: what it understands, and that every answer is
 * built from the office it is shown and nothing else.
 */

import { AGENT_ACTIVITY, CHECK_STATUS, TICKET_PRIORITY, TICKET_STATUS } from "@sim/shared";
import { describe, expect, it } from "vitest";

import type { ManagerRequest } from "./advisor.js";
import type { OfficeView, TicketView } from "./officeView.js";
import { HELP_TEXT, planFromRules } from "./rulePlanner.js";

function ticket(overrides: Partial<TicketView> & Pick<TicketView, "id" | "title">): TicketView {
  return {
    status: TICKET_STATUS.backlog,
    priority: TICKET_PRIORITY.normal,
    assigneeId: "",
    assignee: undefined,
    hasDeliverable: false,
    latestNote: undefined,
    ...overrides,
  };
}

const VIEW: OfficeView = {
  ceo: "Dana",
  agents: [
    { id: "agent-1", name: "Ada Byrne", jobTitle: "Product Manager", activity: AGENT_ACTIVITY.working, ticketId: "ticket-2" },
    { id: "agent-2", name: "Bo Mendes", jobTitle: "Engineer", activity: AGENT_ACTIVITY.idle, ticketId: undefined },
    { id: "agent-3", name: "Cleo Hart", jobTitle: "Designer", activity: AGENT_ACTIVITY.blocked, ticketId: "ticket-3" },
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
  tickets: [
    ticket({ id: "ticket-1", title: "Fix the login redirect loop" }),
    ticket({ id: "ticket-5", title: "Draft the Q3 roadmap" }),
    ticket({ id: "ticket-2", title: "Write the onboarding email", status: TICKET_STATUS.in_progress, assigneeId: "agent-1", assignee: "Ada Byrne" }),
    ticket({
      id: "ticket-3",
      title: "Cut the dashboard load time",
      status: TICKET_STATUS.in_progress,
      assigneeId: "agent-3",
      assignee: "Cleo Hart",
      latestNote: "Cleo Hart: Blocked: no answer within 120s.",
    }),
    ticket({ id: "ticket-4", title: "Audit the third-party licences", status: TICKET_STATUS.review, assigneeId: "agent-1", assignee: "Ada Byrne", hasDeliverable: true }),
  ],
  project: {
    repository: "o/r",
    stale: false,
    issues: [
      { number: 33, title: "Live agents", url: "https://github.com/o/r/issues/33", column: "in progress", labels: ["wave-2"], assignees: [], pullRequests: [46] },
      { number: 39, title: "Night shift", url: "https://github.com/o/r/issues/39", column: "open", labels: ["client"], assignees: [], pullRequests: [] },
      { number: 12, title: "Old thing", url: "https://github.com/o/r/issues/12", column: "closed", labels: [], assignees: [], pullRequests: [] },
    ],
    pullRequests: [
      { number: 46, title: "Show live agents", url: "https://github.com/o/r/pull/46", author: "crew", draft: false, checks: CHECK_STATUS.failing },
    ],
  },
  orchestrator: true,
};

function ask(message: string, view: OfficeView = VIEW) {
  const request: ManagerRequest = { message, ceoName: "Dana", view, history: [] };
  return planFromRules(request);
}

describe("planFromRules: status", () => {
  it("answers for a ticket by id, from its column and assignee", () => {
    expect(ask("what's the status of ticket-2?")).toEqual({
      reply: "ticket-2 “Write the onboarding email” is in progress with Ada Byrne.",
      assignments: [],
      tokensUsed: 0,
    });
    expect(ask("status of ticket 4").reply).toBe(
      "ticket-4 “Audit the third-party licences” is waiting for your review: Ada Byrne handed in a deliverable.",
    );
  });

  it("says why a stuck ticket is stuck", () => {
    expect(ask("how is ticket-3 going?").reply).toBe(
      "ticket-3 “Cut the dashboard load time” is in progress, but Cleo Hart is stuck on it — Cleo Hart: Blocked: no answer within 120s.",
    );
  });

  it("finds a ticket by its title", () => {
    expect(ask("where are we on the onboarding email?").reply).toContain("ticket-2");
  });

  it("answers for a GitHub issue, with its labels, its pull requests and who is on it", () => {
    expect(ask("what's the status of #33?").reply).toBe(
      "#33 “Live agents” is in progress [wave-2]. PR #46 closes it. Crewmate is working on it.",
    );
    expect(ask("and PR 46?").reply).toBe("PR #46 “Show live agents” by crew is open. Checks are failing.");
  });

  it("says when it cannot find what was named, rather than answering about something else", () => {
    expect(ask("status of #999?").reply).toBe("I can't find #999 on the ticket board or the project board.");
    expect(ask("what about ticket-42").reply).toBe("I can't find ticket-42 on the ticket board or the project board.");
  });

  it("describes a named agent", () => {
    expect(ask("what is Bo doing?").reply).toBe("Bo Mendes (Engineer) is idle.");
    expect(ask("and deckhand?").reply).toBe("Deckhand (live coding agent) is idle.");
  });

  it("summarises what everyone is working on, and who is free", () => {
    const reply = ask("What is everyone working on?").reply;
    expect(reply).toContain("- Ada Byrne (Product Manager) is working on ticket-2 “Write the onboarding email”.");
    expect(reply).toContain("- Cleo Hart (Designer) is stuck on ticket-3");
    expect(reply).toContain("- Crewmate (live coding agent) is working on #33 “Live agents”.");
    expect(reply).toContain("Free for something new: Bo Mendes, Deckhand.");
  });

  it("summarises the ticket board", () => {
    const reply = ask("how's the board?").reply;
    expect(reply).toContain("The ticket board: 2 in the backlog, 0 assigned, 2 in progress, 1 waiting for your review, 0 done.");
    expect(reply).toContain("Waiting for your review: ticket-4 (Ada Byrne).");
    expect(reply).toContain("Unassigned: ticket-1 “Fix the login redirect loop”, ticket-5 “Draft the Q3 roadmap”.");
  });

  it("summarises the project board, or says it has not loaded", () => {
    expect(ask("any open PRs?").reply).toContain("o/r: 1 open issues, 1 in progress, 1 open pull requests.");
    expect(ask("any open PRs?", { ...VIEW, project: undefined }).reply).toContain("hasn't loaded from GitHub yet");
  });

  it("says what it can do when it does not understand", () => {
    expect(ask("bananas").reply).toBe(`I didn't catch what you want me to look at. ${HELP_TEXT}`);
    expect(ask("hello").reply).toBe(`Hello, Dana. ${HELP_TEXT}`);
  });
});

describe("planFromRules: assignments", () => {
  it("puts a named agent on a ticket", () => {
    expect(ask("Put Bo on ticket-1")).toMatchObject({ assignments: [{ work: "ticket-1", agent: "agent-2" }] });
  });

  it("leaves the choice open for someone, to be made against the live office", () => {
    expect(ask("put someone on #39").assignments).toEqual([{ work: "issue #39", agent: "" }]);
    expect(ask("assign the login redirect to anyone").assignments).toEqual([{ work: "ticket-1", agent: "" }]);
  });

  it("pairs names with work in order when there are as many of each", () => {
    expect(ask("give ticket-1 to Bo and ticket-5 to Ada").assignments).toEqual([
      { work: "ticket-1", agent: "agent-2" },
      { work: "ticket-5", agent: "agent-1" },
    ]);
  });

  it("hands out the whole backlog", () => {
    expect(ask("hand out the backlog").assignments).toEqual([
      { work: "ticket-1", agent: "" },
      { work: "ticket-5", agent: "" },
    ]);
    const empty = { ...VIEW, tickets: VIEW.tickets.filter((candidate) => candidate.status !== TICKET_STATUS.backlog) };
    expect(ask("hand out the backlog", empty)).toMatchObject({ reply: "The backlog is empty, so there is nothing to hand out.", assignments: [] });
  });

  it("advises rather than assigns when asked who should do it", () => {
    const plan = ask("who should I give #39 to?");
    expect(plan.assignments).toEqual([]);
    expect(plan.reply).toContain("Deckhand is free.");
  });

  it("assigns nothing when the work named does not exist", () => {
    expect(ask("put Bo on #999")).toMatchObject({ assignments: [], reply: expect.stringContaining("can't find #999") });
  });
});
