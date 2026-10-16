/**
 * The runner link: slots as live agents, the command outbox, the timeout, and
 * the event inbox.
 *
 * The clock and the command ids are injected, so the timeout is exercised by
 * moving time and a test can name the command it expects back.
 */

import type { RunnerSync } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { isLiveAgentSource } from "./registry.js";
import { RunnerLink, isRunnerEventSource, runnerSlotAgentId } from "./runnerLink.js";

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
      { id: "slot-1", name: "Claude 1", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
      { id: "slot-2", name: "Claude 2", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
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
    expect(link.sync(sync())).toEqual({ kind: "accepted", commands: [] });
    expect(link.current()).toEqual([
      { id: "runner:runner-1:slot-1", name: "Claude 1", status: "idle", task: undefined },
      { id: "runner:runner-1:slot-2", name: "Claude 2", status: "idle", task: undefined },
    ]);
    expect(runnerSlotAgentId("runner-1", "slot-1")).toBe("runner:runner-1:slot-1");
    expect(notifications()).toBe(1);
    expect(isLiveAgentSource(link)).toBe(true);
    expect(isRunnerEventSource(link)).toBe(true);
  });

  it("tells nobody about a sync that changes nothing", () => {
    const { link, notifications } = setup();
    link.sync(sync());
    link.sync(sync());
    expect(notifications()).toBe(1);
  });

  it.each(["starting", "working", "needs-input"] as const)("shows a %s slot as working on its issue", (status) => {
    const { link } = setup();
    link.sync(
      sync({ slots: [{ id: "slot-1", name: "Claude 1", status, issueNumber: 39, activity: "Bash: pnpm test", pr: undefined }] }),
    );
    expect(link.current()[0]).toMatchObject({
      status: "working",
      task: { title: "Bash: pnpm test", url: `https://github.com/${REPO}/issues/39` },
    });
  });

  it("shows an exited slot as idle", () => {
    const { link } = setup();
    link.sync(sync({ slots: [{ id: "slot-1", name: "Claude 1", status: "exited", issueNumber: 39, activity: "", pr: undefined }] }));
    expect(link.current()[0]).toMatchObject({ status: "idle", task: undefined });
  });

  it("titles a slot's task from the start command that put it there", () => {
    const { link } = setup();
    link.sync(sync());
    link.enqueue("runner-1", START);
    link.sync(sync({ slots: [{ id: "slot-1", name: "Claude 1", status: "working", issueNumber: 39, activity: "Read", pr: undefined }] }));
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
    expect(link.sync(sync())).toEqual({ kind: "accepted", commands: [command] });
    expect(link.sync(sync())).toEqual({ kind: "accepted", commands: [command] });

    expect(link.sync(sync({ acked: ["command-1"] }))).toEqual({ kind: "accepted", commands: [] });
    expect(link.sync(sync())).toEqual({ kind: "accepted", commands: [] });
    expect(link.sync(sync({ acked: ["command-1"] }))).toEqual({ kind: "accepted", commands: [] });
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
    expect(link.sync(sync())).toEqual({ kind: "accepted", commands: [] });
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
