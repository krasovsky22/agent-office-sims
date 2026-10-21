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
  MAX_RUNNER_ISSUE_STATE_OUTCOMES,
  MAX_RUNNER_PROMPT_LENGTH,
  MAX_RUNNER_PROMPT_OUTCOMES,
  MAX_RUNNER_SLOTS,
  type RunnerWorkEvent,
  SIMULATED_PULL_REQUEST,
  isRunnerSlotCommand,
  isRunnerWorkEvent,
  isSimulatedPullRequestArtifact,
  parseRunnerSync,
  readAgentRestrictLabel,
  retiredAgentIssueLabelNotice,
  simulatedPullRequestArtifact,
  toRunnerCommand,
} from "./runner.js";
import { MAX_AGENT_DESCRIPTION_BYTES, MAX_AGENT_TITLE_BYTES } from "./agentProfile.js";
import { MAX_RUNNER_USD } from "./spend.js";

const ISSUE = "https://github.com/krasovsky22/agent-office-sims/issues/39";
const PULL = "https://github.com/krasovsky22/agent-office-sims/pull/41";

const SYNC = {
  runnerId: "runner-1",
  repo: "krasovsky22/agent-office-sims",
  acked: ["command-1"],
  slots: [
    {
      id: "slot-1",
      name: "Maya",
      title: "Software Developer",
      description: "Takes the issues it is given.\nOpens a pull request for each.",
      status: "working",
      issueNumber: 39,
      activity: "Bash: pnpm test",
      pr: { number: 41, title: "Night shift", url: PULL },
    },
    { id: "slot-2", name: "Leo", status: "idle" },
  ],
  events: [{ id: "event-1", kind: "pr-opened", slotId: "slot-1", issueNumber: 39, pr: { number: 41, url: PULL } }],
  prompts: [{ commandId: "command-7", slotId: "slot-1", outcome: "busy" }],
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
          name: "Maya",
          title: "Software Developer",
          description: "Takes the issues it is given.\nOpens a pull request for each.",
          status: "working",
          issueNumber: 39,
          activity: "Bash: pnpm test",
          pr: { number: 41, title: "Night shift", url: PULL },
        },
        // A runner that gives no profile, as an older one does.
        { id: "slot-2", name: "Leo", title: "", description: "", status: "idle", issueNumber: undefined, activity: "", pr: undefined },
      ],
      events: [
        {
          id: "event-1",
          kind: "pr-opened",
          slotId: "slot-1",
          issueNumber: 39,
          pr: { number: 41, title: "", url: PULL },
          message: "",
          refusal: undefined,
        },
      ],
      spend: undefined,
      prompts: [{ commandId: "command-7", slotId: "slot-1", outcome: "busy" }],
      standing: [],
      standingRuns: [],
      changesIssues: false,
      issueStates: [],
    });
  });

  it("reads an idle agent's answer, or why there is none, and refuses an answer with nothing in it", () => {
    const answered = { commandId: "command-8", slotId: "slot-1", outcome: "answered", text: "Free for one.\nNo blockers." };
    const notAnswered = { commandId: "command-9", slotId: "slot-1", outcome: "not-answered", text: "it ran past its 1 minute" };
    expect(parseRunnerSync({ ...SYNC, prompts: [answered, notAnswered, { commandId: "command-10", slotId: "slot-1", outcome: "answering" }] })?.prompts).toEqual([
      answered,
      notAnswered,
      { commandId: "command-10", slotId: "slot-1", outcome: "answering" },
    ]);
    expect(parseRunnerSync({ ...SYNC, prompts: [{ ...answered, text: "  " }] })).toBeUndefined();
    expect(parseRunnerSync({ ...SYNC, prompts: [{ ...answered, text: "x".repeat(900) }] })).toBeUndefined();
    // Only an answer carries words.
    expect(parseRunnerSync({ ...SYNC, prompts: [{ commandId: "command-7", slotId: "slot-1", outcome: "busy", text: "hi" }] })?.prompts).toEqual([
      { commandId: "command-7", slotId: "slot-1", outcome: "busy" },
    ]);
  });

  it("reads the day's spend and a start refused for the budget", () => {
    const parsed = parseRunnerSync({
      ...SYNC,
      events: [{ id: "event-2", kind: "failed", slotId: "slot-1", issueNumber: 40, message: "budget spent", refusal: "budget" }],
      spend: { spentUsd: 5.25, budgetUsd: 5 },
    });
    expect((parsed?.events[0] as RunnerWorkEvent | undefined)?.refusal).toBe("budget");
    expect(parsed?.spend).toEqual({ spentUsd: 5.25, budgetUsd: 5 });
    expect(parseRunnerSync({ ...SYNC, spend: { spentUsd: 0.5 } })?.spend).toEqual({ spentUsd: 0.5, budgetUsd: undefined });
  });

  it("treats missing lists as empty, and names a slot by its id when it has no name", () => {
    expect(
      parseRunnerSync({ runnerId: "r", repo: "o/r", slots: [{ id: "slot-1", status: "needs-input" }] }),
    ).toEqual({
      runnerId: "r",
      repo: "o/r",
      acked: [],
      slots: [{ id: "slot-1", name: "slot-1", title: "", description: "", status: "needs-input", issueNumber: undefined, activity: "", pr: undefined }],
      events: [],
      spend: undefined,
      prompts: [],
      standing: [],
      standingRuns: [],
      changesIssues: false,
      issueStates: [],
    });
  });

  it("reads whether the runner changes issues, and what came of the ones it was asked to", () => {
    const parsed = parseRunnerSync({
      ...SYNC,
      changesIssues: true,
      issueStates: [{ commandId: "command-9", outcome: "refused" }],
    });
    expect(parsed?.changesIssues).toBe(true);
    expect(parsed?.issueStates).toEqual([{ commandId: "command-9", outcome: "refused" }]);
  });

  it("keeps a simulated pull request as simulated, with no link", () => {
    const pr = { number: 1_000_039, title: "[mock] Night shift", url: "", simulated: true };
    const parsed = parseRunnerSync({
      ...SYNC,
      slots: [{ id: "slot-1", status: "idle", issueNumber: 39, pr }],
      events: [{ id: "event-1", kind: "pr-opened", slotId: "slot-1", issueNumber: 39, pr: { number: 1_000_039, simulated: true } }],
    });
    expect(parsed?.slots[0]?.pr).toEqual({ number: 1_000_039, title: "[mock] Night shift", url: "", simulated: true });
    expect((parsed?.events[0] as RunnerWorkEvent | undefined)?.pr).toEqual({ number: 1_000_039, title: "", url: "", simulated: true });
    // Only `true` makes one simulated: anything else is a real one, which needs its link.
    expect(parseRunnerSync({ ...SYNC, slots: [{ id: "s", status: "idle", pr: { number: 1, simulated: "yes" } }] })).toBeUndefined();
  });

  it("sanitises every string it keeps", () => {
    const parsed = parseRunnerSync({
      ...SYNC,
      slots: [
        {
          id: "slot-1",
          name: "Claude\n\u0000 1",
          title: "Release\n\u0007Engineer",
          description: "Line one\r\n\u001b[2Jline two\u202e",
          status: "working",
          activity: "a\nb\u0007c".repeat(5),
        },
      ],
      events: [{ id: "event-1", kind: "failed", slotId: "slot-1", issueNumber: 39, message: "line one\nline two" }],
    });
    const slot = parsed?.slots[0];
    expect(slot?.name).toBe("Claude 1");
    expect(slot?.title).toBe("Release Engineer");
    expect(slot?.description).toBe("Line one\n[2Jline two");
    expect(slot?.activity).not.toContain("\n");
    expect(slot?.activity).not.toContain("\u0007");
    expect(parsed?.events[0]).toMatchObject({ message: "line one line two" });
  });

  it("reads what a slot's agent has spent today, and refuses a sync whose spend is not dollars", () => {
    const [first, second] = SYNC.slots;
    const spent = (spentTodayUsd: unknown) => parseRunnerSync({ ...SYNC, slots: [{ ...first, spentTodayUsd }, second] });
    expect(spent(1.25)?.slots[0]?.spentTodayUsd).toBe(1.25);
    expect(parseRunnerSync(SYNC)?.slots[0]).not.toHaveProperty("spentTodayUsd");
    expect(spent(-1)).toBeUndefined();
    expect(spent("1")).toBeUndefined();
  });

  it("reads a slot lent to a desk, and why a desk session ended", () => {
    const parsed = parseRunnerSync({
      ...SYNC,
      slots: [{ id: "slot-2", name: "Claude 2", status: "needs-input", activity: "Wants permission: Bash: rm", desk: { seatId: "seat-desk-a-1" } }],
      events: [{ id: "event-9", kind: "desk-ended", slotId: "slot-1", seatId: "seat-desk-a-2", message: "Claude exited\nwith code 1" }],
    });
    expect(parsed?.slots[0]).toMatchObject({ id: "slot-2", status: "needs-input", issueNumber: undefined, desk: { seatId: "seat-desk-a-1" } });
    expect(parsed?.events).toEqual([
      { id: "event-9", kind: "desk-ended", slotId: "slot-1", seatId: "seat-desk-a-2", message: "Claude exited with code 1" },
    ]);
    // Not about any issue's work, so the work's side never reads it.
    expect(parsed?.events.filter(isRunnerWorkEvent)).toEqual([]);
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
    ["an unknown issue state outcome", { ...SYNC, issueStates: [{ commandId: "command-9", outcome: "merged" }] }],
    [
      "too many issue state outcomes",
      { ...SYNC, issueStates: Array.from({ length: MAX_RUNNER_ISSUE_STATE_OUTCOMES + 1 }, () => ({ commandId: "c", outcome: "done" })) },
    ],
    ["a changesIssues that is not a boolean", { ...SYNC, changesIssues: "yes" }],
    ["an event with no issue", { ...SYNC, events: [{ ...SYNC.events[0], issueNumber: undefined }] }],
    ["an ack that is not an id", { ...SYNC, acked: [7] }],
    ["slots that are not a list", { ...SYNC, slots: { id: "s" } }],
    ["too many slots", { ...SYNC, slots: Array.from({ length: MAX_RUNNER_SLOTS + 1 }, (_, i) => ({ id: `s${i}`, status: "idle" })) }],
    ["too many events", { ...SYNC, events: Array.from({ length: MAX_RUNNER_EVENTS + 1 }, (_, i) => ({ ...SYNC.events[0], id: `e${i}` })) }],
    ["too many acks", { ...SYNC, acked: Array.from({ length: MAX_RUNNER_ACKS + 1 }, (_, i) => `c${i}`) }],
    ["a slot name longer than a nameplate", { ...SYNC, slots: [{ id: "s", name: "n".repeat(19), status: "idle" }] }],
    ["an activity longer than a title", { ...SYNC, slots: [{ id: "s", status: "working", activity: "a".repeat(91) }] }],
    ["a pull request title longer than a title", { ...SYNC, slots: [{ id: "s", status: "working", pr: { number: 1, title: "t".repeat(91), url: PULL } }] }],
    ["a simulated pull request with a link", { ...SYNC, slots: [{ id: "s", status: "idle", pr: { number: 1, url: PULL, simulated: true } }] }],
    ["a simulated pull request title longer than a title", { ...SYNC, slots: [{ id: "s", status: "idle", pr: { number: 1, title: "t".repeat(91), simulated: true } }] }],
    ["an event message longer than a work note", { ...SYNC, events: [{ ...SYNC.events[0], message: "m".repeat(281) }] }],
    ["an event message within its length but past its bytes", { ...SYNC, events: [{ ...SYNC.events[0], message: "\u2014".repeat(94) }] }],
    ["a slot name of control characters past its bytes", { ...SYNC, slots: [{ id: "s", name: "\u001b".repeat(4), status: "idle" }] }],
    ["a pull request link within its length but past its bytes", { ...SYNC, slots: [{ id: "s", status: "working", pr: { number: 1, url: `${PULL}?q=${"\u00e9".repeat(150)}` } }] }],
    ["a slot name that is not a string", { ...SYNC, slots: [{ id: "s", name: ["Claude"], status: "idle" }] }],
    ["a title past its bytes", { ...SYNC, slots: [{ id: "s", title: "t".repeat(MAX_AGENT_TITLE_BYTES + 1), status: "idle" }] }],
    ["a description past its bytes", { ...SYNC, slots: [{ id: "s", description: "\u00e9".repeat(MAX_AGENT_DESCRIPTION_BYTES / 2 + 1), status: "idle" }] }],
    ["a title that is not a string", { ...SYNC, slots: [{ id: "s", title: 7, status: "idle" }] }],
    ["an unknown refusal", { ...SYNC, events: [{ ...SYNC.events[0], refusal: "bored" }] }],
    ["a spend that is not an object", { ...SYNC, spend: 5 }],
    ["a spend with no amount", { ...SYNC, spend: { budgetUsd: 5 } }],
    ["a negative spend", { ...SYNC, spend: { spentUsd: -1 } }],
    ["a spend past the most a runner may report", { ...SYNC, spend: { spentUsd: MAX_RUNNER_USD + 1 } }],
    ["a budget that is not a number", { ...SYNC, spend: { spentUsd: 1, budgetUsd: "5" } }],
    ["a budget that is not finite", { ...SYNC, spend: { spentUsd: 1, budgetUsd: Number.POSITIVE_INFINITY } }],
    ["an unknown prompt outcome", { ...SYNC, prompts: [{ commandId: "c", slotId: "s", outcome: "typed-anyway" }] }],
    ["a prompt outcome for no command", { ...SYNC, prompts: [{ slotId: "s", outcome: "delivered" }] }],
    ["a prompt outcome for a slot id with a colon", { ...SYNC, prompts: [{ commandId: "c", slotId: "s:1", outcome: "delivered" }] }],
    ["too many prompt outcomes", { ...SYNC, prompts: Array.from({ length: MAX_RUNNER_PROMPT_OUTCOMES + 1 }, (_, i) => ({ commandId: `c${i}`, slotId: "s", outcome: "busy" })) }],
    ["a desk with no seat", { ...SYNC, slots: [{ id: "s", status: "idle", desk: {} }] }],
    ["a desk whose seat is not an id", { ...SYNC, slots: [{ id: "s", status: "idle", desk: { seatId: "seat 1" } }] }],
    ["a slot at a desk and on an issue", { ...SYNC, slots: [{ id: "s", status: "working", issueNumber: 39, desk: { seatId: "seat-desk-a-1" } }] }],
    ["a slot at a desk and on a standing run", { ...SYNC, slots: [{ id: "s", status: "working", standing: { taskId: "task-1" }, desk: { seatId: "seat-desk-a-1" } }] }],
    ["a desk event with no seat", { ...SYNC, events: [{ id: "e", kind: "desk-ended", slotId: "s", message: "" }] }],
    ["a desk event with a message past a work note", { ...SYNC, events: [{ id: "e", kind: "desk-ended", slotId: "s", seatId: "seat-1", message: "m".repeat(281) }] }],
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
    // Naming an issue, it stops only the slot's work on that one.
    expect(toRunnerCommand("command-4", { kind: "stop", slotId: "slot-1", reason: "done", issueNumber: 39 })).toEqual({
      id: "command-4",
      slotId: "slot-1",
      kind: "stop",
      reason: "done",
      issueNumber: 39,
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

  it("marks only the CEO's prompt, and strips every control character from any prompt", () => {
    expect(
      toRunnerCommand("command-5", {
        kind: "prompt",
        slotId: "slot-1",
        text: "yes\u001b[201~\r\nrm -rf /\u009b\u0007\tok",
        requestedBy: "Dana",
        fromCeo: true,
      }),
    ).toEqual({
      id: "command-5",
      slotId: "slot-1",
      kind: "prompt",
      text: "yes[201~\nrm -rf / ok",
      requestedBy: "Dana",
      fromCeo: true,
    });
    expect(toRunnerCommand("command-6", { kind: "prompt", slotId: "slot-1", text: "rework", requestedBy: "Dana" })).not.toHaveProperty(
      "fromCeo",
    );
  });

  it("keeps a standup direction for later only when it is the CEO's", () => {
    const draft = { kind: "prompt", slotId: "slot-1", text: "Open the PR.", requestedBy: "Dana", queue: true } as const;
    expect(toRunnerCommand("command-8", { ...draft, fromCeo: true })).toMatchObject({ fromCeo: true, queue: true });
    expect(toRunnerCommand("command-9", draft)).not.toHaveProperty("queue");
  });

  it("carries a direction's status for an idle agent's answer, printable and capped, and only with the direction", () => {
    const draft = { kind: "prompt", slotId: "slot-1", text: "Status?", requestedBy: "Dana", fromCeo: true, queue: true } as const;
    expect(toRunnerCommand("command-10", { ...draft, context: "Free.\n\u001b[31mNo blockers." })).toMatchObject({ context: "Free.\n[31mNo blockers." });
    expect(toRunnerCommand("command-11", { ...draft, context: "x".repeat(5000) })).toMatchObject({ context: "x".repeat(2000) });
    expect(toRunnerCommand("command-12", { ...draft, context: "" })).not.toHaveProperty("context");
    expect(toRunnerCommand("command-13", { ...draft, queue: false, context: "Free." })).not.toHaveProperty("context");
  });

  it("builds a key command for a key the CEO may press", () => {
    expect(toRunnerCommand("command-7", { kind: "key", slotId: "slot-1", key: "down", requestedBy: "Dana\u0007" })).toEqual({
      id: "command-7",
      slotId: "slot-1",
      kind: "key",
      key: "down",
      requestedBy: "Dana",
    });
  });

  it("builds a profile command, sanitised, the CEO's description's lines kept", () => {
    expect(
      toRunnerCommand("command-10", {
        kind: "profile",
        slotId: "slot-1",
        name: " Grace\u0007 ",
        title: "Release\nEngineer",
        description: "Keeps it green.\r\n\r\n\r\n\u001bNever skips the changelog.",
        requestedBy: "Dana",
      }),
    ).toEqual({
      id: "command-10",
      slotId: "slot-1",
      kind: "profile",
      name: "Grace",
      title: "Release Engineer",
      description: "Keeps it green.\n\nNever skips the changelog.",
      requestedBy: "Dana",
    });
  });

  it("builds a hire command for a new slot, its profile sanitised as an edit's is, and refuses one with no name", () => {
    expect(
      toRunnerCommand("command-12", { kind: "hire", slotId: "hired-1", name: " Nova ", title: "Accessibility\nSpecialist", description: "Hired for #39.", requestedBy: "Dana" }),
    ).toEqual({ id: "command-12", slotId: "hired-1", kind: "hire", name: "Nova", title: "Accessibility Specialist", description: "Hired for #39.", requestedBy: "Dana" });
    expect(toRunnerCommand("command-13", { kind: "hire", slotId: "hired-1", name: " ", title: "Specialist", description: "", requestedBy: "" })).toBeUndefined();
    expect(isRunnerSlotCommand({ kind: "hire" })).toBe(true);
  });

  it("builds the commands that lend a slot to a desk and take it back, sanitised", () => {
    expect(toRunnerCommand("command-8", { kind: "desk-open", slotId: "slot-2", seatId: "seat-desk-a-1", requestedBy: "Dana\u0007" })).toEqual({
      id: "command-8",
      slotId: "slot-2",
      kind: "desk-open",
      seatId: "seat-desk-a-1",
      requestedBy: "Dana",
    });
    expect(toRunnerCommand("command-9", { kind: "desk-close", slotId: "slot-2", seatId: "seat-desk-a-1", reason: "stood\nup" })).toEqual({
      id: "command-9",
      slotId: "slot-2",
      kind: "desk-close",
      seatId: "seat-desk-a-1",
      reason: "stood up",
    });
    expect(toRunnerCommand("command-11", { kind: "desk-resize", slotId: "slot-2", seatId: "seat-desk-a-1", cols: 150, rows: 40 })).toEqual({
      id: "command-11",
      slotId: "slot-2",
      kind: "desk-resize",
      seatId: "seat-desk-a-1",
      cols: 150,
      rows: 40,
    });
  });

  it.each([
    ["a bad slot id", { kind: "stop", slotId: "slot:1", reason: "" }],
    ["a javascript: link", { kind: "start", slotId: "s", issueNumber: 1, title: "t", url: "javascript:x", note: "", requestedBy: "" }],
    ["no title", { kind: "start", slotId: "s", issueNumber: 1, title: " ", url: ISSUE, note: "", requestedBy: "" }],
    ["no issue number", { kind: "start", slotId: "s", issueNumber: 0, title: "t", url: ISSUE, note: "", requestedBy: "" }],
    ["an empty prompt", { kind: "prompt", slotId: "s", text: "\n\n", requestedBy: "" }],
    ["a stop for no issue", { kind: "stop", slotId: "s", reason: "", issueNumber: -1 }],
    ["a key that types text", { kind: "key", slotId: "s", key: "y" as "enter", requestedBy: "" }],
    ["a profile with no name", { kind: "profile", slotId: "s", name: "\u0007", title: "Developer", description: "", requestedBy: "" }],
    ["a profile with no title", { kind: "profile", slotId: "s", name: "Grace", title: " ", description: "", requestedBy: "" }],
    ["an issue state that is not open or closed", { kind: "issue-state", issueNumber: 1, state: "merged" as "open", requestedBy: "" }],
    ["an issue state for no issue", { kind: "issue-state", issueNumber: 0, state: "closed", requestedBy: "" }],
    ["a desk that is not a seat id", { kind: "desk-open", slotId: "s", seatId: "seat/1", requestedBy: "" }],
    ["a desk to close that is no seat", { kind: "desk-close", slotId: "s", seatId: "", reason: "" }],
    ["a desk terminal wider than a frame carries", { kind: "desk-resize", slotId: "s", seatId: "seat-desk-a-1", cols: 201, rows: 40 }],
    ["a desk terminal too short to lay out", { kind: "desk-resize", slotId: "s", seatId: "seat-desk-a-1", cols: 120, rows: 9 }],
    ["a desk terminal of part of a cell", { kind: "desk-resize", slotId: "s", seatId: "seat-desk-a-1", cols: 120.5, rows: 30 }],
  ] as const)("refuses a command with %s", (_label, draft) => {
    expect(toRunnerCommand("command-1", draft)).toBeUndefined();
  });
});

describe("toRunnerCommand for an issue's state", () => {
  it("builds a command that names no slot, with the CEO's name sanitised", () => {
    expect(toRunnerCommand("command-10", { kind: "issue-state", issueNumber: 39, state: "closed", requestedBy: "Dana\u0007" })).toEqual({
      id: "command-10",
      kind: "issue-state",
      issueNumber: 39,
      state: "closed",
      requestedBy: "Dana",
    });
  });
});

describe("readAgentRestrictLabel", () => {
  it("defaults to agent-restricted, and keeps a label trimmed", () => {
    expect(readAgentRestrictLabel(undefined)).toBe("agent-restricted");
    expect(readAgentRestrictLabel("  ")).toBe("agent-restricted");
    expect(readAgentRestrictLabel(" humans only ")).toBe("humans only");
  });

  it("refuses a name GitHub would not give a label", () => {
    expect(() => readAgentRestrictLabel("x".repeat(51))).toThrow(/REAL_AGENT_RESTRICT_LABEL/);
    expect(() => readAgentRestrictLabel("agent\nrestricted")).toThrow(/REAL_AGENT_RESTRICT_LABEL/);
  });
});

describe("retiredAgentIssueLabelNotice", () => {
  it("says the old label setting is ignored only when it is set", () => {
    expect(retiredAgentIssueLabelNotice({})).toBeUndefined();
    expect(retiredAgentIssueLabelNotice({ REAL_AGENT_ISSUE_LABEL: " " })).toBeUndefined();
    expect(retiredAgentIssueLabelNotice({ REAL_AGENT_ISSUE_LABEL: "agent-ready" })).toMatch(/^REAL_AGENT_ISSUE_LABEL is ignored/);
  });
});

describe("simulatedPullRequestArtifact", () => {
  it("names a simulated pull request as one, and is told apart from any other deliverable", () => {
    expect(simulatedPullRequestArtifact("[mock] Night shift")).toBe("Simulated pull request, nothing on GitHub: [mock] Night shift");
    expect(simulatedPullRequestArtifact("")).toBe(SIMULATED_PULL_REQUEST);
    expect(isSimulatedPullRequestArtifact(simulatedPullRequestArtifact("[mock] Night shift"))).toBe(true);
    expect(isSimulatedPullRequestArtifact(SIMULATED_PULL_REQUEST)).toBe(true);
    expect(isSimulatedPullRequestArtifact(`PR #41: Night shift, ${PULL}`)).toBe(false);
    expect(isSimulatedPullRequestArtifact("")).toBe(false);
  });
});
