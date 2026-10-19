/**
 * The sync loop against a scripted client: what each sync carries, that a
 * command is carried out once however often it comes back, that acks and
 * events are dropped only once a sync carrying them is answered, and the
 * backoff while the server is away.
 */

import {
  MAX_RUNNER_ACKS,
  MAX_RUNNER_EVENTS,
  MAX_RUNNER_PROMPT_OUTCOMES,
  RUNNER_PROMPT_OUTCOME,
  type RunnerCommand,
  type RunnerWorkEvent,
  type RunnerPromptOutcome,
  type RunnerSlotReport,
  type RunnerSync,
} from "@sim/shared";
import { describe, expect, it } from "vitest";

import { IssueStateDesk } from "./issueStates.js";
import { SyncError, type SyncReply } from "./syncClient.js";
import { SyncLoop } from "./syncLoop.js";

const REPO = "krasovsky22/agent-office-sims";

const SLOTS: RunnerSlotReport[] = [
  { id: "slot-1", name: "Maya", title: "Software Developer", description: "", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
];

function event(id: string): RunnerWorkEvent {
  return { id, kind: "started", slotId: "slot-1", issueNumber: 39, pr: undefined, message: "" };
}

function stop(id: string): RunnerCommand {
  return { id, slotId: "slot-1", kind: "stop", reason: "" };
}

/** A pool that records what it is handed, and a client that answers from a script. */
function setup(replies: (SyncReply | Error)[], events: RunnerWorkEvent[] = [], outcomes: RunnerPromptOutcome[] = []) {
  const sent: RunnerSync[] = [];
  const handled: string[] = [];
  const standups: boolean[] = [];
  const logged: string[] = [];
  let pending = [...events];
  let prompts = [...outcomes];
  const loop = new SyncLoop({
    runnerId: "runner-1",
    repo: REPO,
    pool: {
      report: () => SLOTS,
      pendingEvents: () => pending,
      pendingPromptOutcomes: () => prompts,
      delivered: (ids) => {
        pending = pending.filter((candidate) => !ids.has(candidate.id));
        prompts = prompts.filter((candidate) => !ids.has(candidate.commandId));
      },
      handle: (command) => {
        handled.push(command.id);
      },
      setStandup: (on) => {
        standups.push(on);
      },
      spend: () => ({ spentUsd: 1.25, budgetUsd: 5 }),
    },
    client: async (sync) => {
      sent.push(sync);
      const reply = replies.shift() ?? { commands: [], unreadable: [] };
      if (reply instanceof Error) {
        throw reply;
      }
      return reply;
    },
    intervalMs: 1000,
    maxBackoffMs: 30_000,
    log: (line) => logged.push(line),
  });
  return { loop, sent, handled, standups, logged, pending: () => pending, prompts: () => prompts };
}

describe("SyncLoop", () => {
  it("reports the runner, its repository, its slots and the day's spend on every sync", async () => {
    const { loop, sent } = setup([]);
    expect(await loop.syncOnce()).toBe(true);
    expect(sent).toEqual([
      {
        runnerId: "runner-1",
        repo: REPO,
        acked: [],
        slots: SLOTS,
        events: [],
        spend: { spentUsd: 1.25, budgetUsd: 5 },
        prompts: [],
        changesIssues: false,
        issueStates: [],
      },
    ]);
  });

  it("carries out a command once, and acks it until a sync carrying the ack is answered", async () => {
    const command = stop("command-1");
    const { loop, sent, handled } = setup([
      { commands: [command], unreadable: [] },
      // The ack was lost with this sync, so the server sends the command again.
      new SyncError("could not reach the server"),
      { commands: [command], unreadable: [] },
      { commands: [], unreadable: [] },
    ]);
    await loop.syncOnce();
    expect(handled).toEqual(["command-1"]);

    await loop.syncOnce();
    expect(sent[1]?.acked).toEqual(["command-1"]);

    await loop.syncOnce();
    expect(sent[2]?.acked).toEqual(["command-1"]);
    expect(handled).toEqual(["command-1"]);

    await loop.syncOnce();
    expect(sent[3]?.acked).toEqual(["command-1"]);
    await loop.syncOnce();
    expect(sent[4]?.acked).toEqual([]);
  });

  it("tells the slots whether a standup is on after every answered sync, once its commands are carried out", async () => {
    const { loop, handled, standups } = setup([
      { commands: [stop("command-1")], unreadable: [], standup: true },
      { commands: [], unreadable: [] },
      new Error("down"),
    ]);
    await loop.syncOnce();
    expect(handled).toEqual(["command-1"]);
    expect(standups).toEqual([true]);
    await loop.syncOnce();
    expect(standups).toEqual([true, false]);
    await loop.syncOnce();
    expect(standups).toEqual([true, false]);
  });

  it("acks a command it cannot read, without acting on it", async () => {
    const { loop, sent, handled, logged } = setup([{ commands: [], unreadable: ["command-1"] }]);
    await loop.syncOnce();
    await loop.syncOnce();
    expect(handled).toEqual([]);
    expect(sent[1]?.acked).toEqual(["command-1"]);
    expect(logged).toContain("command command-1 could not be read; acked without acting on it");
  });

  it("keeps sending an event until a sync carrying it is answered", async () => {
    const { loop, sent, pending } = setup([new SyncError("refused with HTTP 429: too many syncs", 429)], [event("event-1")]);
    await loop.syncOnce();
    await loop.syncOnce();
    expect(sent.map((sync) => sync.events.map((item) => item.id))).toEqual([["event-1"], ["event-1"]]);
    expect(pending()).toEqual([]);
  });

  it("keeps sending what came of a prompt until a sync carrying it is answered, a few at a time", async () => {
    const outcomes = Array.from({ length: MAX_RUNNER_PROMPT_OUTCOMES + 1 }, (_, index) => ({
      commandId: `command-${index}`,
      slotId: "slot-1",
      outcome: RUNNER_PROMPT_OUTCOME.busy,
    }));
    const { loop, sent, prompts } = setup([new SyncError("refused with HTTP 429: too many syncs", 429)], [], outcomes);
    await loop.syncOnce();
    await loop.syncOnce();
    expect(sent.map((sync) => sync.prompts?.length)).toEqual([MAX_RUNNER_PROMPT_OUTCOMES, MAX_RUNNER_PROMPT_OUTCOMES]);
    expect(prompts().map((outcome) => outcome.commandId)).toEqual([`command-${MAX_RUNNER_PROMPT_OUTCOMES}`]);
    await loop.syncOnce();
    expect(prompts()).toEqual([]);
  });

  it("sends no more events or acks in one sync than the contract allows, and the rest next time", async () => {
    const events = Array.from({ length: MAX_RUNNER_EVENTS + 2 }, (_, index) => event(`event-${index}`));
    const commands = Array.from({ length: MAX_RUNNER_ACKS + 3 }, (_, index) => stop(`command-${index}`));
    const { loop, sent, pending } = setup([{ commands, unreadable: [] }], events);
    await loop.syncOnce();
    expect(sent[0]?.events).toHaveLength(MAX_RUNNER_EVENTS);
    expect(pending()).toHaveLength(2);

    await loop.syncOnce();
    expect(sent[1]?.acked).toHaveLength(MAX_RUNNER_ACKS);
    expect(sent[1]?.events).toHaveLength(2);
    await loop.syncOnce();
    expect(sent[2]?.acked).toEqual(["command-32", "command-33", "command-34"]);
  });

  it("backs off while syncs fail, says why once per reason, and recovers", async () => {
    const down = new SyncError("could not reach http://localhost:2567: fetch failed");
    const { loop, logged } = setup([
      down,
      down,
      down,
      new SyncError("refused with HTTP 401: unauthorized", 401),
      ...Array.from({ length: 10 }, () => down),
    ]);
    expect(loop.nextDelayMs()).toBe(1000);
    const delays: number[] = [];
    for (let attempt = 0; attempt < 14; attempt += 1) {
      expect(await loop.syncOnce()).toBe(false);
      delays.push(loop.nextDelayMs());
    }
    expect(delays.slice(0, 6)).toEqual([2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(delays.at(-1)).toBe(30_000);
    expect(logged).toEqual([
      "sync failed: could not reach http://localhost:2567: fetch failed; retrying with backoff",
      "sync failed: refused with HTTP 401: unauthorized; retrying with backoff",
      "sync failed: could not reach http://localhost:2567: fetch failed; retrying with backoff",
    ]);

    expect(await loop.syncOnce()).toBe(true);
    expect(loop.nextDelayMs()).toBe(1000);
    expect(logged.at(-1)).toBe("synced with the server after 14 failed syncs");
  });
});

describe("SyncLoop issue states", () => {
  const close: RunnerCommand = { id: "command-1", kind: "issue-state", issueNumber: 39, state: "closed", requestedBy: "Dana" };

  function withDesk(replies: SyncReply[], desk: IssueStateDesk | undefined) {
    const sent: RunnerSync[] = [];
    const logged: string[] = [];
    const loop = new SyncLoop({
      runnerId: "runner-1",
      repo: REPO,
      pool: {
        report: () => SLOTS,
        pendingEvents: () => [],
        pendingPromptOutcomes: () => [],
        delivered: () => undefined,
        handle: () => undefined,
        spend: () => ({ spentUsd: 0, budgetUsd: undefined }),
      },
      ...(desk === undefined ? {} : { issues: desk }),
      client: async (sync) => {
        sent.push(sync);
        return replies.shift() ?? { commands: [], unreadable: [] };
      },
      log: (line) => logged.push(line),
    });
    return { loop, sent, logged };
  }

  it("says it changes issues, hands the command to the desk, and reports what came of it until delivered", async () => {
    const calls: [number, string][] = [];
    const desk = new IssueStateDesk({
      set: async (issueNumber, state) => {
        calls.push([issueNumber, state]);
        return "done";
      },
    });
    const { loop, sent } = withDesk([{ commands: [close], unreadable: [] }], desk);

    await loop.syncOnce();
    expect(sent[0]?.changesIssues).toBe(true);
    // The desk answers on its own time; give it a turn.
    await Promise.resolve();
    expect(calls).toEqual([[39, "closed"]]);

    await loop.syncOnce();
    expect(sent[1]?.issueStates).toEqual([{ commandId: "command-1", outcome: "done" }]);
    await loop.syncOnce();
    expect(sent[2]?.issueStates).toEqual([]);
  });

  it("acks a command to change an issue without acting on it when it has no desk", async () => {
    const { loop, sent, logged } = withDesk([{ commands: [close], unreadable: [] }], undefined);
    await loop.syncOnce();
    expect(sent[0]?.changesIssues).toBe(false);
    await loop.syncOnce();
    expect(sent[1]?.acked).toEqual(["command-1"]);
    expect(logged.some((line) => line.includes("cannot"))).toBe(true);
  });
});
