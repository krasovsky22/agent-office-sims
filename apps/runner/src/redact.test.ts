/**
 * The redactor: every secret the runner holds is masked in a screen's runs,
 * however it was styled, wrapped or cut off, and nothing else is touched.
 */

import { describe, expect, it } from "vitest";

import { type MutableRun, createRedactor, runnerSecrets } from "./redact.js";

const SECRET = "a-runner-secret-long-enough";
const MASKED = stars(SECRET.length);

function stars(count: number): string {
  return "*".repeat(count);
}

function plain(text: string): MutableRun {
  return [text, -1, -1, 0];
}

function texts(rows: readonly MutableRun[][]): string[] {
  return rows.map((runs) => runs.map((run) => run[0]).join(""));
}

describe("createRedactor", () => {
  it("masks a secret in one run, keeping every cell", () => {
    const rows = [[plain(`RUNNER_SECRET=${SECRET} done`)]];
    createRedactor([SECRET]).redact(rows, [false], "");
    expect(texts(rows)).toEqual([`RUNNER_SECRET=${MASKED} done`]);
  });

  it("masks a secret split across differently styled runs, keeping their styles", () => {
    const rows: MutableRun[][] = [[plain("token: a-runner-"), ["secret", 1, -1, 1], plain("-long-enough!")]];
    createRedactor([SECRET]).redact(rows, [false], "");
    expect(rows).toEqual([[plain(`token: ${stars(9)}`), [stars(6), 1, -1, 1], plain(`${stars(12)}!`)]]);
  });

  it("masks every occurrence on every row", () => {
    const rows = [[plain(`${SECRET} ${SECRET}`)], [plain("nothing here")], [plain(`x${SECRET}`)]];
    createRedactor([SECRET]).redact(rows, [false, false, false], "");
    expect(texts(rows)).toEqual([`${MASKED} ${MASKED}`, "nothing here", `x${MASKED}`]);
  });

  it("masks a secret wrapped across rows", () => {
    const rows = [[plain("export X=a-runner-sec")], [plain("ret-long-enough")]];
    createRedactor([SECRET]).redact(rows, [false, true], "");
    expect(texts(rows)).toEqual([`export X=${stars(12)}`, stars(15)]);
  });

  it("does not join rows that do not wrap", () => {
    const rows = [[plain("a-runner-sec")], [plain("ret-long-enough")]];
    createRedactor([SECRET]).redact(rows, [false, false], "");
    expect(texts(rows)).toEqual([stars(12), "ret-long-enough"]);
  });

  it("masks the rest of a secret whose start is above the screen", () => {
    const rows = [[plain("ret-long-enough and on")]];
    createRedactor([SECRET]).redact(rows, [true], "export X=a-runner-sec");
    expect(texts(rows)).toEqual([`${stars(15)} and on`]);
  });

  it("masks the start of a secret still being printed at the end of a line", () => {
    const rows = [[plain("export X=a-runner-se")]];
    createRedactor([SECRET]).redact(rows, [false], "");
    expect(texts(rows)).toEqual([`export X=${stars(11)}`]);
  });

  it("masks the longer of two secrets whole when one contains the other", () => {
    const rows = [[plain(`${SECRET}-and-more`)]];
    createRedactor([SECRET, `${SECRET}-and-more`]).redact(rows, [false], "");
    expect(texts(rows)).toEqual([stars(SECRET.length + 9)]);
  });

  it("masks every secret in plain text, as an event's message carries it", () => {
    const redactor = createRedactor([SECRET]);
    expect(redactor.redactText(`Claude exited with code 1: TOKEN=${SECRET}`)).toBe(`Claude exited with code 1: TOKEN=${MASKED}`);
    expect(createRedactor([]).redactText(`TOKEN=${SECRET}`)).toBe(`TOKEN=${SECRET}`);
  });

  it("leaves short values and screens without secrets alone", () => {
    const rows = [[plain("true 1234 secret")]];
    const redactor = createRedactor(["true", "1234", ""]);
    redactor.redact(rows, [false], "");
    expect(texts(rows)).toEqual(["true 1234 secret"]);
    expect(redactor.longest).toBe(0);
  });
});

describe("runnerSecrets", () => {
  it("takes the runner's own secret and every variable named as a secret", () => {
    const env = {
      RUNNER_SECRET: SECRET,
      GITHUB_TOKEN: "ghp_abcdefghijklmnop",
      ANTHROPIC_API_KEY: "sk-ant-0123456789",
      DB_PASSWORD: " hunter2hunter2 ",
      SIGNING_KEY: "0123456789abcdef",
      PATH: "/usr/bin:/bin",
      HOME: "/home/runner",
      MONKEY_BUSINESS: "not-a-secret-at-all",
    };
    expect(runnerSecrets(env, ["own-secret-value"]).sort()).toEqual(
      ["own-secret-value", SECRET, "ghp_abcdefghijklmnop", "sk-ant-0123456789", "hunter2hunter2", "0123456789abcdef"].sort(),
    );
  });
});
