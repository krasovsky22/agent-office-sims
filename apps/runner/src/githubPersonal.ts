/**
 * A real agent's GitHub identity when the operator opts out of the runner's
 * GitHub App (`RUNNER_GITHUB_AUTH=personal`): a person's own token, from
 * `RUNNER_GITHUB_TOKEN` or the machine's `gh` login.
 *
 * Simpler to set up than an App, at a price the README spells out: the agents
 * act as that person, with everything the token can reach, not one
 * repository's contents and pull requests. So it is never a fallback, only a
 * choice made by name.
 *
 * The token is handed over the way the App's is: written into the runner's own
 * `gh` config dir, which the agents and the runner's `gh` and `git` read
 * through {@link appCredentialEnv}, with the user's own `GH_TOKEN` and git
 * helpers kept out. A person's token does not expire on the runner's clock, so
 * it is written once and never refreshed.
 */

import { appCredentialEnv, type GithubCredentials, writeGhHosts } from "./githubApp.js";

/** Where a personal token came from, said at boot so the operator knows whose it is. */
export type PersonalTokenSource = "RUNNER_GITHUB_TOKEN" | "gh auth token";

export interface PersonalGithubConfig {
  /** Never logged. */
  readonly token: string;
  readonly source: PersonalTokenSource;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export interface PersonalGithubCredentialsOptions {
  readonly personal: PersonalGithubConfig;
  /** The GitHub CLI config dir the token is kept in; the runner's own. */
  readonly configDir: string;
  /** Injected so a test can answer for GitHub. */
  readonly fetch?: FetchLike;
}

const API_URL = "https://api.github.com";

export class PersonalGithubCredentials implements GithubCredentials {
  private readonly fetch: FetchLike;
  private checked: Promise<void> | undefined;
  private account: string | undefined;

  public constructor(private readonly options: PersonalGithubCredentialsOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The login the token belongs to, once {@link fresh} has asked GitHub. */
  public get login(): string | undefined {
    return this.account;
  }

  public env(): Record<string, string> {
    return appCredentialEnv(this.options.configDir);
  }

  /**
   * The first call asks GitHub whose token it is, so one it refuses stops the
   * runner at boot, and writes it into the config dir; later calls have
   * nothing to do.
   */
  public fresh(): Promise<void> {
    this.checked ??= this.check().catch((error: unknown) => {
      this.checked = undefined;
      throw error;
    });
    return this.checked;
  }

  public start(): void {}

  public stop(): void {}

  private async check(): Promise<void> {
    const { personal, configDir } = this.options;
    const response = await this.fetch(`${API_URL}/user`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${personal.token}`,
        "user-agent": "agent-office-sims-runner",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub refused the personal token from ${personal.source} (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { login?: unknown };
    const login = typeof body.login === "string" && body.login !== "" ? body.login : undefined;
    writeGhHosts(configDir, personal.token, login ?? "x-access-token");
    this.account = login;
  }
}
