/**
 * Where the runner keeps the slots the CEO changed the pool by:
 * `<RUNNER_DATA_DIR>/fired.json`, the slots whose agents were fired, and
 * `<RUNNER_DATA_DIR>/hired.json`, the slots the AI Manager hired agents into,
 * each private to the runner's user.
 *
 * A fired slot stays out of the pool across a restart of the runner, so a
 * firing is for good; deleting the file, or a slot's id from it, hires the
 * agent back at the next start. A hired slot comes back into the pool at the
 * next start, after the configured ones, unless it was fired since. Written
 * whole and moved into place, as the profiles are, and read defensively: an
 * id the contract would not take is dropped, and an unreadable file is read as
 * holding nobody, which the log says.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { isRunnerName } from "@sim/shared";

/** What the slots need of wherever a list of slots is kept. */
export interface SlotIds {
  /** Every slot kept, by id, in the order they were kept. */
  load(): ReadonlySet<string>;
  /** Keeps these slots, by id, replacing what was kept. */
  save(slotIds: ReadonlySet<string>): void;
}

export interface SlotIdStoreOptions {
  /** `<RUNNER_DATA_DIR>/fired.json` or `<RUNNER_DATA_DIR>/hired.json`. */
  readonly file: string;
  /** Which list the file holds, which is also its one key. */
  readonly list: "fired" | "hired";
  readonly log?: (line: string) => void;
}

export class SlotIdStore implements SlotIds {
  private readonly log: (line: string) => void;

  public constructor(private readonly options: SlotIdStoreOptions) {
    this.log = options.log ?? (() => undefined);
  }

  public load(): ReadonlySet<string> {
    const { file, list } = this.options;
    if (!existsSync(file)) {
      return new Set();
    }
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> | null;
      const value = raw?.[list];
      const ids: unknown[] = Array.isArray(value) ? value : [];
      return new Set(ids.filter(isRunnerName));
    } catch (error) {
      this.log(`could not read ${file}, so no agent is taken to be ${list}: ${(error as Error).message}`);
      return new Set();
    }
  }

  /** Written whole and moved into place, readable by the runner's user alone. */
  public save(slotIds: ReadonlySet<string>): void {
    const { file, list } = this.options;
    const partial = `${file}.partial`;
    try {
      writeFileSync(partial, `${JSON.stringify({ [list]: [...slotIds] }, null, 2)}\n`, { mode: 0o600 });
      renameSync(partial, file);
    } catch (error) {
      this.log(`could not save the ${list} agents to ${file}: ${(error as Error).message}`);
    }
  }
}
