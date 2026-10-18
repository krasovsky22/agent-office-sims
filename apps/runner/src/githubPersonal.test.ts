/**
 * A person's token as the agents' GitHub identity: GitHub is asked whose it
 * is once, a token it refuses stops the runner, and the token is handed over
 * through the same private `gh` config dir as the App's.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appCredentialEnv } from "./githubApp.js";
import { PersonalGithubCredentials } from "./githubPersonal.js";

const TOKEN = "ghp_a-personal-token-long-enough";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sims-personal-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function credentials(answer: { ok: boolean; status: number; body?: unknown }) {
  const requests: { url: string; method: string; headers: Record<string, string> }[] = [];
  const personal = new PersonalGithubCredentials({
    personal: { token: TOKEN, source: "gh auth token" },
    configDir: join(dir, "gh"),
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      return { ok: answer.ok, status: answer.status, json: async () => answer.body };
    },
  });
  return { personal, requests };
}

describe("PersonalGithubCredentials", () => {
  it("asks GitHub whose token it is once, and keeps it in the runner's own gh config dir", async () => {
    const { personal, requests } = credentials({ ok: true, status: 200, body: { login: "octocat" } });
    await personal.fresh();
    await personal.fresh();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.github.com/user");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(personal.login).toBe("octocat");
    const hosts = join(dir, "gh", "hosts.yml");
    expect(readFileSync(hosts, "utf8")).toBe(`github.com:\n    oauth_token: ${TOKEN}\n    git_protocol: https\n    user: octocat\n`);
    expect(statSync(hosts).mode & 0o777).toBe(0o600);
    expect(personal.env()).toEqual(appCredentialEnv(join(dir, "gh")));
  });

  it("refuses a token GitHub will not take, naming where it came from but not the token, and asks again next time", async () => {
    const { personal, requests } = credentials({ ok: false, status: 401 });
    const refused = personal.fresh();
    await expect(refused).rejects.toThrow("GitHub refused the personal token from gh auth token (HTTP 401)");
    await expect(refused).rejects.not.toThrow(TOKEN);
    await expect(personal.fresh()).rejects.toThrow(/HTTP 401/);
    expect(requests).toHaveLength(2);
    expect(personal.login).toBeUndefined();
  });
});
