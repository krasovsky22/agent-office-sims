/**
 * The debug command, without a socket: who it finds, what it queues, and that
 * it does nothing at all on a server that did not turn it on.
 */

import { OFFICE_LAYOUT, OfficeState } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { AgentMotion } from "../sim/agentMotion.js";
import { hireAgentEmployees } from "../sim/agents.js";
import { HoldRegistry } from "../sim/interaction.js";
import { type AgentDebugHost, findAgent, runDebugGoto } from "./agentDebug.js";

function createHost(enabled: boolean): AgentDebugHost {
  const state = new OfficeState();
  hireAgentEmployees(state.occupants, OFFICE_LAYOUT, 2);
  const motion = new AgentMotion({
    layout: OFFICE_LAYOUT,
    occupants: state.occupants,
    motions: new Map(),
    holds: new HoldRegistry(),
    lastUsedAt: new Map(),
  });
  return { enabled, motion, occupants: state.occupants };
}

describe("findAgent", () => {
  const { occupants } = createHost(true);

  it.each(["agent-1", "Ada Byrne", "ada byrne", "ada", " ADA "])("finds Ada by %j", (query) => {
    expect(findAgent(occupants.values(), query)?.id).toBe("agent-1");
  });

  it.each(["byrne", "agent-9", "ad"])("finds nobody by %j", (query) => {
    expect(findAgent(occupants.values(), query)).toBeUndefined();
  });
});

describe("runDebugGoto", () => {
  it("queues a goto for the named agent", () => {
    const host = createHost(true);
    const reply = runDebugGoto(host, { agent: "bo", target: "wp-meeting-table" });
    expect(reply.ok).toBe(true);
    expect(reply.text).toContain("Bo Mendes");
    expect(host.motion.pending("agent-2")).toBe(1);
  });

  it("says why it refused a target", () => {
    const host = createHost(true);
    const reply = runDebugGoto(host, { agent: "ada", target: { x: 40, z: 0 } });
    expect(reply).toEqual({ ok: false, text: expect.stringContaining("off the floor") });
    expect(host.motion.pending("agent-1")).toBe(0);
  });

  it("says when there is nobody by that name", () => {
    const host = createHost(true);
    expect(runDebugGoto(host, { agent: "zed", target: "wp-ceo-desk" }).ok).toBe(false);
  });

  it("does nothing on a server that did not turn it on", () => {
    const host = createHost(false);
    const reply = runDebugGoto(host, { agent: "ada", target: "wp-ceo-desk" });
    expect(reply).toEqual({ ok: false, text: expect.stringContaining("AGENT_DEBUG") });
    expect(host.motion.pending("agent-1")).toBe(0);
  });
});
