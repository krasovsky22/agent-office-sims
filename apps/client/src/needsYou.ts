/**
 * Telling the CEO an agent needs them, wherever they are looking.
 *
 * The "Needs you" beacon is drawn in the scene and the roster, which a CEO
 * facing the wrong way or in another tab never sees, while the agent waits
 * at its prompt for as long as nobody answers. So the CEO's tab also counts
 * the waiting agents in its title, chimes when one starts waiting, and puts
 * up a desktop notification once the CEO has allowed them. Everyone else's
 * tab says nothing: only the CEO can answer.
 */

/** The page title with the number of agents waiting on the CEO, or unchanged when none is. */
export function needsYouTitle(baseTitle: string, waiting: number): string {
  return waiting === 0 ? baseTitle : `(${waiting}) Needs you · ${baseTitle}`;
}

/** The agents in `waiting` that were not in `before`: the ones to chime and notify about. */
export function newlyWaiting(before: ReadonlySet<string>, waiting: readonly string[]): string[] {
  return waiting.filter((id) => !before.has(id));
}

/** Whether this browser can show desktop notifications at all. */
export function notificationsSupported(): boolean {
  return typeof Notification !== "undefined";
}

let audio: AudioContext | undefined;

/**
 * Two short rising notes. Synthesised rather than a file, so there is no
 * asset to load. A browser that has not seen the player click or type yet
 * keeps the audio suspended, and the chime is then silently skipped.
 */
export function chime(): void {
  if (typeof AudioContext === "undefined") {
    return;
  }
  audio ??= new AudioContext();
  const context = audio;
  void context.resume().catch(() => {});
  const start = context.currentTime;
  for (const [offset, frequency] of [
    [0, 660],
    [0.12, 880],
  ] as const) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.15, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.25);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.3);
  }
}

/**
 * A desktop notification that agent `agentId`, called `name`, needs the CEO, when the CEO has allowed
 * them; clicking it brings the tab forward and runs `open`.
 */
export function notifyNeedsYou(agentId: string, name: string, caption: string, open: () => void): void {
  if (!notificationsSupported() || Notification.permission !== "granted") {
    return;
  }
  // One per agent: a second wait replaces the first rather than stacking up.
  const notification = new Notification(`${name} needs you`, { body: caption, tag: `needs-you:${agentId}` });
  notification.onclick = () => {
    window.focus();
    open();
    notification.close();
  };
}
