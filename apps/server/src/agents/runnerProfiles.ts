/**
 * The server's own copy of the CEO's edits to the runners' agents' profiles:
 * `<SERVER_DATA_DIR>/agent-profiles.json`.
 *
 * The runner keeps a profile once it has one (`apps/runner/src/profiles.ts`),
 * but an edit is only a queued command in this process until the runner's
 * next sync takes it. A server stopped in that window lost the edit, and a
 * runner that came back without its own file (a new data directory, another
 * machine under the same id) went back to its defaults. Kept here as well,
 * the runner link can give the edit to the runner again whenever its sync
 * reports something else (`./runnerLink.ts`).
 *
 * Kept by runner id and slot id, as the runner keeps its own by slot id.
 * Written whole and moved into place, so a server killed mid-write leaves the
 * last good file. Read defensively: an entry the contract would not take is
 * dropped with the reason logged, and an unreadable file is read as nothing
 * kept, which the log says, rather than stopping the server. Nothing here
 * writes to GitHub.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type AgentProfile, asRecord, isRunnerName, parseAgentProfile, sanitizeName } from "@sim/shared";

/** A profile as the CEO edited it, with who did, so the runner hears it again in the same words. */
export interface KeptProfile extends AgentProfile {
  readonly requestedBy: string;
}

/** What the runner link needs of wherever the edits are kept. */
export interface RunnerProfiles {
  /** The edit kept for a runner's slot, if the CEO made one. */
  get(runnerId: string, slotId: string): KeptProfile | undefined;
  /** Keeps an edit, replacing the one kept for that slot. */
  keep(runnerId: string, slotId: string, profile: KeptProfile): void;
  /** Drops the one kept for a slot that never came to be. */
  forget(runnerId: string, slotId: string): void;
}

/** Kept in memory alone: for tests, and a server given nowhere to write. */
export class MemoryRunnerProfiles implements RunnerProfiles {
  protected readonly kept = new Map<string, Map<string, KeptProfile>>();

  public get(runnerId: string, slotId: string): KeptProfile | undefined {
    return this.kept.get(runnerId)?.get(slotId);
  }

  public keep(runnerId: string, slotId: string, profile: KeptProfile): void {
    let slots = this.kept.get(runnerId);
    if (slots === undefined) {
      slots = new Map();
      this.kept.set(runnerId, slots);
    }
    slots.set(slotId, profile);
  }

  public forget(runnerId: string, slotId: string): void {
    this.kept.get(runnerId)?.delete(slotId);
  }
}

export interface RunnerProfileFileOptions {
  /** `<SERVER_DATA_DIR>/agent-profiles.json`. */
  readonly file: string;
  readonly log?: (line: string) => void;
}

export class RunnerProfileFile extends MemoryRunnerProfiles {
  private readonly log: (line: string) => void;

  public constructor(private readonly options: RunnerProfileFileOptions) {
    super();
    this.log = options.log ?? (() => undefined);
    this.load();
  }

  public override keep(runnerId: string, slotId: string, profile: KeptProfile): void {
    super.keep(runnerId, slotId, profile);
    this.save();
  }

  public override forget(runnerId: string, slotId: string): void {
    super.forget(runnerId, slotId);
    this.save();
  }

  private load(): void {
    const { file } = this.options;
    if (!existsSync(file)) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      this.log(`could not read ${file}, so no profile edit is kept: ${(error as Error).message}`);
      return;
    }
    const runners = asRecord(asRecord(raw)?.["runners"]);
    for (const [runnerId, value] of Object.entries(runners ?? {})) {
      for (const [slotId, entry] of Object.entries(asRecord(value) ?? {})) {
        const profile = parseAgentProfile(entry);
        if (!isRunnerName(runnerId) || !isRunnerName(slotId) || profile === undefined) {
          this.log(`dropped the profile kept for ${JSON.stringify(`${runnerId}/${slotId}`)} from ${file}: it is not one the server takes`);
          continue;
        }
        super.keep(runnerId, slotId, { ...profile, requestedBy: sanitizeName(asRecord(entry)?.["requestedBy"]) });
      }
    }
  }

  /** Written whole and moved into place, readable by the server's user alone. */
  private save(): void {
    const { file } = this.options;
    const partial = `${file}.partial`;
    const runners = Object.fromEntries([...this.kept].map(([runnerId, slots]) => [runnerId, Object.fromEntries(slots)]));
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(partial, `${JSON.stringify({ runners }, null, 2)}\n`, { mode: 0o600 });
      renameSync(partial, file);
    } catch (error) {
      this.log(`could not save the agents' profiles to ${file}: ${(error as Error).message}`);
    }
  }
}
