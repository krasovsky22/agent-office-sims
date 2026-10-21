/** When a page counts as asking its own host, the rule that lets a tunnel in unlisted. */

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { isSameHttpsOrigin } from "./origins.js";

const req = (host: string | undefined): IncomingMessage => ({ headers: { host } }) as IncomingMessage;

describe("isSameHttpsOrigin", () => {
  it("accepts an https page asking its own host", () => {
    expect(isSameHttpsOrigin("https://f1a2.ngrok-free.app", req("f1a2.ngrok-free.app"))).toBe(true);
  });

  it("refuses another host, a plain-http origin, and a missing header", () => {
    expect(isSameHttpsOrigin("https://evil.example.com", req("f1a2.ngrok-free.app"))).toBe(false);
    expect(isSameHttpsOrigin("http://rebound.example.com:2567", req("rebound.example.com:2567"))).toBe(false);
    expect(isSameHttpsOrigin(undefined, req("f1a2.ngrok-free.app"))).toBe(false);
    expect(isSameHttpsOrigin("https://f1a2.ngrok-free.app", req(undefined))).toBe(false);
    expect(isSameHttpsOrigin("not a url", req("f1a2.ngrok-free.app"))).toBe(false);
  });
});
