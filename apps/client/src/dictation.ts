/**
 * Speaking into a text field instead of typing into it.
 *
 * The browser's own speech recognition does the listening, so dictation costs
 * no server, key or money, and it only exists where the browser has it (Chrome,
 * Edge and Safari at the time of writing). What it hears is written into the
 * field's draft and nothing more: the player still reads it and presses Send,
 * because a misheard sentence sent to an agent is work done on the wrong thing.
 */

/** The slice of the Web Speech API's `SpeechRecognition` this uses; TypeScript's DOM lib has none. */
export interface Recognizer {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface RecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }> & { readonly isFinal: boolean }>;
}

export type RecognizerConstructor = new () => Recognizer;

/** The browser's recognizer, under either of its names, or `undefined` where it has none. */
export function speechRecognition(scope: object = globalThis): RecognizerConstructor | undefined {
  const named = scope as { SpeechRecognition?: RecognizerConstructor; webkitSpeechRecognition?: RecognizerConstructor };
  return named.SpeechRecognition ?? named.webkitSpeechRecognition;
}

/** The draft with what was said after it, spaced, and cut to what the field accepts. */
export function appendTranscript(draft: string, transcript: string, maxLength: number): string {
  const said = transcript.trim();
  if (said === "") {
    return draft;
  }
  const joined = draft === "" || /\s$/.test(draft) ? draft + said : `${draft} ${said}`;
  return joined.slice(0, maxLength);
}

/** What the player is told when listening fails, or `undefined` when there is nothing to say. */
export function dictationError(error: string): string | undefined {
  switch (error) {
    case "aborted":
      return undefined;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow it for this site to dictate.";
    case "audio-capture":
      return "No microphone was found.";
    case "no-speech":
      return "Didn't hear anything. Try again.";
    case "network":
      return "Dictation needs a network connection.";
    default:
      return `Dictation stopped (${error}).`;
  }
}

export interface DictationHandlers {
  /** A finished phrase; the caller appends it to the field's draft. */
  heard: (transcript: string) => void;
  /** Listening is over, by `stop`, by silence, or by an error. */
  ended: () => void;
  /** Something went wrong that the player should hear about. */
  failed: (message: string) => void;
}

/**
 * Listens for one utterance: the recognizer stops by itself at the first
 * pause, which is the "silence stops it" behaviour. Only finished phrases are
 * passed on, so the field never holds a guess that is about to change.
 *
 * @returns what stops listening early.
 */
export function startDictation(Recognition: RecognizerConstructor, handlers: DictationHandlers): () => void {
  const recognizer = new Recognition();
  recognizer.continuous = false;
  recognizer.interimResults = false;
  recognizer.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result?.isFinal === true) {
        handlers.heard(result[0]?.transcript ?? "");
      }
    }
  };
  recognizer.onerror = (event) => {
    const message = dictationError(event.error);
    if (message !== undefined) {
      handlers.failed(message);
    }
  };
  recognizer.onend = handlers.ended;
  try {
    recognizer.start();
  } catch {
    handlers.failed("Dictation could not start.");
    handlers.ended();
  }
  return () => recognizer.stop();
}
