/**
 * Where the runner keeps the slots whose agents the CEO fired:
 * `<RUNNER_DATA_DIR>/fired.json`, private to the runner's user.
 *
 * A fired slot stays out of the pool across a restart of the runner, so a
 * firing is for good; deleting the file, or a slot's id from it, hires the
 * agent back at the next start. Written whole and moved into place, as the
 * profiles are, and read defensively: an id the contract would not take is
 * dropped, and an unreadable file is read as nobody fired, which the log says.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { isRunnerName } from "@sim/shared";

/** What the slots need of wherever the fired slots are kept. */
export interface FiredSlots {
  /** Every slot fired, by id. */
  load(): ReadonlySet<string>;
  /** Keeps the fired slots, by id, replacing what was kept. */
  save(slotIds: ReadonlySet<string>): void;
}

export interface FiredSlotStoreOptions {
  /** `<RUNNER_DATA_DIR>/fired.json`. */
  readonly file: string;
  readonly log?: (line: string) => void;
}

export class FiredSlotStore implements FiredSlots {
  private readonly log: (line: string) => void;

  public constructor(private readonly options: FiredSlotStoreOptions) {
    this.log = options.log ?? (() => undefined);
  }

  public load(): ReadonlySet<string> {
    const { file } = this.options;
    if (!existsSync(file)) {
      return new Set();
    }
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { fired?: unknown } | null;
      const ids: unknown[] = Array.isArray(raw?.fired) ? raw.fired : [];
      return new Set(ids.filter(isRunnerName));
    } catch (error) {
      this.log(`could not read ${file}, so no agent is taken to be fired: ${(error as Error).message}`);
      return new Set();
    }
  }

  /** Written whole and moved into place, readable by the runner's user alone. */
  public save(slotIds: ReadonlySet<string>): void {
    const { file } = this.options;
    const partial = `${file}.partial`;
    try {
      writeFileSync(partial, `${JSON.stringify({ fired: [...slotIds].sort() }, null, 2)}\n`, { mode: 0o600 });
      renameSync(partial, file);
    } catch (error) {
      this.log(`could not save the fired agents to ${file}: ${(error as Error).message}`);
    }
  }
}
