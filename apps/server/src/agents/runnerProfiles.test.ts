/**
 * The server's copy of the CEO's profile edits: the file it keeps them in,
 * and the runner link giving a runner one again until it reports it.
 *
 * The regression this guards: an edit was only a queued command in the
 * server's memory until the runner's next sync, so a server stopped in that
 * window lost it, and the agent kept its old profile on the floor for good.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunnerSync } from "@sim/shared";
import { afterEach, describe, expect, it } from "vitest";

import { RunnerLink } from "./runnerLink.js";
import { MemoryRunnerProfiles, type RunnerProfiles, RunnerProfileFile } from "./runnerProfiles.js";

const REPO = "krasovsky22/agent-office-sims";

const dirs: string[] = [];

function profilesFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "sim-server-profiles-"));
  dirs.push(dir);
  return join(dir, "data", "agent-profiles.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DEFAULT = { name: "Lena", title: "Software Developer", description: "Takes the GitHub issues it is given." };
const EDIT = { name: "Grace", title: "Release Engineer", description: "Keeps the release branch green.\nNever skips the changelog." };

function sync(profile: { name: string; title: string; description: string }, acked: string[] = []): RunnerSync {
  return {
    runnerId: "runner-1",
    repo: REPO,
    acked,
    slots: [{ id: "slot-1", ...profile, status: "idle", issueNumber: undefined, activity: "", pr: undefined }],
    events: [],
  };
}

function link(profiles: RunnerProfiles, clock = { now: 1_000_000 }) {
  let nextId = 1;
  return new RunnerLink({
    repository: REPO,
    timeoutMs: 60_000,
    now: () => clock.now,
    commandId: () => `command-${nextId++}`,
    profiles,
  });
}

function commandsOf(outcome: ReturnType<RunnerLink["sync"]>) {
  return outcome.kind === "accepted" ? outcome.commands : [];
}

describe("RunnerLink with kept profiles", () => {
  it("gives the runner an edit queued before a server restart, once the restarted server hears from it", () => {
    const file = profilesFile();
    const before = link(new RunnerProfileFile({ file }));
    before.sync(sync(DEFAULT));
    expect(before.enqueue("runner-1", { kind: "profile", slotId: "slot-1", ...EDIT, requestedBy: "Boss" })).toBeDefined();
    // The server stops here, before the runner's next sync has taken the command.

    const after = link(new RunnerProfileFile({ file }));
    const commands = commandsOf(after.sync(sync(DEFAULT)));
    expect(commands).toEqual([{ id: "command-1", kind: "profile", slotId: "slot-1", ...EDIT, requestedBy: "Boss" }]);

    // The runner takes it and reports it back: nothing more goes out.
    expect(commandsOf(after.sync(sync(EDIT, ["command-1"])))).toEqual([]);
    expect(after.current()[0]).toMatchObject({ name: "Grace", title: "Release Engineer" });
  });

  it("gives a runner that came back with its defaults the edit again", () => {
    const profiles = new MemoryRunnerProfiles();
    const office = link(profiles);
    office.sync(sync(DEFAULT));
    const edit = office.enqueue("runner-1", { kind: "profile", slotId: "slot-1", ...EDIT, requestedBy: "Boss" });
    office.sync(sync(EDIT, [edit?.id ?? ""]));

    // Its own file gone, the runner reports the default profile.
    const commands = commandsOf(office.sync(sync(DEFAULT)));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: "profile", slotId: "slot-1", ...EDIT });
  });

  it("does not queue a second copy while one is waiting, and waits before sending one again", () => {
    const clock = { now: 1_000_000 };
    const profiles = new MemoryRunnerProfiles();
    profiles.keep("runner-1", "slot-1", { ...EDIT, requestedBy: "Boss" });
    const office = link(profiles, clock);
    expect(commandsOf(office.sync(sync(DEFAULT)))).toHaveLength(1);
    expect(commandsOf(office.sync(sync(DEFAULT)))).toHaveLength(1);

    // A runner that acks it and still reports another profile is not sent it every second.
    expect(commandsOf(office.sync(sync(DEFAULT, ["command-1"])))).toEqual([]);
    clock.now += 30_000;
    expect(commandsOf(office.sync(sync(DEFAULT)))).toEqual([{ id: "command-2", kind: "profile", slotId: "slot-1", ...EDIT, requestedBy: "Boss" }]);
  });

  it("sends nothing for a slot whose runner already reports the kept profile, or that was never edited", () => {
    const profiles = new MemoryRunnerProfiles();
    profiles.keep("runner-1", "slot-1", { ...EDIT, requestedBy: "Boss" });
    expect(commandsOf(link(profiles).sync(sync(EDIT)))).toEqual([]);
    expect(commandsOf(link(new MemoryRunnerProfiles()).sync(sync(DEFAULT)))).toEqual([]);
  });
});

describe("RunnerProfileFile", () => {
  it("keeps edits across a restart, in a file only the server's user can read", () => {
    const file = profilesFile();
    new RunnerProfileFile({ file }).keep("runner-1", "slot-2", { ...EDIT, requestedBy: "Boss" });
    expect(new RunnerProfileFile({ file }).get("runner-1", "slot-2")).toEqual({ ...EDIT, requestedBy: "Boss" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.partial`)).toBe(false);
  });

  it("drops what the contract would not take, and says so", () => {
    const file = profilesFile();
    new RunnerProfileFile({ file }).keep("runner-1", "slot-1", { ...EDIT, requestedBy: "Boss" });
    const kept = JSON.parse(readFileSync(file, "utf8")) as { runners: Record<string, Record<string, unknown>> };
    kept.runners["runner-1"] = { ...kept.runners["runner-1"], "slot-2": { name: "", title: "Developer" } };
    kept.runners["not a runner"] = { "slot-1": EDIT };
    writeFileSync(file, JSON.stringify(kept));

    const lines: string[] = [];
    const profiles = new RunnerProfileFile({ file, log: (line) => lines.push(line) });
    expect(profiles.get("runner-1", "slot-1")).toEqual({ ...EDIT, requestedBy: "Boss" });
    expect(profiles.get("runner-1", "slot-2")).toBeUndefined();
    expect(lines).toHaveLength(2);
  });

  it("reads an unreadable file as nothing kept rather than stopping the server", () => {
    const file = profilesFile();
    new RunnerProfileFile({ file }).keep("runner-1", "slot-1", { ...EDIT, requestedBy: "Boss" });
    writeFileSync(file, "{ not json");
    const lines: string[] = [];
    expect(new RunnerProfileFile({ file, log: (line) => lines.push(line) }).get("runner-1", "slot-1")).toBeUndefined();
    expect(lines[0]).toContain("could not read");
  });
});
