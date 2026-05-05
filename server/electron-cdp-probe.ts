/**
 * Phase 30.1 BROWSER-CHAT-06 — Electron CDP availability probe.
 *
 * Detect whether the parent Electron host exposes CDP on port 19333
 * (set by `app.commandLine.appendSwitch('remote-debugging-port', '19333')`
 * in electron-app/main.ts). Result is cached for 30s to avoid hammering
 * the endpoint on every tool call.
 *
 * Caller pattern (in server/browser-tools-handler.ts):
 *   if (await isElectronCdpAvailable()) { handleViaCdp(...) }
 *   else { handleViaPlaywrightService(...) }
 *
 * Web-only mode: probe always fails (no Electron host), tools fall
 * through to the Phase 30 Playwright path. Zero regressions.
 */

const CDP_PORT = 19333;
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const TTL_MS = 30_000;

interface CacheEntry {
  available: boolean;
  checkedAt: number;
}

let cache: CacheEntry | null = null;

/** Reset the probe cache (test seam). */
export function resetCdpProbeCache(): void {
  cache = null;
}

/** Returns the CDP base URL (single source of truth for callers). */
export function getElectronCdpEndpoint(): string {
  return CDP_BASE;
}

/**
 * Returns true if Electron is exposing CDP on 19333. Cached 30s.
 *
 * The probe is best-effort: a 1.5s timeout + AbortSignal so a hung
 * Electron process doesn't block tool calls. On error -> false (web mode).
 */
export async function isElectronCdpAvailable(): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.checkedAt < TTL_MS) {
    return cache.available;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(`${CDP_BASE}/json/version`, { signal: ctrl.signal });
      if (!res.ok) {
        cache = { available: false, checkedAt: now };
        return false;
      }
      const body = (await res.json()) as { Browser?: string };
      // Sanity: Electron returns Browser like "Topics-Electron/1.0" or
      // "Chrome/<ver>". We don't pin to a specific string — any valid
      // /json/version response means CDP is up.
      const ok = typeof body?.Browser === 'string' && body.Browser.length > 0;
      cache = { available: ok, checkedAt: now };
      return ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    cache = { available: false, checkedAt: now };
    return false;
  }
}
