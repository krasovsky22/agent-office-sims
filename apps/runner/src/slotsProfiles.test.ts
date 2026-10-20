/**
 * The slot pool's agent profiles: named from the runner's id, the CEO's edits
 * reported and kept, and given to the next run as its system prompt.
 */

import { type AgentProfile, type RunnerSlotCommand, defaultAgentName, defaultAgentProfile } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { systemPrompt } from "./agents/prompt.js";
import type { Agent, AgentTask } from "./agents/types.js";
import type { AgentProfiles } from "./profiles.js";
import { SlotPool } from "./slots.js";
import { DEFAULT_PROFILE, START, TIMEOUT_MS, settle, slot, useSlotFixture, workspaces } from "./slotPoolFixture.js";

describe("SlotPool profiles", () => {
  useSlotFixture();

  const EDITED: AgentProfile = {
    name: "Grace",
    title: "Release Engineer",
    description: "Keeps the release branch green.\nNever skips the changelog.",
  };

  function profileCommand(profile: AgentProfile = EDITED, slotId = "slot-1"): RunnerSlotCommand {
    return { id: `command-profile-${slotId}`, slotId, kind: "profile", ...profile, requestedBy: "Dana" };
  }

  /** Profiles kept in memory, as `./profiles.ts` keeps them on disk; `saved` is every save, in order. */
  function memoryProfiles(kept: ReadonlyMap<string, AgentProfile> = new Map()) {
    const saved: Array<ReadonlyMap<string, AgentProfile>> = [];
    const profiles: AgentProfiles = {
      load: () => kept,
      save: (all) => {
        saved.push(new Map(all));
      },
    };
    return { profiles, saved };
  }

  /** An agent that keeps every task it is given, and never ends one itself. */
  function spyAgent() {
    const tasks: AgentTask[] = [];
    const agent: Agent = {
      label: "Spy",
      start: (task) => {
        tasks.push(task);
        return { stop: () => Promise.resolve() };
      },
    };
    return { agent, tasks };
  }

  function profiledPool(agent: Agent, profiles: AgentProfiles, log?: (line: string) => void) {
    return new SlotPool({
      count: 2,
      agent,
      workspaces: workspaces(),
      taskTimeoutMs: TIMEOUT_MS,
      runnerId: "runner-7",
      profiles,
      ...(log === undefined ? {} : { log }),
    });
  }

  it("names its agents from the runner's id, and starts with the profiles kept for them", () => {
    const { agent } = spyAgent();
    const { profiles } = memoryProfiles(new Map([["slot-2", EDITED]]));
    const slots = profiledPool(agent, profiles);
    expect(slot(slots)).toMatchObject({ name: defaultAgentName("runner-7", 0), ...DEFAULT_PROFILE });
    expect(slot(slots, "slot-2")).toMatchObject(EDITED);
  });

  it("takes the CEO's edit: reports it, keeps only the edited profile, and gives it to the next run as its system prompt", async () => {
    const { agent, tasks } = spyAgent();
    const { profiles, saved } = memoryProfiles();
    const lines: string[] = [];
    const slots = profiledPool(agent, profiles, (line) => lines.push(line));
    slots.handle(profileCommand());
    expect(slot(slots)).toMatchObject(EDITED);
    expect(slot(slots, "slot-2")).toMatchObject(defaultAgentProfile("runner-7", 1));
    expect(saved).toEqual([new Map([["slot-1", EDITED]])]);
    expect(lines).toEqual(["slot-1 is now Grace, Release Engineer, as Dana asked"]);

    slots.handle(START);
    await settle();
    expect(tasks[0]?.systemPrompt).toBe(systemPrompt(EDITED));
    expect(tasks[0]?.systemPrompt).toContain("your title is Release Engineer");
    expect(tasks[0]?.systemPrompt).toContain("Keeps the release branch green.\nNever skips the changelog.");
  });

  it("keeps a profile kept before alongside a new edit", () => {
    const { agent } = spyAgent();
    const before: AgentProfile = { name: "Linus", title: "Kernel Hacker", description: "Reviews patches." };
    const { profiles, saved } = memoryProfiles(new Map([["slot-2", before]]));
    profiledPool(agent, profiles).handle(profileCommand());
    expect(saved).toEqual([
      new Map([
        ["slot-1", EDITED],
        ["slot-2", before],
      ]),
    ]);
  });

  it("keeps a profile kept for a slot beyond the pool's count when saving an edit", () => {
    const { agent } = spyAgent();
    const beyond: AgentProfile = { name: "Ada", title: "Compiler Engineer", description: "Owns the parser." };
    const { profiles, saved } = memoryProfiles(new Map([["slot-3", beyond]]));
    profiledPool(agent, profiles).handle(profileCommand());
    expect(saved).toEqual([
      new Map([
        ["slot-3", beyond],
        ["slot-1", EDITED],
      ]),
    ]);
  });

  it("leaves the session an agent is in alone: an edit applies from its next one", async () => {
    const { agent, tasks } = spyAgent();
    const { profiles } = memoryProfiles();
    const lines: string[] = [];
    const slots = profiledPool(agent, profiles, (line) => lines.push(line));
    slots.handle(START);
    await settle();
    const before = tasks[0]?.systemPrompt;
    expect(before).toBe(systemPrompt(defaultAgentProfile("runner-7", 0)));

    slots.handle(profileCommand());
    expect(slot(slots)).toMatchObject({ ...EDITED, status: "starting", issueNumber: 39 });
    expect(tasks).toHaveLength(1);
    expect(lines.at(-1)).toBe("slot-1 is now Grace, Release Engineer, as Dana asked; its agent's prompt changes from its next session");
  });

  it("gives a standing run its slot's system prompt and name", () => {
    const { agent } = spyAgent();
    const { profiles } = memoryProfiles(new Map([["slot-1", EDITED]]));
    const lease = profiledPool(agent, profiles).leaseForStanding("slot-1", { taskId: "st-aaaaaaaaaaaaaaaa", pr: 7 }, "Reviewing");
    expect(lease?.slotName).toBe("Grace");
    expect(lease?.systemPrompt).toBe(systemPrompt(EDITED));
  });
});
