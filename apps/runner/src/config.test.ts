/**
 * The runner's configuration refuses to boot when it is wrong. Each case is a
 * claim the README makes about a `RUNNER_*` variable, above all that a runner
 * is never configured past the server's own slot cap.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_RUNNER_SLOTS } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { readConfig, runnerIdFor } from "./config.js";

const SECRET = "a-runner-secret-long-enough";

function config(env: NodeJS.ProcessEnv) {
  return readConfig({ RUNNER_SECRET: SECRET, ...env }, "build-box.local");
}

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    readConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the configuration to be refused");
}

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n";

function withKey<T>(read: (keyFile: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "runner-app-"));
  try {
    const keyFile = join(dir, "app.pem");
    writeFileSync(keyFile, PEM);
    return read(keyFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readConfig", () => {
  it("needs only the secret, defaulting everything else for pnpm dev", () => {
    const read = config({});
    expect(read.serverUrl.href).toBe("http://localhost:2567/");
    expect(read.secret).toBe(SECRET);
    expect(read.repo).toBe("krasovsky22/agent-office-sims");
    expect(read.dataDir).toBe(join(homedir(), ".sim-runner"));
    expect(read.agent).toBe("mock");
    expect(read.mockOutcome).toBe("failed");
    expect(read.model).toBeUndefined();
    expect(read.maxAgents).toBe(2);
    expect(read.taskTimeoutMs).toBe(60 * 60_000);
    expect(read.dailyBudgetUsd).toBeUndefined();
    expect(read.runnerId).toBe("build-box");
    expect(read.issueLabel).toBe("agent-ready");
    expect(read.githubApp).toBeUndefined();
  });

  it("reads every variable", () => {
    const read = withKey((keyFile) =>
      config({
        RUNNER_SERVER_URL: "https://office-server.example/",
        RUNNER_REPO: "someone/something.else",
        RUNNER_DATA_DIR: "/srv/runner",
        RUNNER_AGENT: "Claude",
        RUNNER_MOCK_OUTCOME: "pr-opened",
        RUNNER_MODEL: "claude-sonnet-4-5",
        RUNNER_MAX_AGENTS: "4",
        RUNNER_TASK_TIMEOUT_MINUTES: "15",
        RUNNER_DAILY_BUDGET_USD: "12.50",
        RUNNER_GITHUB_APP_ID: "123456",
        RUNNER_GITHUB_APP_INSTALLATION_ID: "7890",
        RUNNER_GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
      }),
    );
    expect(read.serverUrl.href).toBe("https://office-server.example/");
    expect(read.repo).toBe("someone/something.else");
    expect(read.dataDir).toBe("/srv/runner");
    expect(read.agent).toBe("claude");
    expect(read.mockOutcome).toBe("pr-opened");
    expect(read.model).toBe("claude-sonnet-4-5");
    expect(read.maxAgents).toBe(4);
    expect(read.taskTimeoutMs).toBe(15 * 60_000);
    expect(read.dailyBudgetUsd).toBe(12.5);
  });

  it("refuses to start without a secret, or with one too short to be the server's", () => {
    expect(() => readConfig({})).toThrow(/RUNNER_SECRET is not set/);
    expect(() => readConfig({ RUNNER_SECRET: "   " })).toThrow(/RUNNER_SECRET is not set/);
    expect(() => readConfig({ RUNNER_SECRET: "short-secret" })).toThrow(/at least 16 characters, got 12/);
  });

  it("keeps the secret out of every message", () => {
    const secret = "a-secret-that-must-stay-out";
    for (const env of [{ RUNNER_MAX_AGENTS: "9" }, { RUNNER_SERVER_URL: "ftp://x" }, { RUNNER_REPO: "nope" }]) {
      expect(refusal({ RUNNER_SECRET: secret, ...env })).not.toContain(secret);
    }
    expect(refusal({ RUNNER_SECRET: "tooshort" })).not.toContain("tooshort");
  });

  it("refuses more slots than the server's cap, and fewer than one", () => {
    expect(config({ RUNNER_MAX_AGENTS: String(MAX_RUNNER_SLOTS) }).maxAgents).toBe(MAX_RUNNER_SLOTS);
    for (const raw of [String(MAX_RUNNER_SLOTS + 1), "0", "-1", "1.5", "two"]) {
      expect(() => config({ RUNNER_MAX_AGENTS: raw })).toThrow(/RUNNER_MAX_AGENTS must be a whole number from 1 to 4/);
    }
  });

  it("sends the secret over plain http only to this machine", () => {
    expect(config({ RUNNER_SERVER_URL: "http://127.0.0.1:2567" }).serverUrl.origin).toBe("http://127.0.0.1:2567");
    expect(config({ RUNNER_SERVER_URL: "http://[::1]:2567" }).serverUrl.origin).toBe("http://[::1]:2567");
    expect(() => config({ RUNNER_SERVER_URL: "http://office-server.example" })).toThrow(/must be https/);
    expect(() => config({ RUNNER_SERVER_URL: "ws://localhost:2567" })).toThrow(/must be http\(s\)/);
    expect(() => config({ RUNNER_SERVER_URL: "not a url" })).toThrow(/must be a URL/);
    expect(() => config({ RUNNER_SERVER_URL: "https://user:pass@office.example" })).toThrow(/must not carry credentials/);
  });

  it("keeps only the server's origin, so the sync path is always the contract's", () => {
    expect(config({ RUNNER_SERVER_URL: "https://office.example/some/path?q=1" }).serverUrl.href).toBe(
      "https://office.example/",
    );
  });

  it("refuses a repository that is not owner/name", () => {
    for (const raw of ["agent-office-sims", "a/b/c", "owner/", "own er/name"]) {
      expect(() => config({ RUNNER_REPO: raw })).toThrow(/RUNNER_REPO must be owner\/name/);
    }
  });

  it("refuses a relative data directory", () => {
    expect(() => config({ RUNNER_DATA_DIR: "runner-data" })).toThrow(/RUNNER_DATA_DIR must be an absolute path/);
  });

  it("refuses an agent it cannot run, and a mock outcome it does not know", () => {
    expect(() => config({ RUNNER_AGENT: "codex" })).toThrow(/RUNNER_AGENT must be one of mock, claude, got "codex"/);
    expect(() => config({ RUNNER_MOCK_OUTCOME: "merged" })).toThrow(/RUNNER_MOCK_OUTCOME must be one of failed, pr-opened/);
  });

  it("refuses a model name that is not one", () => {
    expect(config({ RUNNER_MODEL: "opus[1m]" }).model).toBe("opus[1m]");
    expect(() => config({ RUNNER_MODEL: "--dangerously-skip-permissions" })).toThrow(/RUNNER_MODEL must be a model name/);
    expect(() => config({ RUNNER_MODEL: "sonnet; rm -rf /" })).toThrow(/RUNNER_MODEL must be a model name/);
  });

  it("takes a daily budget of nothing, which refuses every start", () => {
    expect(config({ RUNNER_DAILY_BUDGET_USD: "0" }).dailyBudgetUsd).toBe(0);
  });

  it("refuses a daily budget that is not a plain amount of dollars", () => {
    for (const raw of ["-5", "$5", "five", "1e3", "5.", "Infinity", "2000000"]) {
      expect(() => config({ RUNNER_DAILY_BUDGET_USD: raw })).toThrow(/RUNNER_DAILY_BUDGET_USD must be an amount of US dollars/);
    }
  });

  it("refuses a task timeout that is not whole minutes", () => {
    for (const raw of ["0", "1.5", "-5", "soon"]) {
      expect(() => config({ RUNNER_TASK_TIMEOUT_MINUTES: raw })).toThrow(/RUNNER_TASK_TIMEOUT_MINUTES must be a whole number/);
    }
  });
});

describe("readConfig's GitHub App", () => {
  it("reads the App, its key from its file, and the issue label", () => {
    const read = withKey((keyFile) =>
      config({
        RUNNER_GITHUB_APP_ID: "123456",
        RUNNER_GITHUB_APP_INSTALLATION_ID: "7890",
        RUNNER_GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
        REAL_AGENT_ISSUE_LABEL: " ready-for-agents ",
      }),
    );
    expect(read.githubApp).toEqual({ appId: "123456", installationId: "7890", privateKey: PEM });
    expect(read.issueLabel).toBe("ready-for-agents");
  });

  it("is required for a claude agent, naming all three settings, and not for the mock", () => {
    expect(() => config({ RUNNER_AGENT: "claude" })).toThrow(
      /RUNNER_AGENT=claude .* needs RUNNER_GITHUB_APP_ID, RUNNER_GITHUB_APP_INSTALLATION_ID, RUNNER_GITHUB_APP_PRIVATE_KEY_FILE/,
    );
    expect(config({ RUNNER_AGENT: "mock" }).githubApp).toBeUndefined();
  });

  it("takes all three settings or none", () => {
    expect(() => config({ RUNNER_GITHUB_APP_ID: "123456" })).toThrow(
      /RUNNER_GITHUB_APP_INSTALLATION_ID, RUNNER_GITHUB_APP_PRIVATE_KEY_FILE not set/,
    );
  });

  it("refuses ids that are not numbers, a relative key path, and a file that is no key", () => {
    withKey((keyFile) => {
      const app = { RUNNER_GITHUB_APP_ID: "123456", RUNNER_GITHUB_APP_INSTALLATION_ID: "7890", RUNNER_GITHUB_APP_PRIVATE_KEY_FILE: keyFile };
      expect(() => config({ ...app, RUNNER_GITHUB_APP_ID: "my-app" })).toThrow(/RUNNER_GITHUB_APP_ID must be the App's numeric id/);
      expect(() => config({ ...app, RUNNER_GITHUB_APP_PRIVATE_KEY_FILE: "app.pem" })).toThrow(/must be an absolute path/);
      writeFileSync(keyFile, "not a key");
      expect(() => config(app)).toThrow(/is not a PEM private key/);
      expect(() => config({ ...app, RUNNER_GITHUB_APP_PRIVATE_KEY_FILE: join(keyFile, "missing") })).toThrow(/could not be read/);
    });
  });
});

describe("runnerIdFor", () => {
  it("narrows a host name to what the sync contract takes as a runner id", () => {
    expect(runnerIdFor("build-box.local")).toBe("build-box");
    expect(runnerIdFor("Vlad's MacBook Pro")).toBe("Vlad-s-MacBook-Pro");
    expect(runnerIdFor("a".repeat(40))).toBe("a".repeat(32));
    expect(runnerIdFor("")).toBe("runner");
  });
});
