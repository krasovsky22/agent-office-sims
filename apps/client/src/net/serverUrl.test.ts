/** Which server the client dials when the build named none. */

import { describe, expect, it } from "vitest";

import { resolveServerUrl } from "./serverUrl.js";

describe("resolveServerUrl", () => {
  it("dials the page's own origin through the dev proxy, matching its scheme", () => {
    expect(resolveServerUrl(undefined, { protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/colyseus",
    );
    expect(resolveServerUrl("", { protocol: "https:", host: "f1a2.ngrok-free.app" })).toBe(
      "wss://f1a2.ngrok-free.app/colyseus",
    );
  });

  it("keeps a configured URL as is", () => {
    expect(resolveServerUrl("wss://office.example.com", { protocol: "https:", host: "x" })).toBe(
      "wss://office.example.com",
    );
  });
});
