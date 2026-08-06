import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Lo STORE dell'icona di progetto: cache persistita, sonda single-flight per
 * path, recupero via blob, e l'hook che espone l'esito.
 *
 * Sta in un file suo e non dentro `ProjectFavicon.tsx` perché quel file deve
 * esportare SOLO componenti: un modulo che mescola componenti e hook rompe il
 * fast refresh, e la regola del repo lo blocca. La logica qui sotto è quella di
 * prima, trasferita e non riscritta.
 *
 * ARCHITECTURE — one shared, reactive resolver per path (module store below),
 * NOT per-instance probing. The old per-instance model raced: the sidebar
 * row's <img> error could write a session 'none' the exact moment the tab
 * bar's instance mounted, freezing the tab on "no icon" while the sidebar
 * later recovered — same project, icon on one surface and not the other.
 * Here every instance subscribes to the same per-path status, a probe runs
 * once (single-flight) per path, and a recovery flips ALL surfaces at once.
 */

// ── Persisted cache (localStorage) ──────────────────────────────────────
//
// INVARIANT — 'none' is NEVER persisted to localStorage, only kept in memory
// for the current page lifetime. Four cache-key bumps (v1→v4) were spent
// flushing 'none' entries latched by transient failures (server restarts,
// allowlist warm-up 403s, dev-bundle reload storms): any code path that
// writes 'none' to disk eventually poisons the cache for the whole TTL and
// real icons vanish. Persisting only 'has' makes that class of bug
// impossible. Entries with s:'none' still found under the key (written by
// older bundles) are dropped — and the purge is persisted immediately, so a
// concurrent window still running an old bundle can't re-read the poison.
const CACHE_KEY = 'topics-project-icon-cache-v4';
// A VERIFIED 'none' (a fetch confirmed a real 204/404) holds for hours; an
// UNVERIFIED one (transport error without confirmation) only briefly, enough
// to stop an error-remount storm without hiding a recovering icon for long.
const NONE_VERIFIED_TTL_MS = 12 * 60 * 60 * 1000;
const NONE_UNVERIFIED_TTL_MS = 5 * 60 * 1000;
type IconStatus = 'has' | 'none';
interface CacheEntry { s: IconStatus; t: number; v?: boolean }

let memCache: Record<string, CacheEntry> | null = null;
function cache(): Record<string, CacheEntry> {
  if (memCache) return memCache;
  try { memCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch { memCache = {}; }
  let hadNone = false;
  for (const k of Object.keys(memCache!)) {
    if (memCache![k].s === 'none') { delete memCache![k]; hadNone = true; }
  }
  if (hadNone) persist();
  return memCache!;
}
function persist(): void {
  const hasOnly: Record<string, CacheEntry> = {};
  for (const [k, e] of Object.entries(memCache ?? {})) {
    if (e.s === 'has') hasOnly[k] = e;
  }
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(hasOnly)); } catch {}
}
function cachedStatus(path: string): IconStatus | 'unknown' {
  const e = cache()[path];
  if (!e) return 'unknown';
  // 'none' self-heals after its TTL so a newly-added favicon eventually shows
  // even in a long-lived window (the entry is memory-only, so a reload also
  // clears it).
  if (e.s === 'none' && Date.now() - e.t > (e.v ? NONE_VERIFIED_TTL_MS : NONE_UNVERIFIED_TTL_MS)) return 'unknown';
  return e.s;
}
function remember(path: string, s: IconStatus, verified = true): void {
  const c = cache();
  if (c[path]?.s === s && c[path]?.v === verified) return;
  c[path] = { s, t: Date.now(), v: verified };
  persist();
}

// ── Shared reactive resolver (module store) ─────────────────────────────
type Resolved =
  | { s: 'probing' }
  | { s: 'has'; src: string }
  | { s: 'none' };
const PROBING: Resolved = { s: 'probing' };

const state = new Map<string, Resolved>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Set<string>();

const endpointUrl = (path: string) => `/api/projects/icon?path=${encodeURIComponent(path)}`;

function notify(path: string): void {
  listeners.get(path)?.forEach((cb) => cb());
}
function setResolved(path: string, r: Resolved): void {
  state.set(path, r);
  notify(path);
}
function subscribe(path: string, cb: () => void): () => void {
  let set = listeners.get(path);
  if (!set) { set = new Set(); listeners.set(path, set); }
  set.add(cb);
  return () => { listeners.get(path)?.delete(cb); };
}
function getSnapshot(path: string): Resolved {
  return state.get(path) ?? PROBING;
}

/** Settle a path's status via fetch — the recovery lane. Used when the native
 *  <img> load path fails: in some WKWebView windows (Tauri app, self-signed
 *  TLS cert) <img> loads to the server fail while fetch() works — the exact
 *  split varies per window — so a 200 here is served to every surface from a
 *  blob URL, bypassing the broken transport for the rest of the session. */
function settleViaFetch(path: string): void {
  fetch(endpointUrl(path))
    .then(async (r) => {
      // 204 = "il progetto non ha un'icona", ed è una risposta RIUSCITA (prima
      // era un 404, il 4xx più rumoroso a ogni load). Va intercettata PRIMA di
      // `r.ok`, che per un 204 è true: altrimenti si costruirebbe un blob VUOTO,
      // lo si monterebbe come <img>, quella fallirebbe e si ricadrebbe qui via
      // reportImgError con un 'none' NON verificato — TTL 5 minuti, cioè una
      // riprova continua per ogni progetto senza icona.
      if (r.status === 204) {
        remember(path, 'none', true);
        setResolved(path, { s: 'none' });
      } else if (r.ok) {
        const src = URL.createObjectURL(await r.blob());
        remember(path, 'has');
        setResolved(path, { s: 'has', src });
      } else if (r.status === 404) {
        // La directory non esiste più (progetto spostato/cancellato).
        remember(path, 'none', true);
        setResolved(path, { s: 'none' });
      } else {
        // 403 during allowlist warm-up / restart — transient, short TTL.
        remember(path, 'none', false);
        setResolved(path, { s: 'none' });
      }
    })
    .catch(() => {
      remember(path, 'none', false);
      setResolved(path, { s: 'none' });
    })
    .finally(() => { inflight.delete(path); });
}

/** Ensure a (single-flight) probe for this path is running or settled. */
function ensureProbe(path: string): void {
  const cur = state.get(path);
  if (cur?.s === 'has') return;
  if (cur?.s === 'none' && cachedStatus(path) === 'none') return; // TTL still valid
  if (inflight.has(path)) return;
  // Persisted 'has' → trust it and go straight to the endpoint URL (the
  // browser HTTP cache makes this instant); a broken window falls into
  // reportImgError → blob recovery below.
  if (cachedStatus(path) === 'has') {
    setResolved(path, { s: 'has', src: endpointUrl(path) });
    return;
  }
  inflight.add(path);
  if (!cur || cur.s !== 'probing') setResolved(path, PROBING);
  // Probe with a detached Image(): the natural, cache-friendly path. On error
  // fall through to fetch, which distinguishes "no icon" (204 — un'immagine
  // vuota fa comunque scattare onerror) da un trasporto immagini rotto
  // (200 → recover via blob).
  const img = new Image();
  img.onload = () => {
    remember(path, 'has');
    setResolved(path, { s: 'has', src: endpointUrl(path) });
    inflight.delete(path);
  };
  img.onerror = () => { settleViaFetch(path); };
  img.src = endpointUrl(path);
}

/** A mounted <img> failed on a src the store believed in. Endpoint src →
 *  attempt the fetch→blob recovery (single-flight); blob src → give up for
 *  this session (short-TTL 'none', re-probed later). */
export function reportImgError(path: string, failedSrc: string): void {
  const cur = state.get(path);
  if (cur?.s !== 'has' || cur.src !== failedSrc) return; // stale report
  if (failedSrc.startsWith('blob:')) {
    remember(path, 'none', false);
    setResolved(path, { s: 'none' });
    return;
  }
  if (inflight.has(path)) return;
  inflight.add(path);
  setResolved(path, PROBING);
  settleViaFetch(path);
}

/**
 * Lo stato dell'icona di un progetto, dallo STESSO store che alimenta
 * `ProjectFavicon` — nessuna seconda sonda, nessuna divergenza fra chi disegna
 * l'icona e chi decide in base alla sua esistenza.
 *
 * Serve a chi deve cambiare LAYOUT a seconda che l'icona ci sia (la tessera
 * fissata mostra la sola icona quando c'e', e il nome quando non c'e') o
 * campionarne la tinta: entrambe le cose hanno bisogno di `src`, che il
 * componente teneva per se'.
 *
 * `path` vuoto = nessun progetto: resta `probing` e non fa partire niente.
 */
export function useProjectIcon(path: string): { status: 'probing' | 'has' | 'none'; src: string | null } {
  const subscribeToPath = useCallback(
    (cb: () => void) => (path ? subscribe(path, cb) : () => {}),
    [path],
  );
  const resolved = useSyncExternalStore(
    subscribeToPath,
    () => (path ? getSnapshot(path) : PROBING),
  );
  useEffect(() => {
    if (path) ensureProbe(path);
  }, [path]);
  return {
    status: resolved.s,
    src: resolved.s === 'has' ? resolved.src : null,
  };
}
