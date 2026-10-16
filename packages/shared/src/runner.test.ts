/**
 * The runner link's wire contract.
 *
 * A sync crosses a trust boundary the way a live agent's report does, so the
 * parser is held to the same standard: anything it returns is safe to keep and
 * render, and every list in it is bounded. Commands are built through the same
 * sanitising, so what the server sends is as bounded as what it takes.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_RUNNER_ACKS,
  MAX_RUNNER_EVENTS,
  MAX_RUNNER_PROMPT_LENGTH,
  MAX_RUNNER_SLOTS,
  parseRunnerSync,
  toRunnerCommand,
} from "./runner.js";

const ISSUE = "https://github.com/krasovsky22/agent-office-sims/issues/39";
const PULL = "https://github.com/krasovsky22/agent-office-sims/pull/41";

const SYNC = {
  runnerId: "runner-1",
  repo: "krasovsky22/agent-office-sims",
  acked: ["command-1"],
  slots: [
    {
      id: "slot-1",
      name: "Claude 1",
      status: "working",
      issueNumber: 39,
      activity: "Bash: pnpm test",
      pr: { number: 41, title: "Night shift", url: PULL },
    },
    { id: "slot-2", name: "Claude 2", status: "idle" },
  ],
  events: [{ id: "event-1", kind: "pr-opened", slotId: "slot-1", issueNumber: 39, pr: { number: 41, url: PULL } }],
};

describe("parseRunnerSync", () => {
  it("reads a whole sync", () => {
    expect(parseRunnerSync(SYNC)).toEqual({
      runnerId: "runner-1",
      repo: "krasovsky22/agent-office-sims",
      acked: ["command-1"],
      slots: [
        {
          id: "slot-1",
          name: "Claude 1",
          status: "working",
          issueNumber: 39,
          activity: "Bash: pnpm test",
          pr: { number: 41, title: "Night shift", url: PULL },
        },
        { id: "slot-2", name: "Claude 2", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
      ],
      events: [
        {
          id: "event-1",
          kind: "pr-opened",
          slotId: "slot-1",
          issueNumber: 39,
          pr: { number: 41, title: "", url: PULL },
          message: "",
        },
      ],
    });
  });

  it("treats missing lists as empty, and names a slot by its id when it has no name", () => {
    expect(
      parseRunnerSync({ runnerId: "r", repo: "o/r", slots: [{ id: "slot-1", status: "needs-input" }] }),
    ).toEqual({
      runnerId: "r",
      repo: "o/r",
      acked: [],
      slots: [{ id: "slot-1", name: "slot-1", status: "needs-input", issueNumber: undefined, activity: "", pr: undefined }],
      events: [],
    });
  });

  it("sanitises every string it keeps", () => {
    const parsed = parseRunnerSync({
      ...SYNC,
      slots: [{ id: "slot-1", name: "Claude\n\u0000 1", status: "working", activity: "a\nb\u0007c".repeat(10) }],
      events: [{ id: "event-1", kind: "failed", slotId: "slot-1", issueNumber: 39, message: "line one\nline two" }],
    });
    const slot = parsed?.slots[0];
    expect(slot?.name).toBe("Claude 1");
    expect(slot?.activity).not.toContain("\n");
    expect(slot?.activity).not.toContain("\u0007");
    expect(parsed?.events[0]?.message).toBe("line one line two");
  });

  it.each([
    ["not an object", "sync"],
    ["an array", []],
    ["no runner id", { ...SYNC, runnerId: undefined }],
    ["a runner id with a colon", { ...SYNC, runnerId: "runner:1" }],
    ["a runner id that is too long", { ...SYNC, runnerId: "r".repeat(33) }],
    ["no repository", { ...SYNC, repo: undefined }],
    ["a repository that is not owner/name", { ...SYNC, repo: "agent-office-sims" }],
    ["an unknown slot status", { ...SYNC, slots: [{ id: "slot-1", status: "sleeping" }] }],
    ["a slot id with a colon", { ...SYNC, slots: [{ id: "slot:1", status: "idle" }] }],
    ["a slot reported twice", { ...SYNC, slots: [{ id: "s", status: "idle" }, { id: "s", status: "idle" }] }],
    ["a fractional issue number", { ...SYNC, slots: [{ id: "s", status: "working", issueNumber: 1.5 }] }],
    ["a javascript: pull request", { ...SYNC, slots: [{ id: "s", status: "working", pr: { number: 1, url: "javascript:alert(1)" } }] }],
    ["a pull request with no link", { ...SYNC, slots: [{ id: "s", status: "working", pr: { number: 1 } }] }],
    ["an unknown event kind", { ...SYNC, events: [{ ...SYNC.events[0], kind: "exploded" }] }],
    ["an event with no issue", { ...SYNC, events: [{ ...SYNC.events[0], issueNumber: undefined }] }],
    ["an ack that is not an id", { ...SYNC, acked: [7] }],
    ["slots that are not a list", { ...SYNC, slots: { id: "s" } }],
    ["too many slots", { ...SYNC, slots: Array.from({ length: MAX_RUNNER_SLOTS + 1 }, (_, i) => ({ id: `s${i}`, status: "idle" })) }],
    ["too many events", { ...SYNC, events: Array.from({ length: MAX_RUNNER_EVENTS + 1 }, (_, i) => ({ ...SYNC.events[0], id: `e${i}` })) }],
    ["too many acks", { ...SYNC, acked: Array.from({ length: MAX_RUNNER_ACKS + 1 }, (_, i) => `c${i}`) }],
    ["a slot name longer than a nameplate", { ...SYNC, slots: [{ id: "s", name: "n".repeat(19), status: "idle" }] }],
    ["an activity longer than a title", { ...SYNC, slots: [{ id: "s", status: "working", activity: "a".repeat(91) }] }],
    ["a pull request title longer than a title", { ...SYNC, slots: [{ id: "s", status: "working", pr: { number: 1, title: "t".repeat(91), url: PULL } }] }],
    ["an event message longer than a work note", { ...SYNC, events: [{ ...SYNC.events[0], message: "m".repeat(281) }] }],
    ["a slot name that is not a string", { ...SYNC, slots: [{ id: "s", name: ["Claude"], status: "idle" }] }],
  ])("refuses a sync with %s", (_label, raw) => {
    expect(parseRunnerSync(raw)).toBeUndefined();
  });
});

describe("toRunnerCommand", () => {
  it("builds a start command, sanitised", () => {
    expect(
      toRunnerCommand("command-1", {
        kind: "start",
        slotId: "slot-1",
        issueNumber: 39,
        title: "Night\nshift",
        url: ISSUE,
        note: "put\u0000 someone on #39",
        requestedBy: "Dana",
      }),
    ).toEqual({
      id: "command-1",
      slotId: "slot-1",
      kind: "start",
      issueNumber: 39,
      title: "Night shift",
      url: ISSUE,
      note: "put someone on #39",
      requestedBy: "Dana",
    });
  });

  it("builds stop and prompt commands, keeping a prompt's lines and capping its length", () => {
    expect(toRunnerCommand("command-2", { kind: "stop", slotId: "slot-1", reason: "released" })).toEqual({
      id: "command-2",
      slotId: "slot-1",
      kind: "stop",
      reason: "released",
    });
    const prompt = toRunnerCommand("command-3", {
      kind: "prompt",
      slotId: "slot-1",
      text: `first\nsecond${"x".repeat(MAX_RUNNER_PROMPT_LENGTH)}`,
      requestedBy: "Dana",
    });
    expect(prompt?.kind === "prompt" && prompt.text.startsWith("first\nsecond")).toBe(true);
    expect(prompt?.kind === "prompt" && prompt.text.length).toBe(MAX_RUNNER_PROMPT_LENGTH);
  });

  it.each([
    ["a bad slot id", { kind: "stop", slotId: "slot:1", reason: "" }],
    ["a javascript: link", { kind: "start", slotId: "s", issueNumber: 1, title: "t", url: "javascript:x", note: "", requestedBy: "" }],
    ["no title", { kind: "start", slotId: "s", issueNumber: 1, title: " ", url: ISSUE, note: "", requestedBy: "" }],
    ["no issue number", { kind: "start", slotId: "s", issueNumber: 0, title: "t", url: ISSUE, note: "", requestedBy: "" }],
    ["an empty prompt", { kind: "prompt", slotId: "s", text: "\n\n", requestedBy: "" }],
  ] as const)("refuses a command with %s", (_label, draft) => {
    expect(toRunnerCommand("command-1", draft)).toBeUndefined();
  });
});
