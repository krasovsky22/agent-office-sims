/**
 * The runner's default GitHub identity: a GitHub App installed on the one
 * repository it works on, whose short-lived installation tokens are what its
 * agents push and open pull requests with.
 *
 * An App rather than a person's token because the runner runs unattended and
 * its agents run whatever their task leads them to: the App can only do what
 * its installation allows (contents and pull requests write, issues read), on
 * that repository alone, and each token it mints lasts an hour. Merging stays
 * out of reach of the agents through branch protection on the default branch,
 * which the README's setup asks for.
 *
 * A token is minted by signing a JWT with the App's private key and trading
 * it for an installation token, which is asked for on the one repository
 * only. The current one is kept in a GitHub CLI config dir of the runner's
 * own, rewritten before it expires: the agents and the runner's own `gh` and
 * `git` read it from there on every call, so a run that outlives one token
 * carries on with the next, where a token set once in an agent's environment
 * would not.
 */

import { createSign } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What the operator configures for the App. */
export interface GithubAppConfig {
  /** The App's numeric id, from its settings page. */
  readonly appId: string;
  /** The numeric id of its installation on the repository. */
  readonly installationId: string;
  /** Its private key, PEM. Never logged. */
  readonly privateKey: string;
}

/** Minted tokens last an hour; a new one is minted once this little of one is left. */
const REFRESH_BEFORE_EXPIRY_MS = 20 * 60_000;

/** How often the token is checked, so the config dir never holds an expired one. */
const CHECK_INTERVAL_MS = 5 * 60_000;

const API_URL = "https://api.github.com";

/** Variables that would make `gh` use another token than the App's: `GH_TOKEN` wins over the config dir. */
export const GITHUB_TOKEN_ENV: readonly string[] = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export interface GithubAppCredentialsOptions {
  readonly app: GithubAppConfig;
  /** `owner/name`: the one repository its tokens are asked for. */
  readonly repo: string;
  /** The GitHub CLI config dir the current token is kept in; the runner's own. */
  readonly configDir: string;
  /** Each new token, so the runner can mask it on its screens. */
  readonly onToken?: (token: string) => void;
  readonly log?: (line: string) => void;
  /** Injected so a test can answer for GitHub. */
  readonly fetch?: FetchLike;
  /** Epoch milliseconds. Injected so a test controls the clock. */
  readonly now?: () => number;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * The JWT an App authenticates as itself with: RS256, issued a minute in the
 * past for clock drift, and valid for nine minutes, under GitHub's ten.
 */
export function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

/** The environment that makes `gh`, and `git` through it, use the token in `configDir`, whatever the user's own setup. */
export function appCredentialEnv(configDir: string): Record<string, string> {
  return {
    GH_CONFIG_DIR: configDir,
    GH_PROMPT_DISABLED: "1",
    // An empty helper clears the ones git has already read, the user's own
    // keychain among them, so a push can only go as the App.
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_CONFIG_KEY_2: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_2: "!gh auth git-credential",
  };
}

/**
 * What the runner needs of an agent identity on GitHub, whichever it is: the
 * App, or a person's token (`./githubPersonal.ts`).
 */
export interface GithubCredentials {
  /** What an agent or a `gh` call needs in its environment to act as this identity. */
  env(): Record<string, string>;
  /** Makes sure the config dir holds a usable token; rejects with why when GitHub would not take it. */
  fresh(): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * Writes `token` as `gh`'s login in `configDir`, whole and moved into place,
 * so a `gh` reading it never sees half a file.
 */
export function writeGhHosts(configDir: string, token: string, user: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const hosts = join(configDir, "hosts.yml");
  const partial = `${hosts}.partial`;
  writeFileSync(partial, `github.com:\n    oauth_token: ${token}\n    git_protocol: https\n    user: ${user}\n`, {
    mode: 0o600,
  });
  renameSync(partial, hosts);
}

export class GithubAppCredentials implements GithubCredentials {
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private expiresAt = 0;
  private minting: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(private readonly options: GithubAppCredentialsOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  /** What an agent or a `gh` call needs in its environment to act as the App. */
  public env(): Record<string, string> {
    return appCredentialEnv(this.options.configDir);
  }

  /**
   * Makes sure the config dir holds a token with time left on it, minting one
   * when it does not. Rejects with why when GitHub would not give one.
   */
  public fresh(): Promise<void> {
    if (this.now() < this.expiresAt - REFRESH_BEFORE_EXPIRY_MS) {
      return Promise.resolve();
    }
    this.minting ??= this.mint().finally(() => {
      this.minting = undefined;
    });
    return this.minting;
  }

  /** Keeps the token fresh in the background, so a long run's next push still has one. */
  public start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      this.fresh().catch((error: unknown) => {
        this.log(`could not refresh the GitHub App token: ${(error as Error).message}`);
      });
    }, CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  public stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async mint(): Promise<void> {
    const { app, repo } = this.options;
    const name = repo.split("/")[1] ?? repo;
    const response = await this.fetch(`${API_URL}/app/installations/${app.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt(app.appId, app.privateKey, this.now())}`,
        "content-type": "application/json",
        "user-agent": "agent-office-sims-runner",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ repositories: [name] }),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub refused an installation token (HTTP ${response.status}); check RUNNER_GITHUB_APP_ID, ` +
          `RUNNER_GITHUB_APP_INSTALLATION_ID, the private key, and that the App is installed on ${repo}`,
      );
    }
    const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
    const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
    if (typeof body.token !== "string" || body.token === "" || Number.isNaN(expiresAt)) {
      throw new Error("GitHub's installation token response had no token in it");
    }
    this.options.onToken?.(body.token);
    writeGhHosts(this.options.configDir, body.token, "x-access-token");
    this.expiresAt = expiresAt;
  }
}
