/**
 * The sync client against a stand-in for the server: what it sends, how it
 * reads a reply, and that every refusal or silence is an error the loop can
 * back off from rather than a crash.
 */

import type { RunnerSync } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { SyncError, createSyncClient, readCommands } from "./syncClient.js";

const SECRET = "a-runner-secret-long-enough";
const SERVER = new URL("https://office.example");
const REPO = "krasovsky22/agent-office-sims";

const SYNC: RunnerSync = {
  runnerId: "runner-1",
  repo: REPO,
  acked: [],
  slots: [{ id: "slot-1", name: "Maya", title: "Software Developer", description: "", status: "idle", issueNumber: undefined, activity: "", pr: undefined }],
  events: [],
  spend: { spentUsd: 0.4, budgetUsd: undefined },
};

const START = {
  id: "command-1",
  slotId: "slot-1",
  kind: "start",
  issueNumber: 39,
  title: "Night shift",
  url: `https://github.com/${REPO}/issues/39`,
  note: "put someone on #39",
  requestedBy: "Dana",
};

function answering(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { calls, client: createSyncClient({ serverUrl: SERVER, secret: SECRET, fetch }) };
}

async function refusal(promise: Promise<unknown>): Promise<SyncError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    return error as SyncError;
  }
  throw new Error("expected the sync to fail");
}

describe("createSyncClient", () => {
  it("posts the sync as JSON to the contract's path, with the secret as a bearer token", async () => {
    const { calls, client } = answering(200, { ok: true, commands: [] });
    await client(SYNC);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://office.example/agents/runner/sync");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.headers).toEqual({ Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      runnerId: "runner-1",
      repo: REPO,
      acked: [],
      slots: [{ id: "slot-1", name: "Maya", title: "Software Developer", description: "", status: "idle", activity: "" }],
      events: [],
      spend: { spentUsd: 0.4 },
    });
  });

  it("returns the commands the server is waiting on", async () => {
    const stop = { id: "command-2", slotId: "slot-1", kind: "stop", reason: "CEO said so" };
    const { client } = answering(200, { ok: true, commands: [START, stop] });
    const reply = await client(SYNC);
    expect(reply.commands).toEqual([START, stop]);
    expect(reply.unreadable).toEqual([]);
  });

  it("says a standup is on only when the server says so", async () => {
    expect((await answering(200, { ok: true, commands: [], standup: true }).client(SYNC)).standup).toBe(true);
    expect((await answering(200, { ok: true, commands: [], standup: "yes" }).client(SYNC)).standup).toBeUndefined();
    expect((await answering(200, { ok: true, commands: [] }).client(SYNC)).standup).toBeUndefined();
  });

  it("turns each refusal into an error carrying the status and the server's reason", async () => {
    for (const [status, error] of [
      [401, "unauthorized"],
      [403, "this server works on another repository"],
      [409, "the office is full"],
      [429, "too many syncs"],
    ] as const) {
      const { client } = answering(status, { error });
      const refused = await refusal(client(SYNC));
      expect(refused.status).toBe(status);
      expect(refused.message).toBe(`refused with HTTP ${status}: ${error}`);
    }
  });

  it("never puts the secret in an error", async () => {
    const { client } = answering(401, { error: "unauthorized" });
    expect((await refusal(client(SYNC))).message).not.toContain(SECRET);
  });

  it("fails on a reply that is not JSON or not a sync reply", async () => {
    expect((await refusal(answering(200, "<html>").client(SYNC))).message).toMatch(/unreadable reply \(HTTP 200\)/);
    expect((await refusal(answering(200, { ok: true }).client(SYNC))).message).toBe("the reply is not a sync reply");
    expect((await refusal(answering(200, [1, 2]).client(SYNC))).message).toBe("the reply is not a sync reply");
  });

  it("fails without a status when the server cannot be reached", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:2567") });
    }) as typeof globalThis.fetch;
    const client = createSyncClient({ serverUrl: SERVER, secret: SECRET, fetch });
    const refused = await refusal(client(SYNC));
    expect(refused.status).toBeUndefined();
    expect(refused.message).toBe("could not reach https://office.example: fetch failed (connect ECONNREFUSED 127.0.0.1:2567)");
  });

  it("gives up on a server that does not answer in time", async () => {
    const fetch = ((_url: URL | string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    const client = createSyncClient({ serverUrl: SERVER, secret: SECRET, fetch, requestTimeoutMs: 10 });
    expect((await refusal(client(SYNC))).message).toMatch(/could not reach https:\/\/office\.example/);
  });
});

describe("readCommands", () => {
  it("rebuilds each command through the contract, sanitising its strings", () => {
    const { commands } = readCommands([{ ...START, title: "Night\nshift", requestedBy: "Dana\u0000" }]);
    expect(commands).toEqual([{ ...START, title: "Night shift", requestedBy: "Dana" }]);
  });

  it("keeps a prompt's mark as the CEO's, and strips its control characters", () => {
    const { commands } = readCommands([
      { id: "command-1", slotId: "slot-1", kind: "prompt", text: "yes\u001b[201~\nok", requestedBy: "Dana", fromCeo: true },
      { id: "command-2", slotId: "slot-1", kind: "prompt", text: "rework", requestedBy: "Dana", fromCeo: "yes" },
    ]);
    expect(commands).toEqual([
      { id: "command-1", slotId: "slot-1", kind: "prompt", text: "yes[201~\nok", requestedBy: "Dana", fromCeo: true },
      { id: "command-2", slotId: "slot-1", kind: "prompt", text: "rework", requestedBy: "Dana" },
    ]);
  });

  it("keeps a standup direction's mark to keep it for later, only on the CEO's prompt", () => {
    const { commands } = readCommands([
      { id: "command-1", slotId: "slot-1", kind: "prompt", text: "Open the PR.", requestedBy: "Dana", fromCeo: true, queue: true },
      { id: "command-2", slotId: "slot-1", kind: "prompt", text: "rework", requestedBy: "Dana", queue: true },
    ]);
    expect(commands).toEqual([
      { id: "command-1", slotId: "slot-1", kind: "prompt", text: "Open the PR.", requestedBy: "Dana", fromCeo: true, queue: true },
      { id: "command-2", slotId: "slot-1", kind: "prompt", text: "rework", requestedBy: "Dana" },
    ]);
  });

  it("reads a key the CEO pressed, and sets aside one that is not a key", () => {
    const reply = readCommands([
      { id: "command-1", slotId: "slot-1", kind: "key", key: "down", requestedBy: "Dana" },
      { id: "command-2", slotId: "slot-1", kind: "key", key: "\u001b[B", requestedBy: "Dana" },
    ]);
    expect(reply.commands).toEqual([{ id: "command-1", slotId: "slot-1", kind: "key", key: "down", requestedBy: "Dana" }]);
    expect(reply.unreadable).toEqual(["command-2"]);
  });

  it("reads the CEO's edit of an agent's profile, sanitised, and sets aside one with no title", () => {
    const profile = { id: "command-1", slotId: "slot-1", kind: "profile", name: "Grace\u0007", title: "Release\nEngineer", description: "Keeps it green.", requestedBy: "Dana" };
    const reply = readCommands([profile, { ...profile, id: "command-2", title: "" }, { ...profile, id: "command-3", description: 7 }]);
    expect(reply.commands).toEqual([
      { id: "command-1", slotId: "slot-1", kind: "profile", name: "Grace", title: "Release Engineer", description: "Keeps it green.", requestedBy: "Dana" },
    ]);
    expect(reply.unreadable).toEqual(["command-2", "command-3"]);
  });

  it("reads a change to an issue's state, which names no slot, and sets aside one it cannot act on", () => {
    const reply = readCommands([
      { id: "command-1", kind: "issue-state", issueNumber: 39, state: "closed", requestedBy: "Dana" },
      { id: "command-2", kind: "issue-state", issueNumber: 39, state: "merged", requestedBy: "Dana" },
    ]);
    expect(reply.commands).toEqual([{ id: "command-1", kind: "issue-state", issueNumber: 39, state: "closed", requestedBy: "Dana" }]);
    expect(reply.unreadable).toEqual(["command-2"]);
  });

  it("reads the commands that lend a slot to a desk and take it back", () => {
    const reply = readCommands([
      { id: "command-1", slotId: "slot-1", kind: "desk-open", seatId: "seat-desk-north-1-1", requestedBy: "Dana" },
      { id: "command-2", slotId: "slot-1", kind: "desk-close", seatId: "seat-desk-north-1-1", reason: "the CEO stood up" },
      { id: "command-3", slotId: "slot-1", kind: "desk-open", seatId: 7, requestedBy: "Dana" },
      { id: "command-4", slotId: "slot-1", kind: "desk-resize", seatId: "seat-desk-north-1-1", cols: 150, rows: 40 },
      { id: "command-5", slotId: "slot-1", kind: "desk-resize", seatId: "seat-desk-north-1-1", cols: 5000, rows: 40 },
    ]);
    expect(reply.commands).toEqual([
      { id: "command-1", slotId: "slot-1", kind: "desk-open", seatId: "seat-desk-north-1-1", requestedBy: "Dana" },
      { id: "command-2", slotId: "slot-1", kind: "desk-close", seatId: "seat-desk-north-1-1", reason: "the CEO stood up" },
      { id: "command-4", slotId: "slot-1", kind: "desk-resize", seatId: "seat-desk-north-1-1", cols: 150, rows: 40 },
    ]);
    expect(reply.unreadable).toEqual(["command-3", "command-5"]);
  });

  it("reads a stop's issue and a cancel's discard, and the CEO firing a slot's agent", () => {
    const reply = readCommands([
      { id: "command-1", slotId: "slot-1", kind: "stop", reason: "the CEO cancelled the task", issueNumber: 39, discard: true },
      { id: "command-2", slotId: "slot-1", kind: "stop", reason: "", discard: "yes" },
      { id: "command-3", slotId: "slot-1", kind: "stop", reason: "", issueNumber: -1 },
      { id: "command-4", slotId: "slot-1", kind: "fire", requestedBy: "Dana" },
      { id: "command-5", slotId: "slot-1", kind: "fire" },
      { id: "command-6", slotId: "hired-1", kind: "hire", name: "Nova", title: "Specialist", description: "", requestedBy: "Dana" },
      { id: "command-7", slotId: "hired-2", kind: "hire", name: "Nova", requestedBy: "Dana" },
    ]);
    expect(reply.commands).toEqual([
      { id: "command-1", slotId: "slot-1", kind: "stop", reason: "the CEO cancelled the task", issueNumber: 39, discard: true },
      { id: "command-2", slotId: "slot-1", kind: "stop", reason: "" },
      { id: "command-4", slotId: "slot-1", kind: "fire", requestedBy: "Dana" },
      { id: "command-6", slotId: "hired-1", kind: "hire", name: "Nova", title: "Specialist", description: "", requestedBy: "Dana" },
    ]);
    expect(reply.unreadable).toEqual(["command-3", "command-5", "command-7"]);
  });

  it("sets aside a command it cannot read, by id, so it can be acked", () => {
    const reply = readCommands([
      { id: "command-1", slotId: "slot-1", kind: "dance" },
      { ...START, id: "command-2", issueNumber: -1 },
      { ...START, id: "command-3", url: "http://insecure.example" },
      { id: "command-4", slotId: "slot-1", kind: "prompt", text: "", requestedBy: "Dana" },
      { id: "command-5", slotId: "slot-1", kind: "stop" },
      START,
    ]);
    expect(reply.commands).toEqual([START]);
    expect(reply.unreadable).toEqual(["command-1", "command-2", "command-3", "command-4", "command-5"]);
  });

  it("never offers to ack an id the server's parser would refuse the whole sync for", () => {
    const reply = readCommands([null, "start", { kind: "stop" }, { id: "has spaces", kind: "stop" }, { id: "x".repeat(65) }]);
    expect(reply).toEqual({ commands: [], unreadable: [] });
  });
});
