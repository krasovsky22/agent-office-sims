/**
 * Which slot works in which worktree, kept in the data dir so a restarted
 * runner knows its worktrees again.
 *
 * A task gets a worktree as it starts and gives it up as it ends: removed
 * when nothing in it would be lost, kept otherwise with the reason logged,
 * and handed back to the same slot if the same issue comes to it again. A
 * runner that restarts finds the worktrees its last run left mid-task and
 * settles them the same way; anything else in its worktrees dir is a stray,
 * reported and left alone, since the runner cannot vouch for it.
 *
 * Each slot's opens and closes run one after another, so a task stopped while
 * its worktree is still being made gives it up only once it is there.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { SlotWorkspaces } from "./slots.js";
import { type WorktreeRef, type Worktrees, gitError } from "./worktrees.js";

/** One worktree the runner owns; its folder and branch follow from these, see `Worktrees.refFor`. */
export interface WorktreeRecord {
  readonly slotId: string;
  readonly issueNumber: number;
  /** The commit it was branched from. */
  readonly base: string;
}

interface StateFile {
  readonly worktrees: readonly WorktreeRecord[];
}

/** What a slot id must look like to be read back from the state file. */
const SLOT_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface SlotWorktreesOptions {
  readonly worktrees: Worktrees;
  /** The JSON file the records live in. */
  readonly stateFile: string;
  readonly log?: (line: string) => void;
}

export class SlotWorktrees implements SlotWorkspaces {
  private records: WorktreeRecord[];
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly log: (line: string) => void;

  public constructor(private readonly options: SlotWorktreesOptions) {
    this.log = options.log ?? (() => undefined);
    this.records = this.read();
  }

  /** The worktrees the runner owns now. */
  public current(): readonly WorktreeRecord[] {
    return this.records;
  }

  /**
   * At boot: makes the clone if it is missing, settles the worktrees the last
   * run left, and reports strays. Never throws; what went wrong is logged,
   * and a missing clone is made again on the first start.
   */
  public async reattach(): Promise<{ reattached: WorktreeRecord[]; strays: string[] }> {
    const { worktrees } = this.options;
    try {
      await worktrees.ready();
      const listed = await worktrees.list();
      const registered = new Set(listed.worktrees.map((worktree) => worktree.path));
      const reattached: WorktreeRecord[] = [];
      for (const record of [...this.records]) {
        if (registered.has(this.refOf(record).path)) {
          reattached.push(record);
        } else {
          // Its folder went while the runner was down; a branch with work left
          // on it is checked out again if the task comes back, see `Worktrees.create`.
          this.log(`${record.slotId}'s worktree for #${record.issueNumber} is gone; forgetting it`);
          this.forget(record);
        }
      }
      if (reattached.length > 0) {
        this.log(`re-attached ${reattached.map((record) => `${record.slotId} to #${record.issueNumber}`).join(", ")}`);
      }
      const owned = new Set(this.records.map((record) => this.refOf(record).path));
      const ownedBranches = new Set(this.records.map((record) => this.refOf(record).branch));
      const checkedOut = new Set(listed.worktrees.map((worktree) => worktree.branch));
      const strays = [
        ...listed.worktrees.filter((worktree) => !owned.has(worktree.path)).map((worktree) => worktree.path),
        ...listed.strays,
        ...listed.branches.filter((branch) => !ownedBranches.has(branch) && !checkedOut.has(branch)),
      ];
      if (strays.length > 0) {
        this.log(`left alone, not the runner's to remove: ${strays.join(", ")}`);
      }
      // Nothing works in them now: a task the restart cut short ends here.
      await Promise.all(reattached.map((record) => this.chain(record.slotId, () => this.settle(record))));
      return { reattached, strays };
    } catch (error) {
      this.log(`could not check the worktrees: ${gitError(error)}`);
      return { reattached: [], strays: [] };
    }
  }

  /**
   * A working directory for a task: the worktree this slot kept for this issue
   * if there is one, else a new one from what origin has now.
   */
  public open(slotId: string, issueNumber: number): Promise<string> {
    return this.chain(slotId, async () => {
      const kept = this.find(slotId, issueNumber);
      if (kept !== undefined && existsSync(this.refOf(kept).path)) {
        const ref = this.refOf(kept);
        this.log(`${slotId} picks up its kept worktree for #${issueNumber} at ${ref.path}, on ${ref.branch}`);
        return ref.path;
      }
      if (kept !== undefined) {
        this.forget(kept);
      }
      const { worktrees } = this.options;
      await worktrees.ready();
      await worktrees.fetch();
      const made = await worktrees.create(issueNumber, slotId);
      this.records.push({ slotId, issueNumber, base: made.base });
      this.write();
      this.log(`${slotId} made a worktree for #${issueNumber} at ${made.path}, on ${made.branch} from ${made.base.slice(0, 12)}`);
      return made.path;
    });
  }

  /** A task is over: its worktree goes when nothing in it would be lost, and stays, saying why, when something would. */
  public close(slotId: string, issueNumber: number): Promise<void> {
    return this.chain(slotId, async () => {
      const record = this.find(slotId, issueNumber);
      if (record !== undefined) {
        await this.settle(record);
      }
    }).catch((error: unknown) => {
      this.log(`${slotId} could not give up its worktree for #${issueNumber}: ${(error as Error).message}`);
    });
  }

  /** Waits for every open and close under way, as the runner shuts down. */
  public async settled(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  private async settle(record: WorktreeRecord): Promise<void> {
    const { worktrees } = this.options;
    const ref = this.refOf(record);
    const lose = await worktrees.wouldLose(ref);
    if (lose !== "") {
      this.log(`${record.slotId} keeps its worktree for #${record.issueNumber} at ${ref.path}: ${lose}`);
      return;
    }
    const failed = await worktrees.remove(ref);
    if (failed !== undefined) {
      this.log(`${record.slotId} could not remove its worktree for #${record.issueNumber} at ${ref.path}: ${failed}`);
      return;
    }
    this.forget(record);
    this.log(`${record.slotId} removed its worktree for #${record.issueNumber}: nothing in it to keep`);
  }

  /** Runs `step` after every earlier step for the same slot, whether or not those succeeded. */
  private chain<T>(slotId: string, step: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(slotId) ?? Promise.resolve()).then(step);
    const tail = result.catch(() => undefined);
    this.chains.set(slotId, tail);
    void tail.then(() => {
      if (this.chains.get(slotId) === tail) {
        this.chains.delete(slotId);
      }
    });
    return result;
  }

  private refOf(record: WorktreeRecord): WorktreeRef {
    return this.options.worktrees.refFor(record.issueNumber, record.slotId);
  }

  private find(slotId: string, issueNumber: number): WorktreeRecord | undefined {
    return this.records.find((record) => record.slotId === slotId && record.issueNumber === issueNumber);
  }

  private forget(record: WorktreeRecord): void {
    this.records = this.records.filter((candidate) => candidate !== record);
    this.write();
  }

  /** The records the last run wrote. An unreadable file is logged and read as none: their worktrees then show as strays, never as the runner's to remove. */
  private read(): WorktreeRecord[] {
    const { stateFile } = this.options;
    if (!existsSync(stateFile)) {
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<StateFile> | null;
      const raw: unknown[] = Array.isArray(parsed?.worktrees) ? parsed.worktrees : [];
      return raw.flatMap((item): WorktreeRecord[] => {
        const { slotId, issueNumber, base } = (item ?? {}) as Record<string, unknown>;
        return typeof slotId === "string" &&
          SLOT_ID.test(slotId) &&
          typeof issueNumber === "number" &&
          Number.isSafeInteger(issueNumber) &&
          issueNumber > 0 &&
          typeof base === "string"
          ? [{ slotId, issueNumber, base }]
          : [];
      });
    } catch (error) {
      this.log(`could not read ${stateFile}, so no worktree is known to be the runner's: ${(error as Error).message}`);
      return [];
    }
  }

  /** Written whole and moved into place, so a runner killed mid-write leaves the last good file. */
  private write(): void {
    const { stateFile } = this.options;
    const state: StateFile = { worktrees: this.records };
    const partial = `${stateFile}.partial`;
    writeFileSync(partial, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(partial, stateFile);
  }
}
