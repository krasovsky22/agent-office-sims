/**
 * The project board's close-up view: the full lists, as readable HUD text,
 * with a search and label filters over them.
 *
 * The wall board is sized to be read across the open floor, which means big
 * type and few rows. Walking up to it and pressing `E` at the proximity prompt
 * opens this panel over most of the screen, which shows everything the
 * snapshot carries and narrows it by text or by label. `E` again, or stepping
 * out of reach, closes it; `main.ts` decides both.
 *
 * The filter lives and dies with this panel, so every visit to the board starts
 * unfiltered. It narrows only this tab's view: the wall board everyone sees
 * stays whole.
 *
 * Each issue and pull request links to its page on GitHub in a new tab, so a
 * card read here is one click from the discussion behind it.
 *
 * Every string is a React text node, from a snapshot the server sanitized, so
 * an issue title containing markup is shown rather than interpreted.
 */

import type { BoardLabel, ProjectBoardSnapshot } from "@sim/shared";
import { useEffect, useRef, useState } from "react";

import { isTypingTarget } from "../keys.js";
import {
  type BoardColumnKey,
  type BoardFilter,
  NO_BOARD_FILTER,
  boardColumns,
  boardLabels,
  boardStatus,
  filterBoardColumns,
  formatClockTime,
  formatShortDate,
  isFiltering,
  labelColours,
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

export function ProjectBoardPanel({ snapshot }: { snapshot: ProjectBoardSnapshot | undefined }) {
  const [filter, setFilter] = useState<BoardFilter>(NO_BOARD_FILTER);
  const searchRef = useRef<HTMLInputElement>(null);

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
      <div className="board__columns">
        {columns.map((column) => {
          const unsearched = column.total - (snapshot === undefined ? 0 : carried(snapshot, column.key));
          return (
            <div className="board__column" key={column.key}>
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
                  {column.rows.map((row) => (
                    <li className="board__row" key={row.key}>
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
                    </li>
                  ))}
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
      <p className="board__hint">
        <span className="hud__keys">{SEARCH_KEY}</span> to search · step back from the board to close this.
      </p>
    </section>
  );
}

/** How many of a column's items the snapshot actually carries, before any filter. */
function carried(snapshot: ProjectBoardSnapshot, key: BoardColumnKey): number {
  return snapshot[key].length;
}
