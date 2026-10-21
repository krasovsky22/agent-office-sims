/**
 * The slot pool on a brainstorm ticket: research that opens no worktree and
 * holds no session, checked on GitHub for its label, reported as a write-up
 * rather than a pull request, and lines at the idea's meeting that hold nothing.
 */

import { type RunnerBrainstormSpeakCommand, type RunnerStartCommand } from "@sim/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Brainstormer, type ResearchRequest, createMockBrainstormer } from "./agents/brainstorm.js";
import { createMockAgent } from "./agents/mock.js";
import { SpendLedger } from "./budget.js";
import type { TaskGithub } from "./github.js";
import { SlotPool, type SlotWorkspaces } from "./slots.js";

const START: RunnerStartCommand = {
  id: "command-1",
  slotId: "slot-1",
  kind: "start",
  issueNumber: 191,
  title: "Idea tasks",
  url: "https://github.com/krasovsky22/agent-office-sims/issues/191",
  note: "Keep it small.",
  requestedBy: "Dana",
  brainstorm: { role: "critic", prior: "## Maya (researcher)\n\nBuild it." },
};

const SPEAK: RunnerBrainstormSpeakCommand = {
  id: "command-2",
  slotId: "slot-2",
  kind: "brainstorm-speak",
  issueNumber: 191,
  part: "line",
  text: "The meeting so far.",
  requestedBy: "Dana",
};

function setup(options: { brainstormer?: Brainstormer; github?: Partial<TaskGithub>; ledger?: SpendLedger } = {}) {
  const asked: string[] = [];
  const workspaces: SlotWorkspaces = {
    open: async (slotId, issueNumber) => {
      asked.push(`open ${slotId} #${issueNumber}`);
      return "/nowhere";
    },
    close: async (slotId, issueNumber) => {
      asked.push(`close ${slotId} #${issueNumber}`);
    },
  };
  const refusals: Array<[number, boolean | undefined]> = [];
  const github: TaskGithub = {
    refusal: async (issueNumber, brainstorm) => {
      refusals.push([issueNumber, brainstorm]);
      return undefined;
    },
    pullRequest: async () => undefined,
    pullRequestTitle: async () => "",
    discard: async () => undefined,
    ...options.github,
  };
  let nextId = 1;
  const pool = new SlotPool({
    count: 2,
    agent: createMockAgent({ outcome: "pr-opened", stepMs: 100 }),
    workspaces,
    taskTimeoutMs: 60_000,
    github,
    eventId: () => `event-${nextId++}`,
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    ...(options.brainstormer === undefined ? {} : { brainstormer: options.brainstormer }),
  });
  return { pool, asked, refusals };
}

describe("SlotPool on a brainstorm ticket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("researches read-only: no worktree, a write-up reported in place of a pull request, and the slot free after", async () => {
    const requests: ResearchRequest[] = [];
    const brainstormer: Brainstormer = {
      research: async (request) => {
        requests.push(request);
        request.spent(0.4);
        return { ok: true, text: "Verdict: doable with caveats\n\nIt misses the client.", why: "" };
      },
      speak: async () => ({ ok: false, text: "", why: "" }),
    };
    const ledger = new SpendLedger({ budgetUsd: undefined });
    const { pool, asked, refusals } = setup({ brainstormer, ledger });
    pool.handle(START);
    await vi.advanceTimersByTimeAsync(0);

    // The GitHub check is the brainstorm's: the label must be there, not kept off.
    expect(refusals).toEqual([[191, true]]);
    expect(asked).toEqual([]);
    expect(requests[0]).toMatchObject({ issueNumber: 191, title: "Idea tasks", note: "Keep it small.", role: "critic", prior: "## Maya (researcher)\n\nBuild it." });
    expect(pool.pendingEvents().map((event) => event.kind)).toEqual(["started", "brainstorm", "finished"]);
    expect(pool.pendingEvents()[1]).toMatchObject({ part: "take", slotId: "slot-1", issueNumber: 191, text: "Verdict: doable with caveats\n\nIt misses the client." });
    expect(pool.pendingEvents().some((event) => event.kind === "pr-opened")).toBe(false);
    expect(pool.report()[0]).toMatchObject({ status: "idle", issueNumber: undefined, pr: undefined });
    expect(ledger.report().spentUsd).toBeCloseTo(0.4);
  });

  it("reports a synthesis as the recommendation, and research that came back empty as a failed start", async () => {
    let text = "**Recommended features**\n1. Ideas.";
    const brainstormer: Brainstormer = {
      research: async () => ({ ok: true, text, why: "" }),
      speak: async () => ({ ok: false, text: "", why: "" }),
    };
    const { pool } = setup({ brainstormer });
    pool.handle({ ...START, brainstorm: { role: "synthesis", prior: "" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.pendingEvents()[1]).toMatchObject({ kind: "brainstorm", part: "synthesis" });

    text = "\u0007\u0007";
    pool.handle({ ...START, id: "command-9", slotId: "slot-2" });
    await vi.advanceTimersByTimeAsync(0);
    const last = pool.pendingEvents().at(-1);
    expect(last).toMatchObject({ kind: "failed", slotId: "slot-2", message: "The research stopped: it said nothing" });
  });

  it("refuses research its GitHub check turns down, and an ordinary start that check refuses on an idea", async () => {
    const { pool } = setup({
      brainstormer: createMockBrainstormer(0),
      github: { refusal: async (_number, brainstorm) => (brainstorm === true ? "#191 is not labelled brainstorm on GitHub" : "#191 is labelled brainstorm on GitHub") },
    });
    pool.handle(START);
    const { brainstorm: _research, ...ordinary } = START;
    pool.handle({ ...ordinary, id: "command-3", slotId: "slot-2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.pendingEvents()).toEqual([
      expect.objectContaining({ kind: "failed", slotId: "slot-1", message: "#191 is not labelled brainstorm on GitHub" }),
      expect.objectContaining({ kind: "failed", slotId: "slot-2", message: "#191 is labelled brainstorm on GitHub" }),
    ]);
  });

  it("stops research the server stops, saying so, and researches nothing without a brainstormer", async () => {
    const { pool } = setup({ brainstormer: createMockBrainstormer(10_000) });
    pool.handle(START);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.report()[0]).toMatchObject({ status: "working", issueNumber: 191 });
    pool.handle({ id: "command-4", slotId: "slot-1", kind: "stop", reason: "the office has no work for it", issueNumber: 191 });
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.pendingEvents().at(-1)).toMatchObject({ kind: "failed", message: "Stopped: the office has no work for it" });
    expect(pool.pendingEvents().some((event) => event.kind === "brainstorm")).toBe(false);

    const bare = setup();
    bare.pool.handle(START);
    await vi.advanceTimersByTimeAsync(0);
    expect(bare.pool.pendingEvents().at(-1)).toMatchObject({ kind: "failed", message: "This runner researches no ideas" });
  });

  it("says a meeting line that holds nothing, and why when the budget is spent", async () => {
    const { pool } = setup({ brainstormer: createMockBrainstormer(0) });
    pool.handle(SPEAK);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.pendingEvents()).toEqual([expect.objectContaining({ kind: "brainstorm", part: "line", slotId: "slot-2", issueNumber: 191 })]);
    expect(pool.report()[1]).toMatchObject({ status: "idle", issueNumber: undefined });

    const ledger = new SpendLedger({ budgetUsd: 1 });
    ledger.add(2);
    const broke = setup({ brainstormer: createMockBrainstormer(0), ledger });
    broke.pool.handle(SPEAK);
    await vi.advanceTimersByTimeAsync(0);
    expect(broke.pool.pendingEvents()[0]).toMatchObject({ kind: "brainstorm", part: "unanswered" });
    expect((broke.pool.pendingEvents()[0] as { text: string }).text).toContain("budget");
  });
});
