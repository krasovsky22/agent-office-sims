/**
 * The `mock` agent: a script of progress on a timer, then an outcome, printed
 * to its terminal in colour as a real agent's would be.
 *
 * It costs nothing and needs no credentials, so the runner, the sync loop and
 * the floor can all be developed and tested end to end without a real agent.
 * It says it spends a little on every step all the same, pretend money, so
 * the runner's daily budget can be run out and seen to refuse the next start.
 * Partway through it stops to wait on a person, as a real agent does for a
 * permission, so the office's needs-you beacon can be seen without one; like a
 * real agent it waits for as long as nobody answers, on a menu of its own that
 * the CEO's keys answer as a real agent's permission screen is answered: up and
 * down between yes and no, a number or Enter to choose, Esc to say no. Yes has
 * it carry on; no ends its turn with nothing handed in, waiting at its prompt
 * to be told what to do instead. A prompt answers the wait too, as a yes. By default the work fails, which is what a real
 * agent does most often while this is being built; configured to, it hands in
 * a simulated pull request instead, one it never opens on GitHub and that the
 * office says is simulated wherever it names it, and then waits at its prompt
 * as a real agent does: sent back for rework, it reads the prompt, commits
 * again, and hands the same simulated pull request in again. Configured to ask
 * a `question`, it ends its first turn with one and nothing handed in, waiting
 * at its prompt at its desk, as a real agent that wants an answer does; the
 * CEO's prompt is the answer, and it carries on to hand its simulated pull
 * request in.
 *
 * It pauses for a standup between one step and the next, saying so on its
 * screen, and carries on from that step once the standup is over.
 *
 * Lent to the CEO's desk, it is a pretend session instead: it comes up at its
 * prompt and answers each prompt after a step of pretend work, running nothing.
 *
 * It does one real thing, writing a file in its worktree and committing it, so
 * a task's worktree is exercised end to end too: stopped before it writes, its
 * worktree is removed, and from then on kept, first with an uncommitted change
 * and then with a commit nothing pushes yet.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AgentKey } from "@sim/shared";

import { gitError } from "../worktrees.js";
import type { Agent, AgentReporter, AgentRun, AgentSession, AgentTask } from "./types.js";

export const MOCK_OUTCOMES = ["failed", "pr-opened", "question"] as const;

export type MockOutcome = (typeof MOCK_OUTCOMES)[number];

export interface MockAgentOptions {
  readonly outcome: MockOutcome;
  /** Between one scripted step and the next. */
  readonly stepMs?: number;
}

const DEFAULT_STEP_MS = 2000;

/**
 * Added to the issue number for the simulated pull request's. The contract
 * needs a number, and this one is never shown; should anything show it, it
 * still names no pull request that exists.
 */
const SIMULATED_PR_OFFSET = 1_000_000;

/** Where in its worktree the mock writes, apart from anything the repository has. */
const MOCK_DIR = ".sims-mock";

/** What the mock waits on a person for, as a real agent waits on a permission. */
export const MOCK_PERMISSION = "Permission: Bash pnpm test";

/** What it is doing once its permission is given, as a real agent is back at work the moment it is. */
export const MOCK_PERMISSION_GRANTED = "Permission granted: Bash pnpm test";

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

/** The choices on its permission menu, in order: the first carries on, the second says no. */
export const MOCK_PERMISSION_CHOICES = ["Yes", "No, and tell the agent what to do differently (esc)"] as const;

/** What it prints when it stops for a standup, and when it carries on. */
export const MOCK_PAUSED = "Paused for the standup.";
export const MOCK_RESUMED = "Back from the standup.";

/** What it prints when it is told no, ending its turn. */
export const MOCK_DECLINED = "Declined. Waiting to be told what to do instead.";

/** What a desk session says as it comes up. */
export const MOCK_SESSION_HINT = "A pretend session: type a prompt in the office and it answers.";

/** How a desk session's pretend turn ends, before the prompt's first line. */
export const MOCK_SESSION_ANSWER = "Done (pretend, nothing was run)";

/** The pretend US dollars each step it works costs: twenty cents for a task. */
export const MOCK_STEP_USD = 0.05;

/** One step of the script: what it is doing, or what it is waiting on. */
interface Step {
  readonly activity: string;
  /** Whether it waits on a person rather than working: until a prompt answers it, however long that takes. */
  readonly needsInput?: boolean;
  /** What the step really does, if anything; throws to fail the work. */
  readonly act?: () => void;
}

/** What the mock asks at the end of its first turn, as the `question` outcome. */
export const MOCK_QUESTION = "Should the change cover the empty case too? Answer from the office to carry on.";

/** What the mock does when prompted, sent back or answered: reads the prompt, and commits again. */
function reworkScript(task: AgentTask, text: string): readonly Step[] {
  const file = join(MOCK_DIR, `issue-${task.issueNumber}.md`);
  return [
    { activity: `Reading: ${text.split("\n")[0] ?? ""}` },
    {
      activity: `Edit: ${file}`,
      act: () => {
        appendFileSync(join(task.workdir, file), `\nReworked: ${text}\n`);
      },
    },
    { activity: "Bash: git commit", act: () => commit(task.workdir, `mock: rework #${task.issueNumber}`) },
    { activity: "Bash: git push" },
  ];
}

/** Its permission menu's lines, `selected` marked with the pointer a real agent's menu has. */
function menuLines(selected: number): string {
  return MOCK_PERMISSION_CHOICES.map(
    (choice, index) => `\u001b[2K${index === selected ? `${CYAN}❯${RESET}` : " "} ${index + 1}. ${choice}\r\n`,
  ).join("");
}

/** What the mock does, one step at a time. */
function script(task: AgentTask): readonly Step[] {
  const file = join(MOCK_DIR, `issue-${task.issueNumber}.md`);
  return [
    { activity: `Reading issue #${task.issueNumber}` },
    {
      activity: `Edit: ${file}`,
      act: () => {
        mkdirSync(join(task.workdir, MOCK_DIR), { recursive: true });
        writeFileSync(join(task.workdir, file), `# ${task.title}\n\n${task.url}\n${task.note === "" ? "" : `\n${task.note}\n`}`);
      },
    },
    { activity: "Bash: git commit", act: () => commit(task.workdir, `mock: work on #${task.issueNumber}`) },
    { activity: MOCK_PERMISSION, needsInput: true },
    { activity: "Bash: pnpm test" },
  ];
}

/**
 * Commits everything in `workdir` as the mock, whatever the machine's git
 * identity, signing or hooks, and even when there is nothing new: a task
 * picked up again from its kept worktree writes the same file over. Synchronous:
 * one small commit is milliseconds, and it keeps each step a single timer.
 */
function commit(workdir: string, message: string): void {
  // Only the worktree's own repository: never one git would find above it.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: realpathSync(dirname(workdir)) };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: workdir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  git("add", "--all");
  git(
    "-c",
    "user.name=Sims mock agent",
    "-c",
    "user.email=mock-agent@sims.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "--allow-empty",
    "-m",
    message,
  );
}

export function createMockAgent(options: MockAgentOptions): Agent {
  const stepMs = options.stepMs ?? DEFAULT_STEP_MS;
  return {
    label: "Mock",
    simulated: true,
    start(task: AgentTask, reporter: AgentReporter): AgentRun {
      let steps = script(task);
      let step = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let worked = 0;
      let asked = false;
      /** It is waiting on a person, with no timer: only a key or a prompt moves it on. */
      let waiting = false;
      /** The choice its permission menu points at. */
      let selected = 0;
      /** A standup is on: it takes no next step until it is over. */
      let paused = false;
      /** A step came due while it was paused, and is taken on resuming. */
      let stalled = false;

      const next = (): void => {
        if (paused) {
          timer = undefined;
          stalled = true;
          reporter.output(`${DIM}⏸ ${MOCK_PAUSED}${RESET}\r\n`);
          return;
        }
        const current = steps[step];
        step += 1;
        if (current !== undefined) {
          if (current.needsInput === true) {
            // No timer: it waits for as long as nobody answers.
            timer = undefined;
            waiting = true;
            selected = 0;
            reporter.needsInput(current.activity);
            reporter.output(`${CYAN}?${RESET} ${current.activity}\r\n  Do you want to proceed?\r\n${menuLines(selected)}`);
            reporter.output(`${DIM}  ↑/↓ to move · Enter to confirm · Esc to cancel${RESET}\r\n`);
            return;
          }
          reporter.progress(current.activity);
          reporter.output(`${CYAN}●${RESET} ${current.activity}\r\n`);
          worked += 1;
          reporter.spent(worked * MOCK_STEP_USD);
          try {
            current.act?.();
          } catch (error) {
            timer = undefined;
            const message = `${current.activity} failed: ${gitError(error)}`;
            reporter.output(`${RED}✗ ${message}${RESET}\r\n`);
            reporter.failed(message);
            return;
          }
          timer = setTimeout(next, stepMs);
          return;
        }
        timer = undefined;
        if (options.outcome === "question" && !asked) {
          // Ends its turn with nothing handed in, so its slot shows it waiting at its prompt.
          asked = true;
          reporter.output(`${YELLOW}?${RESET} ${MOCK_QUESTION}\r\n`);
          reporter.turnDone();
          return;
        }
        if (options.outcome === "pr-opened" || options.outcome === "question") {
          reporter.output(`${GREEN}✓ Handed in a simulated pull request; nothing was opened on GitHub${RESET}\r\n`);
          reporter.prOpened({ number: SIMULATED_PR_OFFSET + task.issueNumber, title: `[mock] ${task.title}`, url: "", simulated: true });
          reporter.turnDone();
        } else {
          const message = "The mock agent always fails; set RUNNER_MOCK_OUTCOME=pr-opened for a simulated pull request.";
          reporter.output(`${RED}✗ ${message}${RESET}\r\n`);
          reporter.failed(message);
        }
      };

      timer = setTimeout(() => {
        reporter.started();
        reporter.output(`${BOLD}mock agent${RESET} on #${task.issueNumber}: ${task.title}\r\n${DIM}for ${task.requestedBy}${RESET}\r\n`);
        // What a real agent would be given as its system prompt, so the office can see its profile reach it.
        reporter.output(`${DIM}${task.systemPrompt.replace(/\n/g, "\r\n")}${RESET}\r\n\r\n`);
        next();
      }, stepMs);

      /** Answers its permission menu: the first choice carries on, any other ends its turn. */
      const choose = (choice: number): void => {
        waiting = false;
        if (choice === 0) {
          reporter.output(`${GREEN}  ✓ ${MOCK_PERMISSION_CHOICES[0]}${RESET}\r\n`);
          reporter.progress(MOCK_PERMISSION_GRANTED);
          timer = setTimeout(next, stepMs);
          return;
        }
        reporter.output(`${YELLOW}  ✗ ${MOCK_DECLINED}${RESET}\r\n`);
        reporter.turnDone();
      };

      return {
        promptAnswersWait: true,
        key(key: AgentKey) {
          if (stopped || !waiting) {
            return;
          }
          const last = MOCK_PERMISSION_CHOICES.length - 1;
          switch (key) {
            case "up":
            case "down":
              selected = key === "up" ? Math.max(selected - 1, 0) : Math.min(selected + 1, last);
              // Back over the hint and the menu, and the menu drawn again over itself.
              reporter.output(`\u001b[${MOCK_PERMISSION_CHOICES.length + 1}A\r${menuLines(selected)}\u001b[1B\r`);
              return;
            case "enter":
              choose(selected);
              return;
            case "escape":
              choose(last);
              return;
            default: {
              const choice = Number(key) - 1;
              if (choice <= last) {
                choose(choice);
              }
            }
          }
        },
        stop() {
          stopped = true;
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
        },
        pause() {
          paused = true;
        },
        resume() {
          paused = false;
          if (stalled && !stopped) {
            stalled = false;
            reporter.output(`${DIM}▶ ${MOCK_RESUMED}${RESET}\r\n`);
            timer = setTimeout(next, stepMs);
          }
        },
        prompt(text) {
          if (stopped) {
            return;
          }
          clearTimeout(timer);
          stalled = false;
          reporter.output(`\r\n${BOLD}>${RESET} ${text.replace(/\n/g, "\r\n  ")}\r\n`);
          if (waiting) {
            // The answer to what it waits on: it carries on from there.
            waiting = false;
          } else {
            steps = reworkScript(task, text);
            step = 0;
          }
          timer = setTimeout(next, stepMs);
        },
      };
    },
    startSession(session: AgentSession, reporter: AgentReporter): AgentRun {
      return startMockSession(session, reporter, stepMs);
    },
  };
}

/**
 * A desk session: it comes up at its prompt, and each prompt the CEO types is
 * a short turn of pretend work that ends with an answer. It touches nothing,
 * not even its worktree, and spends a pretend step's worth a turn, so a desk
 * session can be watched and prompted without a real agent.
 */
function startMockSession(session: AgentSession, reporter: AgentReporter, stepMs: number): AgentRun {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let turns = 0;
  const prompt = (): void => reporter.output(`\r\n${BOLD}>${RESET} `);

  timer = setTimeout(() => {
    timer = undefined;
    reporter.started();
    reporter.output(`${BOLD}mock agent${RESET} at ${session.requestedBy}'s desk\r\n${DIM}${MOCK_SESSION_HINT}${RESET}\r\n`);
    prompt();
  }, stepMs);

  return {
    prompt(text) {
      if (stopped || timer !== undefined) {
        return;
      }
      const first = text.split("\n")[0] ?? "";
      reporter.output(`${text.replace(/\n/g, "\r\n  ")}\r\n`);
      reporter.progress(`Thinking: ${first}`);
      reporter.output(`${CYAN}●${RESET} Thinking about it\r\n`);
      timer = setTimeout(() => {
        timer = undefined;
        turns += 1;
        reporter.spent(turns * MOCK_STEP_USD);
        reporter.output(`${GREEN}✓${RESET} ${MOCK_SESSION_ANSWER}: ${first}\r\n`);
        prompt();
        reporter.turnDone();
      }, stepMs);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
