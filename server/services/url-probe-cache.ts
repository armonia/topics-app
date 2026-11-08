/**
 * Sonda server-side sull'output_url dei task in review.
 *
 * TRE STATI distinti, non due:
 *   live    - sonda HTTP risponde 2xx/3xx
 *   dead    - sonda risponde 4xx/5xx o non risponde
 *   unknown - mai provata (default)
 *
 * Un falso negativo su un server lento vale peggio del silenzio, quindi:
 *   - `unknown` NON equivale a `dead`
 *   - La sonda ha un timeout corto (3s) e non si ritenta sul 000
 *   - Il client mostra il link su `live` e `unknown`, lo NASCONDE su `dead`
 *
 * Cache TTL: 5 minuti. La sonda gira lato server per evitare che ogni
 * ridisegno della board spari una richiesta per card.
 */

export type UrlProbeStatus = 'live' | 'dead' | 'unknown';

export interface UrlProbeResult {
  status: UrlProbeStatus;
  checkedAt: string;
}

/** Fetch injectable per i test. */
export type ProbeFetch = (url: string, timeoutMs: number) => Promise<{ ok: boolean; status: number }>;

const PROBE_TIMEOUT_MS = 3_000;
/** Durata minima della cache: non ri-provare prima di N minuti. */
const CACHE_TTL_MS = 5 * 60 * 1_000;

/** In-memory cache per evitare sonde duplicate nel ciclo di vita del processo. */
const probeCache = new Map<string, { result: UrlProbeResult; ts: number }>();

function isCacheValid(entry: { result: UrlProbeResult; ts: number }): boolean {
  return Date.now() - entry.ts < CACHE_TTL_MS;
}

/** Sonda reale via fetch con timeout. */
async function defaultProbeFetch(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, method: 'HEAD', redirect: 'follow' });
    return { ok: res.ok || (res.status >= 300 && res.status < 400), status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sonda l'URL e restituisce lo stato.
 * Usa la cache in-process se fresca; altrimenti HTTP.
 *
 * Accetta un `probeFn` iniettabile per i test.
 */
export async function probeUrl(
  url: string,
  probeFn: ProbeFetch = defaultProbeFetch,
): Promise<UrlProbeResult> {
  const cached = probeCache.get(url);
  if (cached && isCacheValid(cached)) return cached.result;

  const { ok } = await probeFn(url, PROBE_TIMEOUT_MS);
  const result: UrlProbeResult = {
    status: ok ? 'live' : 'dead',
    checkedAt: new Date().toISOString(),
  };
  probeCache.set(url, { result, ts: Date.now() });
  return result;
}

/**
 * Invalida la cache per un URL (usato nei test e quando `output_url` cambia).
 */
export function invalidateProbeCache(url: string): void {
  probeCache.delete(url);
}

/** Espulsi tutti i record scaduti (utile per i test). */
export function __clearProbeCacheForTests(): void {
  probeCache.clear();
}
