import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { subscribeFrames, subscribeReconnect } from '../../lib/wsFrameBus';

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
 *
 * LIVE (PROJECT-14). The answer follows the folder: the server watches the
 * icons clients ask about and pushes `project:icon` with the new version when
 * one appears, changes or goes away, and the store applies it to every surface
 * of every window, without a probe. The `<img>` URL carries that version, so
 * a changed icon is a new URL and the old bytes cannot come back from any
 * cache. Answers drawn from the persisted cache are revalidated in ONE request
 * per page (`/api/projects/icon-versions`), again on every reconnect and when
 * the window comes back to the front: a push missed while the socket was down,
 * or a restart that lost the server's watches, heals there.
 */

// ── Persisted cache (localStorage) ──────────────────────────────────────
//
// INVARIANT — an UNVERIFIED 'none' is never persisted, only kept in memory
// for the current page lifetime. Four cache-key bumps (v1→v4) were spent
// flushing 'none' entries latched by transient failures (server restarts,
// allowlist warm-up 403s, dev-bundle reload storms): a transient written to
// disk poisons the cache for the whole TTL and real icons vanish.
//
// A VERIFIED 'none' — the server itself answered 204 («no icon») or 404 («no
// such directory») — IS persisted, since 2026-09-03, and the reason is a
// layout shift. Without it every reload re-probed every project without an
// icon: the tile reserved the 18 px slot while probing and dropped it when the
// answer came back, so the names of six pinned tiles slid 22 px to the left
// about a second after the first paint, on every single refresh. Persisted, the
// answer is already known at the first render (`getSnapshot`) and nothing
// moves. Expiry does not reopen the slot either: a stale verified 'none' keeps
// drawing as 'none' while `ensureProbe` re-asks in the background, and only
// a real icon flips it (see the silent re-probe there). Entries with an
// unverified 'none' still found under the key (written by an older bundle)
// are dropped, and the purge is persisted immediately.
const CACHE_KEY = 'topics-project-icon-cache-v4';
// A VERIFIED 'none' (a fetch confirmed a real 204/404) holds for hours; an
// UNVERIFIED one (transport error without confirmation) only briefly, enough
// to stop an error-remount storm without hiding a recovering icon for long.
const NONE_VERIFIED_TTL_MS = 12 * 60 * 60 * 1000;
const NONE_UNVERIFIED_TTL_MS = 5 * 60 * 1000;
type IconStatus = 'has' | 'none';
/** `version` = the server's version of a 'has' (see `projectIconVersion`), when known. */
interface CacheEntry { s: IconStatus; t: number; v?: boolean; version?: string }

let memCache: Record<string, CacheEntry> | null = null;
function cache(): Record<string, CacheEntry> {
  if (memCache) return memCache;
  try { memCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); }
  catch { memCache = {}; }
  let hadUnverifiedNone = false;
  for (const k of Object.keys(memCache!)) {
    if (memCache![k].s === 'none' && memCache![k].v !== true) { delete memCache![k]; hadUnverifiedNone = true; }
  }
  if (hadUnverifiedNone) persist();
  return memCache!;
}
/** Is this entry allowed on disk? 'has' always; 'none' only when the server
 *  itself said so (see the invariant above). */
function keepOnDisk(e: CacheEntry): boolean {
  return e.s === 'has' || e.v === true;
}
function persist(): void {
  const onDisk: Record<string, CacheEntry> = {};
  for (const [k, e] of Object.entries(memCache ?? {})) {
    if (keepOnDisk(e)) onDisk[k] = e;
  }
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(onDisk)); } catch {}
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
function remember(path: string, s: IconStatus, verified = true, version?: string): void {
  const c = cache();
  // A 'has' is timeless (it never expires), so re-confirming it is a no-op. A
  // 'none' is NOT: its date is what the TTL reads, and the re-probe that lands
  // on the same answer must refresh it. Until 2026-09-05 this returned early
  // for both, so a verified 'none' kept its ORIGINAL date forever: past twelve
  // hours every reload re-probed every project without an icon (22 requests
  // measured, two per project — the <img> lane and then the fetch lane), and
  // the entry stayed expired no matter how many times the answer came back.
  // A 'has' learns its version later than its existence (the <img> probe
  // cannot read headers), so a 'has' without one is not the same entry as a
  // 'has' with one, and a NEW version is not the same entry either.
  if (s === 'has' && c[path]?.s === 'has' && (version === undefined || c[path].version === version)) return;
  c[path] = s === 'has' && version ? { s, t: Date.now(), v: verified, version } : { s, t: Date.now(), v: verified };
  persist();
}
/**
 * A TRANSIENT answer — a transport error, a 403 while the allowlist warms up
 * after a restart — teaches nothing about the icon. It gets the short-lived
 * unverified marker only where nothing better is known: a verified 'none'
 * already on disk stays. Writing the unverified one over it REPLACED the
 * verified entry, and `persist` drops unverified entries, so the answer the
 * server had given vanished from disk and the next boot re-probed the project
 * from scratch (measured 2026-09-06: at boot the probes queue behind ~60 other
 * requests, and a ⌘R aborts them all — every reload emptied the cache).
 */
function rememberTransientNone(path: string): void {
  const e = cache()[path];
  if (e?.s === 'none' && e.v === true) return;
  remember(path, 'none', false);
}

// ── Shared reactive resolver (module store) ─────────────────────────────
type Resolved =
  | { s: 'probing' }
  | { s: 'has'; src: string; version?: string }
  | { s: 'none' };
const PROBING: Resolved = { s: 'probing' };
/** One object for every 'none', so a re-probe that lands on the same answer
 *  hands `useSyncExternalStore` the same snapshot and nobody re-renders. */
const NONE: Resolved = { s: 'none' };
/** How long an <img> probe may stay silent before the fetch lane settles the path. */
const PROBE_DEADLINE_MS = 4000;

const state = new Map<string, Resolved>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Set<string>();

/**
 * The URL of a project's icon. With a version it is the URL of THOSE bytes: a
 * changed icon is a new URL, so neither the page's decoded-image cache nor the
 * HTTP cache can hand back the old picture, and the server lets the browser
 * keep it for good. Without one (the first probe) the server revalidates it
 * against its ETag at every use.
 */
const endpointUrl = (path: string, version?: string) =>
  `/api/projects/icon?path=${encodeURIComponent(path)}${version ? `&v=${encodeURIComponent(version)}` : ''}`;

/**
 * A per-path GENERATION, bumped whenever the server states the icon (a push, a
 * revalidation). A probe or a revalidation remembers the generation it started
 * in and drops its answer if it moved meanwhile: a 204 that left the server
 * before the favicon was written must not overwrite the push that announced
 * it.
 */
const generation = new Map<string, number>();
const genOf = (path: string) => generation.get(path) ?? 0;

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
    const version = cache()[path]?.version;
    const known: Resolved = { s: 'has', src: endpointUrl(path, version), version };
    state.set(path, known);
    return known;
  }
  // A verified 'none' on disk is an answer too, and it stays the answer past
  // its TTL: the first frame draws no slot, `ensureProbe` re-asks quietly.
  if (cache()[path]?.s === 'none' && cache()[path]?.v === true) {
    state.set(path, NONE);
    return NONE;
  }
  return PROBING;
}

/** Settle a path's status via fetch — the recovery lane. Used when the native
 *  <img> load path fails: in some WKWebView windows (Tauri app, self-signed
 *  TLS cert) <img> loads to the server fail while fetch() works — the exact
 *  split varies per window — so a 200 here is served to every surface from a
 *  blob URL, bypassing the broken transport for the rest of the session. */
function settleViaFetch(path: string, opts: { version?: string; afterImgError?: boolean } = {}): void {
  const startedIn = genOf(path);
  const superseded = () => genOf(path) !== startedIn;
  // Low priority: an icon never decides a layout (the slot is reserved before
  // it lands, a 'none' draws nothing), so it must not take one of the six
  // connections from the chat history at boot.
  fetch(endpointUrl(path, opts.version), { priority: 'low' })
    .then(async (r) => {
      if (superseded()) return;
      // 204 = "il progetto non ha un'icona", ed è una risposta RIUSCITA (prima
      // era un 404, il 4xx più rumoroso a ogni load). Va intercettata PRIMA di
      // `r.ok`, che per un 204 è true: altrimenti si costruirebbe un blob VUOTO,
      // lo si monterebbe come <img>, quella fallirebbe e si ricadrebbe qui via
      // reportImgError con un 'none' NON verificato — TTL 5 minuti, cioè una
      // riprova continua per ogni progetto senza icona.
      if (r.status === 204) {
        remember(path, 'none', true);
        setResolved(path, NONE);
      } else if (r.ok) {
        const blob = await r.blob();
        if (superseded()) return;
        const version = r.headers.get('etag')?.replace(/^W\//, '').replace(/"/g, '') || opts.version;
        // The <img> failed and the same bytes came through fetch: this
        // window's image transport is the broken one, for the whole session.
        if (opts.afterImgError) imgTransportBroken = true;
        const before = state.get(path);
        remember(path, 'has', true, version);
        setResolved(path, { s: 'has', src: URL.createObjectURL(blob), version });
        if (before?.s === 'has' && before.src.startsWith('blob:')) URL.revokeObjectURL(before.src);
      } else if (r.status === 404) {
        // La directory non esiste più (progetto spostato/cancellato).
        remember(path, 'none', true);
        setResolved(path, NONE);
      } else {
        // 403 during allowlist warm-up / restart — transient, short TTL.
        rememberTransientNone(path);
        setResolved(path, NONE);
      }
    })
    .catch(() => {
      if (superseded()) return;
      // The common transient: a probe still in flight when the page reloads.
      rememberTransientNone(path);
      setResolved(path, NONE);
    })
    .finally(() => { inflight.delete(path); });
}

/**
 * Set once a blob recovery succeeded after an <img> failed: in this window an
 * <img> pointed at the server cannot load (WKWebView with the self-signed
 * certificate). From then on a new version is fetched as a blob BEFORE it is
 * shown, so the old picture stays until the new one is ready, instead of the
 * slot emptying while a versioned URL fails and the recovery runs again.
 */
let imgTransportBroken = false;

/** Ensure a (single-flight) probe for this path is running or settled. */
function ensureProbe(path: string): void {
  armLiveUpdates();
  const cur = state.get(path);
  // An answer drawn from the persisted cache was not asked of the server in
  // this page: it may be days old. It stays on screen, and the batch
  // revalidation confirms or corrects it, one request for all of them. That
  // is also what re-asks an EXPIRED verified 'none' at load, so the fetch
  // further down is left to a window that has been open for twelve hours.
  if ((cur?.s === 'has' || cur?.s === 'none') && queueRevalidation(path)) return;
  if (cur?.s === 'has') return;
  if (cur?.s === 'none' && cachedStatus(path) === 'none') return; // TTL still valid
  if (inflight.has(path)) return;
  // Persisted 'has' → trust it and go straight to the endpoint URL (the
  // browser HTTP cache makes this instant); a broken window falls into
  // reportImgError → blob recovery below.
  if (cachedStatus(path) === 'has') {
    const version = cache()[path]?.version;
    setResolved(path, { s: 'has', src: endpointUrl(path, version), version });
    queueRevalidation(path);
    return;
  }
  askedThisPage.add(path);
  inflight.add(path);
  const startedIn = genOf(path);
  // SILENT when re-asking past a verified 'none': the surfaces keep drawing
  // «no icon» and only a real icon changes anything. Announcing 'probing' here
  // would reopen the 18 px slot every 12 hours for the sake of a question
  // whose answer is almost always the same.
  if (!cur || (cur.s !== 'probing' && cur.s !== 'none')) setResolved(path, PROBING);
  // Re-asking past a verified 'none' goes straight to the fetch lane. For a
  // project without an icon the <img> lane can only fail (a 204 fires onerror)
  // and then fall through to the fetch anyway: two requests per project, every
  // twelve hours, for an answer the fetch alone gives in one. The <img> lane
  // stays for the unknown case, where the likely answer is an icon and the
  // image cache is the cheapest way to get it.
  if (cur?.s === 'none') {
    settleViaFetch(path);
    return;
  }
  // Probe with a detached Image(): the natural, cache-friendly path. On error
  // fall through to fetch, which distinguishes "no icon" (204 — un'immagine
  // vuota fa comunque scattare onerror) da un trasporto immagini rotto
  // (200 → recover via blob).
  const img = new Image();
  // Same reason as the fetch lane: nothing on screen waits for a probe.
  img.fetchPriority = 'low';
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
    inflight.delete(path);
    // The server stated the icon while this probe was out: its answer wins.
    if (genOf(path) !== startedIn) return;
    remember(path, 'has');
    setResolved(path, { s: 'has', src: endpointUrl(path) });
  };
  img.onerror = () => {
    if (settled) return;
    settled = true; clearTimeout(deadline);
    if (genOf(path) !== startedIn) { inflight.delete(path); return; }
    settleViaFetch(path);
  };
  img.src = endpointUrl(path);
}

// ── Live updates: the server's push, and the cheap revalidation ──────────

/**
 * Paths whose answer this page got from the server (a probe, a revalidation,
 * a push). The others were drawn from the persisted cache and get revalidated.
 */
const askedThisPage = new Set<string>();

/**
 * The server stated this path's icon: `null` = it has none, a string = the
 * version now served. Authoritative (a push or a revalidation), so it bumps
 * the generation and the probes still out lose their vote. Only paths this
 * window knows about are touched: a frame about a project drawn nowhere here
 * changes nothing.
 */
function applyIconVersion(path: string, version: string | null): void {
  if (!state.has(path) && !cache()[path]) return;
  generation.set(path, genOf(path) + 1);
  askedThisPage.add(path);
  if (version === null) {
    remember(path, 'none', true);
    if (state.get(path) !== NONE) setResolved(path, NONE);
    return;
  }
  remember(path, 'has', true, version);
  const cur = state.get(path);
  if (cur?.s === 'has' && cur.version === version) return;
  if (imgTransportBroken) {
    inflight.add(path);
    settleViaFetch(path, { version });
    return;
  }
  setResolved(path, { s: 'has', src: endpointUrl(path, version), version });
}

/** A short window to gather every surface that mounts together into ONE request. */
const REVALIDATE_GATHER_MS = 250;
/** A window coming back to the front revalidates at most this often. */
const REVALIDATE_ON_FOCUS_EVERY_MS = 30_000;
const revalidationQueue = new Set<string>();
let revalidationTimer: ReturnType<typeof setTimeout> | null = null;
let lastFullRevalidation = 0;

/** Queue `path` for the next batch revalidation; false when this page already asked about it. */
function queueRevalidation(path: string): boolean {
  if (askedThisPage.has(path)) return false;
  askedThisPage.add(path);
  revalidationQueue.add(path);
  if (revalidationTimer) return true;
  revalidationTimer = setTimeout(() => {
    revalidationTimer = null;
    const paths = [...revalidationQueue];
    revalidationQueue.clear();
    void revalidate(paths);
  }, REVALIDATE_GATHER_MS);
  return true;
}

/**
 * ONE request for the current version of many icons
 * (`POST /api/projects/icon-versions`), applied where nothing newer arrived
 * meanwhile. It also tells the server which icons this window draws, so they
 * are watched: after a server restart that set is empty, and this is what
 * fills it again. A path left out of the answer (not a known project right
 * now) keeps what it has.
 */
async function revalidate(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const startedIn = new Map(paths.map((p) => [p, genOf(p)]));
  try {
    const r = await fetch('/api/projects/icon-versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths }),
      credentials: 'same-origin',
      priority: 'low',
    });
    if (!r.ok) return;
    const body = (await r.json()) as { versions?: Record<string, string | null> };
    for (const [path, version] of Object.entries(body.versions ?? {})) {
      if (!startedIn.has(path) || genOf(path) !== startedIn.get(path)) continue;
      if (inflight.has(path)) continue; // a probe is out and will answer
      applyIconVersion(path, version);
    }
  } catch {
    // Offline or the server is restarting: the reconnect revalidates again.
  }
}

/** Every icon this window draws, in one request. */
function revalidateAll(): void {
  lastFullRevalidation = Date.now();
  const paths = [...state.keys()].filter((p) => !inflight.has(p));
  for (const p of paths) askedThisPage.add(p);
  void revalidate(paths);
}

let liveArmed = false;
/**
 * Armed on the first icon asked, for the life of the page, and independent of
 * any pane: the sidebar alone is enough to receive a project's new icon.
 *  - `project:icon` frames apply directly (no probe: the version is in the frame);
 *  - a RE-connection revalidates everything (a restart lost the server's watches
 *    and any frame sent while the socket was down);
 *  - a window back to the front revalidates, at most every 30 s (a phone that
 *    slept, a laptop lid).
 */
function armLiveUpdates(): void {
  if (liveArmed) return;
  liveArmed = true;
  subscribeFrames(
    (frame) => {
      const f = frame as { path?: unknown; version?: unknown };
      if (typeof f.path !== 'string') return;
      if (f.version !== null && typeof f.version !== 'string') return;
      applyIconVersion(f.path, f.version);
    },
    { types: ['project:icon'] },
  );
  subscribeReconnect(revalidateAll);
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const onFront = () => {
    if (document.visibilityState === 'hidden') return;
    if (Date.now() - lastFullRevalidation < REVALIDATE_ON_FOCUS_EVERY_MS) return;
    revalidateAll();
  };
  window.addEventListener('focus', onFront);
  document.addEventListener('visibilitychange', onFront);
}

/**
 * The same store without React: what a surface would read for `path`, and the
 * call a surface makes when it mounts. The hooks below are these two plus a
 * subscription; the unit tests drive the store through them.
 *  @knipignore used from the child process of projectIconStore.test.ts, which knip does not see
 */
export function projectIconSnapshot(path: string): Readonly<Resolved> {
  return getSnapshot(path);
}
/** @knipignore used from the child process of projectIconStore.test.ts, which knip does not see */
export function ensureProjectIcon(path: string): void {
  ensureProbe(path);
}

/** A mounted <img> failed on a src the store believed in. Endpoint src →
 *  attempt the fetch→blob recovery (single-flight); blob src → give up for
 *  this session (short-TTL 'none', re-probed later). */
export function reportImgError(path: string, failedSrc: string): void {
  const cur = state.get(path);
  if (cur?.s !== 'has' || cur.src !== failedSrc) return; // stale report
  if (failedSrc.startsWith('blob:')) {
    remember(path, 'none', false);
    setResolved(path, NONE);
    return;
  }
  if (inflight.has(path)) return;
  inflight.add(path);
  setResolved(path, PROBING);
  settleViaFetch(path, { afterImgError: true });
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
