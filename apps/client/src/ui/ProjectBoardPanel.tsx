/**
 * The lobby board's close-up view: the full lists, as readable HUD text.
 *
 * The wall board is sized to be read across the lobby, which means big type
 * and few rows. Walking up to it opens this panel, which shows everything the
 * snapshot carries. It closes again when the player steps away; `main.ts`
 * decides when with the shared range check, so there is no button to find.
 *
 * Every string is a React text node, from a snapshot the server sanitized, so
 * an issue title containing markup is shown rather than interpreted.
 */

import type { ProjectBoardSnapshot } from "@sim/shared";

import { boardColumns, boardStatus, formatClockTime, formatShortDate } from "../projectBoard.js";

export function ProjectBoardPanel({ snapshot }: { snapshot: ProjectBoardSnapshot | undefined }) {
  const status = boardStatus(snapshot, formatClockTime);
  const columns = snapshot === undefined ? [] : boardColumns(snapshot, formatShortDate);

  return (
    <section className="board" aria-label="Project board">
      <header className="board__header">
        <h2 className="board__title">
          Project board
          {snapshot === undefined ? null : <span className="board__repo">{snapshot.repository}</span>}
        </h2>
        <p className={status.stale ? "board__status board__status--stale" : "board__status"}>{status.text}</p>
      </header>
      <div className="board__columns">
        {columns.map((column) => (
          <div className="board__column" key={column.key}>
            <h3 className="board__columnTitle">
              {column.title} <span className="board__count">{column.total}</span>
            </h3>
            {column.rows.length === 0 ? (
              <p className="board__empty">Nothing here</p>
            ) : (
              <ol className="board__rows">
                {column.rows.map((row) => (
                  <li className="board__row" key={row.key}>
                    <span className="board__label">{row.label}</span> {row.title}
                    {row.detail === "" ? null : (
                      <span className={`board__detail board__detail--${row.tone}`}>{row.detail}</span>
                    )}
                  </li>
                ))}
                {column.total > column.rows.length ? (
                  <li className="board__more">+{column.total - column.rows.length} more on GitHub</li>
                ) : null}
              </ol>
            )}
          </div>
        ))}
      </div>
      <p className="board__hint">Step back from the board to close this.</p>
    </section>
  );
}
