// The shell's boot verdict, for the SPA's own offline state.
//
// WHY THIS EXISTS, measured on Windows 2.2.199 on 2026-08-28 (board card d1f702ab).
// The Tauri shell writes a marker the first time it finds a real Topics server on
// :3333. From then on, if nobody answers there it WAITS instead of spawning its
// bundled sidecar: forking an empty universe over a slow-but-alive server once cost
// the user every task and tab (the 2026-08-13 incident). That rule is right and it
// stays.
//
// What was wrong is that the wait was MUTE where the person looks. The shell does
// explain itself on the reconnect page, but that page is served by the loopback
// proxy and only in place of a document navigation: the window loads its bundle from
// the app's own scheme, so the SPA paints, its API calls find nobody, and the whole
// message is a red dot. Measured on the machine: the app listened on no port at all
// and said "Reconnecting" forever.
//
// So the fact comes over IPC, which works with no server at all, and the offline
// surface says it. Off Tauri (web / PWA) there is no shell to ask and this module
// answers null: a browser tab's outage is an ordinary outage.

import { shellKind } from './index';
import { tauriInvoke } from './tauri';

/** The shell deferred to a server that never answered, and this is the file that
 *  made it defer. Present ONLY in the degraded case. */
export interface BootDegraded {
  /** Absolute path of the `external-server-seen` marker. */
  markerPath: string;
  /** The port the shell is waiting on (3333 today, told by the shell so the
   *  sentence and the probe can never disagree). */
  port: number;
}

/**
 * Read the shell's answer.
 *
 * Returns null for everything that is NOT the degraded case: an ordinary outage, a
 * shell too old to answer, a malformed payload. That asymmetry is deliberate — this
 * explanation must appear only when it is true, because a sentence about a marker
 * file during a plain server restart would send whoever reads it to delete a file
 * that has nothing to do with the wait.
 */
export function parseBootDegraded(raw: unknown): BootDegraded | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { degraded?: unknown; markerPath?: unknown; port?: unknown };
  if (o.degraded !== true) return null;
  if (typeof o.markerPath !== 'string' || o.markerPath.length === 0) return null;
  // A path with no port to go with it is still worth showing: the way out is the
  // file, and the port is only part of the explanation. Falls back to the fixed
  // one the shell has always used rather than printing "undefined".
  const port = typeof o.port === 'number' && Number.isFinite(o.port) ? o.port : 3333;
  return { markerPath: o.markerPath, port };
}

/**
 * Ask the shell whether this boot is the degraded one.
 *
 * NO ANSWER IS CACHED, and the yes least of all. Measured on the Windows machine
 * on 2026-08-28, with a stopwatch on the shell's own stderr: the window paints at
 * about +5s, and the boot verdict lands at about +150s. So a question asked once,
 * at mount, is asked roughly 145 seconds before the shell has an answer, and
 * caching that early "no" meant the explanation could never appear for the whole
 * life of the app.
 *
 * The yes was cached too, on the belief that the verdict was written once and
 * never unset. It is not: the shell publishes the marker's path before the search
 * and RETRACTS it on the branch where deleting the marker would change nothing (a
 * live daemon pid, `lib.rs` `WaitForKnownServer`). A cached yes survived that
 * retraction, so the bar kept offering "delete the marker" for the rest of the
 * session and the button answered "not degraded" (board card c0faad1d). The only
 * true answer is the last one the shell gave, so every call asks.
 *
 * Off Tauri the answer is null without asking anybody: a browser tab has no
 * shell to have a verdict.
 */
export function fetchBootDegraded(askShell: () => Promise<unknown> = shellAnswer): Promise<BootDegraded | null> {
  // Concurrent callers still share one round trip, and the sharing ends with the
  // answer: the next question is a new question.
  if (inFlight) return inFlight;
  const asked = askShell()
    .then(parseBootDegraded)
    // An older shell has no such command. Silence is the right answer: the client
    // then behaves exactly as it did before this existed.
    .catch(() => null);
  inFlight = asked;
  void asked.then(() => {
    if (inFlight === asked) inFlight = null;
  });
  return asked;
}

/** The transport, named so a test can hand in a shell that changes its mind
 *  without replacing the module for the whole process. */
function shellAnswer(): Promise<unknown> {
  if (shellKind !== 'tauri') return Promise.resolve(null);
  return tauriInvoke<unknown>('boot_degraded');
}

let inFlight: Promise<BootDegraded | null> | null = null;

/**
 * Do the way out instead of describing it: the shell deletes the marker and
 * relaunches itself.
 *
 * Resolves ONLY when nothing happened — on success the process is replaced, so
 * this promise never settles and there is no "done" state to draw. The string it
 * resolves with is why it did not: an older shell without the command, or a boot
 * that was not the degraded one (the shell gates on its own verdict, so a click
 * cannot remove a marker that is doing its job).
 */
export async function clearBootDegraded(): Promise<string> {
  if (shellKind !== 'tauri') return 'no shell';
  try {
    const r = await tauriInvoke<unknown>('boot_degraded_clear');
    const o = (r && typeof r === 'object' ? r : {}) as { reason?: unknown };
    return typeof o.reason === 'string' && o.reason ? o.reason : 'unchanged';
  } catch {
    // An older shell has no such command; the printed path is still the way out.
    return 'unsupported';
  }
}

/**
 * KEEP ASKING WHILE THERE IS NOTHING TO CONNECT TO, and report every answer,
 * the null included.
 *
 * The bar used to stop at the first yes (`if (degraded || connected) return;`),
 * which is the client half of the same bug as the cache above: the shell retracts
 * its verdict when the marker is not what makes it wait, and nobody was listening
 * any more. So the loop runs for as long as the app is disconnected and hands over
 * whatever the shell says now, so the sentence and its button disappear the moment
 * they stop being true.
 *
 * Returns the stopper, which is what a React effect has to give back.
 */
export function watchBootDegraded(
  report: (d: BootDegraded | null) => void,
  intervalMs = 5000,
  ask: () => Promise<BootDegraded | null> = fetchBootDegraded,
): () => void {
  let alive = true;
  const round = () => {
    void ask().then((d) => {
      if (alive) report(d);
    });
  };
  round();
  const timer = setInterval(round, intervalMs);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

/** What the offline surface has to print: the two sentences (as catalogue keys, so
 *  the language stays where every other string lives) plus the marker's path. */
export interface DegradedNotice {
  whyKey: 'statusBar.degraded.why';
  wayOutKey: 'statusBar.degraded.wayOut';
  /** Interpolated into `whyKey` — the port the shell says it is waiting on. */
  port: string;
  markerPath: string;
}

/**
 * The gate, kept out of the component so it can be proved without a screen (which
 * is exactly how this bug was found: by reading what the shell answers, not by
 * looking at pixels).
 *
 * Two conditions, both necessary. The shell must have said `degraded`, and the app
 * must NOT be connected: a machine whose server came back is a machine with nothing
 * to explain, and leaving the sentence up next to a live connection would send
 * somebody to delete a marker that is doing its job.
 */
export function degradedNotice(
  d: BootDegraded | null,
  wsStatus: string | undefined,
): DegradedNotice | null {
  if (!d) return null;
  if (wsStatus === 'connected') return null;
  return {
    whyKey: 'statusBar.degraded.why',
    wayOutKey: 'statusBar.degraded.wayOut',
    port: String(d.port),
    markerPath: d.markerPath,
  };
}
