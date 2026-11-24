/** A high five: relayed to the others only from beside a live agent, and no faster than a jump. */

import type { Client } from "@colyseus/core";
import { CLIENT_MESSAGE, HIGH_FIVE_REACH, HumanPlayer, LiveAgent, OfficeState, SERVER_MESSAGE } from "@sim/shared";
import { describe, expect, it, vi } from "vitest";

import type { InteractionHost } from "../sim/interaction.js";
import { createMotion } from "../sim/movement.js";
import { registerPresenceHandlers } from "./presenceHandlers.js";

function harness(agentX = 1) {
  const state = new OfficeState();
  const player = new HumanPlayer();
  state.occupants.set("ada", player);
  const agent = new LiveAgent();
  agent.x = agentX;
  agent.interactableId = "seat-1";
  state.occupants.set("agent:maya", agent);
  const motions = new Map([["ada", createMotion(0, 0, 0, 0)]]);
  let now = 10_000;
  const handlers = new Map<string, (client: Client, raw: unknown) => void>();
  const broadcast = vi.fn();
  registerPresenceHandlers(
    { onMessage: ((type: string, handler: (client: Client, raw: unknown) => void) => handlers.set(type, handler)) as never, broadcast },
    { state, interaction: { motions } as unknown as InteractionHost, now: () => now, allow: () => true, say: () => undefined },
  );
  const client = { sessionId: "ada" } as Client;
  const highFive = (agentId: unknown) => handlers.get(CLIENT_MESSAGE.highFive)!(client, { agentId });
  return { agent, client, broadcast, highFive, wait: (ms: number) => (now += ms) };
}

describe("high five", () => {
  it("tells everyone else that both jump, even with the agent at its desk", () => {
    const { client, broadcast, highFive } = harness();
    highFive("agent:maya");
    expect(broadcast).toHaveBeenCalledWith(SERVER_MESSAGE.highFive, { playerId: "ada", agentId: "agent:maya" }, { except: client });
  });

  it("waits out a jump before the next one", () => {
    const { broadcast, highFive, wait } = harness();
    highFive("agent:maya");
    highFive("agent:maya");
    expect(broadcast).toHaveBeenCalledTimes(1);
    wait(1000);
    highFive("agent:maya");
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("ignores an agent out of reach, a fired one, a stranger and a malformed payload", () => {
    const far = harness(HIGH_FIVE_REACH + 0.1);
    far.highFive("agent:maya");
    expect(far.broadcast).not.toHaveBeenCalled();

    const { agent, broadcast, highFive } = harness();
    highFive("ada");
    highFive("agent:nobody");
    highFive(42);
    agent.fired = true;
    highFive("agent:maya");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
