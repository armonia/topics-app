import { detectShell } from './shell/index';
import type { InteractionSnapshot } from './eventTiming';
import { getEventTimingSnapshot, refreshTotal, subscribeEventTiming } from './eventTiming';
import { tracePaneAttach } from './paneAttachTrace';

/**
 * Report the interaction histogram to the local server log, from the desktop
 * shell only. The shell talks to a loopback server, so the summary never
 * leaves the machine; web clients (phones, browsers) stay silent. A gate
 * reads the real shell p95 back from those lines.
 */

const REPORT_EVENT = 'inp-summary';
const REPORT_INTERVAL_MS = 60_000;

let reporting = false;
let pageLoadId = '';
let lastReport: { total: number; at: number } = { total: 0, at: 0 };
let stopListening: (() => void) | null = null;
let reportController: AbortController | null = null;

/**
 * The compact summary the shell appends to the server log. Stays small on
 * purpose: the server cuts trace fields past 600 characters, and this line
 * serialises under 300.
 */
export function buildInteractionSummary(
  snapshot: InteractionSnapshot,
  pageLoad: string,
): Record<string, unknown> {
  return {
    shell: 'tauri',
    pl: pageLoad,
    n: snapshot.total,
    s: snapshot.slow,
    w: snapshot.worst === null ? 0 : snapshot.worst.durationMs,
    h: snapshot.histogram,
  };
}

/**
 * True when this snapshot deserves a new line: the total moved past the last
 * reported one (or past zero, for the first line), and either the flush was
 * forced (page hidden) or a minute passed since that line, or since load for
 * the first. An empty store never reports.
 */
export function shouldReportInteractions(
  previous: { total: number; at: number },
  snapshot: InteractionSnapshot,
  nowMs: number,
  forced: boolean,
): boolean {
  if (snapshot.slow === 0 && snapshot.total === 0) return false;
  return snapshot.total > previous.total && (forced || nowMs - previous.at >= REPORT_INTERVAL_MS);
}

function evaluateReport(forced: boolean): void {
  const snapshot = getEventTimingSnapshot();
  const now = Date.now();
  if (!shouldReportInteractions(lastReport, snapshot, now, forced)) return;
  lastReport = { total: snapshot.total, at: now };
  tracePaneAttach(REPORT_EVENT, buildInteractionSummary(snapshot, pageLoadId));
}

// Last chance accounting: fold the fast interactions in, then report even
// when the minute has not passed yet.
function flushReport(): void {
  refreshTotal();
  evaluateReport(true);
}

/**
 * Start reporting. No-op outside the desktop shell. Hooks the timing store
 * and the two page-hide signals; no timers anywhere.
 */
export function startInteractionReport(): void {
  if (reporting) return;
  if (detectShell() !== 'tauri') return;
  reporting = true;
  pageLoadId = Math.random().toString(36).slice(2, 8);
  lastReport = { total: 0, at: Date.now() };
  stopListening = subscribeEventTiming(() => evaluateReport(false));
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    reportController = new AbortController();
    const signal = reportController.signal;
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') flushReport();
      },
      { signal },
    );
    window.addEventListener('pagehide', () => flushReport(), { signal });
  }
}

/** Test-only: stop listening and allow a fresh start. */
export function resetInteractionReportForTests(): void {
  reporting = false;
  pageLoadId = '';
  lastReport = { total: 0, at: 0 };
  if (stopListening !== null) {
    stopListening();
    stopListening = null;
  }
  if (reportController !== null) {
    reportController.abort();
    reportController = null;
  }
}
