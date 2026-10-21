/**
 * A brainstorm ticket up close on the project board: who is researching it
 * and what each wrote, its design document, and the controls for the steps
 * after, in place of an ordinary issue's work.
 *
 * The CEO hands an idea to several agents at once, in a mode; anyone reads
 * the document, the CEO gathers its agents in the meeting room, and anyone
 * marks it reviewed and converts it into implementation issues drafted from
 * it, edited here before they are created. Whether each control is open, and
 * why not, comes from `brainstormBoard.ts`, so the panel never offers what the
 * server will refuse. None of it writes to GitHub itself: a runner posts the
 * document and creates the issues.
 *
 * Every string is a React text node from state the server sanitized, so a
 * write-up holding markup is shown, not interpreted.
 */

import {
  BRAINSTORM_ACTION,
  BRAINSTORM_MODE,
  BRAINSTORM_STATUS,
  BRAINSTORM_TAKE_STATUS,
  type BoardIssue,
  type BrainstormData,
  type BrainstormDraft,
  type BrainstormMode,
  MAX_BRAINSTORM_AGENTS,
  MAX_BRAINSTORM_DRAFTS,
  MAX_DRAFT_BODY_LENGTH,
  MAX_DRAFT_TITLE_LENGTH,
  designDocument,
  draftIssues,
} from "@sim/shared";
import { useState } from "react";

import type { BoardAccess } from "../boardAccess.js";
import {
  type BrainstormBoardActions,
  type BrainstormChoice,
  brainstormActionBlock,
  brainstormAssignBlock,
  postLine,
  takeLine,
} from "../brainstormBoard.js";

/** A button that blurs itself once pressed, so the next key goes to the game, as the board's do. */
function PanelButton({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <button
      className="panel__button"
      type="button"
      disabled={disabled === true}
      onClick={(event) => {
        event.currentTarget.blur();
        onPress();
      }}
    >
      {label}
    </button>
  );
}

export function BrainstormDetail({
  issueNumber,
  issue,
  open,
  brainstorm,
  brainstorms,
  hasWork,
  restrictLabel,
  choices,
  standupActive,
  access,
  actions,
}: {
  issueNumber: number;
  issue: Pick<BoardIssue, "labels"> | undefined;
  /** Whether the issue is open on the board. */
  open: boolean;
  brainstorm: BrainstormData | undefined;
  brainstorms: readonly BrainstormData[];
  hasWork: boolean;
  restrictLabel: string;
  choices: readonly BrainstormChoice[];
  standupActive: boolean;
  access: BoardAccess | undefined;
  actions: BrainstormBoardActions;
}) {
  const [converting, setConverting] = useState(false);
  const handOut = brainstorm === undefined || brainstorm.status === BRAINSTORM_STATUS.failed;
  const view = { standupActive, brainstorms, choices };
  const block = (action: (typeof BRAINSTORM_ACTION)[keyof typeof BRAINSTORM_ACTION]) =>
    brainstorm === undefined || access === undefined ? "" : brainstormActionBlock(action, access, brainstorm, view);
  const written =
    brainstorm !== undefined &&
    brainstorm.status !== BRAINSTORM_STATUS.researching &&
    brainstorm.status !== BRAINSTORM_STATUS.synthesizing &&
    brainstorm.status !== BRAINSTORM_STATUS.failed;
  return (
    <div className="brainstorm">
      <p className="work__text">
        A brainstorm ticket: several agents research it and write no code. Their write-ups make one design document to
        review, then turn into implementation issues.
      </p>
      {brainstorm === undefined || brainstorm.note === "" ? null : <p className="work__text work__note">{brainstorm.note}</p>}
      {brainstorm === undefined ? null : (
        <ol className="brainstorm__takes" aria-label="Write-ups">
          {brainstorm.takes.map((take) => (
            <li key={take.agentId}>
              {take.status === BRAINSTORM_TAKE_STATUS.done ? (
                <details>
                  <summary>{takeLine(take)}</summary>
                  <p className="work__text">{take.text}</p>
                </details>
              ) : (
                takeLine(take)
              )}
            </li>
          ))}
        </ol>
      )}
      {handOut && open && access?.mayAssign === true ? (
        <BrainstormAssign
          issueNumber={issueNumber}
          choices={choices}
          block={(picked) =>
            brainstormAssignBlock(access, { issue, restrictLabel, existing: brainstorm, hasWork }, picked, choices)
          }
          onAssign={actions.assign}
        />
      ) : null}
      {!written || brainstorm === undefined ? null : (
        <>
          <details className="brainstorm__doc" open>
            <summary className="board__columnTitle">Design document</summary>
            <p className="work__text">{designDocument(brainstorm)}</p>
          </details>
          {postLine(brainstorm) === undefined ? null : <p className="board__hint">{postLine(brainstorm)}</p>}
        </>
      )}
      {brainstorm === undefined || brainstorm.created.length === 0 ? null : (
        <p className="work__text">
          Converted into{" "}
          {brainstorm.created.map((created, index) => (
            <span key={created.number}>
              {index === 0 ? "" : ", "}
              <a className="board__link" href={created.url} target="_blank" rel="noopener noreferrer">
                #{created.number}
              </a>
            </span>
          ))}
          .
        </p>
      )}
      {!written || brainstorm === undefined || brainstorm.status === BRAINSTORM_STATUS.converted ? null : (
        <div className="work__moves">
          <PanelButton label="Discuss in meeting room" disabled={block(BRAINSTORM_ACTION.meet) !== undefined} onPress={() => actions.meet(issueNumber)} />
          {brainstorm.status === BRAINSTORM_STATUS.ready ? (
            <PanelButton label="Mark reviewed" disabled={block(BRAINSTORM_ACTION.review) !== undefined} onPress={() => actions.review(issueNumber)} />
          ) : null}
          {brainstorm.status === BRAINSTORM_STATUS.reviewed && !converting ? (
            <PanelButton label="Convert…" disabled={block(BRAINSTORM_ACTION.convert) !== undefined} onPress={() => setConverting(true)} />
          ) : null}
        </div>
      )}
      {written && brainstorm !== undefined ? (
        <p className="board__hint">
          {[block(BRAINSTORM_ACTION.meet), brainstorm.status === BRAINSTORM_STATUS.reviewed ? block(BRAINSTORM_ACTION.convert) : undefined]
            .filter((reason): reason is string => reason !== undefined && reason !== "")
            .join(" ")}
        </p>
      ) : null}
      {converting && brainstorm !== undefined && brainstorm.status === BRAINSTORM_STATUS.reviewed ? (
        <ConvertEditor
          brainstorm={brainstorm}
          onCancel={() => setConverting(false)}
          onCreate={(drafts) => {
            actions.convert(issueNumber, drafts);
            setConverting(false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Which agents to give the idea to, in which mode. In the critics' mode the
 * first agent picked researches and the rest review it, so the picks are
 * numbered in the order they were made.
 */
function BrainstormAssign({
  issueNumber,
  choices,
  block,
  onAssign,
}: {
  issueNumber: number;
  choices: readonly BrainstormChoice[];
  block: (picked: readonly string[]) => string | undefined;
  onAssign: (issueNumber: number, agentIds: readonly string[], mode: BrainstormMode) => void;
}) {
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [mode, setMode] = useState<BrainstormMode>(BRAINSTORM_MODE.takes);
  // Only those still offered: an agent picked and since put to work, or gone, drops out.
  const live = picked.filter((id) => choices.some((choice) => choice.agent.id === id && !choice.busy));
  const reason = block(live);
  if (choices.length === 0) {
    return <p className="board__empty">No agent in the office can take an issue right now.</p>;
  }
  return (
    <fieldset className="brainstorm__assign">
      <legend className="board__columnTitle">Hand it to agents</legend>
      {choices.map(({ agent, label, busy }) => {
        const order = live.indexOf(agent.id);
        return (
          <label key={agent.id} className="brainstorm__choice">
            <input
              type="checkbox"
              name="brainstorm-agent"
              checked={order !== -1}
              disabled={busy || (order === -1 && live.length >= MAX_BRAINSTORM_AGENTS)}
              onChange={(event) =>
                setPicked(event.target.checked ? [...live, agent.id] : live.filter((id) => id !== agent.id))
              }
            />{" "}
            {label}
            {order === -1 || mode !== BRAINSTORM_MODE.critics ? "" : order === 0 ? " — researcher" : " — critic"}
          </label>
        );
      })}
      <label className="brainstorm__choice">
        <input type="radio" name="brainstorm-mode" checked={mode === BRAINSTORM_MODE.takes} onChange={() => setMode(BRAINSTORM_MODE.takes)} />{" "}
        Each writes a take of its own
      </label>
      <label className="brainstorm__choice">
        <input type="radio" name="brainstorm-mode" checked={mode === BRAINSTORM_MODE.critics} onChange={() => setMode(BRAINSTORM_MODE.critics)} />{" "}
        The first picked researches, the others review and challenge it
      </label>
      <PanelButton label="Start research" disabled={reason !== undefined} onPress={() => onAssign(issueNumber, live, mode)} />
      {reason === undefined ? null : <p className="board__hint">{reason}</p>}
    </fieldset>
  );
}

/**
 * The implementation issues to create from a reviewed idea, drafted from its
 * design document and edited here: one to start with, more added for a
 * recommendation that is several features.
 */
function ConvertEditor({
  brainstorm,
  onCancel,
  onCreate,
}: {
  brainstorm: BrainstormData;
  onCancel: () => void;
  onCreate: (drafts: readonly BrainstormDraft[]) => void;
}) {
  const [drafts, setDrafts] = useState<readonly BrainstormDraft[]>(() => draftIssues(brainstorm));
  const change = (index: number, next: Partial<BrainstormDraft>) =>
    setDrafts(drafts.map((draft, at) => (at === index ? { ...draft, ...next } : draft)));
  const titled = drafts.every((draft) => draft.title.trim() !== "");
  return (
    <div className="brainstorm__convert">
      <h4 className="board__columnTitle">Issues to create</h4>
      {drafts.map((draft, index) => (
        <div key={index} className="brainstorm__draft">
          <input
            className="hud__input"
            name={`brainstorm-draft-title-${index}`}
            aria-label={`Issue ${index + 1} title`}
            value={draft.title}
            maxLength={MAX_DRAFT_TITLE_LENGTH}
            onChange={(event) => change(index, { title: event.target.value })}
          />
          <textarea
            className="hud__input brainstorm__body"
            name={`brainstorm-draft-body-${index}`}
            aria-label={`Issue ${index + 1} description`}
            rows={8}
            value={draft.body}
            maxLength={MAX_DRAFT_BODY_LENGTH}
            onChange={(event) => change(index, { body: event.target.value })}
          />
          {drafts.length === 1 ? null : (
            <PanelButton label="Remove" onPress={() => setDrafts(drafts.filter((_, at) => at !== index))} />
          )}
        </div>
      ))}
      <div className="work__moves">
        {drafts.length >= MAX_BRAINSTORM_DRAFTS ? null : (
          <PanelButton label="Add another issue" onPress={() => setDrafts([...drafts, { title: "", body: "" }])} />
        )}
        <PanelButton
          label={drafts.length === 1 ? "Create the issue" : `Create ${drafts.length} issues`}
          disabled={!titled}
          onPress={() => onCreate(drafts)}
        />
        <PanelButton label="Cancel" onPress={onCancel} />
      </div>
      <p className="board__hint">
        A runner creates them on GitHub, then closes #{brainstorm.issueNumber} with links to them. Hand them out from the
        board to build them.
      </p>
    </div>
  );
}
