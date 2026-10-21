/**
 * A planner for tests, standing in for the model: a fixed plan for each
 * message it expects, by its words, so a test drives the manager exactly as a
 * model's answer would, without a call. A message it was not given a plan for
 * fails as a model call would, so a test cannot pass on an answer it never set.
 */

import { type ManagerAdvisor, type ManagerPlan, type ManagerPlanner, createManagerAdvisor } from "./advisor.js";
import { PlannerError } from "./plannerError.js";

export type ScriptedPlans = Readonly<Record<string, Partial<ManagerPlan>>>;

export function scriptedPlanner(plans: ScriptedPlans): ManagerPlanner {
  return async (request) => {
    const plan = plans[request.message];
    if (plan === undefined) {
      throw new PlannerError(`no plan scripted for “${request.message}”`, { retryable: false });
    }
    return { reply: "Here's how that went:", assignments: [], tokensUsed: 0, ...plan };
  };
}

export function scriptedAdvisor(plans: ScriptedPlans = {}): ManagerAdvisor {
  return createManagerAdvisor({ planner: scriptedPlanner(plans) });
}
