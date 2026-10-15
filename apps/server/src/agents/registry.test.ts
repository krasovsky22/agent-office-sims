/**
 * The live agent feed: what a report does to the set, what the timeout does to
 * it, and when rooms are told.
 *
 * The clock is injected, so the timeout is exercised by moving time rather
 * than by waiting for it.
 */

import { LIVE_AGENT_REPORT_STATUS, type LiveAgentReport } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { LiveAgentRegistry, isLiveAgentSource } from "./registry.js";

const TIMEOUT_MS = 30_000;

function setup(maxAgents = 4) {
  const clock = { now: 1_000_000 };
  const registry = new LiveAgentRegistry({
    timeoutMs: TIMEOUT_MS,
    maxAgents,
    now: () => clock.now,
  });
  let notified = 0;
  registry.subscribe(() => {
    notified += 1;
  });
  return { clock, registry, notifications: () => notified };
}

function report(
  id: string,
  status: LiveAgentReport["status"],
  task?: LiveAgentReport["task"],
): LiveAgentReport {
  return { id, name: id, status, task };
}

describe("LiveAgentRegistry", () => {
  it("adds an agent on its first report and tells its subscribers", () => {
    const { registry, notifications } = setup();
    expect(registry.report(report("a", LIVE_AGENT_REPORT_STATUS.idle))).toBe("accepted");
    expect(registry.current()).toEqual([{ id: "a", name: "a", status: "idle", task: undefined }]);
    expect(notifications()).toBe(1);
  });

  it("records a change of status and task", () => {
    const { registry, notifications } = setup();
    registry.report(report("a", LIVE_AGENT_REPORT_STATUS.idle));
    const task = { title: "Live agents", url: "https://github.com/o/r/issues/33" };
    registry.report(report("a", LIVE_AGENT_REPORT_STATUS.working, task));
    expect(registry.current()[0]).toMatchObject({ status: "working", task });
    expect(notifications()).toBe(2);
  });

  it("does not tell anyone about a heartbeat that changes nothing", () => {
    const { registry, notifications } = setup();
    const task = { title: "Live agents", url: "" };
    registry.report(report("a", LIVE_AGENT_REPORT_STATUS.working, task));
    const before = registry.current();
    for (let i = 0; i < 100; i += 1) {
      registry.report(report("a", LIVE_AGENT_REPORT_STATUS.working, { ...task }));
    }
    expect(notifications()).toBe(1);
    // The same array, so a room that reads it twice does no extra work.
    expect(registry.current()).toBe(before);
  });

  it("tells report subscribers of every report it takes, changed or not, and not of a refused one", () => {
    const { registry } = setup(1);
    const heard: string[] = [];
    registry.subscribeReports((id) => heard.push(id));
    registry.report(report("a", LIVE_AGENT_REPORT_STATUS.idle));
    registry.report(report("a", LIVE_AGENT_REPORT_STATUS.idle));
    expect(registry.report(report("b", LIVE_AGENT_REPORT_STATUS.idle))).toBe("full");
    registry.report(report("a", LIVE_AGENT_REPORT_STATUS.stopped));
    expect(heard).toEqual(["a", "a", "a"]);
  });

  it("removes an agent that reports it has stopped", () => {
    const { registry, notifications } = setup();
    registry.report(report("a", LIVE_AGENT_REPORT_STATUS.idle));
    expect(registry.report(report("a", LIVE_AGENT_REPORT_STATUS.stopped))).toBe("stopped");
    expect(registry.current()).toEqual([]);
    expect(notifications()).toBe(2);
    // Stopping one that is not there is harmless and quiet.
    registry.report(report("ghost", LIVE_AGENT_REPORT_STATUS.stopped));
    expect(notifications()).toBe(2);
  });

  it("drops an agent that has been silent for longer than the timeout, and only that one", () => {
    const { clock, registry } = setup();
    registry.report(report("quiet", LIVE_AGENT_REPORT_STATUS.working));
    registry.report(report("chatty", LIVE_AGENT_REPORT_STATUS.idle));

    clock.now += TIMEOUT_MS - 1000;
    registry.report(report("chatty", LIVE_AGENT_REPORT_STATUS.idle));
    registry.sweep();
    expect(registry.current().map((agent) => agent.id)).toEqual(["quiet", "chatty"]);

    clock.now += 2000;
    registry.sweep();
    expect(registry.current().map((agent) => agent.id)).toEqual(["chatty"]);
  });

  it("refuses a new agent once the office is full, but still hears from those inside", () => {
    const { registry } = setup(2);
    registry.report(report("a", LIVE_AGENT_REPORT_STATUS.idle));
    registry.report(report("b", LIVE_AGENT_REPORT_STATUS.idle));
    expect(registry.report(report("c", LIVE_AGENT_REPORT_STATUS.idle))).toBe("full");
    expect(registry.report(report("a", LIVE_AGENT_REPORT_STATUS.working))).toBe("accepted");
    expect(registry.current().map((agent) => agent.id)).toEqual(["a", "b"]);
  });

  it("keeps notifying the other subscribers when one throws", () => {
    const { registry } = setup();
    let heard = false;
    registry.subscribe(() => {
      throw new Error("a room that failed");
    });
    registry.subscribe(() => {
      heard = true;
    });
    registry.report(report("a", LIVE_AGENT_REPORT_STATUS.idle));
    expect(heard).toBe(true);
  });

  it("is something a room accepts as a source, and a client's join options are not", () => {
    const { registry } = setup();
    expect(isLiveAgentSource(registry)).toBe(true);
    expect(isLiveAgentSource({ current: [], subscribe: "no" })).toBe(false);
    expect(isLiveAgentSource(undefined)).toBe(false);
  });
});
