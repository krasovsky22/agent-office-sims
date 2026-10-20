// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/usage.ts. See THIRD_PARTY_NOTICES.md.
/**
 * What one Claude Code session has cost, read off its transcript.
 *
 * Its hooks carry no usage, but every hook payload names the session's
 * transcript (`~/.claude/projects/<dir>/<session>.jsonl`). Each assistant
 * message in it records the API's `usage` (input, output, cache write, cache
 * read) and its model, so the tokens are exact and the cost is priced here from
 * {@link PRICES}. Subagents log to `<session>/subagents/*.jsonl` beside it, and
 * are read too. When a session ends, Claude Code appends a `cost-state` line
 * with its own tally, which also covers calls that never reach the transcript,
 * and the total snaps to it; anything logged after is estimated on top again.
 *
 * The transcript is Claude Code's own format and may change, so everything
 * here is defensive: a line it does not understand is skipped, never fatal.
 */

import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/** One session's tokens and what they cost, in US dollars. */
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly costUsd: number;
  readonly calls: number;
}

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0, calls: 0 };

function addUsage(a: Usage, b: Usage, sign = 1): Usage {
  return {
    input: a.input + sign * b.input,
    output: a.output + sign * b.output,
    cacheWrite: a.cacheWrite + sign * b.cacheWrite,
    cacheRead: a.cacheRead + sign * b.cacheRead,
    costUsd: a.costUsd + sign * b.costUsd,
    calls: a.calls + sign * b.calls,
  };
}

function isZero(usage: Usage): boolean {
  return !usage.input && !usage.output && !usage.cacheWrite && !usage.cacheRead && !usage.costUsd && !usage.calls;
}

/**
 * USD per million tokens, `[input, output, cache read]`, from the Claude
 * pricing page, checked 2026-09-26. A five-minute cache write costs 1.25 times
 * input, an hour's twice. The first match wins, so newer generations come
 * before the family they belong to. A model not listed is priced as Opus: a
 * budget that runs out early beats one that runs out late.
 */
const PRICES: ReadonlyArray<readonly [RegExp, readonly [number, number, number]]> = [
  [/fable-5-1|mythos-5-1/, [10, 50, 0.25]],
  [/fable|mythos/, [10, 50, 1]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus-(5|4-[5-8])/, [5, 25, 0.5]],
  [/opus/, [15, 75, 1.5]],
  [/sonnet-5/, [2, 10, 0.2]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-4/, [1, 5, 0.1]],
  [/haiku-3-5/, [0.8, 4, 0.08]],
  [/haiku/, [0.25, 1.25, 0.03]],
];
const OPUS: readonly [number, number, number] = [5, 25, 0.5];
const WEB_SEARCH_USD = 0.01;

export function priceOf(model: string): readonly [number, number, number] {
  const name = model.toLowerCase();
  return PRICES.find(([pattern]) => pattern.test(name))?.[1] ?? OPUS;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** One assistant message's tokens, priced. */
export function usageOfMessage(model: string, raw: unknown): Usage {
  const usage = record(raw) ?? {};
  const input = count(usage["input_tokens"]);
  const output = count(usage["output_tokens"]);
  const cacheWrite = count(usage["cache_creation_input_tokens"]);
  const hour = Math.min(cacheWrite, count(record(usage["cache_creation"])?.["ephemeral_1h_input_tokens"]));
  const cacheRead = count(usage["cache_read_input_tokens"]);
  const searches = count(record(usage["server_tool_use"])?.["web_search_requests"]);
  const [perInput, perOutput, perRead] = priceOf(model);
  const costUsd =
    (input * perInput + output * perOutput + (cacheWrite - hour) * perInput * 1.25 + hour * perInput * 2 + cacheRead * perRead) / 1e6 +
    searches * WEB_SEARCH_USD;
  return { input, output, cacheWrite, cacheRead, costUsd, calls: 1 };
}

interface FileCursor {
  /** Bytes of the file already read, always at a line boundary. */
  offset: number;
  /** A message with several content blocks is logged once per block, with the same id and usage. */
  lastId: string | undefined;
  lastUsage: Usage | undefined;
}

/** A model id as a session logs it; Claude Code's own placeholder messages (`<synthetic>`) are not one. */
const MODEL_ID = /^[\w.:/@[\]-]{1,120}$/;

/** Read at a time; a line longer than this is read in larger pieces, up to {@link MAX_LINE_BYTES}. */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** Longer than any line a transcript writes; one past it is skipped, rather than read into memory whole. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * One session's running cost: told its transcript by the session's hooks, it
 * reads what was appended each time it is scanned.
 */
export class TranscriptMeter {
  private transcript: string | undefined;
  private readonly files = new Map<string, FileCursor>();
  /** Claude Code's own tally from the end of a session; `at` is the transcript time it covers up to. */
  private base: { readonly usage: Usage; readonly at: number } | undefined;
  /** Estimated from the messages logged after {@link base}. */
  private since: Usage = ZERO_USAGE;
  /** The latest transcript timestamp seen. */
  private at = 0;

  /**
   * The session's transcript, as a hook names it. Only an absolute `.jsonl`
   * path is taken: the meter reads whatever it is pointed at.
   */
  public follow(transcript: string): void {
    if (isAbsolute(transcript) && transcript.endsWith(".jsonl")) {
      this.transcript = transcript;
    }
  }

  /** Everything the session has cost so far. */
  public usage(): Usage {
    return this.base === undefined ? this.since : addUsage(this.base.usage, this.since);
  }

  /** Reads whatever was appended to the session's transcripts. Says whether the total changed. */
  public scan(): boolean {
    if (this.transcript === undefined) {
      return false;
    }
    let changed = false;
    for (const file of [this.transcript, ...subagentFiles(this.transcript)]) {
      let cursor = this.files.get(file);
      if (cursor === undefined) {
        cursor = { offset: 0, lastId: undefined, lastUsage: undefined };
        this.files.set(file, cursor);
      }
      for (const line of readNewLines(file, cursor)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        changed = this.apply(cursor, parsed) || changed;
      }
    }
    return changed;
  }

  private apply(cursor: FileCursor, raw: unknown): boolean {
    const line = record(raw);
    if (line === undefined) {
      return false;
    }
    const at = typeof line["timestamp"] === "string" ? Date.parse(line["timestamp"]) : Number.NaN;
    if (at > this.at) {
      this.at = at;
    }
    if (line["type"] === "assistant") {
      const message = record(line["message"]);
      if (message === undefined || typeof message["id"] !== "string" || message["usage"] === undefined) {
        return false;
      }
      // Already inside Claude Code's own tally.
      if (this.base !== undefined && at <= this.base.at) {
        return false;
      }
      const model = typeof message["model"] === "string" && MODEL_ID.test(message["model"]) ? message["model"] : "";
      const usage = usageOfMessage(model, message["usage"]);
      const delta = cursor.lastId === message["id"] && cursor.lastUsage !== undefined ? addUsage(usage, cursor.lastUsage, -1) : usage;
      cursor.lastId = message["id"];
      cursor.lastUsage = usage;
      if (isZero(delta)) {
        return false;
      }
      this.since = addUsage(this.since, delta);
      return true;
    }
    const models = record(line["modelUsage"]);
    if (line["type"] === "cost-state" && typeof line["totalCostUSD"] === "number" && models !== undefined && line["hasUnknownModelCost"] !== true) {
      let input = 0;
      let output = 0;
      let cacheWrite = 0;
      let cacheRead = 0;
      for (const value of Object.values(models)) {
        const model = record(value);
        if (model === undefined) {
          continue;
        }
        input += count(model["inputTokens"]);
        output += count(model["outputTokens"]);
        cacheWrite += count(model["cacheCreationInputTokens"]);
        cacheRead += count(model["cacheReadInputTokens"]);
      }
      const calls = this.usage().calls;
      this.base = { usage: { input, output, cacheWrite, cacheRead, costUsd: count(line["totalCostUSD"]), calls }, at: this.at };
      this.since = ZERO_USAGE;
      return true;
    }
    return false;
  }
}

/** Subagents' transcripts live in `<transcript dir>/<session id>/subagents/`. */
function subagentFiles(transcript: string): string[] {
  const dir = join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

/** Complete lines appended since the cursor; a half-written last line waits for the next read. */
function* readNewLines(file: string, cursor: FileCursor): Generator<string> {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return;
  }
  try {
    const size = fstatSync(fd).size;
    if (size < cursor.offset) {
      // Shorter than last time: not the file it was. Start over.
      cursor.offset = 0;
      cursor.lastId = undefined;
      cursor.lastUsage = undefined;
    }
    let want = CHUNK_BYTES;
    while (cursor.offset < size) {
      const length = Math.min(want, size - cursor.offset);
      const buffer = Buffer.allocUnsafe(length);
      let got = 0;
      while (got < length) {
        const read = readSync(fd, buffer, got, length - got, cursor.offset + got);
        if (read <= 0) {
          break;
        }
        got += read;
      }
      if (got === 0) {
        return;
      }
      const end = buffer.lastIndexOf(10, got - 1);
      if (end < 0) {
        if (got >= MAX_LINE_BYTES) {
          // No transcript line is this long: skip it, and read on from what follows it.
          cursor.offset += got;
          want = CHUNK_BYTES;
          continue;
        }
        if (got < size - cursor.offset) {
          // One line longer than the chunk: read more of it.
          want *= 2;
          continue;
        }
        // The tail is still being written.
        return;
      }
      const text = buffer.toString("utf8", 0, end);
      cursor.offset += end + 1;
      want = CHUNK_BYTES;
      for (const line of text.split("\n")) {
        if (line !== "") {
          yield line;
        }
      }
    }
  } finally {
    closeSync(fd);
  }
}
