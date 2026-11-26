/**
 * Mirror a native nav error to the server log.
 *
 * WKWebView's did-fail (navErrorMessage.ts) happens on the Mac; without this
 * call it never left the client, so a strip the user saw on the day could not
 * be read back from the server log afterwards (task 590a3979). Fire-and-forget
 * on purpose: a failed POST must not turn into a second strip over the first.
 */
import { apiFetch } from './net';

export interface NativeNavErrorReport {
  paneId: string;
  url: string;
  code: number;
  description: string;
  at?: number;
}

/** `example.com:8443` as a human reads it, or the raw string when it does not parse. */
function hostOf(raw: string): string {
  try {
    const u = new URL(raw);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return raw;
  }
}

export function reportNavError(e: NativeNavErrorReport): void {
  void apiFetch('/api/browsers/nav-error-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paneId: e.paneId,
      host: hostOf(e.url),
      code: e.code,
      description: e.description,
      at: e.at ?? Date.now(),
    }),
  }).catch(() => {});
}
