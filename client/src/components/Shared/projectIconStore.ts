import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

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
/** How long an <img> probe may stay silent before the fetch lane settles the path. */
const PROBE_DEADLINE_MS = 4000;

const state = new Map<string, Resolved>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Set<string>();

const endpointUrl = (path: string) => `/api/projects/icon?path=${encodeURIComponent(path)}`;

/**
 * Un contatore di VERSIONE dello store intero, per chi guarda PIÙ path insieme.
 *
 * `subscribe(path)` serve chi disegna una icona sola. Chi invece deve decidere
 * quali progetti mostrare (la riga della board) ha bisogno di sapere che
 * QUALCOSA è cambiato, senza iscriversi a ogni path uno per uno e senza
 * ricostruire l'iscrizione ogni volta che la lista cambia. Un intero che sale a
 * ogni transizione è la forma che `useSyncExternalStore` sa leggere: lo snapshot
 * è un numero, quindi è stabile per definizione e non può innescare il loop
 * «snapshot nuovo a ogni chiamata» che un Set restituito al volo produce.
 */
let storeVersion = 0;
const anyListeners = new Set<() => void>();
function subscribeAny(cb: () => void): () => void {
  anyListeners.add(cb);
  return () => { anyListeners.delete(cb); };
}
function getStoreVersion(): number { return storeVersion; }

function notify(path: string): void {
  storeVersion++;
  listeners.get(path)?.forEach((cb) => cb());
  anyListeners.forEach((cb) => cb());
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
  const cur = state.get(path);
  if (cur) return cur;
  // IDRATAZIONE SINCRONA, al primo render e non nell'effetto.
  //
  // `ensureProbe` sa già leggere un 'has' persistito e saltare la sonda — ma
  // gira in un `useEffect`, cioè DOPO il primo paint. Chi decide il layout
  // sull'esito (la tessera fissata) disegnava quindi un frame da 'probing'
  // — nome, allineato a sinistra — e poi saltava all'icona: al refresh il
  // titolo lampeggiava anche quando l'icona era in cache da sempre.
  // Qui l'esito noto c'è già al primo render, e non c'è nessun frame
  // intermedio da cui saltare. Nessun `notify`: si scrive lo stato, non lo si
  // annuncia — siamo dentro il render di chi lo sta leggendo.
  if (cachedStatus(path) === 'has') {
    const known: Resolved = { s: 'has', src: endpointUrl(path) };
    state.set(path, known);
    return known;
  }
  return PROBING;
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
  // A probe that never answers is a slot that never closes: in the desktop
  // shell an <img> to the self-signed server can neither load nor error, and
  // every row of that project kept 22px of placeholder for the whole session
  // (seen 2026-09-03). After PROBE_DEADLINE_MS the fetch lane decides.
  let settled = false;
  const deadline = setTimeout(() => {
    if (settled) return;
    settled = true;
    img.onload = null; img.onerror = null;
    settleViaFetch(path);
  }, PROBE_DEADLINE_MS);
  img.onload = () => {
    if (settled) return;
    settled = true; clearTimeout(deadline);
    remember(path, 'has');
    setResolved(path, { s: 'has', src: endpointUrl(path) });
    inflight.delete(path);
  };
  img.onerror = () => {
    if (settled) return;
    settled = true; clearTimeout(deadline);
    settleViaFetch(path);
  };
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
 * QUALI di questi progetti hanno un'icona vera — la domanda al plurale.
 *
 * Serve a chi deve DECIDERE COSA MOSTRARE e non solo come disegnarlo: la riga
 * della board mostra i progetti con l'icona e basta, quindi la lista dei
 * candidati va filtrata PRIMA dell'aritmetica del ritaglio, altrimenti si
 * prenoterebbe spazio per pastiglie che poi non si disegnano.
 *
 * Due proprietà, ed entrambe sono il punto:
 *
 *  · **il primo fotogramma è già giusto** per ogni progetto che la cache
 *    persistita conosce — `getSnapshot` idrata in modo sincrono (vedi sopra),
 *    quindi al ricarico la riga nasce con le sue pastiglie invece di
 *    ricomporsi sotto gli occhi. È la stessa regola per cui la tessera fissata
 *    non decide più il layout su uno stato in volo;
 *  · **la sonda parte da qui**. Se il filtro escludesse i path non ancora noti
 *    e nessuno li sondasse, quei progetti resterebbero esclusi per sempre —
 *    l'esclusione si autoconfermerebbe. Chiedere l'icona è quindi parte del
 *    domandare chi ce l'ha.
 */
export function useProjectIconsPresent(paths: readonly string[]): ReadonlySet<string> {
  // La chiave unisce i path con un NUL, non con uno spazio: un percorso può
  // contenere spazi («Il mio progetto») e con lo spazio la chiave si
  // spezzerebbe in path inesistenti — che poi verrebbero pure SONDATI. `\0` non
  // può comparire in un path POSIX, quindi è l'unico separatore sicuro.
  // (Attenzione se lo cerchi: un NUL nel sorgente è invisibile a grep.)
  const key = paths.join('\u0000');
  const version = useSyncExternalStore(subscribeAny, getStoreVersion, getStoreVersion);
  useEffect(() => {
    for (const p of key.split('\u0000')) if (p) ensureProbe(p);
  }, [key]);
  return useMemo(() => {
    // `version` NON si legge per il suo valore: si legge perché è il segnale di
    // invalidazione. Lo stato vero sta in `getSnapshot`, che è una funzione del
    // modulo e non una dipendenza che React possa vedere; senza questa riga la
    // regola `exhaustive-deps` la classifica come dipendenza inutile e chi la
    // togliesse congelerebbe il Set al primo giro — le pastiglie non
    // comparirebbero mai per i progetti sondati dopo il primo render.
    void version;
    const presenti = new Set<string>();
    for (const p of key.split('\u0000')) {
      if (p && getSnapshot(p).s === 'has') presenti.add(p);
    }
    return presenti;
    // `version` non si legge nel corpo: è la dipendenza che dice «lo store si è
    // mosso, ricalcola». Senza, il Set resterebbe quello del primo giro.
  }, [key, version]);
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
