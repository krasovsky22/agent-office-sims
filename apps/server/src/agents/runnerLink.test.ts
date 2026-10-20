/**
 * The runner link: slots as live agents, the command outbox, the timeout, and
 * the event inbox.
 *
 * The clock and the command ids are injected, so the timeout is exercised by
 * moving time and a test can name the command it expects back.
 */

import type { RunnerSync } from "@sim/shared";
import { describe, expect, it, vi } from "vitest";

import { RunnerLink, runnerSlotAgentId } from "./runnerLink.js";
import { MemoryRunnerProfiles } from "./runnerProfiles.js";

const TIMEOUT_MS = 30_000;
const REPO = "krasovsky22/agent-office-sims";

function setup() {
  const clock = { now: 1_000_000 };
  let nextId = 1;
  const link = new RunnerLink({
    repository: REPO,
    timeoutMs: TIMEOUT_MS,
    now: () => clock.now,
    commandId: () => `command-${nextId++}`,
  });
  let notified = 0;
  link.subscribe(() => {
    notified += 1;
  });
  return { clock, link, notifications: () => notified };
}

function sync(overrides: Partial<RunnerSync> = {}): RunnerSync {
  return {
    runnerId: "runner-1",
    repo: REPO,
    acked: [],
    slots: [
      { id: "slot-1", name: "Claude 1", title: "Software Developer", description: "", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
      { id: "slot-2", name: "Claude 2", title: "Software Developer", description: "", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
    ],
    events: [],
    ...overrides,
  };
}

const START = {
  kind: "start",
  slotId: "slot-1",
  issueNumber: 39,
  title: "Night shift",
  url: `https://github.com/${REPO}/issues/39`,
  note: "put someone on #39",
  requestedBy: "Dana",
} as const;

describe("RunnerLink slots", () => {
  it("puts a runner's slots on the floor as idle live agents, under ids no reported agent can have", () => {
    const { link, notifications } = setup();
    expect(link.sync(sync())).toEqual({ kind: "accepted", commands: [], standup: false });
    expect(link.current()).toEqual([
      { id: "runner:runner-1:slot-1", name: "Claude 1", title: "Software Developer", description: "", status: "idle", task: undefined, canTakeIssues: true, profileEditable: true, activity: "" },
      { id: "runner:runner-1:slot-2", name: "Claude 2", title: "Software Developer", description: "", status: "idle", task: undefined, canTakeIssues: true, profileEditable: true, activity: "" },
    ]);
    expect(runnerSlotAgentId("runner-1", "slot-1")).toBe("runner:runner-1:slot-1");
    expect(notifications()).toBe(1);
  });

  it("tells nobody about a sync that changes nothing", () => {
    const { link, notifications } = setup();
    link.sync(sync());
    link.sync(sync());
    expect(notifications()).toBe(1);
  });

  it.each(["starting", "working"] as const)("shows a %s slot as working on its issue, with what it is doing", (status) => {
    const { link } = setup();
    link.sync(
      sync({ slots: [{ id: "slot-1", name: "Claude 1", title: "Software Developer", description: "", status, issueNumber: 39, activity: "Bash: pnpm test", pr: undefined }] }),
    );
    expect(link.current()[0]).toMatchObject({
      status: "working",
      activity: "Bash: pnpm test",
      task: { title: "Issue #39", url: `https://github.com/${REPO}/issues/39` },
    });
  });

  it("shows a needs-input slot as needing input, still on its issue, with what it waits on", () => {
    const { link } = setup();
    link.sync(
      sync({
        slots: [
          { id: "slot-1", name: "Claude 1", title: "Software Developer", description: "", status: "needs-input", issueNumber: 39, activity: "Permission: Bash", pr: undefined },
        ],
      }),
    );
    expect(link.current()[0]).toMatchObject({
      status: "needs-input",
      activity: "Permission: Bash",
      task: { title: "Issue #39", url: `https://github.com/${REPO}/issues/39` },
    });
  });

  it("tells the rooms when only a slot's profile changes, and carries it to the floor", () => {
    const { link, notifications } = setup();
    const slot = { id: "slot-1", name: "Maya", status: "idle" as const, issueNumber: undefined, activity: "", pr: undefined };
    link.sync(sync({ slots: [{ ...slot, title: "Software Developer", description: "" }] }));
    link.sync(sync({ slots: [{ ...slot, title: "Release Engineer", description: "" }] }));
    link.sync(sync({ slots: [{ ...slot, title: "Release Engineer", description: "Keeps the release branch green." }] }));
    expect(notifications()).toBe(3);
    expect(link.current()[0]).toMatchObject({
      name: "Maya",
      title: "Release Engineer",
      description: "Keeps the release branch green.",
      profileEditable: true,
    });
  });

  it("tells the rooms when only a slot's activity changes", () => {
    const { link, notifications } = setup();
    const slot = { id: "slot-1", name: "Claude 1", title: "Software Developer", description: "", status: "working" as const, issueNumber: 39, pr: undefined };
    link.sync(sync({ slots: [{ ...slot, activity: "Read" }] }));
    link.sync(sync({ slots: [{ ...slot, activity: "Bash: pnpm test" }] }));
    expect(notifications()).toBe(2);
    expect(link.current()[0]?.activity).toBe("Bash: pnpm test");
  });

  it("shows an exited slot as idle", () => {
    const { link } = setup();
    link.sync(sync({ slots: [{ id: "slot-1", name: "Claude 1", title: "Software Developer", description: "", status: "exited", issueNumber: 39, activity: "", pr: undefined }] }));
    expect(link.current()[0]).toMatchObject({ status: "idle", task: undefined });
  });

  it("titles a slot's task from the start command that put it there", () => {
    const { link } = setup();
    link.sync(sync());
    link.enqueue("runner-1", START);
    link.sync(sync({ slots: [{ id: "slot-1", name: "Claude 1", title: "Software Developer", description: "", status: "working", issueNumber: 39, activity: "Read", pr: undefined }] }));
    expect(link.current()[0]?.task?.title).toBe("Night shift");
  });

  it("refuses a runner on another repository and keeps nothing of it", () => {
    const { link } = setup();
    expect(link.sync(sync({ repo: "someone/else" }))).toEqual({ kind: "wrong-repo" });
    expect(link.current()).toEqual([]);
    expect(link.sync(sync({ repo: "Krasovsky22/Agent-Office-Sims" })).kind).toBe("accepted");
  });

  it("refuses a sync that would put more slots on the floor than it holds", () => {
    const { link } = setup();
    link.sync(sync());
    const three = ["slot-1", "slot-2", "slot-3"].map((id) => ({
      id,
      name: id,
      title: "",
      description: "",
      status: "idle" as const,
      issueNumber: undefined,
      activity: "",
      pr: undefined,
    }));
    expect(link.sync(sync({ runnerId: "runner-2", slots: three })).kind).toBe("full");
    expect(link.current()).toHaveLength(2);
    // The same runner reporting the same two again is not more slots.
    expect(link.sync(sync()).kind).toBe("accepted");
  });

  it("takes a silent runner's slots off the floor after the timeout, and not before", () => {
    const { clock, link } = setup();
    link.sync(sync());
    clock.now += TIMEOUT_MS;
    link.sweep();
    expect(link.current()).toHaveLength(2);
    clock.now += 1;
    link.sweep();
    expect(link.current()).toEqual([]);
  });

  it("keeps a runner that keeps syncing", () => {
    const { clock, link } = setup();
    for (let step = 0; step < 5; step += 1) {
      link.sync(sync());
      clock.now += TIMEOUT_MS / 2;
      link.sweep();
    }
    expect(link.current()).toHaveLength(2);
  });
});

describe("RunnerLink commands", () => {
  it("re-delivers a command on every sync until it is acked, and never after", () => {
    const { link } = setup();
    link.sync(sync());
    const command = link.enqueue("runner-1", START);
    expect(command).toMatchObject({ id: "command-1", kind: "start", slotId: "slot-1", issueNumber: 39 });

    // A reply the runner never got is no loss: the next one carries it again.
    expect(link.sync(sync())).toEqual({ kind: "accepted", commands: [command], standup: false });
    expect(link.sync(sync())).toEqual({ kind: "accepted", commands: [command], standup: false });

    expect(link.sync(sync({ acked: ["command-1"] }))).toEqual({ kind: "accepted", commands: [], standup: false });
    expect(link.sync(sync())).toEqual({ kind: "accepted", commands: [], standup: false });
    expect(link.sync(sync({ acked: ["command-1"] }))).toEqual({ kind: "accepted", commands: [], standup: false });
  });

  it("acks commands one by one, oldest first in every reply", () => {
    const { link } = setup();
    link.sync(sync());
    link.enqueue("runner-1", START);
    link.enqueue("runner-1", { kind: "prompt", slotId: "slot-1", text: "keep going", requestedBy: "Dana" });
    link.enqueue("runner-1", { kind: "stop", slotId: "slot-2", reason: "released" });
    const reply = link.sync(sync({ acked: ["command-2", "never-sent"] }));
    expect(reply.kind === "accepted" && reply.commands.map((command) => command.id)).toEqual(["command-1", "command-3"]);
  });

  it("takes back a command the runner has not acked, and only that one", () => {
    const { link } = setup();
    link.sync(sync());
    link.enqueue("runner-1", START);
    link.enqueue("runner-1", { kind: "prompt", slotId: "slot-1", text: "keep going", requestedBy: "Dana" });
    expect(link.withdraw("runner-1", "command-2")).toBe(true);
    const reply = link.sync(sync());
    expect(reply.kind === "accepted" && reply.commands.map((command) => command.id)).toEqual(["command-1"]);
    expect(link.withdraw("runner-1", "command-2")).toBe(false);
    link.sync(sync({ acked: ["command-1"] }));
    expect(link.withdraw("runner-1", "command-1")).toBe(false);
    expect(link.withdraw("runner-9", "command-1")).toBe(false);
  });

  it("refuses a command for a runner it has not heard from, or a slot it did not report", () => {
    const { link } = setup();
    expect(link.enqueue("runner-1", START)).toBeUndefined();
    link.sync(sync());
    expect(link.enqueue("runner-1", { ...START, slotId: "slot-9" })).toBeUndefined();
    expect(link.enqueue("runner-1", { ...START, url: "javascript:alert(1)" })).toBeUndefined();
    expect(link.pending("runner-1")).toEqual([]);
  });

  it("stops queueing for a runner that has stopped acking", () => {
    const clock = { now: 0 };
    const link = new RunnerLink({ repository: REPO, timeoutMs: TIMEOUT_MS, maxPendingCommands: 2, now: () => clock.now });
    link.sync(sync());
    expect(link.enqueue("runner-1", START)).toBeDefined();
    expect(link.enqueue("runner-1", START)).toBeDefined();
    expect(link.enqueue("runner-1", START)).toBeUndefined();
  });

  it("gives commands ids a restarted server will not repeat", () => {
    const link = new RunnerLink({ repository: REPO, timeoutMs: TIMEOUT_MS });
    link.sync(sync());
    const first = link.enqueue("runner-1", START);
    const second = link.enqueue("runner-1", START);
    expect(first?.id).toMatch(/^command-[0-9a-f-]{36}$/);
    expect(second?.id).not.toBe(first?.id);
  });

  it("drops a timed-out runner's commands with its slots", () => {
    const { clock, link } = setup();
    link.sync(sync());
    link.enqueue("runner-1", START);
    clock.now += TIMEOUT_MS + 1;
    link.sweep();
    expect(link.pending("runner-1")).toEqual([]);
    expect(link.sync(sync())).toEqual({ kind: "accepted", commands: [], standup: false });
  });
});

describe("RunnerLink hiring", () => {
  const NOVA = { name: "Nova", title: "Accessibility Specialist", description: "Makes the HUD readable." };

  function hiringSetup() {
    const profiles = new MemoryRunnerProfiles();
    let nextSlot = 1;
    let nextCommand = 1;
    const link = new RunnerLink({
      repository: REPO,
      timeoutMs: TIMEOUT_MS,
      commandId: () => `hire-${nextCommand++}`,
      hiredSlotId: () => `hired-${nextSlot++}`,
      profiles,
    });
    return { link, profiles };
  }

  it("asks a runner for a new slot with the profile, keeps the profile, and counts the hire before it arrives", () => {
    const { link, profiles } = hiringSetup();
    expect(link.hire(NOVA, "Dana")).toBeUndefined();
    link.sync(sync());
    expect(link.agentCount()).toBe(2);

    expect(link.hire(NOVA, "Dana")).toEqual({ runnerId: "runner-1", slotId: "hired-1", commandId: "hire-1" });
    expect(link.agentCount()).toBe(3);
    expect(link.pending("runner-1")).toEqual([{ id: "hire-1", kind: "hire", slotId: "hired-1", ...NOVA, requestedBy: "Dana" }]);
    expect(profiles.get("runner-1", "hired-1")).toEqual({ ...NOVA, requestedBy: "Dana" });
  });

  it("marks the new slot's first appearance as a new hire's, and only that one", () => {
    const { link } = hiringSetup();
    link.sync(sync());
    link.hire(NOVA, "Dana");
    const hired = { id: "hired-1", ...NOVA, status: "idle", issueNumber: undefined, activity: "", pr: undefined } as const;
    const slots = [...sync().slots, hired];
    link.sync(sync({ acked: ["hire-1"], slots }));
    expect(link.agentCount()).toBe(3);
    expect(link.current().find((record) => record.id === "runner:runner-1:hired-1")).toMatchObject({ name: "Nova", hired: true });
    link.sync(sync({ slots }));
    expect(link.current().find((record) => record.id === "runner:runner-1:hired-1")?.hired).toBeUndefined();
  });

  it("forgets a hire given up on, whether or not its runner took the command, but not a slot it reported", () => {
    const { link, profiles } = hiringSetup();
    link.sync(sync());
    const waiting = link.hire(NOVA, "Dana");
    const taken = link.hire({ ...NOVA, name: "Orla" }, "Dana");
    if (waiting === undefined || taken === undefined) {
      throw new Error("expected both hires to be queued");
    }
    link.sync(sync({ acked: [taken.commandId] }));
    link.withdrawHire(waiting);
    link.withdrawHire(taken);
    expect(link.pending("runner-1")).toEqual([]);
    expect(link.agentCount()).toBe(2);
    expect(profiles.get("runner-1", waiting.slotId)).toBeUndefined();
    expect(profiles.get("runner-1", taken.slotId)).toBeUndefined();

    const late = { id: taken.slotId, ...NOVA, status: "idle", issueNumber: undefined, activity: "", pr: undefined } as const;
    link.sync(sync({ slots: [...sync().slots, late] }));
    expect(link.current().find((record) => record.id === `runner:runner-1:${taken.slotId}`)?.hired).toBeUndefined();

    const reported = link.hire({ ...NOVA, name: "Pia" }, "Dana");
    if (reported === undefined) {
      throw new Error("expected the hire to be queued");
    }
    link.sync(sync({ acked: [reported.commandId], slots: [...sync().slots, late, { ...late, id: reported.slotId }] }));
    link.withdrawHire(reported);
    expect(profiles.get("runner-1", reported.slotId)).toMatchObject({ name: "Pia" });
  });

  it("hires nobody once the floor holds as many slots as it takes, hires on their way included", () => {
    const { link } = hiringSetup();
    link.sync(sync());
    expect(link.hire(NOVA, "Dana")).toBeDefined();
    expect(link.hire({ ...NOVA, name: "Orla" }, "Dana")).toBeDefined();
    expect(link.agentCount()).toBe(4);
    expect(link.hire({ ...NOVA, name: "Pia" }, "Dana")).toBeUndefined();
  });

  it("takes no hire for a slot the runner already reports, and no other command for one it does not", () => {
    const { link } = hiringSetup();
    link.sync(sync());
    expect(link.enqueue("runner-1", { kind: "hire", slotId: "slot-1", ...NOVA, requestedBy: "Dana" })).toBeUndefined();
    expect(link.enqueue("runner-1", { kind: "profile", slotId: "hired-9", ...NOVA, requestedBy: "Dana" })).toBeUndefined();
  });
});

describe("RunnerLink spend", () => {
  it("shows nothing until a runner says what it spent", () => {
    const { link } = setup();
    link.sync(sync());
    expect(link.spend()).toEqual({ runners: 0, spentUsd: 0, budgetUsd: undefined, budgetSpent: false });
  });

  it("adds up every runner's spend, and their budgets while every one has one", () => {
    const { link } = setup();
    link.sync(sync({ spend: { spentUsd: 1.5, budgetUsd: 5 } }));
    expect(link.spend()).toEqual({ runners: 1, spentUsd: 1.5, budgetUsd: 5, budgetSpent: false });
    link.sync(sync({ runnerId: "runner-2", slots: [], spend: { spentUsd: 0.5, budgetUsd: 2 } }));
    expect(link.spend()).toEqual({ runners: 2, spentUsd: 2, budgetUsd: 7, budgetSpent: false });
    link.sync(sync({ runnerId: "runner-2", slots: [], spend: { spentUsd: 0.75, budgetUsd: undefined } }));
    expect(link.spend()).toEqual({ runners: 2, spentUsd: 2.25, budgetUsd: undefined, budgetSpent: false });
  });

  it("notes a runner whose own budget is spent, whatever the others have left", () => {
    const { link } = setup();
    link.sync(sync({ spend: { spentUsd: 5, budgetUsd: 5 } }));
    link.sync(sync({ runnerId: "runner-2", slots: [], spend: { spentUsd: 0, budgetUsd: 10 } }));
    expect(link.spend()).toEqual({ runners: 2, spentUsd: 5, budgetUsd: 15, budgetSpent: true });
    link.sync(sync({ runnerId: "runner-2", slots: [], spend: { spentUsd: 0, budgetUsd: undefined } }));
    expect(link.spend()).toEqual({ runners: 2, spentUsd: 5, budgetUsd: undefined, budgetSpent: true });
  });

  it("drops a runner's spend with the runner once it goes silent", () => {
    const { clock, link } = setup();
    link.sync(sync({ spend: { spentUsd: 1.5, budgetUsd: 5 } }));
    clock.now += TIMEOUT_MS + 1;
    link.sweep();
    expect(link.spend().runners).toBe(0);
  });
});

describe("RunnerLink events", () => {
  const STARTED = { id: "event-1", kind: "started", slotId: "slot-1", issueNumber: 39, pr: undefined, message: "" } as const;

  it("passes each event to every open inbox once, however often it is re-sent", () => {
    const { link } = setup();
    const first = link.openEventInbox();
    const second = link.openEventInbox();
    link.sync(sync({ events: [STARTED] }));
    link.sync(sync({ events: [STARTED] }));
    expect(first.drain()).toEqual([{ runnerId: "runner-1", event: STARTED }]);
    expect(first.drain()).toEqual([]);
    expect(second.drain()).toEqual([{ runnerId: "runner-1", event: STARTED }]);
  });

  it("writes nothing to a closed inbox, and nothing for a refused sync", () => {
    const { link } = setup();
    const inbox = link.openEventInbox();
    link.sync(sync({ repo: "someone/else", events: [STARTED] }));
    expect(inbox.drain()).toEqual([]);
    inbox.close();
    link.sync(sync({ events: [STARTED] }));
    expect(inbox.drain()).toEqual([]);
  });

  it("holds a bounded number of events for a room that has not drained", () => {
    const { link } = setup();
    const inbox = link.openEventInbox();
    for (let index = 0; index < 400; index += 1) {
      link.sync(sync({ events: [{ ...STARTED, id: `event-${index}` }] }));
    }
    const drained = inbox.drain();
    expect(drained).toHaveLength(256);
    expect(drained.at(-1)?.event.id).toBe("event-399");
  });
});

describe("RunnerLink standups", () => {
  it("tells every runner a standup is on while any room holds one", () => {
    const { link } = setup();
    expect(link.sync(sync())).toMatchObject({ kind: "accepted", standup: false });
    link.holdForStandup("room-1", true);
    link.holdForStandup("room-2", true);
    expect(link.sync(sync())).toMatchObject({ kind: "accepted", standup: true });
    link.holdForStandup("room-1", false);
    expect(link.sync(sync())).toMatchObject({ kind: "accepted", standup: true });
    link.holdForStandup("room-2", false);
    link.holdForStandup("room-2", false);
    expect(link.sync(sync())).toMatchObject({ kind: "accepted", standup: false });
  });
});

describe("RunnerLink issue states", () => {
  it("can change issues only while a runner that says it can is connected", () => {
    const { clock, link } = setup();
    expect(link.canChangeIssues()).toBe(false);
    link.sync(sync());
    expect(link.canChangeIssues()).toBe(false);
    link.sync(sync({ changesIssues: true }));
    expect(link.canChangeIssues()).toBe(true);
    clock.now += TIMEOUT_MS + 1;
    link.sweep();
    expect(link.canChangeIssues()).toBe(false);
  });

  it("answers at once that nobody can make the change when no such runner is connected", async () => {
    const { link } = setup();
    link.sync(sync());
    await expect(link.changeIssueState(39, "closed", "Dana")).resolves.toBe("unavailable");
    expect(link.pending("runner-1")).toEqual([]);
  });

  it("sends the change to the runner and resolves with what it reports, once", async () => {
    const { link } = setup();
    link.sync(sync({ changesIssues: true }));
    const answer = link.changeIssueState(39, "closed", "Dana");
    expect(link.pending("runner-1")).toEqual([
      { id: "command-1", kind: "issue-state", issueNumber: 39, state: "closed", requestedBy: "Dana" },
    ]);

    link.sync(sync({ changesIssues: true, acked: ["command-1"], issueStates: [{ commandId: "command-1", outcome: "done" }] }));
    await expect(answer).resolves.toBeUndefined();
    // A repeat of the report finds nothing to settle.
    link.sync(sync({ changesIssues: true, issueStates: [{ commandId: "command-1", outcome: "refused" }] }));
  });

  it("tells a refusal from a failure", async () => {
    const { link } = setup();
    link.sync(sync({ changesIssues: true }));
    const refused = link.changeIssueState(39, "open", "Dana");
    const failed = link.changeIssueState(40, "open", "Dana");
    link.sync(
      sync({
        changesIssues: true,
        issueStates: [
          { commandId: "command-1", outcome: "refused" },
          { commandId: "command-2", outcome: "failed" },
        ],
      }),
    );
    await expect(refused).resolves.toBe("refused");
    await expect(failed).resolves.toBe("unreachable");
  });

  it("ignores an outcome from a runner the change was not sent to", async () => {
    vi.useFakeTimers();
    try {
      const { link } = setup();
      link.sync(sync({ changesIssues: true }));
      const answer = link.changeIssueState(39, "closed", "Dana");
      link.sync(sync({ runnerId: "runner-2", slots: [], changesIssues: true, issueStates: [{ commandId: "command-1", outcome: "done" }] }));
      let settled = false;
      void answer.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a runner that does not answer, taking back a command it never took", async () => {
    vi.useFakeTimers();
    try {
      const link = new RunnerLink({ repository: REPO, timeoutMs: TIMEOUT_MS, issueStateWaitMs: 5_000 });
      link.sync(sync({ changesIssues: true }));
      const answer = link.changeIssueState(39, "closed", "Dana");
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(answer).resolves.toBe("unreachable");
      expect(link.pending("runner-1")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a change when its runner goes silent", async () => {
    const { clock, link } = setup();
    link.sync(sync({ changesIssues: true }));
    const answer = link.changeIssueState(39, "closed", "Dana");
    clock.now += TIMEOUT_MS + 1;
    link.sweep();
    await expect(answer).resolves.toBe("unreachable");
  });
});
