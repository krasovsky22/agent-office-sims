/**
 * The manager's `claude` CLI planner with the process stood in for.
 *
 * Its claims: it asks the CLI for the same structured answer the API planner
 * does, with the office on stdin and none of the host's tools or settings, and
 * through the advisor a good run is a plan while a malformed answer, a run cut
 * off by the timeout and a CLI that is not signed in each come back as the
 * same failure notices the API planner's do.
 */

import { MANAGER_ENTRY_KIND } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { type ManagerRequest, createManagerAdvisor } from "./advisor.js";
import { type ClaudeRun, type RunClaude, createCliPlanner } from "./cliPlanner.js";
import { NO_STANDUP_VIEW, type OfficeView } from "./officeView.js";
import { ADVICE_FAILURE } from "./plannerError.js";

const VIEW: OfficeView = {
  ceo: "Dana",
  liveAgents: [{ id: "agent-1", name: "Ada Byrne", status: "idle", task: undefined, activity: "", assigned: undefined }],
  issueAgents: [],
  work: [],
  project: undefined,
  orchestrator: true,
  standing: [],
  standup: NO_STANDUP_VIEW,
};

const REQUEST: ManagerRequest = {
  message: "what is Ada doing?",
  ceoName: "Dana",
  view: VIEW,
  history: [{ id: 1, kind: MANAGER_ENTRY_KIND.update, authorName: "AI Manager", text: "Ada handed in #12.", at: 1 }],
};

const USAGE = { input_tokens: 900, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** What `claude -p --output-format json` prints, with `fields` over a successful run's. */
function result(fields: Record<string, unknown>, code = 0): ClaudeRun {
  return { code, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: USAGE, ...fields }), stderr: "" };
}

function advisorWith(run: RunClaude, timeoutMs?: number) {
  return createManagerAdvisor({
    mode: "model",
    planner: createCliPlanner({ model: "claude-opus-5-5", run }),
    maxAttempts: 2,
    sleep: async () => undefined,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("the CLI planner", () => {
  it("asks the CLI for the structured answer, with the office on stdin, and reads it into a plan", async () => {
    const calls: { args: readonly string[]; input: string }[] = [];
    const run: RunClaude = async (args, input) => {
      calls.push({ args, input });
      return result({
        result: "",
        structured_output: { reply: "Ada is idle.", assignments: [{ work: "#12", agent: "agent-1" }], moves: [], hires: [], standing: [], standup: "none" },
      });
    };

    expect(await advisorWith(run).advise(REQUEST)).toMatchObject({
      ok: true,
      plan: { reply: "Ada is idle.", assignments: [{ work: "#12", agent: "agent-1" }], tokensUsed: 1000 },
    });
    const { args, input } = calls[0] ?? { args: [], input: "" };
    expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "--model", "claude-opus-5-5", "--no-session-persistence"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] ?? "{}")).toMatchObject({ required: expect.arrayContaining(["reply", "hires"]) as unknown });
    expect(args[args.indexOf("--system-prompt") + 1]).toContain("AI Manager");
    expect(args.join(" ")).not.toContain("what is Ada doing?");
    expect(input).toContain("<ceo_message>\nDana: what is Ada doing?");
    expect(input).toContain("Ada Byrne");
  });

  it.each([
    ["no structured answer", result({ subtype: "error_max_structured_output_retries", result: "" }), /not the expected JSON/],
    ["an answer that says nothing", result({ structured_output: { reply: "  ", assignments: [] } }), /said nothing/],
    ["output that is not JSON", { code: 1, stdout: "Segmentation fault", stderr: "" }, /claude CLI failed \(exit 1\): Segmentation fault/],
  ])("reports %s as a provider error, without retrying", async (_name, run, message) => {
    let calls = 0;
    const outcome = await advisorWith(async () => {
      calls += 1;
      return run;
    }).advise(REQUEST);
    expect(outcome).toMatchObject({ ok: false, reason: ADVICE_FAILURE.providerError, message: expect.stringMatching(message) as unknown });
    expect(calls).toBe(1);
  });

  it("times out a run that never answers, and kills it", async () => {
    const aborted: boolean[] = [];
    const run: RunClaude = (_args, _input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted.push(true);
          reject(new Error("The operation was aborted"));
        });
      });
    expect(await advisorWith(run, 20).advise(REQUEST)).toMatchObject({ ok: false, reason: ADVICE_FAILURE.timeout });
    // Each attempt's process is killed when its time is up, the retry's too.
    expect(aborted).toEqual([true, true]);
  });

  it.each([
    ["says so in its result", result({ is_error: true, result: "Not logged in · Please run /login", usage: {} }, 1)],
    ["says so on stderr", { code: 1, stdout: "", stderr: "Invalid API key · Please run /login" }],
  ])("tells the CEO to sign the CLI in when it %s, without retrying", async (_name, run) => {
    let calls = 0;
    const outcome = await advisorWith(async () => {
      calls += 1;
      return run;
    }).advise(REQUEST);
    expect(outcome).toMatchObject({ ok: false, reason: ADVICE_FAILURE.providerError, message: expect.stringMatching(/not signed in.*\/login/) as unknown });
    expect(calls).toBe(1);
  });

  it("retries a rate limit the CLI reports", async () => {
    let calls = 0;
    const outcome = await advisorWith(async () => {
      calls += 1;
      return result({ is_error: true, api_error_status: 429, result: "API Error: 429 rate limited" }, 1);
    }).advise(REQUEST);
    expect(outcome).toMatchObject({ ok: false, reason: ADVICE_FAILURE.providerError, message: expect.stringContaining("(429)") as unknown });
    expect(calls).toBe(2);
  });

  it("says so when the CLI is not installed", async () => {
    const run: RunClaude = () => Promise.reject(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    expect(await advisorWith(run).advise(REQUEST)).toMatchObject({ ok: false, message: expect.stringContaining("not installed") as unknown });
  });
});
