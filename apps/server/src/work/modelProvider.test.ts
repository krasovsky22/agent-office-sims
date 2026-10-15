/**
 * The model provider without the network: the SDK call is replaced, so each
 * test chooses the reply or the error. The claims are that the request carries
 * the agent's role and the ticket, that a reply becomes an artifact, and that
 * every way the API can fail reaches the caller as a structured failure that
 * says whether it was worth retrying.
 */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { WORK_FAILURE, type WorkContext, WorkProviderError, type WorkTicket, createWorkExecutor } from "./executor.js";
import { type SendMessage, classifyError, createModelProvider, readReply } from "./modelProvider.js";

type ModelMessage = Anthropic.Message;

const TICKET: WorkTicket = { id: "t-1", title: "Write the launch email", body: "We ship on Friday." };
const CONTEXT: WorkContext = { agentName: "Grace", jobTitle: "Marketing Lead" };
const SIGNAL = new AbortController().signal;

function reply(text: string, stopReason: ModelMessage["stop_reason"] = "end_turn"): ModelMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: stopReason,
    content: [{ type: "text", text, citations: null }],
    usage: { input_tokens: 300, output_tokens: 700, cache_creation_input_tokens: null, cache_read_input_tokens: 0 },
  } as unknown as ModelMessage;
}

function apiError(status: number, headers: Record<string, string> = {}): Error {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type: "api_error", message: "nope" } },
    "nope",
    new Headers(headers),
  );
}

describe("the request", () => {
  it("puts the agent's role in the system prompt and the ticket in the user turn, with the SDK's retries left to the executor", async () => {
    const sent: Parameters<SendMessage>[0][] = [];
    const send: SendMessage = async (params) => {
      sent.push(params);
      return reply(JSON.stringify({ summary: "Launch email", artifact: "Subject: We ship Friday" }));
    };
    const provider = createModelProvider({ apiKey: "test-key", model: "claude-opus-5-5", send });

    const output = await provider(TICKET, CONTEXT, SIGNAL);

    expect(output).toEqual({ summary: "Launch email", artifact: "Subject: We ship Friday", tokensUsed: 1000 });
    const params = sent[0];
    expect(params?.model).toBe("claude-opus-5-5");
    expect(params?.system).toContain("Grace, the Marketing Lead");
    expect(JSON.stringify(params?.messages)).toContain("Write the launch email");
    expect(JSON.stringify(params?.messages)).toContain("We ship on Friday.");
    expect(params?.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(params)).not.toContain("test-key");
  });
});

describe("readReply", () => {
  it.each([
    ["a refusal", reply("", "refusal"), /declined/],
    ["a cut-off reply", reply('{"summary":"s","artifact":"half', "max_tokens"), /token limit/],
    ["prose instead of JSON", reply("Sure! Here is the email."), /JSON/],
    ["JSON without an artifact", reply(JSON.stringify({ summary: "s" })), /artifact/],
  ])("refuses %s, without a retry, and still counts its tokens", (_name, message, pattern) => {
    let error: unknown;
    try {
      readReply(message);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkProviderError);
    expect((error as WorkProviderError).message).toMatch(pattern);
    expect((error as WorkProviderError).retryable).toBe(false);
    expect((error as WorkProviderError).tokensUsed).toBe(1000);
  });
});

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

describe("through the executor", () => {
  it("a provider error is a structured failure, not an exception", async () => {
    const send: SendMessage = async () => {
      throw apiError(401);
    };
    const executor = createWorkExecutor({
      provider: createModelProvider({ apiKey: "bad-key", model: "claude-opus-5-5", send }),
    });

    const result = await executor.work(TICKET, CONTEXT);

    expect(result).toMatchObject({ ok: false, reason: WORK_FAILURE.providerError, attempts: 1 });
    expect(result.ok === false && result.message).toMatch(/API key/);
    expect(result.ok === false && result.message).not.toContain("bad-key");
  });

  it("an API that never answers times out and the request is aborted", async () => {
    const signals: AbortSignal[] = [];
    const send: SendMessage = (_params, { signal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()));
      });
    };
    const executor = createWorkExecutor({
      provider: createModelProvider({ apiKey: "k", model: "claude-opus-5-5", send }),
      timeoutMs: 10,
      maxAttempts: 1,
    });

    expect(await executor.work(TICKET, CONTEXT)).toMatchObject({ ok: false, reason: WORK_FAILURE.timeout });
    expect(signals[0]?.aborted).toBe(true);
  });
});
