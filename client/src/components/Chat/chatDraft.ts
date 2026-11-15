/**
 * The composer's draft (`draft:<topicId>`) in `localStorage` — the only copy
 * of the text typed in a pane other than the focused one: `ChatPane` re-reads
 * it with `readDraft` on every topic switch, so a `setItem`/`removeItem` that
 * throws (private mode, a full quota) drops what was typed with no trace.
 * `saveDraft` keeps that failure visible instead of swallowing it silently.
 */
let warnedOnce = false;

/** Reset between tests; production never calls this. */
export function __resetDraftWarnOnce(): void {
  warnedOnce = false;
}

export function readDraft(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

export function saveDraft(key: string, message: string): void {
  try {
    if (message) localStorage.setItem(key, message);
    else localStorage.removeItem(key);
  } catch (e) {
    if (warnedOnce) return;
    warnedOnce = true;
    console.warn('[ChatPane] draft could not be saved to localStorage, it will not survive a topic switch or reload', e);
  }
}
