/**
 * What counts as news to the manager between two looks at the office: a
 * coding agent's work started, handed in or failed, the live agents, and the
 * orchestrator.
 */

import { WORK_STATUS, type WorkStatus } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { LIVE_ASSIGNMENT_STATUS, type LiveAssignment, type LiveAssignmentStatus } from "./liveAssignments.js";
import type { LiveAgentView, OfficeView, WorkView } from "./officeView.js";
import { describeChanges, observe } from "./updates.js";

const ISSUE_33 = { title: "Live agents", url: "https://github.com/o/r/issues/33", reference: "#33" };

function view(liveAgents: readonly LiveAgentView[], work: readonly WorkView[] = []): OfficeView {
  return { ceo: "Dana", liveAgents, issueAgents: [], work, project: undefined, orchestrator: true, standing: [] };
}

function work(status: WorkStatus, extra: Partial<WorkView> = {}): WorkView {
  return {
    issueNumber: 39,
    title: "Night shift",
    status,
    assigneeId: "crew-1",
    assignee: "Crewmate",
    hasDeliverable: status === WORK_STATUS.review,
    pullRequest: undefined,
    simulatedPullRequest: false,
    note: undefined,
    ...extra,
  };
}

const PR_48 = { title: "Night shift", url: "https://github.com/o/r/pull/48", reference: "PR #48" };

function crewmate(
  status: LiveAgentView["status"],
  task = status === "idle" ? undefined : ISSUE_33,
  activity = "",
): LiveAgentView {
  return { id: "crew-1", name: "Crewmate", status, task, activity, assigned: undefined };
}

function assignment(status: LiveAssignmentStatus): LiveAssignment {
  return {
    id: "assignment-1",
    agentId: "crew-1",
    item: { kind: "issue", number: 39, title: "Night shift", url: "https://github.com/o/r/issues/39" },
    requestedBy: "Dana",
    note: "",
    origin: "room-a",
    assignedAt: 0,
    status,
  };
}

describe("describeChanges", () => {
  it("says when work is handed in for review", () => {
    const started = observe(view([], [work(WORK_STATUS.in_progress)]), []);
    const handedIn = observe(view([], [work(WORK_STATUS.review)]), []);
    expect(describeChanges(started, handedIn)).toEqual(["Crewmate handed in #39 “Night shift” for your review."]);
    expect(describeChanges(handedIn, handedIn)).toEqual([]);
  });

  it("says when a coding agent starts on its issue, and links the pull request it hands in", () => {
    const assigned = observe(view([], [work(WORK_STATUS.assigned)]), []);
    const started = observe(view([], [work(WORK_STATUS.in_progress)]), []);
    const opened = observe(view([], [work(WORK_STATUS.review, { pullRequest: PR_48 })]), []);
    expect(describeChanges(assigned, started)).toEqual(["Crewmate started on #39 “Night shift”."]);
    expect(describeChanges(started, opened)).toEqual([
      "Crewmate opened PR #48 for #39 “Night shift” and handed it in for your review: https://github.com/o/r/pull/48",
    ]);
    // Both between two looks: the pull request is the news.
    expect(describeChanges(assigned, opened)).toEqual([
      "Crewmate opened PR #48 for #39 “Night shift” and handed it in for your review: https://github.com/o/r/pull/48",
    ]);
    // Handed out and started between two looks is still a start.
    expect(describeChanges(observe(view([]), []), started)).toEqual(["Crewmate started on #39 “Night shift”."]);
  });

  it("says a simulated pull request is one, with no number and no link", () => {
    const started = observe(view([], [work(WORK_STATUS.in_progress)]), []);
    const simulated = observe(view([], [work(WORK_STATUS.review, { simulatedPullRequest: true })]), []);
    const [line] = describeChanges(started, simulated);
    expect(line).toBe(
      "Crewmate handed in #39 “Night shift” for your review as a simulated pull request: the mock agent opened nothing on GitHub.",
    );
    expect(line).not.toMatch(/https:|PR #/);
  });

  it("passes on, once, why a coding agent could not work its issue, a budget refusal included", () => {
    const started = observe(view([], [work(WORK_STATUS.in_progress)]), []);
    const failed = observe(view([], [work(WORK_STATUS.in_progress, { note: "Timed out after 30 minutes" })]), []);
    expect(describeChanges(started, failed)).toEqual(["Crewmate couldn't work on #39 “Night shift”: Timed out after 30 minutes"]);
    expect(describeChanges(failed, failed)).toEqual([]);

    const assigned = observe(view([], [work(WORK_STATUS.assigned)]), []);
    for (const reason of [
      "#39 is not labelled agent-ready on GitHub, so no agent may work it",
      "The runner's daily budget of $5.00 is spent",
    ]) {
      const refused = observe(view([], [work(WORK_STATUS.assigned, { note: reason })]), []);
      expect(describeChanges(assigned, refused)).toEqual([`Crewmate couldn't work on #39 “Night shift”: ${reason}`]);
    }
  });

  it("does not repeat a failure for another agent's old note, but does for its own new one", () => {
    const failed = observe(view([], [work(WORK_STATUS.assigned, { note: "Mock 1 is busy with #12" })]), []);
    const handedOn = observe(
      view([], [work(WORK_STATUS.assigned, { assigneeId: "crew-2", assignee: "Deckhand", note: "Mock 1 is busy with #12" })]),
      [],
    );
    expect(describeChanges(failed, handedOn)).toEqual(["Deckhand couldn't work on #39 “Night shift”: Mock 1 is busy with #12"]);
    expect(describeChanges(handedOn, handedOn)).toEqual([]);
  });

  it("says when a live agent comes in, starts, stops, and leaves", () => {
    const nobody = observe(view([]), []);
    const idle = observe(view([crewmate("idle")]), []);
    const working = observe(view([crewmate("working")]), []);
    expect(describeChanges(nobody, idle)).toEqual(["Crewmate came in."]);
    expect(describeChanges(idle, working)).toEqual(["Crewmate started on #33 “Live agents”."]);
    expect(describeChanges(working, idle)).toEqual(["Crewmate stopped working on #33 “Live agents” and is free."]);
    expect(describeChanges(idle, nobody)).toEqual(["Crewmate left the office."]);
    expect(describeChanges(working, observe(view([crewmate("working")]), []))).toEqual([]);
  });

  it("says once per episode when a live agent needs someone, and with what", () => {
    const working = observe(view([crewmate("working", ISSUE_33, "Bash: pnpm test")]), []);
    const waiting = observe(view([crewmate("needs-input", ISSUE_33, "Permission: Bash pnpm test")]), []);
    const stillWaiting = observe(view([crewmate("needs-input", ISSUE_33, "Permission: Edit src/index.ts")]), []);
    const line = "Crewmate needs you on #33: Permission: Bash pnpm test";
    expect(describeChanges(working, waiting)).toEqual([line]);
    expect(describeChanges(waiting, stillWaiting)).toEqual([]);
    // Resuming is not news; it is still on the same task. Waiting again is a new episode.
    expect(describeChanges(waiting, working)).toEqual([]);
    expect(describeChanges(working, waiting)).toEqual([line]);
  });

  it("says who needs someone even without a task or a reason", () => {
    const idle = observe(view([crewmate("idle")]), []);
    const untracked = { ...crewmate("needs-input"), task: undefined };
    expect(describeChanges(idle, observe(view([untracked]), []))).toEqual([
      "Crewmate started on its task.",
      "Crewmate needs you.",
    ]);
    const unlinked = { title: "Night shift", url: "", reference: "" };
    expect(describeChanges(idle, observe(view([crewmate("needs-input", unlinked, "Sign in")]), []))).toEqual([
      "Crewmate started on “Night shift”.",
      "Crewmate needs you on “Night shift”: Sign in",
    ]);
  });

  it("says a live agent that comes in already waiting needs someone", () => {
    expect(describeChanges(observe(view([]), []), observe(view([crewmate("needs-input", ISSUE_33, "Sign in")]), []))).toEqual([
      "Crewmate came in, working on #33 “Live agents”.",
      "Crewmate needs you on #33: Sign in",
    ]);
  });

  it("says when the orchestrator picks an assignment up, even one made since the last look", () => {
    const agents = view([crewmate("idle")]);
    const pending = observe(agents, [assignment(LIVE_ASSIGNMENT_STATUS.pending)]);
    const collected = observe(agents, [assignment(LIVE_ASSIGNMENT_STATUS.collected)]);
    const line = "The orchestrator picked up #39 “Night shift” for Crewmate.";
    expect(describeChanges(pending, collected)).toEqual([line]);
    expect(describeChanges(observe(agents, []), collected)).toEqual([line]);
    expect(describeChanges(collected, collected)).toEqual([]);
  });

  it("says when an agent did not pick up what it was handed", () => {
    const agents = view([crewmate("idle")]);
    const collected = observe(agents, [assignment(LIVE_ASSIGNMENT_STATUS.collected)]);
    const dropped = observe(agents, [assignment(LIVE_ASSIGNMENT_STATUS.dropped)]);
    expect(describeChanges(collected, dropped)).toEqual(["Crewmate did not pick up #39 “Night shift”."]);
    expect(describeChanges(dropped, dropped)).toEqual([]);
  });
});
