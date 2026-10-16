/**
 * Reading the SDK's errors: every way the API can fail reaches the advisor as
 * a {@link PlannerError} that says whether it was worth retrying.
 */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { classifyError } from "./plannerError.js";

function apiError(status: number, headers: Record<string, string> = {}): Error {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type: "api_error", message: "nope" } },
    "nope",
    new Headers(headers),
  );
}

describe("classifyError", () => {
  it("retries a rate limit after the wait the API asked for", () => {
    const error = classifyError(apiError(429, { "retry-after": "7" }));
    expect(error).toMatchObject({ retryable: true, retryAfterMs: 7_000 });
    expect(error.message).toMatch(/rate limited/);
  });

  it.each([500, 503, 529, 408, 409])("retries a %i", (status) => {
    expect(classifyError(apiError(status)).retryable).toBe(true);
  });

  it.each([400, 401, 403, 404])("does not retry a %i", (status) => {
    expect(classifyError(apiError(status)).retryable).toBe(false);
  });

  it("retries an unreachable API", () => {
    expect(classifyError(new Anthropic.APIConnectionError({ message: "ECONNRESET" })).retryable).toBe(true);
  });
});
