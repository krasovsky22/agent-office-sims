/**
 * The terminal panel's links are pieced together from three records, and one
 * of them is text an agent wrote, so what gets linked is pinned here.
 */

import { type ProjectBoardSnapshot, WORK_STATUS, type WorkData, liveAgentKey } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { terminalLinks } from "./agentTerminal.js";

const REPO = "krasovsky22/agent-office-sims";
const AGENT = liveAgentKey("runner-1");
const ISSUE_URL = `https://github.com/${REPO}/issues/72`;

function snapshot(pullRequests: readonly number[] = []): ProjectBoardSnapshot {
  return {
    repository: REPO,
    updatedAt: 1000,
    stale: false,
    open: [],
    inProgress: [{ number: 72, title: "Terminal panel", body: "", labels: [], assignees: [], pullRequests, closedAt: null }],
    closed: [],
    pullRequests: [],
    counts: { open: 0, inProgress: 1, pullRequests: pullRequests.length },
  };
}

function work(
  outputArtifact: string,
  assigneeId = AGENT,
  issueNumber = 72,
  status: WorkData["status"] = WORK_STATUS.in_progress,
): WorkData {
  return {
    issueNumber,
    title: "Terminal panel",
    status,
    assigneeId,
    outputArtifact,
    note: "",
    assignedAt: 0,
    updatedAt: 0,
  };
}

describe("terminalLinks", () => {
  it("links the issue the agent's task names", () => {
    expect(terminalLinks(AGENT, ISSUE_URL, [], undefined)).toEqual({
      issue: { label: "#72", href: ISSUE_URL },
      pullRequests: [],
    });
  });

  it("links the pull request the agent handed in, without the sentence around it", () => {
    const artifact = `PR #94: Terminal panel, https://github.com/${REPO}/pull/94.`;
    expect(terminalLinks(AGENT, ISSUE_URL, [work(artifact)], undefined).pullRequests).toEqual([
      { label: "PR #94", href: `https://github.com/${REPO}/pull/94` },
    ]);
  });

  it("adds the board's linked pull requests once each", () => {
    const artifact = `PR #94: https://github.com/${REPO}/pull/94`;
    expect(terminalLinks(AGENT, ISSUE_URL, [work(artifact)], snapshot([94, 95])).pullRequests).toEqual([
      { label: "PR #94", href: `https://github.com/${REPO}/pull/94` },
      { label: "PR #95", href: `https://github.com/${REPO}/pull/95` },
    ]);
  });

  it("finds the issue from the agent's work when its task has no link", () => {
    expect(terminalLinks(AGENT, "", [work("")], snapshot([95]))).toEqual({
      issue: { label: "#72", href: ISSUE_URL },
      pullRequests: [{ label: "PR #95", href: `https://github.com/${REPO}/pull/95` }],
    });
  });

  it("ignores somebody else's work", () => {
    const artifact = `https://github.com/${REPO}/pull/94`;
    expect(terminalLinks(AGENT, "", [work(artifact, liveAgentKey("runner-2"))], snapshot())).toEqual({
      issue: undefined,
      pullRequests: [],
    });
  });

  it("does not link work the agent handed in for an earlier issue", () => {
    const earlier = work(`https://github.com/${REPO}/pull/40`, AGENT, 5, WORK_STATUS.review);
    expect(terminalLinks(AGENT, `https://github.com/${REPO}/issues/7`, [earlier], undefined)).toEqual({
      issue: { label: "#7", href: `https://github.com/${REPO}/issues/7` },
      pullRequests: [],
    });
    expect(terminalLinks(AGENT, "", [earlier, work("", AGENT, 72, WORK_STATUS.done)], snapshot())).toEqual({
      issue: undefined,
      pullRequests: [],
    });
  });

  it("finds the issue from the agent's open work, not its handed-in work", () => {
    const earlier = work(`https://github.com/${REPO}/pull/40`, AGENT, 5, WORK_STATUS.review);
    expect(terminalLinks(AGENT, "", [earlier, work("")], snapshot([95]))).toEqual({
      issue: { label: "#72", href: ISSUE_URL },
      pullRequests: [{ label: "PR #95", href: `https://github.com/${REPO}/pull/95` }],
    });
  });

  it("links nothing from a deliverable but GitHub pull requests over https", () => {
    const artifact = [
      "http://github.com/o/n/pull/1",
      "https://example.com/o/n/pull/2",
      `https://github.com/${REPO}/issues/3`,
      "javascript:alert(1)",
    ].join(" ");
    expect(terminalLinks(AGENT, ISSUE_URL, [work(artifact)], undefined).pullRequests).toEqual([]);
  });

  it("does not read the board's numbers onto an issue in another repository", () => {
    const elsewhere = "https://github.com/someone/else/issues/72";
    expect(terminalLinks(AGENT, elsewhere, [], snapshot([95]))).toEqual({
      issue: { label: "#72", href: elsewhere },
      pullRequests: [],
    });
  });

  it("links a task that is a pull request as one", () => {
    const pull = `https://github.com/${REPO}/pull/40`;
    expect(terminalLinks(AGENT, pull, [], snapshot())).toEqual({
      issue: undefined,
      pullRequests: [{ label: "PR #40", href: pull }],
    });
  });
});
