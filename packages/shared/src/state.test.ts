/**
 * The live agent's replicated fields, as a browser decodes them: a client
 * rebuilds the types from the handshake, so a field missing from the schema
 * never reaches anyone however the server sets it.
 */

import { Encoder, Reflection } from "@colyseus/schema";
import { describe, expect, it } from "vitest";

import { LIVE_AGENT_STATUS, LiveAgent, OfficeState, isLiveAgentOnTask } from "./state.js";

describe("LiveAgent", () => {
  it("reaches a client needing input, with what it waits on", () => {
    const state = new OfficeState();
    const agent = new LiveAgent();
    agent.id = "agent:runner:runner-1:slot-1";
    agent.status = LIVE_AGENT_STATUS.needsInput;
    agent.activity = "Permission: Bash pnpm test";
    state.occupants.set(agent.id, agent);
    const encoder = new Encoder(state);

    const decoder = Reflection.decode<OfficeState>(Reflection.encode(encoder));
    decoder.decode(encoder.encodeAll());

    expect(decoder.state.occupants.get(agent.id)).toMatchObject({
      status: "needs-input",
      activity: "Permission: Bash pnpm test",
    });
  });

  it("starts idle, doing nothing", () => {
    expect(new LiveAgent()).toMatchObject({ status: LIVE_AGENT_STATUS.idle, activity: "" });
  });
});

describe("isLiveAgentOnTask", () => {
  it("counts waiting on a person as still being on the task", () => {
    expect(isLiveAgentOnTask(LIVE_AGENT_STATUS.working)).toBe(true);
    expect(isLiveAgentOnTask(LIVE_AGENT_STATUS.needsInput)).toBe(true);
    expect(isLiveAgentOnTask(LIVE_AGENT_STATUS.idle)).toBe(false);
  });
});
