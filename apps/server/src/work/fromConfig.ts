/**
 * Builds the executor the server's configuration asks for.
 *
 * Mock mode gets no call budget: it spends nothing, and a budget sized for a
 * paid model would stop a long demo for no reason. Model mode always gets one.
 */

import { type AgentWorkConfig } from "../config.js";
import { CallBudget } from "./budget.js";
import { type WorkExecutor, createWorkExecutor } from "./executor.js";
import { createMockProvider } from "./mockProvider.js";
import { createModelProvider } from "./modelProvider.js";

export function createConfiguredExecutor(config: AgentWorkConfig): WorkExecutor {
  if (config.mode === "mock") {
    return createWorkExecutor({ provider: createMockProvider() });
  }
  return createWorkExecutor({
    provider: createModelProvider({ apiKey: config.apiKey, model: config.model }),
    budget: new CallBudget({ perDay: config.callsPerDay, perRun: config.callsPerRun }),
  });
}

/** One line for the boot log; it never includes the key. */
export function describeAgentWork(config: AgentWorkConfig): string {
  return config.mode === "mock"
    ? "agents: mock work (MOCK_AGENTS on), no model calls"
    : `agents: ${config.model}, at most ${config.callsPerDay} calls a day and ${config.callsPerRun} this run`;
}
