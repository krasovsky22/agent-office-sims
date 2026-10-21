/**
 * Builds the AI manager's advisor the server's configuration asks for.
 *
 * The manager always plans through a model, through the API or the `claude`
 * CLI, and always on a budget, so a chatty CEO cannot run up an unbounded bill
 * or spend a subscription's limits.
 */

import { type ManagerConfig } from "../config.js";
import { CallBudget } from "./budget.js";
import { type ManagerAdvisor, createManagerAdvisor } from "./advisor.js";
import { createCliPlanner } from "./cliPlanner.js";
import { createModelPlanner } from "./modelPlanner.js";

export function createConfiguredManager(config: ManagerConfig): ManagerAdvisor {
  return createManagerAdvisor({
    planner: config.mode === "cli" ? createCliPlanner({ model: config.model }) : createModelPlanner({ apiKey: config.apiKey, model: config.model }),
    budget: new CallBudget({ perDay: config.callsPerDay, perRun: config.callsPerRun, label: "manager" }),
  });
}

/** One line for the boot log; it never includes the key. */
export function describeManager(config: ManagerConfig): string {
  return `manager: ${config.model}${config.mode === "cli" ? " through the signed-in claude CLI" : ""}, at most ${config.callsPerDay} calls a day and ${config.callsPerRun} this run`;
}
