/**
 * A coding agent's profile, opened from its line in the roster: its name,
 * title and description, which its runner gives the agent as its system
 * prompt.
 *
 * Everyone can read it. The CEO also gets a form for it, offered exactly when
 * the server would take the edit (`agentProfileAccess.ts`); anyone else is told
 * why not. A saved edit goes to the agent's runner, which keeps it and reports
 * it back, so the card says it is saving until the roster shows the new
 * profile, or the server's refusal arrives. Either way the card says plainly
 * that an edit applies from the agent's next session, never the one it is in.
 */

import {
  type AgentProfile,
  MAX_AGENT_DESCRIPTION_BYTES,
  MAX_AGENT_TITLE_BYTES,
  MAX_NAME_LENGTH,
} from "@sim/shared";
import { useEffect, useState } from "react";

import { type AgentProfileAccess, PROFILE_TAKES_EFFECT, profileDraft } from "../agentProfileAccess.js";
import type { RosterEntry } from "./hudStore.js";

export interface AgentProfileActions {
  /** Asks for the agent's profile to be edited; the server sanitises it and decides. Says whether it went out at all. */
  readonly save: (agentId: string, profile: AgentProfile) => boolean;
}

/** Why the local player's last edit was not passed on, numbered so the same words twice still count as news. */
export interface AgentProfileNotice {
  readonly id: number;
  readonly agentId: string;
  readonly text: string;
}

/** How long a saved edit waits for the runner to report it before the card stops saying it is saving. */
const SAVE_TIMEOUT_MS = 15_000;

function sameProfile(entry: RosterEntry, profile: AgentProfile): boolean {
  return entry.name === profile.name && entry.title === profile.title && entry.description === profile.description;
}

export function AgentProfileCard({
  entry,
  access,
  notice,
  actions,
}: {
  entry: RosterEntry;
  access: AgentProfileAccess | undefined;
  notice: AgentProfileNotice | undefined;
  actions: AgentProfileActions;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry.name);
  const [title, setTitle] = useState(entry.title);
  const [description, setDescription] = useState(entry.description);
  const [saving, setSaving] = useState<{ readonly profile: AgentProfile; readonly noticeId: number } | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const mayEdit = access?.mayEdit === true;
  const refused = notice !== undefined && notice.agentId === entry.id && notice.id > (saving?.noticeId ?? Number.POSITIVE_INFINITY);

  // Settled by the runner reporting the profile back, or by the server's refusal.
  useEffect(() => {
    if (saving === undefined) {
      return;
    }
    if (sameProfile(entry, saving.profile)) {
      setSaving(undefined);
      setEditing(false);
    } else if (refused) {
      setSaving(undefined);
      setProblem(notice?.text);
    }
  }, [entry, saving, refused, notice]);

  useEffect(() => {
    if (saving === undefined) {
      return;
    }
    const timer = window.setTimeout(() => {
      setSaving(undefined);
      setProblem("The runner has not reported the new profile yet; it may be offline. Check back shortly.");
    }, SAVE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [saving]);

  const open = () => {
    setName(entry.name);
    setTitle(entry.title);
    setDescription(entry.description);
    setProblem(undefined);
    setEditing(true);
  };

  const submit = () => {
    if (!mayEdit || saving !== undefined) {
      return;
    }
    const draft = profileDraft({ name, title, description });
    if (!draft.ok) {
      setProblem(draft.reason);
      return;
    }
    setProblem(undefined);
    if (sameProfile(entry, draft.profile)) {
      setEditing(false);
      return;
    }
    if (actions.save(entry.id, draft.profile)) {
      setSaving({ profile: draft.profile, noticeId: notice?.id ?? 0 });
    } else {
      setProblem("Not connected; the edit was not sent.");
    }
  };

  return (
    <div className="hud__profile" aria-label={`${entry.name}'s profile`}>
      {editing && mayEdit ? (
        <form
          className="hud__profile-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="hud__profile-field">
            <span className="hud__profile-label">Name</span>
            <input
              className="hud__input"
              name="agent-name"
              value={name}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="off"
              disabled={saving !== undefined}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="hud__profile-field">
            <span className="hud__profile-label">Title</span>
            <input
              className="hud__input"
              name="agent-title"
              value={title}
              maxLength={MAX_AGENT_TITLE_BYTES}
              autoComplete="off"
              disabled={saving !== undefined}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="hud__profile-field">
            <span className="hud__profile-label">Description</span>
            <textarea
              className="hud__input hud__profile-description"
              name="agent-description"
              rows={4}
              value={description}
              maxLength={MAX_AGENT_DESCRIPTION_BYTES}
              disabled={saving !== undefined}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <span className="hud__profile-buttons">
            <button className="hud__send" type="submit" disabled={saving !== undefined}>
              {saving === undefined ? "Save" : "Saving…"}
            </button>
            <button
              className="hud__standing-button"
              type="button"
              disabled={saving !== undefined}
              onClick={() => {
                setProblem(undefined);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </span>
        </form>
      ) : (
        <>
          <span className="hud__profile-title">{entry.title === "" ? "No title" : entry.title}</span>
          {entry.description === "" ? null : <p className="hud__profile-text">{entry.description}</p>}
          {mayEdit ? (
            <button className="hud__standing-button" type="button" onClick={open}>
              Edit profile
            </button>
          ) : access === undefined ? null : (
            <span className="hud__task">{access.summary}</span>
          )}
        </>
      )}
      {problem === undefined ? null : (
        <p className="hud__notice" role="alert">
          {problem}
        </p>
      )}
      <p className="hud__profile-note">{PROFILE_TAKES_EFFECT}</p>
    </div>
  );
}
