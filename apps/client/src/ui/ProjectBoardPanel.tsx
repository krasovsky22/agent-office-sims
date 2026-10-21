/**
 * The project board's close-up view: the full lists, as readable HUD text,
 * with a search and label filters over them.
 *
 * The wall board is sized to be read across the open floor, which means big
 * type and few rows. Walking up to it and pressing `E` at the proximity prompt
 * opens this panel over most of the screen, which shows everything the
 * snapshot carries and narrows it by text or by label. `E` again, or stepping
 * out of reach, closes it; `gameLoop.ts` decides both.
 *
 * The filter lives and dies with this panel, so every visit to the board starts
 * unfiltered. It narrows only this tab's view: the wall board everyone sees
 * stays whole.
 *
 * Each issue and pull request links to its page on GitHub in a new tab, so a
 * card read here is one click from the discussion behind it.
 *
 * The open issues are the work the office's agents do, so an issue an agent has
 * says who and how far they have got, and opening its detail shows the agent's
 * note and deliverable. The CEO's controls live in that detail: hand the issue
 * to an agent, approve the work, send it back. What is offered comes from
 * `boardAccess.ts`, so the panel never shows a move the server will refuse,
 * and an executive sees the same detail with no controls. None of it writes to
 * GitHub.
 *
 * The one thing that does is dragging. The CEO can pick an issue card up and
 * drop it on Closed to close the issue on GitHub, or a closed one on Open to
 * reopen it, which a connected agent runner does with its own GitHub
 * identity; dropping an open issue on In progress opens its detail to choose
 * the agent, as its assign button does, and once given the card stays there. `boardDrop` in `projectBoard.ts`
 * decides which column takes which card. A dropped card shows in its new
 * column at once, from the moves `pendingIssueMoves.ts` keeps, and goes back with the
 * reason, said here on the board, if GitHub does not take it.
 *
 * Every string is a React text node, from a snapshot or state the server
 * sanitized, so an issue title containing markup is shown rather than
 * interpreted.
 */

import {
  type BoardLabel,
  type IssueState,
  type ProjectBoardSnapshot,
  WORK_ACTION,
  type WorkData,
  type WorkStatus,
  isWorkStopped,
} from "@sim/shared";
import { useEffect, useRef, useState } from "react";

import type { BoardAccess } from "../boardAccess.js";
import { isTypingTarget } from "../keys.js";
import {
  type BoardAgent,
  type BoardColumnKey,
  type BoardFilter,
  type IssueMove,
  NO_BOARD_FILTER,
  assignOption,
  boardColumns,
  boardDrop,
  boardIssue,
  boardLabels,
  boardStatus,
  filterBoardColumns,
  formatClockTime,
  formatShortDate,
  githubItemUrl,
  isFiltering,
  labelColours,
  workAgentName,
  workBadge,
  workMoveLabel,
  workStatusText,
  withIssueMoves,
  withOfficeWork,
} from "../projectBoard.js";

/** The key that puts the cursor in the search field, as `Enter` does for chat. */
const SEARCH_KEY = "/";

function LabelChip({ label }: { label: BoardLabel }) {
  const { fill, text } = labelColours(label);
  return (
    <span className="board__chip" style={{ backgroundColor: fill, color: text }}>
      {label.name}
    </span>
  );
}

/** What the CEO's controls send; the replicated work is the reply. */
export interface ProjectBoardActions {
  readonly assign: (issueNumber: number, agentId: string) => void;
  readonly move: (issueNumber: number, status: WorkStatus) => void;
  readonly release: (issueNumber: number) => void;
  /** Closes or reopens the issue on GitHub; `pendingIssueMoves.ts` shows the move until GitHub's answer. */
  readonly setIssueState: (issueNumber: number, state: IssueState) => void;
}

interface ProjectBoardPanelProps {
  readonly snapshot: ProjectBoardSnapshot | undefined;
  /** The office's work on the board's issues, in no particular order. */
  readonly work: readonly WorkData[];
  /** Who an issue can be given to, and so who the board names as having one. */
  readonly agents: readonly BoardAgent[];
  /** `undefined` before the local player has joined, when nothing is offered. */
  readonly access: BoardAccess | undefined;
  /** Cards this player dropped on Closed or Open that the snapshot does not show there yet. */
  readonly moves: readonly IssueMove[];
  /** Why the latest dropped card went back, if one did. */
  readonly notice: string | undefined;
  readonly actions: ProjectBoardActions;
}

/** The card being dragged, and the column it was picked up from. */
interface DraggedCard {
  readonly issueNumber: number;
  readonly from: BoardColumnKey;
}

export function ProjectBoardPanel({
  snapshot: received,
  work,
  agents,
  access,
  moves,
  notice,
  actions,
}: ProjectBoardPanelProps) {
  const [filter, setFilter] = useState<BoardFilter>(NO_BOARD_FILTER);
  const [openIssue, setOpenIssue] = useState<number | undefined>(undefined);
  const [dragged, setDragged] = useState<DraggedCard | undefined>(undefined);
  // Read by the drag events themselves, which can follow `dragstart` before
  // React has rendered the state it set.
  const draggedRef = useRef<DraggedCard | undefined>(undefined);
  const [dropColumn, setDropColumn] = useState<BoardColumnKey | undefined>(undefined);
  // Every list, count and detail below reads the board with this player's
  // unanswered drops already made, so a dropped card is where it was put, and
  // with the office's work placed, as the wall board shows it.
  const snapshot =
    received === undefined
      ? undefined
      : withOfficeWork(moves.length === 0 ? received : withIssueMoves(received, moves, Date.now()), work);
  const moving = new Set(moves.map((move) => move.issueNumber));
  const searchRef = useRef<HTMLInputElement>(null);

  // The pointer lock swallows clicks, so a player who walked up while looking
  // around could not reach the links or label toggles. Closing does not take the
  // lock back: a click on the canvas does that, as it always has.
  useEffect(() => {
    if (document.pointerLockElement !== null) {
      document.exitPointerLock();
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== SEARCH_KEY || isTypingTarget(event.target) || event.repeat) {
        return;
      }
      event.preventDefault();
      // The pointer lock swallows clicks, so a player looking around could not
      // otherwise reach the field.
      if (document.pointerLockElement !== null) {
        document.exitPointerLock();
      }
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const status = boardStatus(snapshot, formatClockTime);
  const labels = snapshot === undefined ? [] : boardLabels(snapshot, filter.labels);
  const filtering = isFiltering(filter);
  const columns =
    snapshot === undefined ? [] : filterBoardColumns(boardColumns(snapshot, formatShortDate), filter);

  const workOn = (issueNumber: number | null) =>
    issueNumber === null ? undefined : work.find((entry) => entry.issueNumber === issueNumber);
  // Looked up on every render, so the detail tracks the live issue and work.
  const detailIssue = openIssue === undefined ? undefined : boardIssue(snapshot, openIssue);
  const detailWork = openIssue === undefined ? undefined : workOn(openIssue);
  const detailOpen = openIssue !== undefined && (detailIssue !== undefined || detailWork !== undefined);

  const dropOf = (card: DraggedCard | undefined, to: BoardColumnKey) =>
    card === undefined || access === undefined
      ? undefined
      : boardDrop(card.from, to, {
          mayChangeState: access.mayChangeIssueState,
          mayAssign: access.mayAssign,
          hasWork: workOn(card.issueNumber) !== undefined,
        });
  const endDrag = () => {
    draggedRef.current = undefined;
    setDragged(undefined);
    setDropColumn(undefined);
  };
  const drop = (to: BoardColumnKey) => {
    const card = draggedRef.current;
    const action = dropOf(card, to);
    endDrag();
    if (card === undefined || action === undefined) {
      return;
    }
    if (action.kind === "state") {
      actions.setIssueState(card.issueNumber, action.state);
    } else {
      setOpenIssue(card.issueNumber);
    }
  };
  // Whether a card can be picked up at all: by someone with a column to put it in.
  const draggable = (from: BoardColumnKey, issueNumber: number | null): issueNumber is number =>
    issueNumber !== null &&
    !moving.has(issueNumber) &&
    (["open", "inProgress", "closed"] as const).some((to) => dropOf({ issueNumber, from }, to) !== undefined);

  const toggleLabel = (name: string) => {
    const next = new Set(filter.labels);
    if (!next.delete(name)) {
      next.add(name);
    }
    setFilter({ ...filter, labels: next });
  };

  return (
    <section className="board" aria-label="Project board">
      <header className="board__header">
        <h2 className="board__title">
          Project board
          {snapshot === undefined ? null : <span className="board__repo">{snapshot.repository}</span>}
        </h2>
        <p className={status.stale ? "board__status board__status--stale" : "board__status"}>{status.text}</p>
      </header>
      {notice === undefined ? null : (
        <p className="board__notice" role="alert">
          {notice}
        </p>
      )}
      <div className="board__filters">
        <input
          ref={searchRef}
          className="board__search"
          type="search"
          name="board-search"
          value={filter.query}
          placeholder="Search tickets — number, title, label, person…"
          aria-label="Search tickets"
          autoComplete="off"
          onChange={(event) => setFilter({ ...filter, query: event.target.value })}
          onKeyDown={(event) => {
            // Either key hands the keyboard back to walking; the search stays.
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              searchRef.current?.blur();
            }
          }}
        />
        {labels.length === 0 ? null : (
          <ul className="board__labels" aria-label="Filter by label">
            {labels.map((label) => {
              const selected = filter.labels.has(label.name);
              const { fill, text } = labelColours(label);
              return (
                <li key={label.name}>
                  <button
                    className={selected ? "board__labelToggle board__labelToggle--on" : "board__labelToggle"}
                    type="button"
                    aria-pressed={selected}
                    style={selected ? { backgroundColor: fill, color: text, borderColor: fill } : { borderColor: fill }}
                    // Blurred on the way out, so the next Enter or Space goes to
                    // the game rather than toggling this again.
                    onClick={(event) => {
                      event.currentTarget.blur();
                      toggleLabel(label.name);
                    }}
                  >
                    {label.name}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {filtering ? (
          <button
            className="board__clear"
            type="button"
            onClick={(event) => {
              event.currentTarget.blur();
              setFilter(NO_BOARD_FILTER);
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
      <div className={detailOpen ? "work__body work__body--detail" : "work__body"}>
      <div className="board__columns">
        {columns.map((column) => {
          const unsearched = column.total - (snapshot === undefined ? 0 : carried(snapshot, column.key));
          const takes = dragged !== undefined && dropOf(dragged, column.key) !== undefined;
          const columnClass = [
            "board__column",
            takes ? "board__column--takes" : "",
            takes && dropColumn === column.key ? "board__column--over" : "",
          ]
            .filter((name) => name !== "")
            .join(" ");
          return (
            <div
              className={columnClass}
              key={column.key}
              onDragOver={(event) => {
                if (dropOf(draggedRef.current, column.key) === undefined) {
                  return;
                }
                // Cancelling the default is what tells the browser this column takes the drop.
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropColumn(column.key);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDropColumn((current) => (current === column.key ? undefined : current));
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                drop(column.key);
              }}
            >
              <h3 className="board__columnTitle">
                {column.title}{" "}
                <span className="board__count">
                  {filtering ? `${column.rows.length} of ${column.total}` : column.total}
                </span>
              </h3>
              {column.rows.length === 0 ? (
                <p className="board__empty">{filtering ? "No matches" : "Nothing here"}</p>
              ) : (
                <ol className="board__rows">
                  {column.rows.map((row) => {
                    const issueNumber = row.issueNumber;
                    const canDrag = draggable(column.key, issueNumber);
                    const rowClass = [
                      "board__row",
                      canDrag ? "board__row--draggable" : "",
                      issueNumber !== null && moving.has(issueNumber) ? "board__row--moving" : "",
                      issueNumber !== null && dragged?.issueNumber === issueNumber ? "board__row--dragged" : "",
                    ]
                      .filter((name) => name !== "")
                      .join(" ");
                    return (
                      <li
                        className={rowClass}
                        key={row.key}
                        draggable={canDrag}
                        onDragStart={(event) => {
                          if (!canDrag) {
                            event.preventDefault();
                            return;
                          }
                          event.dataTransfer.effectAllowed = "move";
                          // Some browsers start no drag without data; the number is all it is.
                          event.dataTransfer.setData("text/plain", `#${issueNumber}`);
                          draggedRef.current = { issueNumber, from: column.key };
                          setDragged(draggedRef.current);
                        }}
                        onDragEnd={endDrag}
                      >
                        {row.url === null ? (
                          <>
                            <span className="board__label">{row.label}</span> {row.title}
                          </>
                        ) : (
                          <a
                            className="board__link"
                            href={row.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            // A drag that starts on the title moves the card, not the link.
                            draggable={false}
                            // Blurred like the label toggles, so a later Enter goes
                            // to the game instead of opening the tab again.
                            onClick={(event) => event.currentTarget.blur()}
                          >
                            <span className="board__label">{row.label}</span> {row.title}
                          </a>
                        )}
                        {row.labels.length === 0 ? null : (
                          <span className="board__chips">
                            {row.labels.map((label) => (
                              <LabelChip key={label.name} label={label} />
                            ))}
                          </span>
                        )}
                        {row.detail === "" ? null : (
                          <span className={`board__detail board__detail--${row.tone}`}>{row.detail}</span>
                        )}
                        <RowWork
                          issueNumber={row.issueNumber}
                          work={workOn(row.issueNumber)}
                          agents={agents}
                          assignable={column.key !== "closed" && access?.mayAssign === true}
                          open={row.issueNumber !== null && row.issueNumber === openIssue}
                          onToggle={(issueNumber) => setOpenIssue(issueNumber === openIssue ? undefined : issueNumber)}
                          onRestart={actions.assign}
                        />
                      </li>
                    );
                  })}
                </ol>
              )}
              {unsearched > 0 ? (
                <p className="board__more">
                  +{unsearched} more on GitHub{filtering ? ", not searched" : ""}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {!detailOpen || openIssue === undefined ? null : (
        <IssueDetail
          key={openIssue}
          issueNumber={openIssue}
          title={detailIssue?.title ?? detailWork?.title ?? ""}
          body={detailIssue?.body ?? ""}
          url={snapshot === undefined ? null : githubItemUrl(snapshot.repository, "issues", openIssue)}
          open={detailIssue !== undefined && detailIssue.closedAt === null}
          work={detailWork}
          allWork={work}
          agents={agents}
          access={access}
          actions={actions}
          onClose={() => setOpenIssue(undefined)}
        />
      )}
      </div>
      <p className="board__hint">
        <span className="hud__keys">{SEARCH_KEY}</span> to search
        {access?.mayChangeIssueState === true
          ? " · drag a card to Closed to close it on GitHub, or back to Open to reopen it"
          : ""}
        {access?.mayAssign === true ? " · drop an open issue on In progress to assign it" : ""} · step back from the board
        to close this.
      </p>
      {access?.issueStateNote === undefined ? null : <p className="board__hint">{access.issueStateNote}</p>}
    </section>
  );
}

/** How many of a column's items the snapshot actually carries, before any filter. */
function carried(snapshot: ProjectBoardSnapshot, key: BoardColumnKey): number {
  return snapshot[key].length;
}

/**
 * What an issue card says about the office's work on it, and the button that
 * opens its detail: offered when there is work to read, or to the CEO on an
 * open issue nobody has yet. Stopped work also offers the CEO "Start again":
 * the same agent is given it again, which restarts its slot from scratch.
 */
function RowWork({
  issueNumber,
  work,
  agents,
  assignable,
  open,
  onToggle,
  onRestart,
}: {
  issueNumber: number | null;
  work: WorkData | undefined;
  agents: readonly BoardAgent[];
  assignable: boolean;
  open: boolean;
  onToggle: (issueNumber: number) => void;
  onRestart: (issueNumber: number, agentId: string) => void;
}) {
  if (issueNumber === null || (work === undefined && !assignable)) {
    return null;
  }
  const badge = work === undefined ? undefined : workBadge(work, agents);
  return (
    <span className="work__row">
      {badge === undefined ? null : (
        <span className={`board__detail board__detail--${badge.tone} work__badge`}>{badge.text}</span>
      )}
      <button
        className={open ? "panel__button work__open work__open--on" : "panel__button work__open"}
        type="button"
        aria-pressed={open}
        // Blurred like the label toggles, so the next key goes to the game.
        onClick={(event) => {
          event.currentTarget.blur();
          onToggle(issueNumber);
        }}
      >
        {work === undefined ? "Assign…" : "Work"}
      </button>
      {work === undefined || !assignable || !isWorkStopped(work) ? null : (
        <button
          className="panel__button work__restart"
          type="button"
          onClick={(event) => {
            event.currentTarget.blur();
            onRestart(issueNumber, work.assigneeId);
          }}
        >
          Start again
        </button>
      )}
    </span>
  );
}

/**
 * One issue up close: its description, what the office is doing about it, and
 * the CEO's controls. Every control comes from `boardAccess.ts`.
 */
function IssueDetail({
  issueNumber,
  title,
  body,
  url,
  open,
  work,
  allWork,
  agents,
  access,
  actions,
  onClose,
}: {
  issueNumber: number;
  title: string;
  body: string;
  url: string | null;
  open: boolean;
  work: WorkData | undefined;
  /** The office's work on every issue, so the picker can tell who is busy. */
  allWork: readonly WorkData[];
  agents: readonly BoardAgent[];
  access: BoardAccess | undefined;
  actions: ProjectBoardActions;
  onClose: () => void;
}) {
  const moves = work === undefined ? [] : (access?.movesFor(work, agents) ?? []);
  return (
    <aside className="work__detail" aria-label="Issue detail">
      <header className="board__header">
        <h3 className="work__detailTitle">
          {url === null ? (
            `#${issueNumber} ${title}`
          ) : (
            <a className="board__link" href={url} target="_blank" rel="noopener noreferrer">
              <span className="board__label">#{issueNumber}</span> {title}
            </a>
          )}
        </h3>
        <button
          className="panel__button"
          type="button"
          onClick={(event) => {
            event.currentTarget.blur();
            onClose();
          }}
        >
          Back
        </button>
      </header>
      <dl className="work__facts">
        <dt>Work</dt>
        <dd>{work === undefined ? "Nobody in the office has it" : workStatusText(work)}</dd>
        {work === undefined ? null : (
          <>
            <dt>Agent</dt>
            <dd>{workAgentName(work, agents)}</dd>
          </>
        )}
      </dl>
      {work === undefined || work.note === "" ? null : <p className="work__text work__note">{work.note}</p>}
      {body === "" ? <p className="board__empty">No description on GitHub.</p> : <p className="work__text">{body}</p>}
      {work === undefined || work.outputArtifact === "" ? null : (
        <>
          <h4 className="board__columnTitle">Deliverable</h4>
          <p className="work__text work__artifact">{work.outputArtifact}</p>
        </>
      )}
      {work === undefined && open && access?.mayAssign === true ? (
        <AssignPicker agents={agents} work={allWork} onAssign={(agentId) => actions.assign(issueNumber, agentId)} />
      ) : null}
      {moves.length === 0 || work === undefined ? null : (
        <div className="work__moves">
          {moves.map((move) => (
            <button
              key={move.action === WORK_ACTION.release ? "release" : move.to}
              className="panel__button"
              type="button"
              onClick={(event) => {
                event.currentTarget.blur();
                if (move.action === WORK_ACTION.release) {
                  actions.release(issueNumber);
                } else {
                  actions.move(issueNumber, move.to);
                }
              }}
            >
              {workMoveLabel(move, work)}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

/**
 * Who to give an issue to.
 *
 * Offers only the agents the server will take — the live agents that can take
 * issues, with those busy on another issue shown but disabled — and re-checks
 * the choice against them as they stand when sent: an agent picked and then
 * gone, or since put to work, is no longer one the server will take.
 */
function AssignPicker({
  agents,
  work,
  onAssign,
}: {
  agents: readonly BoardAgent[];
  work: readonly WorkData[];
  onAssign: (agentId: string) => void;
}) {
  const [choice, setChoice] = useState("");
  const options = agents.map((agent) => ({ agent, ...assignOption(agent, work) }));
  const present = options.some((option) => option.agent.id === choice && !option.busy);
  if (agents.length === 0) {
    return <p className="board__empty">No agent in the office can take an issue right now.</p>;
  }
  return (
    <div className="work__assign">
      <select
        className="hud__input"
        name="work-assignee"
        aria-label="Agent"
        value={present ? choice : ""}
        onChange={(event) => setChoice(event.target.value)}
        onKeyDown={(event) => {
          // Hands the keyboard back to walking, as the search field does.
          if (event.key === "Escape") {
            event.currentTarget.blur();
          }
        }}
      >
        <option value="" disabled>
          Give it to…
        </option>
        {options.map(({ agent, label, busy }) => (
          <option key={agent.id} value={agent.id} disabled={busy}>
            {label}
          </option>
        ))}
      </select>
      <button
        className="panel__button"
        type="button"
        disabled={!present}
        onClick={(event) => {
          event.currentTarget.blur();
          onAssign(choice);
        }}
      >
        Assign
      </button>
    </div>
  );
}
