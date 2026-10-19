// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/workers/manager.ts. See THIRD_PARTY_NOTICES.md.
/**
 * An agent CLI in a terminal of its own: a PTY per task, started in the
 * task's worktree with its first prompt, and read for what it is doing. A desk
 * session is started the same way with no first prompt, in its scratch
 * worktree, and waits at its prompt for the CEO's.
 *
 * Its hooks are what say so first (`./hookServer.ts`); its OSC 9;4 progress
 * catches a turn that ends without one; and its output, read as text, catches
 * a first-run or sign-in screen it can sit on before any hook runs. Its
 * adapter (`./provider.ts`) says what each of those means.
 *
 * What it spends is read off the transcript its hooks name (`./usage.ts`), a
 * moment after each hook and once more as it exits, and said as its run's
 * running total.
 *
 * It runs as the leader of its own process group, so stopping it, whether
 * asked to or at the task timeout, ends what it started too. A prompt for it
 * is typed into its terminal as a paste and submitted, as a person would, and
 * a key the CEO pressed on a choice screen it waits on is pressed there too.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import * as pty from "@lydell/node-pty";
import { type AgentKey, sanitizePromptText } from "@sim/shared";

import { SCREEN_COLS, SCREEN_ROWS } from "../terminal.js";
import { childEnv } from "./childEnv.js";
import { HOOK_ENV, type HookServer } from "./hookServer.js";
import { startPrompt } from "./prompt.js";
import type { ProviderAdapter, RunHandle, RunStatus } from "./provider.js";
import { ScreenReader } from "./screen.js";
import type { Agent, AgentReporter, AgentRun } from "./types.js";
import { TranscriptMeter } from "./usage.js";

/** How long a stopped agent has to exit before its process group is killed outright. */
const DEFAULT_STOP_GRACE_MS = 5000;

/** How long an agent that says itself when it is up may stay silent before it is taken to be waiting on a person. */
const DEFAULT_BOOT_HINT_MS = 12_000;

/** Between pasting a prompt and pressing Enter, so the CLI has taken the paste in whole. */
const SUBMIT_DELAY_MS = 120;

/**
 * Between one key the CEO pressed and the next: keys that land together read
 * as one, and an Esc followed at once by an arrow's own Esc is not an Esc.
 */
const KEY_GAP_MS = 50;

/** What a key is in its terminal, as a person's keyboard sends it. */
const KEY_BYTES: Readonly<Record<AgentKey, string>> = {
  up: "\u001b[A",
  down: "\u001b[B",
  enter: "\r",
  escape: "\u001b",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
};

/** After a hook, before its transcript is read: a burst of hooks is one read, of what they all logged. */
const DEFAULT_SPEND_SCAN_MS = 1000;

/** What it needs to act on GitHub as the runner's App or the person's login it was given. */
export interface AgentGithubEnv {
  /** Set on top of its environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Never passed: the variables that would carry another identity's token. */
  readonly scrub: readonly string[];
}

export interface PtyAgentOptions<P> {
  readonly adapter: ProviderAdapter<P>;
  /** Where the adapter writes its settings: the runner's data dir. */
  readonly dataDir: string;
  readonly hooks: HookServer;
  /** Runs this instead of the adapter's CLI: a fake one, in a test. */
  readonly command?: string;
  /** The environment its own is picked from; the runner's by default. */
  readonly env?: NodeJS.ProcessEnv;
  readonly stopGraceMs?: number;
  readonly bootHintMs?: number;
  readonly spendScanMs?: number;
  /** The agent's identity on GitHub: the runner's GitHub App or a person's login. */
  readonly github?: AgentGithubEnv;
}

/** The absolute path of `command` on `PATH`, or `undefined` when it is not there. */
export function findOnPath(command: string, path: string = process.env["PATH"] ?? ""): string | undefined {
  const candidates = isAbsolute(command) ? [command] : path.split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * An agent running `options.adapter`'s CLI in a PTY.
 *
 * @throws when the CLI is not on `PATH`, so a runner that could never start it refuses to boot.
 */
export function createPtyAgent<P>(options: PtyAgentOptions<P>): Agent {
  const { adapter } = options;
  const source = options.env ?? process.env;
  const command = findOnPath(options.command ?? adapter.command, source["PATH"] ?? "");
  if (command === undefined) {
    throw new Error(`${options.command ?? adapter.command} is not on PATH; install it or put it there`);
  }
  const setup = adapter.prepare(options.dataDir);
  return {
    label: adapter.label,
    start: (task, reporter) => startRun(options, command, setup, source, { prompt: startPrompt(task), workdir: task.workdir, systemPrompt: task.systemPrompt }, reporter),
    // No first prompt: it comes up at its prompt, for the CEO at the desk to type to.
    startSession: (session, reporter) => startRun(options, command, setup, source, { prompt: "", workdir: session.workdir, systemPrompt: session.systemPrompt }, reporter),
  };
}

/** What one run is started with: its first prompt, `""` for none, where, and its system prompt. */
interface RunStart {
  readonly prompt: string;
  readonly workdir: string;
  readonly systemPrompt: string;
}

function startRun<P>(
  options: PtyAgentOptions<P>,
  command: string,
  setup: P,
  source: NodeJS.ProcessEnv,
  task: RunStart,
  reporter: AgentReporter,
): AgentRun {
  const { adapter } = options;
  const screen = new ScreenReader();
  let status: RunStatus = "starting";
  let bootBlocked = false;
  /** Its work is over: it exited, or was stopped. Nothing it says from then on is reported but what it spent. */
  let ended = false;
  const meter = new TranscriptMeter();
  let spentUsd = 0;
  let spendTimer: ReturnType<typeof setTimeout> | undefined;

  /** Reads what its session has spent, and says so when that changed. */
  const meterSpend = (): void => {
    clearTimeout(spendTimer);
    spendTimer = undefined;
    if (!meter.scan()) {
      return;
    }
    const total = meter.usage().costUsd;
    if (total !== spentUsd) {
      spentUsd = total;
      reporter.spent(total);
    }
  };

  const run: RunHandle = {
    get status() {
      return status;
    },
    get bootBlocked() {
      return bootBlocked;
    },
    set bootBlocked(value) {
      bootBlocked = value;
    },
    pullRequest(pr) {
      if (!ended) {
        reporter.prOpened({ number: pr.number, title: "", url: pr.url });
      }
    },
    transcript(path) {
      meter.follow(path);
    },
    setStatus(next, activity = "") {
      if (ended) {
        return;
      }
      status = next;
      switch (next) {
        case "starting":
          return;
        case "idle":
          reporter.started();
          return;
        case "working":
          reporter.progress(activity);
          return;
        case "needs-input":
          reporter.needsInput(activity);
          return;
        case "turn-done":
          reporter.turnDone();
          return;
      }
    },
  };

  const route = options.hooks.register((event, payload) => {
    // A session starting or a prompt taken means it got past whatever screen it
    // was on, so only output from here on counts.
    if (event === "SessionStart" || event === "UserPromptSubmit") {
      screen.clear();
    }
    adapter.hook.handle(run, event, payload);
    checkBlocked();
    if (spendTimer === undefined) {
      spendTimer = setTimeout(meterSpend, options.spendScanMs ?? DEFAULT_SPEND_SCAN_MS);
      spendTimer.unref();
    }
  });
  const plan = adapter.launch({ prompt: task.prompt, cwd: task.workdir, systemPrompt: task.systemPrompt, setup });
  const scrub = [...(adapter.scrubEnv ?? []), ...(options.github?.scrub ?? [])];
  const env = childEnv(
    {
      ...(adapter.credentialEnv === undefined ? {} : { credentials: adapter.credentialEnv }),
      ...(scrub.length === 0 ? {} : { scrub }),
      set: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...options.github?.env,
        [HOOK_ENV.url]: options.hooks.url,
        [HOOK_ENV.run]: route.runId,
        [HOOK_ENV.token]: route.token,
        ...plan.env,
      },
    },
    source,
  );

  let proc: pty.IPty;
  try {
    proc = pty.spawn(command, plan.args, { name: "xterm-256color", cols: SCREEN_COLS, rows: SCREEN_ROWS, cwd: task.workdir, env });
  } catch (error) {
    route.dispose();
    throw error;
  }

  /**
   * A first-run or sign-in screen needs a person, until a hook says it moved
   * on. Read while it is not busy: before it starts, at its prompt, and once a
   * turn has ended, which is where a turn refused for want of a sign-in ends up.
   */
  const checkBlocked = (): void => {
    const blockedBy = adapter.screen?.blocked;
    if (blockedBy === undefined || (status !== "starting" && status !== "idle" && status !== "turn-done" && !bootBlocked)) {
      return;
    }
    const blocked = blockedBy(screen.text, status === "starting" || bootBlocked);
    if (blocked !== undefined && status !== "needs-input") {
      bootBlocked = true;
      run.setStatus("needs-input", blocked);
    }
  };

  // Progress stays busy while a permission prompt is open, so going idle from
  // needs-input means the turn ended without a Stop hook: the prompt was refused or Esc'd.
  const onProgress = (busy: boolean): void => {
    if (busy && (status === "idle" || status === "turn-done" || status === "starting")) {
      run.setStatus("working");
    } else if (!busy && (status === "working" || (status === "needs-input" && !bootBlocked))) {
      run.setStatus("turn-done");
    }
  };

  const data = proc.onData((chunk) => {
    if (!ended) {
      reporter.output(chunk);
    }
    const busy = screen.feed(chunk);
    if (busy !== undefined && adapter.screen?.progress === true) {
      onProgress(busy);
    }
    checkBlocked();
  });

  const bootHint =
    adapter.bootHint === undefined
      ? undefined
      : setTimeout(() => {
          if (status === "starting" && adapter.bootHint !== undefined) {
            bootBlocked = true;
            run.setStatus("needs-input", adapter.bootHint);
          }
        }, options.bootHintMs ?? DEFAULT_BOOT_HINT_MS);
  bootHint?.unref();

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let submitTimer: ReturnType<typeof setTimeout> | undefined;
  /** The keys waiting their turn to be pressed, a {@link KEY_GAP_MS} apart. */
  const keys: string[] = [];
  let keyTimer: ReturnType<typeof setTimeout> | undefined;
  const pressNext = (): void => {
    keyTimer = undefined;
    const bytes = keys.shift();
    if (bytes === undefined || ended) {
      return;
    }
    proc.write(bytes);
    keyTimer = setTimeout(pressNext, KEY_GAP_MS);
  };
  /** Signals its whole process group, which it leads, as a PTY's process does. Says whether any of it was there. */
  const signalGroup = (name: NodeJS.Signals): boolean => {
    try {
      process.kill(-proc.pid, name);
      return true;
    } catch {
      return false;
    }
  };

  const exit = proc.onExit(({ exitCode, signal: killedBy }) => {
    data.dispose();
    exit.dispose();
    route.dispose();
    clearTimeout(bootHint);
    clearTimeout(killTimer);
    clearTimeout(submitTimer);
    clearTimeout(keyTimer);
    // Its work is over and its terminal gone: anything it left running in its group goes too.
    signalGroup("SIGKILL");
    // Whatever its last turn logged is paid for, however its work ended.
    meterSpend();
    if (ended) {
      return;
    }
    ended = true;
    const clean = exitCode === 0 && !killedBy;
    const how = killedBy ? `was killed by signal ${killedBy}` : `exited with code ${exitCode}`;
    const lastLine = screen.text.split("\n").map((line) => line.trim()).filter(Boolean).pop();
    reporter.exited(clean || lastLine === undefined ? `${adapter.label} ${how}` : `${adapter.label} ${how}: ${lastLine}`, clean);
  });

  return {
    // Its path and pid only: its arguments carry the prompt.
    process: { command, pid: proc.pid },
    prompt(text) {
      // Again here, at the PTY: no control character, an escape above all, may end the paste early.
      const clean = sanitizePromptText(text);
      if (ended || clean === "") {
        return;
      }
      // A bracketed paste keeps a prompt of many lines one message; Enter then submits it.
      proc.write(`\u001b[200~${clean}\u001b[201~`);
      clearTimeout(submitTimer);
      submitTimer = setTimeout(() => {
        if (!ended) {
          proc.write("\r");
        }
      }, SUBMIT_DELAY_MS);
    },
    key(key) {
      if (ended) {
        return;
      }
      keys.push(KEY_BYTES[key]);
      if (keyTimer === undefined) {
        pressNext();
      }
    },
    resize(cols, rows) {
      if (!ended) {
        proc.resize(cols, rows);
      }
    },
    stop() {
      if (ended) {
        return;
      }
      ended = true;
      clearTimeout(bootHint);
      clearTimeout(submitTimer);
      clearTimeout(keyTimer);
      route.dispose();
      if (!signalGroup("SIGTERM")) {
        // Not a group leader after all; its own pid is still its own until it exits.
        proc.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        if (!signalGroup("SIGKILL")) {
          proc.kill("SIGKILL");
        }
      }, options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
      killTimer.unref();
    },
  };
}
