/**
 * The runner's GitHub App: its JWT verifies with the App's public key, a
 * token is minted for the one repository and kept in the runner's own `gh`
 * config dir, and a new one is minted only when the last is running out.
 */

import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GithubAppCredentials, appCredentialEnv, appJwt } from "./githubApp.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP = { appId: "123456", installationId: "7890", privateKey };
const NOW = Date.parse("2026-10-16T12:00:00Z");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sims-app-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function decode(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("appJwt", () => {
  it("is an RS256 JWT for the App, issued a minute back and valid for nine", () => {
    const jwt = appJwt(APP.appId, APP.privateKey, NOW);
    const [header, payload, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const now = NOW / 1000;
    expect(decode(payload)).toEqual({ iat: now - 60, exp: now + 540, iss: "123456" });
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(createPublicKey(publicKey), signature ?? "", "base64url");
    expect(verified).toBe(true);
  });
});

describe("GithubAppCredentials", () => {
  function credentials(expiresAt: string, minted: string[] = []) {
    let clock = NOW;
    const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
    const tokens: string[] = [];
    const app = new GithubAppCredentials({
      app: APP,
      repo: "krasovsky22/agent-office-sims",
      configDir: join(dir, "gh"),
      onToken: (token) => tokens.push(token),
      now: () => clock,
      fetch: async (url, init) => {
        requests.push({ url, headers: init.headers, body: init.body });
        const token = `ghs_${"x".repeat(30)}${requests.length}`;
        minted.push(token);
        return { ok: true, status: 201, json: async () => ({ token, expires_at: expiresAt }) };
      },
    });
    return {
      app,
      requests,
      tokens,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("mints a token for the one repository and keeps it in its gh config dir", async () => {
    const { app, requests, tokens } = credentials("2026-10-16T13:00:00Z");
    await app.fresh();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.github.com/app/installations/7890/access_tokens");
    expect(requests[0]?.headers["authorization"]).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({ repositories: ["agent-office-sims"] });
    const hosts = join(dir, "gh", "hosts.yml");
    expect(readFileSync(hosts, "utf8")).toContain(`oauth_token: ${tokens[0] ?? "?"}`);
    expect(statSync(hosts).mode & 0o777).toBe(0o600);
  });

  it("mints again only once the token is running out", async () => {
    const { app, requests, advance } = credentials("2026-10-16T13:00:00Z");
    await app.fresh();
    advance(30 * 60_000);
    await app.fresh();
    expect(requests).toHaveLength(1);
    advance(15 * 60_000);
    await app.fresh();
    expect(requests).toHaveLength(2);
  });

  it("says what to check when GitHub refuses", async () => {
    const app = new GithubAppCredentials({
      app: APP,
      repo: "krasovsky22/agent-office-sims",
      configDir: join(dir, "gh"),
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    await expect(app.fresh()).rejects.toThrow(/HTTP 404.*installed on krasovsky22\/agent-office-sims/);
  });

  it("points gh at its config dir, and git at gh alone for github.com", () => {
    const env = appCredentialEnv("/runner/gh");
    expect(env["GH_CONFIG_DIR"]).toBe("/runner/gh");
    expect(env["GIT_CONFIG_COUNT"]).toBe("3");
    expect([env["GIT_CONFIG_VALUE_0"], env["GIT_CONFIG_VALUE_1"], env["GIT_CONFIG_VALUE_2"]]).toEqual([
      "",
      "",
      "!gh auth git-credential",
    ]);
  });
});
