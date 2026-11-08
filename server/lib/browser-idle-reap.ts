/**
 * Whether the idle reaper may close the headless browser.
 *
 * Measured 13/10 on the live server, under memory pressure (swap at 97%):
 * Chromium launched at 12:32:17 and was reaped at 12:32:35 as "idle 21min".
 * The idle clock only moves when a context REGISTERS, and that happens at the
 * end of `createContext`; a launch that a context is still being built on had
 * an empty context map and a clock 21 minutes old. The pane got "Target page,
 * context or browser has been closed" on every retry, for ever, because each
 * retry relaunched into the same race. A browser that is launching or has a
 * context being created is in use, whatever the clock says.
 */
export interface ReapState {
  connected: boolean;
  contexts: number;
  /** Contexts whose `createContext` has not settled yet. */
  creating: number;
  launching: boolean;
  idleMs: number;
  idleTimeoutMs: number;
}

export function browserReapable(s: ReapState): boolean {
  return s.connected && s.contexts === 0 && s.creating === 0 && !s.launching && s.idleMs > s.idleTimeoutMs;
}
