/**
 * The work provider used in development: canned deliverables on a timer.
 *
 * The office has to be buildable and demonstrable without spending anything,
 * so this is the default (`MOCK_AGENTS`, see `../config.ts`). It makes no
 * network call and reports no tokens. What it does reproduce is the shape of
 * real work: a delay of several seconds, so an agent visibly sits at a desk,
 * and text that reads like a deliverable for the ticket in hand, so the board
 * panel has something worth opening.
 *
 * The kind of deliverable is guessed from the ticket's title — an email, a
 * plan, a specification, or an analysis when nothing else fits — and the text
 * quotes the ticket so two tickets never look alike.
 */

import { type WorkContext, type WorkOutput, type WorkProvider, type WorkTicket } from "./executor.js";

export interface MockProviderOptions {
  /** Shortest and longest pretend working time. */
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Injected so a test can pin the delay. In `[0, 1)`. */
  readonly random?: () => number;
}

/** Long enough to read as work at a desk, short enough not to stall a demo. */
const DEFAULT_MIN_DELAY_MS = 4_000;
const DEFAULT_MAX_DELAY_MS = 12_000;

type ArtifactKind = "email" | "plan" | "specification" | "analysis";

const KIND_KEYWORDS: readonly (readonly [ArtifactKind, RegExp])[] = [
  ["email", /\b(email|e-mail|mail|reply|announce|announcement|letter|message)\b/i],
  ["plan", /\b(plan|roadmap|schedule|timeline|migrate|migration|rollout|launch)\b/i],
  ["specification", /\b(spec|specification|design|feature|api|build|implement|add)\b/i],
];

function kindOf(ticket: WorkTicket): ArtifactKind {
  for (const [kind, pattern] of KIND_KEYWORDS) {
    if (pattern.test(ticket.title)) {
      return kind;
    }
  }
  return "analysis";
}

/** The ticket body as the deliverable quotes it, or a stand-in when there is none. */
function brief(ticket: WorkTicket): string {
  const body = ticket.body.trim();
  return body === "" ? "No further detail was given beyond the title." : body;
}

function write(kind: ArtifactKind, ticket: WorkTicket, context: WorkContext): WorkOutput {
  const title = ticket.title.trim() === "" ? "Untitled ticket" : ticket.title.trim();
  const signature = `${context.agentName}, ${context.jobTitle}`;
  switch (kind) {
    case "email":
      return {
        summary: `Draft email for "${title}"`,
        tokensUsed: 0,
        artifact: [
          `Subject: ${title}`,
          "",
          "Hi all,",
          "",
          `A quick note on ${title.toLowerCase()}. The short version: the work is scoped, the owners are clear, and nothing below needs a reply unless you disagree.`,
          "",
          `What prompted this: ${brief(ticket)}`,
          "",
          "What happens next: I will circulate a follow-up once the first pieces land, and flag anything that changes the timeline as soon as I know.",
          "",
          "Thanks,",
          signature,
        ].join("\n"),
      };
    case "plan":
      return {
        summary: `Three-phase plan for "${title}"`,
        tokensUsed: 0,
        artifact: [
          `# Plan: ${title}`,
          "",
          `## Goal`,
          brief(ticket),
          "",
          "## Phases",
          "1. **Prepare.** Confirm scope with the requester, list the open questions, and agree what done looks like.",
          "2. **Deliver.** Do the work in small, reviewable steps, each one usable on its own.",
          "3. **Close out.** Check the result against the goal, write down what changed, and hand over.",
          "",
          "## Risks",
          "- Scope grows mid-flight. Mitigation: anything new becomes its own ticket.",
          "- A dependency slips. Mitigation: phase 2 is ordered so the riskiest step goes first.",
          "",
          `Prepared by ${signature}.`,
        ].join("\n"),
      };
    case "specification":
      return {
        summary: `Specification for "${title}"`,
        tokensUsed: 0,
        artifact: [
          `# Specification: ${title}`,
          "",
          "## Problem",
          brief(ticket),
          "",
          "## Requirements",
          "- It does the one thing the ticket asks, and nothing the ticket does not.",
          "- It fails visibly: a user can always tell whether it worked.",
          "- It can be switched off without a redeploy.",
          "",
          "## Out of scope",
          "- Anything that would need a decision nobody has made yet.",
          "",
          "## Acceptance",
          "- A reviewer can follow the steps above and see the result.",
          "",
          `Written by ${signature}.`,
        ].join("\n"),
      };
    case "analysis":
      return {
        summary: `Analysis of "${title}"`,
        tokensUsed: 0,
        artifact: [
          `# Analysis: ${title}`,
          "",
          "## Question",
          brief(ticket),
          "",
          "## Findings",
          "1. The cause is narrower than it first looks: one path accounts for most of the effect.",
          "2. The cheapest fix and the right fix are the same change, which is rare and worth taking.",
          "3. Nothing found suggests the problem will grow if it waits a week.",
          "",
          "## Recommendation",
          "Make the change described in finding 2, then measure again before doing anything larger.",
          "",
          `Analysed by ${signature}.`,
        ].join("\n"),
      };
  }
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockProvider(options: MockProviderOptions = {}): WorkProvider {
  const minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
  const maxDelayMs = Math.max(minDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const random = options.random ?? Math.random;

  return async (ticket, context, signal) => {
    await delay(minDelayMs + Math.floor(random() * (maxDelayMs - minDelayMs)), signal);
    return write(kindOf(ticket), ticket, context);
  };
}
