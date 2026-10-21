/**
 * The microphone beside a message field: press to dictate into the field,
 * press again to stop early. It only ever changes the draft; sending stays the
 * field's own Send button and Enter (see `dictation.ts`).
 */

import { type Dispatch, type RefObject, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";

import { appendTranscript, speechRecognition, startDictation } from "../dictation.js";
import { timedNotice } from "../timedNotice.js";

const NOTICE_MS = 5000;

export function MicButton({
  inputRef,
  setDraft,
  maxLength,
  disabled = false,
}: {
  inputRef: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  setDraft: Dispatch<SetStateAction<string>>;
  maxLength: number;
  disabled?: boolean;
}) {
  const Recognition = useMemo(() => speechRecognition(), []);
  const stopRef = useRef<(() => void) | undefined>(undefined);
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const showNotice = useMemo(() => timedNotice(setNotice, NOTICE_MS), []);

  // A panel closing mid-sentence takes the microphone with it.
  useEffect(() => () => stopRef.current?.(), []);

  const toggle = () => {
    if (Recognition === undefined) {
      return;
    }
    if (stopRef.current !== undefined) {
      stopRef.current();
      return;
    }
    // The field keeps focus while listening, so the keys it is given stay
    // letters and never walk the avatar.
    inputRef.current?.focus();
    setNotice(undefined);
    setListening(true);
    stopRef.current = startDictation(Recognition, {
      heard: (transcript) => setDraft((draft) => appendTranscript(draft, transcript, maxLength)),
      ended: () => {
        stopRef.current = undefined;
        setListening(false);
      },
      failed: showNotice,
    });
  };

  const label =
    Recognition === undefined
      ? "Dictation needs a browser with speech recognition, such as Chrome, Edge or Safari"
      : listening
        ? "Listening… press to stop"
        : "Dictate into this field";

  return (
    <span className="hud__mic">
      <button
        className={listening ? "hud__send hud__micButton hud__micButton--on" : "hud__send hud__micButton"}
        type="button"
        title={label}
        aria-label={label}
        aria-pressed={listening}
        disabled={disabled || Recognition === undefined}
        // Pressing the button would otherwise take focus from the field.
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
      >
        <span aria-hidden="true">{listening ? "●" : "🎤"}</span>
      </button>
      {notice === undefined ? null : (
        <span className="hud__notice hud__micNotice" role="alert">
          {notice}
        </span>
      )}
    </span>
  );
}
