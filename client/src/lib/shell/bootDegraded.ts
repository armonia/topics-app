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
 * Ask the shell whether this boot is the degraded one. One question per app life:
 * the verdict is decided once at boot and never changes, so the answer is cached
 * (including the null, so a web client asks nothing at all).
 */
export function fetchBootDegraded(): Promise<BootDegraded | null> {
  if (cached) return cached;
  if (shellKind !== 'tauri') {
    cached = Promise.resolve(null);
    return cached;
  }
  cached = tauriInvoke<unknown>('boot_degraded')
    .then(parseBootDegraded)
    // An older shell has no such command. Silence is the right answer: the client
    // then behaves exactly as it did before this existed.
    .catch(() => null);
  return cached;
}

let cached: Promise<BootDegraded | null> | null = null;

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
