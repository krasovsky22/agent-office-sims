/**
 * The report an orchestrator sends, and the label a live agent wears.
 *
 * A report crosses a trust boundary the way a client message does, so the
 * parser is held to the same standard: anything it returns is safe to keep and
 * to render, including the task link the HUD turns into an anchor.
 */

import { describe, expect, it } from "vitest";

import { describeLiveAgentTask, parseLiveAgentReport, taskReference } from "./liveAgents.js";

const ISSUE = "https://github.com/krasovsky22/agent-office-sims/issues/33";
const PULL = "https://github.com/krasovsky22/agent-office-sims/pull/40";

describe("parseLiveAgentReport", () => {
  it("reads a working report with its task", () => {
    expect(
      parseLiveAgentReport({
        id: "w2-live-agents-33",
        name: "Crewmate",
        status: "working",
        task: { title: "Live coding agents on the floor", url: ISSUE },
      }),
    ).toEqual({
      id: "w2-live-agents-33",
      name: "Crewmate",
      status: "working",
      task: { title: "Live coding agents on the floor", url: ISSUE },
    });
  });

  it("accepts a working report with no task, or a task with no link", () => {
    expect(parseLiveAgentReport({ id: "a", status: "working" })?.task).toBeUndefined();
    expect(parseLiveAgentReport({ id: "a", status: "working", task: { title: "Busy" } })?.task).toEqual({
      title: "Busy",
      url: "",
    });
  });

  it("drops a task from any status but working", () => {
    expect(
      parseLiveAgentReport({ id: "a", status: "idle", task: { title: "Leftover", url: ISSUE } })?.task,
    ).toBeUndefined();
  });

  it("names an agent after its id when the report does not", () => {
    expect(parseLiveAgentReport({ id: "agent-7", status: "idle" })?.name).toBe("agent-7");
    expect(parseLiveAgentReport({ id: "agent-7", status: "idle", name: "\u0000 " })?.name).toBe("agent-7");
  });

  it("sanitises the name and title it keeps", () => {
    const report = parseLiveAgentReport({
      id: "a",
      name: "  A\nvery   long agent name indeed  ",
      status: "working",
      task: { title: `Fix\u0007 the ${"x".repeat(200)}` },
    });
    expect(report?.name).toBe("A very long agent ");
    expect(report?.task?.title.startsWith("Fix the x")).toBe(true);
    expect(report?.task?.title.length).toBeLessThanOrEqual(90);
  });

  it.each([
    ["no id", { status: "idle" }],
    ["an id with a space", { id: "a b", status: "idle" }],
    ["an id that is too long", { id: "a".repeat(49), status: "idle" }],
    ["an unknown status", { id: "a", status: "busy" }],
    ["a task that is not an object", { id: "a", status: "working", task: "Fix it" }],
    ["a task with no title", { id: "a", status: "working", task: { title: "  ", url: ISSUE } }],
    ["a javascript: link", { id: "a", status: "working", task: { title: "x", url: "javascript:alert(1)" } }],
    ["an http: link", { id: "a", status: "working", task: { title: "x", url: "http://github.com/o/r/issues/1" } }],
    ["a link that is not a URL", { id: "a", status: "working", task: { title: "x", url: "issue 33" } }],
    ["an overlong link", { id: "a", status: "working", task: { title: "x", url: `${ISSUE}?${"q".repeat(300)}` } }],
  ])("rejects a report with %s", (_label, raw) => {
    expect(parseLiveAgentReport(raw)).toBeUndefined();
  });

  it.each([null, undefined, "working", 3, []])("rejects %j", (raw) => {
    expect(parseLiveAgentReport(raw)).toBeUndefined();
  });

  it("accepts a stopped report, which is how an agent leaves", () => {
    expect(parseLiveAgentReport({ id: "a", status: "stopped" })?.status).toBe("stopped");
  });
});

describe("taskReference", () => {
  it("shortens GitHub issue and pull request links", () => {
    expect(taskReference(ISSUE)).toBe("#33");
    expect(taskReference(PULL)).toBe("PR #40");
    expect(taskReference(`${PULL}/files#diff`)).toBe("PR #40");
  });

  it("has nothing to say about any other link", () => {
    expect(taskReference("")).toBe("");
    expect(taskReference("https://example.com/issues/1")).toBe("");
    expect(taskReference("https://github.com/krasovsky22/agent-office-sims")).toBe("");
  });
});

describe("describeLiveAgentTask", () => {
  it("leads with the reference, then the title", () => {
    expect(describeLiveAgentTask("working", "Live agents", ISSUE)).toBe("#33 Live agents");
    expect(describeLiveAgentTask("working", "Live agents", "")).toBe("Live agents");
    expect(describeLiveAgentTask("working", "", PULL)).toBe("PR #40");
    expect(describeLiveAgentTask("working", "", "")).toBe("working");
  });

  it("says idle for an idle agent, whatever it was last doing", () => {
    expect(describeLiveAgentTask("idle", "Live agents", ISSUE)).toBe("idle");
  });
});
