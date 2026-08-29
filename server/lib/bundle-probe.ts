import { bundleBreakageReason } from "./client-bundle";

/**
 * A missing bundle while the server is UP is an alarm, not a detail.
 *
 * On 29/08 `public/index.html` was gone and `public/assets/` empty for an
 * unknown number of minutes: whoever had the window open and reloaded got
 * nothing. Nothing said so - not the card, not the log, not a badge - because
 * nothing was measuring the one thing that was broken. The server itself hides
 * it well: it answers from the last good shell it cached in memory, so the
 * process that still has the old HTML looks healthy while a fresh window gets
 * a 503.
 *
 * So the state of the served directory is checked periodically and it is
 * READABLE: an explicit error line the moment it breaks (and again every
 * `repeatMs`, because a line scrolled past an hour ago is not an alarm), one
 * line when it comes back, and `state()` for `/__daemon/healthz`.
 */
export interface BundleProbeState {
  ok: boolean;
  /** What is missing, when it is missing. */
  reason: string | null;
  /** When this state started (ms epoch). */
  since: number;
  /** When it was last looked at (ms epoch), 0 before the first check. */
  checkedAt: number;
}

export interface BundleProbe {
  stop: () => void;
  state: () => BundleProbeState;
  /** Force a check now (used by the tests and by the first call at boot). */
  check: () => BundleProbeState;
}

export function startBundleProbe(opts: {
  publicDir: string;
  /** How often to look. Default 60s. */
  intervalMs?: number;
  /** How often to repeat the alarm while it stays broken. Default 10 min. */
  repeatMs?: number;
  log?: (line: string) => void;
  /** Test hook: false keeps the probe passive (no timer). */
  schedule?: boolean;
  verify?: (publicDir: string) => string | null;
  now?: () => number;
}): BundleProbe {
  const intervalMs = opts.intervalMs ?? 60_000;
  const repeatMs = opts.repeatMs ?? 10 * 60_000;
  const verify = opts.verify ?? bundleBreakageReason;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((line: string) => console.error(line));

  let state: BundleProbeState = { ok: true, reason: null, since: now(), checkedAt: 0 };
  let lastAlarm = 0;

  function check(): BundleProbeState {
    const reason = verify(opts.publicDir);
    const at = now();
    const ok = reason === null;
    if (ok !== state.ok) {
      state = { ok, reason, since: at, checkedAt: at };
      if (ok) {
        log(`[bundle] public/ is servable again (${opts.publicDir})`);
        lastAlarm = 0;
      } else {
        log(`[bundle] ALARM: the app is served from ${opts.publicDir} and it is not servable - missing ${reason}. Run \`bun run build:client\`.`);
        lastAlarm = at;
      }
      return state;
    }
    state = { ...state, reason, checkedAt: at };
    if (!ok && at - lastAlarm >= repeatMs) {
      log(`[bundle] STILL broken since ${new Date(state.since).toISOString()} - missing ${reason}.`);
      lastAlarm = at;
    }
    return state;
  }

  check();
  let timer: ReturnType<typeof setInterval> | null = null;
  if (opts.schedule !== false) {
    timer = setInterval(check, intervalMs);
    // A probe must never be the reason the process stays alive.
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  return {
    stop: () => { if (timer) clearInterval(timer); },
    state: () => state,
    check,
  };
}
