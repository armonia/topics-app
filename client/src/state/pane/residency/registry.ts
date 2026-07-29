/**
 * Il registro di residenza: raccoglie i fatti da tutte le superfici, chiede a
 * `policy.ts` chi resta, e APPLICA l'esito.
 *
 * Vive fuori dallo store zustand di proposito. La residenza è locale al device
 * e non ha niente da dire agli altri client: farla passare dallo store
 * bumperebbe `lastSeq` e la spedirebbe in giro come se fosse layout. Il
 * precedente esatto è `setPaneScrollOffset` (`state/pane/store.ts`), che per lo
 * stesso motivo scrive nel draft senza toccare `lastSeq`.
 *
 * È un singleton di modulo perché il tetto è GLOBALE al renderer: ogni
 * `GroupLayout` (compresi quelli annidati dentro le pane `project`), ogni
 * gruppo standalone e ogni finestra staccata si registra come SUPERFICIE, e la
 * decisione si prende sull'unione. Un registro per superficie sarebbe il bug
 * che stiamo togliendo, scritto in un altro modo.
 *
 * ORDINE, che è l'invariante da non rompere: **ammissioni sincrone, sfratti
 * differiti**. Quando il timer di sfratto scatta, il render visibile→nascosto è
 * già stato committato e i suoi effetti sono girati — la WKWebView è già spenta
 * (`setNativeVisible(false)`), URL e titolo sono persistiti, il coalescer del
 * terminale ha già fatto flush. Smontare prima significherebbe perdere
 * esattamente quel lavoro (è il motivo del commit `6cadd3b6`, qui reso
 * strutturale invece che affidato all'ordine degli effetti).
 */
import {
  computeResident,
  MIN_DWELL_MS,
  RESIDENCY_BUDGET,
  type ResidencyCandidate,
} from './policy';

/**
 * Ritardo fra la decisione di sfrattare e lo smontaggio. Maggiore di
 * `BROWSER_CLOSE_GRACE_MS` (350 ms, `useTauriBrowser.ts`), che è la finestra in
 * cui una pane browser nascosta spegne la sua WKWebView: sfrattare prima
 * lascerebbe il comando di chiusura senza il componente che lo manda.
 */
export const EVICT_DELAY_MS = 1500;

/** Iniettabile solo per i test: il tempo e i timer del registro. */
export interface ResidencyClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: ResidencyClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

let clock: ResidencyClock = realClock;

interface Surface {
  candidates: readonly ResidencyCandidate[];
  visible: readonly string[];
}

const surfaces = new Map<string, Surface>();
/** Chiave → quante ragioni la trattengono. Refcount: due upload, due hold. */
const holds = new Map<string, number>();
const lastTouchedAt = new Map<string, number>();
const pendingRemoval = new Map<string, unknown>();
const listeners = new Set<() => void>();
/**
 * Il dwell è l'unica regola che scade DA SOLA, senza che nessuno riporti niente:
 * una pane protetta solo perché lasciata un istante fa diventa sfrattabile al
 * passare del tempo. Senza questo timer resterebbe montata fino al prossimo
 * cambio di layout — cioè, con l'app ferma, per sempre.
 */
let dwellTimer: unknown = undefined;

/**
 * L'insieme applicato. Il riferimento cambia SOLO quando cambia l'appartenenza,
 * così `useSyncExternalStore` non ri-renderizza per niente.
 */
let resident: ReadonlySet<string> = new Set();

function notify(): void {
  for (const fn of listeners) fn();
}

/** L'unione delle superfici, più i fatti che il registro accumula da sé. */
function decide() {
  const candidates: ResidencyCandidate[] = [];
  const visible = new Set<string>();
  for (const s of surfaces.values()) {
    for (const c of s.candidates) candidates.push(c);
    for (const k of s.visible) visible.add(k);
  }
  const held = new Set<string>();
  for (const [k, n] of holds) if (n > 0) held.add(k);
  const now = clock.now();
  // Il primo istante futuro in cui una protezione da dwell scade. È l'unico
  // modo in cui la decisione può cambiare senza che nessuno riporti nulla.
  let nextDwellExpiry = Infinity;
  for (const c of candidates) {
    if (visible.has(c.key) || held.has(c.key)) continue;
    const t = lastTouchedAt.get(c.key);
    if (t === undefined) continue;
    const expiry = t + MIN_DWELL_MS;
    if (expiry > now && expiry < nextDwellExpiry) nextDwellExpiry = expiry;
  }
  return {
    decision: computeResident({
      candidates,
      visible,
      held,
      lastTouchedAt,
      now,
      budget: RESIDENCY_BUDGET,
      minDwellMs: MIN_DWELL_MS,
    }),
    liveKeys: new Set(candidates.map((c) => c.key)),
    nextDwellExpiry,
    now,
  };
}

/**
 * Riarma la sveglia sulla prossima scadenza di dwell. Una sola sveglia per tutto
 * il registro: la prima scadenza è anche l'unico istante in cui vale la pena
 * ripensarci, e il ricalcolo che ne segue ne fisserà un'altra se serve.
 */
function armDwellTimer(nextDwellExpiry: number, now: number): void {
  if (dwellTimer !== undefined) {
    clock.clearTimeout(dwellTimer);
    dwellTimer = undefined;
  }
  if (!Number.isFinite(nextDwellExpiry)) return;
  dwellTimer = clock.setTimeout(() => {
    dwellTimer = undefined;
    recompute();
  }, Math.max(1, nextDwellExpiry - now));
}

/**
 * Rimuove una chiave dall'insieme applicato, se la decisione corrente la vuole
 * ancora fuori. Ricontrolla invece di fidarsi della decisione di 1.5 s fa: nel
 * frattempo la pane può essere tornata visibile, o un agente può averla presa.
 */
function applyRemoval(key: string): void {
  pendingRemoval.delete(key);
  if (!resident.has(key)) return;
  const { decision, liveKeys } = decide();
  if (decision.resident.has(key)) return; // è tornata dentro: niente da fare
  const next = new Set(resident);
  next.delete(key);
  resident = next;
  // La recency serve solo a ordinare i candidati. Se la pane non è più in
  // nessuna superficie è stata chiusa: tenerne la data è una perdita lenta.
  if (!liveKeys.has(key)) lastTouchedAt.delete(key);
  notify();
}

/**
 * Ricalcola e applica. Le ammissioni entrano subito; le uscite — sia gli sfratti
 * per budget sia le potature di pane chiuse — passano dal ritardo.
 *
 * Perché anche le potature aspettano: una pane che si sposta fra due superfici
 * (routing di una chat dentro un progetto) può sparire da entrambe per un solo
 * commit. Smontarla in quell'istante costerebbe scroll e cronologia per un
 * movimento che l'utente vede come "trascino una tab".
 */
function recompute(): void {
  const { decision, nextDwellExpiry, now } = decide();
  armDwellTimer(nextDwellExpiry, now);
  let changed = false;
  const next = new Set(resident);

  for (const k of decision.resident) {
    if (!next.has(k)) {
      next.add(k);
      changed = true;
    }
    const timer = pendingRemoval.get(k);
    if (timer !== undefined) {
      clock.clearTimeout(timer);
      pendingRemoval.delete(k);
    }
  }

  for (const k of resident) {
    if (decision.resident.has(k)) continue;
    if (pendingRemoval.has(k)) continue;
    pendingRemoval.set(k, clock.setTimeout(() => applyRemoval(k), EVICT_DELAY_MS));
  }

  if (changed) {
    resident = next;
    notify();
  }
}

/**
 * Una superficie dichiara cosa può montare e cosa sta mostrando adesso.
 * Idempotente: chiamarla con gli stessi dati non ricalcola e non notifica.
 */
export function reportSurface(
  id: string,
  candidates: readonly ResidencyCandidate[],
  visible: readonly string[],
): void {
  const now = clock.now();
  for (const k of visible) lastTouchedAt.set(k, now);

  const prev = surfaces.get(id);
  if (prev && sameSurface(prev, candidates, visible)) {
    // Nessun cambio strutturale, ma la recency delle visibili è avanzata: il
    // dwell si misura da adesso. Non serve ricalcolare — nessuna chiave cambia
    // lato residenza finché non cambiano candidati o visibilità.
    return;
  }
  surfaces.set(id, { candidates, visible });
  recompute();
}

function sameSurface(
  prev: Surface,
  candidates: readonly ResidencyCandidate[],
  visible: readonly string[],
): boolean {
  if (prev.candidates.length !== candidates.length) return false;
  if (prev.visible.length !== visible.length) return false;
  for (let i = 0; i < candidates.length; i++) {
    if (prev.candidates[i]!.key !== candidates[i]!.key) return false;
    if (prev.candidates[i]!.cls !== candidates[i]!.cls) return false;
  }
  for (let i = 0; i < visible.length; i++) {
    if (prev.visible[i] !== visible[i]) return false;
  }
  return true;
}

/** La superficie si smonta (finestra chiusa, pane `project` sfrattata). */
export function releaseSurface(id: string): void {
  if (!surfaces.delete(id)) return;
  recompute();
}

/**
 * Trattiene una chiave: finché la funzione restituita non viene chiamata, quella
 * pane non viene sfrattata. Serve per il lavoro che uno smontaggio perderebbe —
 * un agente che sta guidando una pane browser, un upload in volo in una chat.
 *
 * Refcounted: due ragioni, due `hold`, e la pane si libera quando cade
 * l'ultima. La funzione di rilascio è idempotente, così una cleanup React che
 * gira due volte (StrictMode) non scala il contatore due volte.
 */
export function holdKey(key: string): () => void {
  holds.set(key, (holds.get(key) ?? 0) + 1);
  recompute();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (holds.get(key) ?? 1) - 1;
    if (n <= 0) holds.delete(key);
    else holds.set(key, n);
    recompute();
  };
}

export function subscribeResidency(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getResidencySnapshot(): ReadonlySet<string> {
  return resident;
}

/**
 * Quanto tiene questo registro. `lastTouchedAt` e `holds` sono Map di modulo:
 * se una chiave ci restasse dopo la chiusura della pane, crescerebbero per
 * sempre. Sono piccole (una stringa e un numero per pane), ma un CONTEGGIO che
 * sale senza mai scendere e' esattamente cio' che la sonda deve poter vedere.
 */
export function residencyHeapReport(): {
  entries: number;
  items: number;
  detail: Record<string, unknown>;
} {
  return {
    entries: resident.size,
    items: lastTouchedAt.size + holds.size + surfaces.size,
    detail: {
      residenti: resident.size,
      recency: lastTouchedAt.size,
      hold: holds.size,
      superfici: surfaces.size,
      inUscita: pendingRemoval.size,
    },
  };
}

export function isResident(key: string): boolean {
  return resident.has(key);
}

/** Solo per i test: rimette il registro allo stato di boot. */
export function __resetResidency(injected?: ResidencyClock): void {
  for (const t of pendingRemoval.values()) clock.clearTimeout(t);
  if (dwellTimer !== undefined) clock.clearTimeout(dwellTimer);
  dwellTimer = undefined;
  pendingRemoval.clear();
  surfaces.clear();
  holds.clear();
  lastTouchedAt.clear();
  listeners.clear();
  resident = new Set();
  clock = injected ?? realClock;
}

/** Solo per la diagnostica in dev e per i test: cosa sta trattenendo cosa. */
export function __residencyDebug(): {
  resident: string[];
  pendingRemoval: string[];
  holds: Record<string, number>;
  surfaces: number;
} {
  return {
    resident: [...resident].sort(),
    pendingRemoval: [...pendingRemoval.keys()].sort(),
    holds: Object.fromEntries(holds),
    surfaces: surfaces.size,
  };
}
