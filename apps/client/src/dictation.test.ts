/**
 * Dictation writes what was said into the draft and nothing else: these drive
 * it with a stand-in recognizer, since Vitest has no microphone.
 */

import { describe, expect, it, vi } from "vitest";

import {
  type RecognitionResultEvent,
  type Recognizer,
  appendTranscript,
  dictationError,
  speechRecognition,
  startDictation,
} from "./dictation.js";

class FakeRecognizer implements Recognizer {
  static last: FakeRecognizer | undefined;
  continuous = true;
  interimResults = true;
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  onerror: ((event: { readonly error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());

  constructor() {
    FakeRecognizer.last = this;
  }

  say(transcript: string, isFinal = true): void {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript }], { isFinal })] });
  }
}

function dictate() {
  const handlers = { heard: vi.fn(), ended: vi.fn(), failed: vi.fn() };
  const stop = startDictation(FakeRecognizer, handlers);
  const recognizer = FakeRecognizer.last;
  if (recognizer === undefined) {
    throw new Error("no recognizer was made");
  }
  return { handlers, stop, recognizer };
}

describe("appendTranscript", () => {
  it("adds what was said after the draft with one space", () => {
    expect(appendTranscript("", " put Ada on twelve ", 100)).toBe("put Ada on twelve");
    expect(appendTranscript("hello", "world", 100)).toBe("hello world");
    expect(appendTranscript("hello ", "world", 100)).toBe("hello world");
  });

  it("keeps the draft when nothing was said, and stops at the field's length", () => {
    expect(appendTranscript("hello", "  ", 100)).toBe("hello");
    expect(appendTranscript("hello", "world", 8)).toBe("hello wo");
  });
});

describe("startDictation", () => {
  it("listens for one utterance and passes on only finished phrases", () => {
    const { handlers, recognizer } = dictate();
    expect(recognizer.start).toHaveBeenCalledOnce();
    expect(recognizer.continuous).toBe(false);
    expect(recognizer.interimResults).toBe(false);

    recognizer.say("put", false);
    recognizer.say("put Ada on twelve");
    expect(handlers.heard.mock.calls).toEqual([["put Ada on twelve"]]);
  });

  // There is no send handler to call: what was heard can only reach the draft.
  it("fills the draft when the recognizer ends, leaving sending to the player", () => {
    let draft = "hi";
    const failed = vi.fn();
    startDictation(FakeRecognizer, {
      heard: (transcript) => {
        draft = appendTranscript(draft, transcript, 100);
      },
      ended: vi.fn(),
      failed,
    });
    FakeRecognizer.last?.say("there");
    FakeRecognizer.last?.onend?.();
    expect(draft).toBe("hi there");
    expect(failed).not.toHaveBeenCalled();
  });

  it("stops early when asked", () => {
    const { handlers, stop, recognizer } = dictate();
    stop();
    expect(recognizer.stop).toHaveBeenCalledOnce();
    expect(handlers.ended).toHaveBeenCalledOnce();
  });

  it("says why when the microphone is refused, and nothing for an abort", () => {
    const { handlers, recognizer } = dictate();
    recognizer.onerror?.({ error: "aborted" });
    expect(handlers.failed).not.toHaveBeenCalled();
    recognizer.onerror?.({ error: "not-allowed" });
    expect(handlers.failed).toHaveBeenCalledWith(dictationError("not-allowed"));
  });

  it("ends at once when the recognizer will not start", () => {
    class Broken extends FakeRecognizer {
      override start = vi.fn(() => {
        throw new Error("InvalidStateError");
      });
    }
    const handlers = { heard: vi.fn(), ended: vi.fn(), failed: vi.fn() };
    startDictation(Broken, handlers);
    expect(handlers.failed).toHaveBeenCalledOnce();
    expect(handlers.ended).toHaveBeenCalledOnce();
  });
});

describe("speechRecognition", () => {
  it("finds the recognizer under either name, and none where the browser has none", () => {
    expect(speechRecognition({ webkitSpeechRecognition: FakeRecognizer })).toBe(FakeRecognizer);
    expect(speechRecognition({ SpeechRecognition: FakeRecognizer })).toBe(FakeRecognizer);
    expect(speechRecognition({})).toBeUndefined();
  });
});
