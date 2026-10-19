/**
 * Where the runner keeps its agents' profiles between runs:
 * `<RUNNER_DATA_DIR>/profiles.json`, private to the runner's user.
 *
 * A profile is the name, title and description the CEO gave a slot's agent
 * from the office (`@sim/shared`'s `agentProfile.ts`); a slot with none kept
 * has its default. Kept by slot id, so an agent keeps its profile across a
 * restart of the runner or the server, and a slot added later starts with its
 * default.
 *
 * Written whole and moved into place, as the standing tasks are, so a runner
 * killed mid-write leaves the last good file. Read defensively: a profile the
 * contract would not take is dropped with the reason logged, and an
 * unreadable file is read as none kept, which the log says, rather than
 * stopping the runner.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { type AgentProfile, isRunnerName, parseAgentProfile } from "@sim/shared";

export interface ProfileStoreOptions {
  /** `<RUNNER_DATA_DIR>/profiles.json`. */
  readonly file: string;
  readonly log?: (line: string) => void;
}

/** What the slots need of wherever profiles are kept. */
export interface AgentProfiles {
  /** Every profile kept, by slot id. */
  load(): ReadonlyMap<string, AgentProfile>;
  /** Keeps the profiles the CEO edited, by slot id, replacing what was kept. */
  save(profiles: ReadonlyMap<string, AgentProfile>): void;
}

export class ProfileStore implements AgentProfiles {
  private readonly log: (line: string) => void;

  public constructor(private readonly options: ProfileStoreOptions) {
    this.log = options.log ?? (() => undefined);
  }

  public load(): ReadonlyMap<string, AgentProfile> {
    const { file } = this.options;
    const profiles = new Map<string, AgentProfile>();
    if (!existsSync(file)) {
      return profiles;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      this.log(`could not read ${file}, so every agent starts with its default profile: ${(error as Error).message}`);
      return profiles;
    }
    const slots = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["slots"] : undefined;
    if (typeof slots !== "object" || slots === null || Array.isArray(slots)) {
      return profiles;
    }
    for (const [slotId, value] of Object.entries(slots)) {
      const profile = parseAgentProfile(value);
      if (!isRunnerName(slotId) || profile === undefined) {
        this.log(`dropped the profile kept for ${JSON.stringify(slotId)} from ${file}: it is not one this runner takes`);
        continue;
      }
      profiles.set(slotId, profile);
    }
    return profiles;
  }

  /** Written whole and moved into place, readable by the runner's user alone. */
  public save(profiles: ReadonlyMap<string, AgentProfile>): void {
    const { file } = this.options;
    const partial = `${file}.partial`;
    try {
      writeFileSync(partial, `${JSON.stringify({ slots: Object.fromEntries(profiles) }, null, 2)}\n`, { mode: 0o600 });
      renameSync(partial, file);
    } catch (error) {
      this.log(`could not save the agents' profiles to ${file}: ${(error as Error).message}`);
    }
  }
}
