import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { WSMessage } from '../types';
import { normalizePinKey } from '../state/pane/adapters';
import { reconcilePinnedLayout, type PinnedRow } from '../components/Sidebar/pinnedLayout';

/**
 * Le viste della sidebar.
 *   - 'timeline' — una lista sola, ordinata per attività.
 *   - 'state'    — sezioni per STATO: attende te / al lavoro / il resto.
 *
 * 'state' risponde a una domanda che 'timeline' non pone: "di cosa devo
 * occuparmi adesso?". In 'timeline' l'unico segnale era un boost binario sulle
 * notifiche, che mescolava "aspetta una mia risposta" e "ha finito" nello
 * stesso blocco.
 *
 * ── Il modo 'grouped' (sezioni per TIPO) è stato RIMOSSO (Attilio, 06/08) ────
 * Sapere che una cosa è una chat o un terminale non aiuta a decidere cosa
 * guardare: il tipo si vede già dal glifo di ogni riga, quindi la sezione
 * ripeteva un'informazione che era già lì e in cambio spezzava la lista. Un
 * valore 'grouped' rimasto in uno stato salvato ricade su 'timeline'
 * (`hydrateSidebarState`), non lascia la sidebar vuota.
 */
export type SidebarViewMode = 'timeline' | 'state';

/** L'ordine del ciclo del bottone. Anche la guardia per un valore persistito che
 *  non riconosciamo: da lì si riparte da 'timeline'. */
export const SIDEBAR_VIEW_MODES: readonly SidebarViewMode[] = ['timeline', 'state'];

/** Il modo successivo nel ciclo. Puro, così il bottone non contiene logica. */
export function nextSidebarViewMode(current: SidebarViewMode): SidebarViewMode {
  const i = SIDEBAR_VIEW_MODES.indexOf(current);
  // Valore non riconosciuto (storage vecchio o corrotto) ⇒ riparti dall'inizio.
  if (i < 0) return SIDEBAR_VIEW_MODES[0];
  return SIDEBAR_VIEW_MODES[(i + 1) % SIDEBAR_VIEW_MODES.length];
}

/** Loosely-typed persisted sidebar state — the server/storage layer is
 *  schemaless, so every incoming value MUST pass through
 *  `sanitizeSidebarPayload` before reaching state. A plain spread does NOT
 *  drop extra keys at runtime: a pre-migration-012 client once merged the GET
 *  envelope itself ({ value, payload_version, server_seq }) into its state and
 *  PUT it back, so the stored value grew recursively-nested envelopes that
 *  every later client faithfully re-persisted forever (and the web sidebar
 *  read pinnedItems from the wrong nesting level). */
type PartialSidebarState = Partial<SidebarState>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** True if `v` looks like a ui-state GET envelope rather than the state
 *  itself. Real sidebar state never carries `value`/`server_seq` keys. */
function looksLikeEnvelope(v: Record<string, unknown>): boolean {
  return 'value' in v && ('server_seq' in v || 'payload_version' in v);
}

/** Normalize ANY persisted/broadcast payload into a clean partial state:
 *  descend through recursively-nested GET envelopes (self-heals values
 *  corrupted by the historical double-wrap), then pluck ONLY the known
 *  SidebarState keys — junk like `payload_version` must never re-enter the
 *  React state or it gets PUT straight back to the server. Returns null for
 *  payloads with no usable object at the core. Exported for unit tests. */
export function sanitizeSidebarPayload(raw: unknown): PartialSidebarState | null {
  let cur: unknown = raw;
  for (let depth = 0; isRecord(cur) && looksLikeEnvelope(cur) && depth < 10; depth++) {
    cur = cur.value;
  }
  if (!isRecord(cur)) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_STATE) as (keyof SidebarState)[]) {
    if (key in cur) out[key] = cur[key];
  }
  return out as PartialSidebarState;
}

interface SidebarState {
  expandedNodes: string[];
  viewMode: SidebarViewMode;
  showArchived: boolean;
  /** Pinned ("Fissati") sidebar items, in user pin order (append-on-pin).
   *  Keys use the SidebarItem id conventions: chats = raw topic id, projects
   *  = `project:<rawPath>` (the sidebar-item form, NOT the encoded pane id).
   *  Rides the whole sidebar-state pipeline (localStorage + server ui-state
   *  + WS + cross-tab) for free; the `{...DEFAULT_STATE, ...parsed}` spread
   *  IS the migration (old payloads deserialize with `[]`).
   *  KNOWN LWW CAVEAT (accepted, ruling 2.4): sidebar-state syncs as a
   *  whole-object last-write-wins — two clients pinning different items
   *  within the debounce window clobber each other, and a pre-feature
   *  client's next PUT drops the field entirely. Single release train. */
  pinnedItems: string[];
  /** Disposizione delle tessere fissate: righe di chiavi con le loro larghezze.
   *  Viaggia sullo stesso canale dei pin, quindi la disposizione segue l'utente
   *  da un device all'altro come i pin stessi.
   *
   *  NON è autorevole su COSA è fissato — lo è `pinnedItems`. Si riconcilia
   *  contro quella lista a ogni caricamento e a ogni pin
   *  (`reconcilePinnedLayout`), così un payload vecchio o arrivato da un altro
   *  device non può lasciare in giro celle che non si risolvono.
   *
   *  ⚠️ Il campo DEVE stare anche in `DEFAULT_STATE`: `sanitizeSidebarPayload`
   *  copia solo le chiavi che trova lì, quindi un campo non registrato verrebbe
   *  scartato a ogni GET, ogni push WS e ogni evento cross-tab — scritto e mai
   *  riletto, senza un solo errore. */
  pinnedLayout: PinnedRow[];
  // Legacy fields — kept for backward compat during migration, not used in new UI
  showProjects: boolean;
  showChats: boolean;
  showTerminals: boolean;
  showProjectsArchived: boolean;
  showChatsArchived: boolean;
  browserExpanded: boolean;
}

const STORAGE_KEY = 'topics-sidebar-state';
const SERVER_KEY = 'sidebar-state';
const DEBOUNCE_MS = 1000;
/** Quanti giri di rilettura+fusione concedersi su un 409 prima di lasciar
 *  perdere. Due bastano: al terzo la contesa non è una corsa, è un loop. */
const PUBLISH_MAX_RETRY = 2;

const DEFAULT_STATE: SidebarState = {
  expandedNodes: [],
  viewMode: 'timeline',
  showArchived: false,
  pinnedItems: [],
  pinnedLayout: [],
  // Legacy defaults
  showProjects: true,
  showChats: true,
  showTerminals: true,
  showProjectsArchived: false,
  showChatsArchived: false,
  browserExpanded: false,
};

/**
 * Da payload ripulito a stato utilizzabile: default, migrazioni, riconciliazione.
 *
 * Sta in UNA funzione perché i payload entrano da cinque porte — localStorage,
 * la GET iniziale, `ui-state:updated`, `ui-state:init`, l'evento `storage` fra
 * tab — e una migrazione applicata in quattro punti su cinque è una migrazione
 * che non c'è. Vale per la forma vecchia della chiave di pin in particolare:
 * può ripresentarsi da qualunque porta finché un client non aggiornato è vivo.
 *
 * Esportata per i test.
 */
export function hydrateSidebarState(parsed: PartialSidebarState): SidebarState {
  const merged: SidebarState = { ...DEFAULT_STATE, ...parsed };

  // Il modo per TIPO non esiste più: chi ce l'aveva salvato torna alla lista.
  if ((merged.viewMode as string) === 'grouped') merged.viewMode = 'timeline';

  // Formato vecchio (nessun viewMode): deriva dai flag di allora.
  if (!parsed.viewMode) {
    merged.viewMode = 'timeline';
    merged.showArchived = parsed.showProjectsArchived || parsed.showChatsArchived || false;
  }

  // Una sola chiave per progetto. Un pin messo da una TAB prima di
  // `normalizePinKey` porta il path codificato, e il blocco Fissati — che cerca
  // quello grezzo — non lo trovava mai: la riga non compariva, e lo stesso
  // progetto poteva finire due volte in lista, una per superficie.
  const pins: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(merged.pinnedItems) ? merged.pinnedItems : []) {
    if (typeof raw !== 'string') continue;
    const key = normalizePinKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    pins.push(key);
  }
  merged.pinnedItems = pins;

  // Il layout si riconcilia SEMPRE contro i pin: idempotente, e regge un payload
  // assente, vecchio, o scritto da un device che conosceva altri fissati.
  const rows = Array.isArray(merged.pinnedLayout) ? merged.pinnedLayout : [];
  merged.pinnedLayout = reconcilePinnedLayout(
    pins,
    rows.map(r =>
      r && Array.isArray(r.keys)
        ? { keys: r.keys.map(k => (typeof k === 'string' ? normalizePinKey(k) : k)), widths: r.widths }
        : r,
    ),
  );

  return merged;
}

/** La `server_seq` dentro una busta ui-state, o `null` se non c'è. */
export function readServerSeq(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const seq = raw.server_seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null;
}

/** Unione ordinata: prima gli elementi di `a`, poi quelli di `b` che mancano. */
function unionOrdered(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  const seen = new Set(a);
  for (const x of b) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

/**
 * Fonde lo stato REMOTO appena riletto con quello LOCALE, dopo che il server ha
 * rifiutato la scrittura perché partiva da una versione superata.
 *
 * Il criterio non è "vince l'ultimo": è "non si perde niente".
 *   • `pinnedItems` / `expandedNodes` → UNIONE. Se un altro device ha fissato
 *     qualcosa mentre fissavo io, alla fine devono esserci entrambi — è lo
 *     stesso patto dell'union multi-client sull'hydrate del pane-store.
 *   • `pinnedLayout` → la disposizione LOCALE, riconciliata contro i pin uniti:
 *     chi ha appena trascinato è qui, e ogni pin arrivato da fuori riceve
 *     comunque la sua cella invece di restare senza posto.
 *   • tutto il resto (modo di vista, archiviati, flag legacy) → LOCALE: sono
 *     intenzioni di questo schermo, non fatti condivisi.
 *
 * Esportata per i test.
 */
export function mergeSidebarStates(remote: SidebarState, local: SidebarState): SidebarState {
  const pinnedItems = unionOrdered(remote.pinnedItems, local.pinnedItems);
  return {
    ...local,
    expandedNodes: unionOrdered(remote.expandedNodes, local.expandedNodes),
    pinnedItems,
    pinnedLayout: reconcilePinnedLayout(pinnedItems, local.pinnedLayout),
  };
}

function loadFromStorage(): SidebarState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = sanitizeSidebarPayload(JSON.parse(raw));
      if (!parsed) return DEFAULT_STATE;
      return hydrateSidebarState(parsed);
    }
  } catch {}
  return DEFAULT_STATE;
}

function saveToStorage(state: SidebarState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function useSidebarState(onMessage?: (handler: (msg: WSMessage) => void) => () => void) {
  const [state, setStateRaw] = useState<SidebarState>(loadFromStorage);

  const stateRef = useRef(state);
  // eslint-disable-next-line react-hooks/refs -- intentional state→ref mirror so async/WS callbacks read the latest committed value without re-subscribing
  stateRef.current = state;

  const isFromServerRef = useRef(false);
  // Gate for the debounced PUT: a client must HYDRATE from the server before it
  // may write. Without this, a fresh client (empty localStorage) interacting in
  // the window before the initial GET resolves PUTs its DEFAULT_STATE — wiping
  // server-side pinnedItems/expandedNodes for every other client (LWW). This is
  // exactly how the pinned sessions were lost when pin-sync first came alive.
  const hydratedRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Track when user last interacted — ignore WS pushes for 2s after local changes
  const lastLocalChangeRef = useRef(0);
  /** La versione del server da cui questo stato deriva — la `base` del CAS.
   *  `null` = mai vista una versione: si scrive senza condizione (comportamento
   *  di prima), perché condizionare su un numero inventato bloccherebbe la
   *  prima scrittura per sempre. */
  const serverSeqRef = useRef<number | null>(null);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Fetch from server on mount
  // PANE-01-ALLOWED: non-pane ui-state key (sidebar-state: viewMode, expandedNodes, showArchived). Not one of the 6 legacy pane keys.
  // GET /api/ui-state/:key endpoint returns { value, payload_version, server_seq } // PANE-01-ALLOWED
  // as of migration 012; unwrap .value for the legacy consumer shape.
  useEffect(() => {
    fetch(`/api/ui-state/${encodeURIComponent(SERVER_KEY)}`) // PANE-01-ALLOWED: sidebar-state key, not pane state
      .then((r): Promise<unknown> | null => r.ok ? r.json() : null)
      .then((envelope: unknown) => {
        // La versione va letta dalla BUSTA, prima che il sanitize scenda dentro
        // `value`: è la `base` con cui le scritture successive si condizionano.
        serverSeqRef.current = readServerSeq(envelope);
        // PANE-01-ALLOWED: sanitize = unwrap v2 envelope (recursively, healing
        // the historical double-wrap corruption) + strip unknown keys.
        const sv = sanitizeSidebarPayload(envelope);
        if (!mountedRef.current || !sv) return;
        const merged = hydrateSidebarState(sv);
        isFromServerRef.current = true;
        setStateRaw(merged);
        saveToStorage(merged);
      })
      .catch(() => {})
      // Success OR failure: only after the initial fetch settles may this
      // client publish. On failure the PUT would fail too, so nothing is lost.
      .finally(() => { hydratedRef.current = true; });
  }, []);

  // WS listener — skip if user made a local change recently (prevents overwrite race)
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: WSMessage) => {
      // If user interacted locally in the last 2s, ignore server pushes to avoid overwriting
      if (Date.now() - lastLocalChangeRef.current < 2000) return;

      if (msg.type === 'ui-state:updated' && msg.key === SERVER_KEY) {
        const sv = sanitizeSidebarPayload(msg.value);
        if (!sv) return;
        // Il broadcast porta la versione appena scritta: accettandola qui, la
        // prossima scrittura locale si condiziona su quella e non sul numero
        // vecchio (che verrebbe rifiutato per sempre).
        const seq = readServerSeq(msg);
        if (seq !== null) serverSeqRef.current = seq;
        const merged = hydrateSidebarState(sv);
        isFromServerRef.current = true;
        setStateRaw(merged);
        saveToStorage(merged);
      }
      if (msg.type === 'ui-state:init' && msg.data && SERVER_KEY in msg.data) {
        const sv = sanitizeSidebarPayload(msg.data[SERVER_KEY]);
        if (!sv) return;
        const seq = readServerSeq(msg.data[SERVER_KEY]);
        if (seq !== null) serverSeqRef.current = seq;
        const merged = hydrateSidebarState(sv);
        isFromServerRef.current = true;
        setStateRaw(merged);
        saveToStorage(merged);
      }
    });
  }, [onMessage]);

  // Cross-tab sync via storage events
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try {
        const sv = sanitizeSidebarPayload(JSON.parse(e.newValue));
        if (!sv) return;
        isFromServerRef.current = true;
        setStateRaw(hydrateSidebarState(sv));
      } catch {}
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  /**
   * Pubblica lo stato con un CAS: `?base=<server_seq>`, e sul 409 `stale_base`
   * NON si sovrascrive — si rilegge, si fonde (`mergeSidebarStates`) e si
   * riprova sulla versione corrente.
   *
   * Serve perché questa chiave sincronizza come oggetto intero: senza
   * condizione, due device che si muovono nella stessa finestra di debounce si
   * cancellano a vicenda. È già successo, e allora costava un pin; ora dentro
   * c'è anche la disposizione delle tessere, cioè lavoro manuale.
   */
  const publish = useCallback(async (initial: SidebarState): Promise<void> => {
    let next = initial;
    // Un ciclo e non una ricorsione: il retry è lo STESSO tentativo su una base
    // più recente, e scritto così il tetto dei giri è in vista invece di essere
    // un parametro che si passa da solo.
    for (let attempt = 0; attempt <= PUBLISH_MAX_RETRY; attempt++) {
      const base = serverSeqRef.current;
      const q = base !== null ? `?base=${base}` : '';
      try {
        // PANE-01-ALLOWED: non-pane ui-state key (sidebar-state).
        const res = await fetch(`/api/ui-state/${encodeURIComponent(SERVER_KEY)}${q}`, { // PANE-01-ALLOWED
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        });

        if (res.status !== 409) {
          if (res.ok) {
            const seq = readServerSeq(await res.json().catch(() => null));
            if (seq !== null) serverSeqRef.current = seq;
          }
          return;
        }

        // Qualcuno ha scritto nel frattempo: si rilegge e si fonde, invece di
        // ripassarci sopra.
        if (attempt === PUBLISH_MAX_RETRY || !mountedRef.current) return;
        // PANE-01-ALLOWED: rilettura della stessa chiave non-pane per il retry.
        const fresh = await fetch(`/api/ui-state/${encodeURIComponent(SERVER_KEY)}`) // PANE-01-ALLOWED
          .then((r): Promise<unknown> | null => (r.ok ? r.json() : null))
          .catch(() => null);
        if (!mountedRef.current) return;
        serverSeqRef.current = readServerSeq(fresh);
        const sv = sanitizeSidebarPayload(fresh);
        next = sv ? mergeSidebarStates(hydrateSidebarState(sv), next) : next;
        isFromServerRef.current = true;
        setStateRaw(next);
        saveToStorage(next);
      } catch {
        // Rete giù: lo stato resta in localStorage e riparte alla prossima modifica.
        return;
      }
    }
  }, []);

  // Debounced PUT to server on local change
  useEffect(() => {
    if (isFromServerRef.current) {
      isFromServerRef.current = false;
      return;
    }

    // Write localStorage immediately
    saveToStorage(state);

    // Never publish before hydrating (see hydratedRef) — the local change is
    // kept in localStorage and the next interaction after hydrate syncs it.
    if (!hydratedRef.current) return;

    // Debounce server PUT
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => { void publish(state); }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [state, publish]);

  // Helper to update a single field
  const updateField = useCallback(<K extends keyof SidebarState>(key: K, value: SidebarState[K]) => {
    lastLocalChangeRef.current = Date.now();
    setStateRaw(prev => ({ ...prev, [key]: value }));
  }, []);

  // Memoize the Set so consumers get a stable reference when contents don't change
  const expandedNodes = useMemo(() => new Set(state.expandedNodes), [state.expandedNodes]);

  const toggleNode = useCallback((id: string) => {
    lastLocalChangeRef.current = Date.now();
    setStateRaw(prev => {
      const set = new Set(prev.expandedNodes);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return { ...prev, expandedNodes: Array.from(set) };
    });
  }, []);

  // Pinning ("Fissati") — pure pin-state ops. The unpin-while-closed archive
  // semantics live in the App-level wrapper (it needs openPanels/topics);
  // this hook only owns the persisted list.
  const pinnedIds = useMemo(() => new Set(state.pinnedItems), [state.pinnedItems]);

  const togglePin = useCallback((rawId: string) => {
    lastLocalChangeRef.current = Date.now();
    const id = normalizePinKey(rawId);
    setStateRaw(prev => {
      const pinnedItems = prev.pinnedItems.includes(id)
        ? prev.pinnedItems.filter(p => p !== id)
        : [...prev.pinnedItems, id];
      // Lista e disposizione si muovono nello STESSO setState. Separarle
      // lascerebbe il layout con celle che non si risolvono (unpin) o fissati
      // senza posto (pin), per tutto il tempo fra i due aggiornamenti.
      return { ...prev, pinnedItems, pinnedLayout: reconcilePinnedLayout(pinnedItems, prev.pinnedLayout) };
    });
  }, []);

  /** La disposizione dopo un drag. Riconciliata comunque: chi chiama passa una
   *  griglia, non la verità su cosa è fissato. */
  const setPinnedLayout = useCallback((next: PinnedRow[]) => {
    lastLocalChangeRef.current = Date.now();
    setStateRaw(prev => ({ ...prev, pinnedLayout: reconcilePinnedLayout(prev.pinnedItems, next) }));
  }, []);

  // Stable predicate (reads through stateRef) so ref-backed consumers — the
  // usePanelLifecycle archive guards — never re-bind on pin changes.
  const isPinned = useCallback(
    (id: string) => stateRef.current.pinnedItems.includes(normalizePinKey(id)),
    [],
  );

  // New view mode controls
  const setViewMode = useCallback((v: SidebarViewMode) => updateField('viewMode', v), [updateField]);
  const toggleViewMode = useCallback(() => {
    lastLocalChangeRef.current = Date.now();
    setStateRaw(prev => ({ ...prev, viewMode: nextSidebarViewMode(prev.viewMode) }));
  }, []);
  const setShowArchived = useCallback((v: boolean) => updateField('showArchived', v), [updateField]);
  const toggleShowArchived = useCallback(() => {
    lastLocalChangeRef.current = Date.now();
    setStateRaw(prev => ({ ...prev, showArchived: !prev.showArchived }));
  }, []);

  // Legacy setters (still used during transition by App.tsx browser section etc.)
  const setShowProjects = useCallback((v: boolean) => updateField('showProjects', v), [updateField]);
  const setShowChats = useCallback((v: boolean) => updateField('showChats', v), [updateField]);
  const setShowTerminals = useCallback((v: boolean) => updateField('showTerminals', v), [updateField]);
  const setShowProjectsArchived = useCallback((v: boolean) => updateField('showProjectsArchived', v), [updateField]);
  const setShowChatsArchived = useCallback((v: boolean) => updateField('showChatsArchived', v), [updateField]);

  const setBrowserExpanded = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setStateRaw(prev => ({
      ...prev,
      browserExpanded: typeof v === 'function' ? v(prev.browserExpanded) : v,
    }));
  }, []);

  return {
    expandedNodes,
    toggleNode,
    // Pinning (Fissati)
    pinnedItems: state.pinnedItems,
    pinnedIds,
    pinnedLayout: state.pinnedLayout,
    setPinnedLayout,
    togglePin,
    isPinned,
    // New
    viewMode: state.viewMode,
    setViewMode,
    toggleViewMode,
    showArchived: state.showArchived,
    setShowArchived,
    toggleShowArchived,
    // Legacy
    showProjects: state.showProjects,
    setShowProjects,
    showChats: state.showChats,
    setShowChats,
    showTerminals: state.showTerminals,
    setShowTerminals,
    showProjectsArchived: state.showProjectsArchived,
    setShowProjectsArchived,
    showChatsArchived: state.showChatsArchived,
    setShowChatsArchived,
    browserExpanded: state.browserExpanded,
    setBrowserExpanded,
  };
}
