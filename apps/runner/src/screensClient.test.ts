/**
 * The screens client against a stand-in for the server: what it sends, how
 * it reads a reply, and that every refusal is an error carrying its status.
 */

import type { RunnerScreens } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { createScreensClient } from "./screensClient.js";
import { SyncError } from "./syncClient.js";

const SECRET = "a-runner-secret-long-enough";
const SERVER = new URL("https://office.example");

const SCREENS: RunnerScreens = {
  runnerId: "runner-1",
  screens: [{ slotId: "slot-1", frame: { cols: 10, rows: 2, lines: { 0: [["hi", -1, -1, 0]] }, full: true, cursor: [2, 0] } }],
};

function answering(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { calls, client: createScreensClient({ serverUrl: SERVER, secret: SECRET, fetch }) };
}

async function refusal(promise: Promise<unknown>): Promise<SyncError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    return error as SyncError;
  }
  throw new Error("expected the post to fail");
}

describe("createScreensClient", () => {
  it("posts the screens as JSON to the contract's path, with the secret as a bearer token and no redirects", async () => {
    const { calls, client } = answering(200, { ok: true, resend: [] });
    expect(await client(SCREENS)).toEqual({ resend: [] });
    const [call] = calls;
    expect(call?.url).toBe("https://office.example/agents/runner/screens");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.headers).toEqual({ Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" });
    expect(JSON.parse(String(call?.init.body))).toEqual(SCREENS);
  });

  it("returns the slots to send whole, leaving out anything that is not a slot id", async () => {
    const { client } = answering(200, { ok: true, resend: ["slot-2", 7, "not a slot", "slot-3"] });
    expect(await client(SCREENS)).toEqual({ resend: ["slot-2", "slot-3"] });
  });

  it("turns a refusal into an error carrying the status, and never the secret", async () => {
    const refused = await refusal(answering(429, { error: "too many screens" }).client(SCREENS));
    expect(refused.status).toBe(429);
    expect(refused.message).toBe("screens refused with HTTP 429: too many screens");
    expect((await refusal(answering(401, { error: "unauthorized" }).client(SCREENS))).message).not.toContain(SECRET);
  });

  it("fails on a reply that is not JSON or not a screens reply", async () => {
    expect((await refusal(answering(200, "<html>").client(SCREENS))).message).toBe("unreadable reply to screens (HTTP 200)");
    expect((await refusal(answering(200, { ok: true }).client(SCREENS))).message).toBe("the reply is not a screens reply");
  });

  it("fails without a status when the server cannot be reached", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const refused = await refusal(createScreensClient({ serverUrl: SERVER, secret: SECRET, fetch })(SCREENS));
    expect(refused.status).toBeUndefined();
    expect(refused.message).toBe("could not reach https://office.example: fetch failed");
  });
});
