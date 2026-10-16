/**
 * Keeps the runner's own secrets off the agents' screens.
 *
 * Everything on a slot's screen goes to every client in the office, and an
 * agent can print anything it can read: `env`, a config file, a failing
 * command that echoes its token. So before a frame leaves the runner, every
 * secret value the runner holds is masked in the text of its runs, whatever
 * colours it was drawn in and however it wrapped.
 *
 * The secrets are the runner's own: `RUNNER_SECRET`, and every variable in
 * its environment whose name says it holds a secret, since the runner's
 * agents inherit that environment. Values too short to be a credential are
 * left alone; masking them would hide ordinary words.
 */

/** A styled run as the snapshot builds it, before it is frozen into a frame. */
export type MutableRun = [text: string, fg: number, bg: number, flags: number];

/** Names of variables that hold secrets. */
const SECRET_NAME = /SECRET|TOKEN|PASSWORD|PASSPHRASE|CREDENTIAL|(?:^|_)KEY(?:$|_)|API_?KEY/i;

/** Shortest value treated as a secret. */
const MIN_SECRET_LENGTH = 8;

/**
 * Shortest start of a secret masked at the end of a line, where an agent is
 * still printing it: long enough that ordinary text rarely matches it.
 */
const MIN_PARTIAL_LENGTH = 4;

/** What stands in for each character of a secret. */
const MASK = "*";

export interface Redactor {
  /** The longest secret, in characters; `0` when there is none. */
  readonly longest: number;
  /**
   * Masks every secret in a screen's rows, in place.
   *
   * @param rows each row's runs, top to bottom.
   * @param wrapped whether each row continues the row above it.
   * @param above the text a wrapped first row continues, from above the
   * screen, so a secret cut by the top edge is still found; `""` when none.
   */
  redact(rows: readonly MutableRun[][], wrapped: readonly boolean[], above: string): void;
  /** `text` with every secret in it masked: a status line or an event's message. */
  redactText(text: string): string;
}

/** Every secret value the runner holds: the given ones, and the environment's. */
export function runnerSecrets(env: NodeJS.ProcessEnv, own: readonly string[]): string[] {
  const secrets = [...own];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && SECRET_NAME.test(name)) {
      secrets.push(value.trim());
    }
  }
  return secrets;
}

export function createRedactor(secrets: readonly string[]): Redactor {
  // Longest first, so a secret that contains another is masked whole.
  const list = [...new Set(secrets)]
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  return {
    longest: list[0]?.length ?? 0,
    redact(rows, wrapped, above) {
      if (list.length === 0) {
        return;
      }
      let start = 0;
      while (start < rows.length) {
        let end = start + 1;
        while (end < rows.length && wrapped[end] === true) {
          end += 1;
        }
        maskLine(list, rows.slice(start, end), start === 0 ? above : "");
        start = end;
      }
    },
    redactText(text) {
      const run: MutableRun = [text, 0, 0, 0];
      if (list.length > 0) {
        maskLine(list, [[run]], "");
      }
      return run[0];
    },
  };
}

/** Masks every secret in one logical line: a row and the rows that wrap on from it. */
function maskLine(secrets: readonly string[], rows: readonly MutableRun[][], before: string): void {
  let text = before;
  for (const runs of rows) {
    for (const run of runs) {
      text += run[0];
    }
  }
  let masked: Uint8Array | undefined;
  const mark = (from: number, to: number): void => {
    masked ??= new Uint8Array(text.length);
    masked.fill(1, from, to);
  };
  for (const secret of secrets) {
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
      mark(at, at + secret.length);
    }
    for (let length = Math.min(secret.length - 1, text.length); length >= MIN_PARTIAL_LENGTH; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        mark(text.length - length, text.length);
        break;
      }
    }
  }
  if (masked === undefined) {
    return;
  }
  const marks = masked;
  let offset = before.length;
  for (const runs of rows) {
    for (const run of runs) {
      const from = offset;
      offset += run[0].length;
      if (marks.subarray(from, offset).includes(1)) {
        // By UTF-16 unit, the unit the marks are counted in.
        let replaced = "";
        for (let index = 0; index < run[0].length; index += 1) {
          replaced += marks[from + index] === 1 ? MASK : run[0].charAt(index);
        }
        run[0] = replaced;
      }
    }
  }
}
