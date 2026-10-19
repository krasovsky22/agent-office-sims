// Adapted from agent-office (MIT, Copyright (c) 2026 AgentSystemLabs): src/server/providers/types.ts. See THIRD_PARTY_NOTICES.md.
/**
 * What the runner needs from an agent CLI that runs in a terminal: one
 * adapter per CLI, so the terminal agent (`./ptyAgent.ts`) never asks which
 * CLI it runs. Claude Code's is `./claude.ts`.
 */

/** Where a terminal agent's run stands, as its hooks and its screen say. */
export type RunStatus = "starting" | "idle" | "working" | "needs-input" | "turn-done";

/** One run of an agent, as its adapter's hooks see it. */
export interface RunHandle {
  readonly status: RunStatus;
  /**
   * It sits on a first-run or sign-in screen: `needs-input` that only its
   * session starting, or a prompt, clears.
   */
  bootBlocked: boolean;
  /** Moves it on; `activity` is what it is doing when `working`, and why it waits when `needs-input`. */
  setStatus(status: RunStatus, activity?: string): void;
  /** It opened a pull request, as one of its tool calls showed. */
  pullRequest(pr: { readonly number: number; readonly url: string }): void;
  /** Its session's transcript, as a hook named it: what its spend is read off. */
  transcript(path: string): void;
}

/** One run, for its adapter to turn into a command line. */
export interface LaunchInput<P> {
  /** Its first message. */
  readonly prompt: string;
  /** The folder it runs in: its task's worktree. */
  readonly cwd: string;
  /** Appended to its own system prompt: its slot's profile, from `./prompt.ts`. */
  readonly systemPrompt: string;
  /** What `prepare` set up. */
  readonly setup: P;
}

export interface LaunchPlan {
  readonly args: string[];
  /** Its own environment, set on top of what the runner passes it. */
  readonly env?: Record<string, string>;
}

export interface ProviderAdapter<P> {
  readonly id: string;
  /** Which CLI it is, e.g. `Claude`, for the runner's log. */
  readonly label: string;
  /** Its CLI, looked up on `PATH`. */
  readonly command: string;
  /** Its credential variables, the only ones of its own the runner passes it. */
  readonly credentialEnv?: readonly string[];
  /** Variables its own sessions set that would make it think it runs inside one: never passed. */
  readonly scrubEnv?: readonly string[];
  /** Once, as the runner starts: writes its settings and hook helper under `dataDir`. What it returns goes to launch. */
  prepare(dataDir: string): P;
  /** Its command line for one run. */
  launch(input: LaunchInput<P>): LaunchPlan;
  /**
   * It says itself when it is up, with a hook: still `starting` this long
   * after launch, it is taken to be stuck on a screen that needs a person,
   * and this says which.
   */
  readonly bootHint?: string;
  readonly hook: {
    /** One hook event from one of its runs, its body `{}` when that was not JSON. */
    handle(run: RunHandle, event: string, payload: unknown): void;
  };
  readonly screen?: {
    /** It reports progress with OSC 9;4: that catches a turn ending without a hook, Esc, say. */
    readonly progress?: boolean;
    /**
     * Why it cannot be used yet when its screen shows a first-run or sign-in
     * screen, else `undefined`. `early`: it has not started, or was already
     * found blocked.
     */
    blocked?(text: string, early: boolean): string | undefined;
  };
}
