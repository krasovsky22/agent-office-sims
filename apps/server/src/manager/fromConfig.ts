/**
 * Builds the AI manager's advisor the server's configuration asks for.
 *
 * Rules mode gets no call budget, since it spends nothing; it does get a short
 * pause, so the manager's badge visibly reads "thinking" before it answers.
 * A model mode, through the API or the `claude` CLI, always gets a budget, so
 * a chatty CEO cannot run up an unbounded bill or spend a subscription's limits.
 */

import { type ManagerConfig } from "../config.js";
import { CallBudget } from "./budget.js";
import { type ManagerAdvisor, type ManagerPlanner, createManagerAdvisor } from "./advisor.js";
import { createCliPlanner } from "./cliPlanner.js";
import { createModelPlanner } from "./modelPlanner.js";
import { planFromRules } from "./rulePlanner.js";

/** Long enough to see the badge change, short enough not to feel slow. */
const RULES_PAUSE_MS = 900;

/** The rule planner, answering after `pauseMs` unless the question is withdrawn first. */
export function createRulePlanner(pauseMs = RULES_PAUSE_MS): ManagerPlanner {
  return (request, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(planFromRules(request));
      }, pauseMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
}

export function createConfiguredManager(config: ManagerConfig): ManagerAdvisor {
  if (config.mode === "mock") {
    return createManagerAdvisor({ planner: createRulePlanner(), mode: "rules" });
  }
  return createManagerAdvisor({
    planner: config.mode === "cli" ? createCliPlanner({ model: config.model }) : createModelPlanner({ apiKey: config.apiKey, model: config.model }),
    mode: "model",
    budget: new CallBudget({ perDay: config.callsPerDay, perRun: config.callsPerRun, label: "manager" }),
  });
}

/** One line for the boot log; it never includes the key. */
export function describeManager(config: ManagerConfig): string {
  return config.mode === "mock"
    ? "manager: answers from live state (MOCK_MANAGER on), no model calls"
    : `manager: ${config.model}${config.mode === "cli" ? " through the signed-in claude CLI" : ""}, at most ${config.callsPerDay} calls a day and ${config.callsPerRun} this run`;
}
