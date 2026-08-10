/**
 * La coda del TURNO: i messaggi scritti mentre l'agente sta ancora rispondendo.
 *
 * Non va confusa con `hooks/outboundQueue.ts`, che è la coda della RETE (roba
 * che il server non ha mai ricevuto). Questa è la coda dell'ATTESA: il server
 * sta benissimo, semplicemente c'è già un turno in volo e il prossimo messaggio
 * aspetta il suo giro.
 *
 * PERCHÉ ESISTE COME MODULO. Fino al 30/07 di code del turno ce n'erano DUE, e
 * non si vedevano fra loro:
 *
 *   1. `ChatPane` teneva `messageQueue` in uno stato React per-topic
 *      (`msgQueue:<topicId>`), la mostrava nel badge del composer e la drenava
 *      con un effetto la cui UNICA condizione era «non sta streammando».
 *   2. `useChat.streamQueueRef` accodava in un ref di finestra quando il lock
 *      di sessione era occupato o il server rispondeva 409 — invisibile nel
 *      badge, non persistita, persa a ogni reload, e per giunta preceduta da un
 *      `addMessage` che disegnava in chat una bolla utente MAI spedita.
 *
 * I guasti che ne uscivano, tutti verificati sul codice:
 *
 *   - **Stop non fermava: FACEVA PARTIRE.** L'effetto di drain vedeva
 *     `streaming` passare a false — che è esattamente quello che fa lo stop — e
 *     spediva il messaggio in coda. Premere «ferma» faceva partire un turno.
 *   - **Il drain viveva nella pane.** Chiusa la tab (o mai aperta, con un turno
 *     avviato da un'altra finestra), la coda restava ferma su disco per sempre;
 *     riaperta la pane, l'effetto scattava al MOUNT e spediva di colpo.
 *   - **Due finestre sullo stesso topic drenavano entrambe.** Stessa chiave di
 *     localStorage, due effetti, nessun arbitro.
 *   - **Il messaggio accodato partiva NUDO**: allegati, immagini, `@file` e la
 *     citazione della risposta venivano composti solo nel ramo dell'invio
 *     immediato, dopo il `return` dell'accodamento. Un messaggio di sole
 *     immagini, accodato, non faceva proprio niente.
 *
 * Le regole che questo modulo rende l'unica strada:
 *
 *   - **una coda sola**, per `sessionKey` (non per topic: la sessione è ciò che
 *     streamma), durevole, condivisa da tutte le finestre e visibile nel badge;
 *   - **chi drena è uno solo**: la testa si estrae con `claimHead`, che prende
 *     una prenotazione a scadenza — due finestre non spediscono lo stesso
 *     messaggio due volte;
 *   - **lo stop TIENE**: `holdQueue` alza una bandiera durevole e nessun drain
 *     riparte finché non è l'umano a rimettersi a scrivere;
 *   - **niente sorpassi**: chi scrive mentre una coda ferma esiste finisce IN
 *     FONDO, e riparte la testa (`decideSend`).
 *
 * Tutto quello che decide sta qui ed è puro (lo storage è iniettabile): i test
 * girano senza browser, vedi `chatQueue.test.ts`.
 */

import { useSyncExternalStore } from 'react';
import type { SendMessageOptions } from '../hooks/useChat';
import type { QueueStorage } from '../hooks/outboundQueue';

/** Un messaggio in attesa del suo turno, con le opzioni con cui è stato SCRITTO. */
export interface QueuedTurn {
  id: string;
  content: string;
  /**
   * Plan Mode, Fast Mode, override di provider/modello: sono quelle del momento
   * dell'accodamento, non del drain. È quello che l'umano vedeva acceso quando
   * ha premuto invio — spedirlo con le impostazioni di dieci minuti dopo
   * significherebbe scrivere sui file con il badge «solo proposte» acceso.
   */
  options?: SendMessageOptions;
  queuedAt: string;
}

export const QUEUE_PREFIX = 'msgQueue:v2:';
export const CLAIM_PREFIX = 'msgQueue:claim:';
export const HOLD_PREFIX = 'msgQueue:hold:';

/** Chiave della coda di una sessione. */
export const queueKey = (sessionKey: string): string => QUEUE_PREFIX + sessionKey;
/** Chiave della vecchia coda per-topic, letta una volta sola e poi rimossa. */
export const legacyQueueKey = (topicId: string): string => `msgQueue:${topicId}`;

/**
 * Quanto vale una prenotazione del drain. Corta di proposito: serve solo a
 * coprire l'istante fra «prendo la testa» e «il server ha accettato». Se la
 * finestra che l'aveva presa muore, dopo questo tempo un'altra può riprovare.
 */
export const CLAIM_LEASE_MS = 10_000;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Ripiego in memoria: sotto test (e in SSR) `localStorage` non esiste. */
function memoryStorage(): QueueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

const browserStorage: QueueStorage = {
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  removeItem: (k) => { try { localStorage.removeItem(k); } catch {} },
};

let storage: QueueStorage = typeof localStorage === 'undefined' ? memoryStorage() : browserStorage;

/** Solo per i test: sostituisce lo storage e azzera cache e ascoltatori. */
export function __setQueueStorage(next: QueueStorage | null): void {
  storage = next ?? (typeof localStorage === 'undefined' ? memoryStorage() : browserStorage);
  cache.clear();
}

// ---------------------------------------------------------------------------
// Lettura / scrittura
// ---------------------------------------------------------------------------

let nextLocalId = 0;
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return `q-${++nextLocalId}-${Date.now()}`;
}

/**
 * Legge tollerando i formati VECCHI: `string[]` (fino a luglio 2026) e
 * `{content, options}[]` senza id. Chi ha una coda salvata non deve perderla al
 * primo caricamento del codice nuovo — una coda persa è un messaggio perso.
 */
export function parseQueue(raw: string | null): QueuedTurn[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: QueuedTurn[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ id: newId(), content: item, queuedAt: new Date(0).toISOString() });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const rec = item as Partial<QueuedTurn>;
    if (typeof rec.content !== 'string' || !rec.content.trim()) continue;
    out.push({
      id: typeof rec.id === 'string' && rec.id ? rec.id : newId(),
      content: rec.content,
      options: rec.options,
      queuedAt: typeof rec.queuedAt === 'string' ? rec.queuedAt : new Date(0).toISOString(),
    });
  }
  return out;
}

const EMPTY: QueuedTurn[] = [];

/**
 * Specchio in memoria della coda. Serve a `useSyncExternalStore`, che pretende
 * uno snapshot STABILE: rileggere e riparsare localStorage a ogni render
 * restituirebbe un array nuovo ogni volta e il componente girerebbe all'infinito.
 */
const cache = new Map<string, QueuedTurn[]>();
const listeners = new Map<string, Set<() => void>>();

function emit(sessionKey: string): void {
  const set = listeners.get(sessionKey);
  if (!set) return;
  for (const cb of set) { try { cb(); } catch {} }
}

/** La coda di una sessione, dalla cache (idratata alla prima lettura). */
export function getQueue(sessionKey: string): QueuedTurn[] {
  const hit = cache.get(sessionKey);
  if (hit) return hit;
  const items = parseQueue(storage.getItem(queueKey(sessionKey)));
  cache.set(sessionKey, items.length ? items : EMPTY);
  return cache.get(sessionKey)!;
}

/** Rilegge dallo STORAGE ignorando la cache: usata dove un'altra finestra può aver scritto. */
function readFresh(sessionKey: string): QueuedTurn[] {
  return parseQueue(storage.getItem(queueKey(sessionKey)));
}

function setQueue(sessionKey: string, items: QueuedTurn[]): void {
  const next = items.length ? items : EMPTY;
  cache.set(sessionKey, next);
  if (items.length) storage.setItem(queueKey(sessionKey), JSON.stringify(items));
  else storage.removeItem(queueKey(sessionKey));
  emit(sessionKey);
}

/** Accoda in FONDO. Ritorna l'item, o null se non c'era niente da accodare. */
export function enqueueTurn(sessionKey: string, content: string, options?: SendMessageOptions): QueuedTurn | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const item: QueuedTurn = { id: newId(), content: trimmed, options, queuedAt: new Date().toISOString() };
  setQueue(sessionKey, [...readFresh(sessionKey), item]);
  return item;
}

/**
 * Rimette in TESTA. È la strada del ritorno: il server ha risposto 409 («c'è
 * già un turno in volo») su un messaggio che avevamo appena estratto, e
 * rimetterlo in fondo lo farebbe scavalcare da chi era in coda dietro di lui.
 */
export function requeueFront(sessionKey: string, item: QueuedTurn): void {
  const items = readFresh(sessionKey);
  if (items.some(i => i.id === item.id)) return;
  setQueue(sessionKey, [item, ...items]);
}

/** Come `requeueFront`, ma per chi ha in mano solo il testo (il ramo 409 dell'invio). */
export function unshiftTurn(sessionKey: string, content: string, options?: SendMessageOptions): QueuedTurn | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const item: QueuedTurn = { id: newId(), content: trimmed, options, queuedAt: new Date().toISOString() };
  setQueue(sessionKey, [item, ...readFresh(sessionKey)]);
  return item;
}

export function updateTurn(sessionKey: string, id: string, content: string): void {
  const items = readFresh(sessionKey);
  const next = items.map(i => (i.id === id ? { ...i, content } : i));
  setQueue(sessionKey, next);
}

export function removeTurn(sessionKey: string, id: string): void {
  const next = readFresh(sessionKey).filter(i => i.id !== id);
  setQueue(sessionKey, next);
  // Svuotata a mano l'ultima riga, il freno non trattiene più niente: va
  // spento, o resta in `localStorage` per sempre (vedi `clearQueue`).
  if (next.length === 0) releaseHold(sessionKey);
}

export function clearQueue(sessionKey: string): void {
  setQueue(sessionKey, []);
  // Il freno è DUREVOLE e finora lo toglieva solo un invio riuscito
  // (`performSend`/`editMessage`). Su una sessione fermata e mai più usata la
  // chiave `msgQueue:hold:<sessionKey>` restava in `localStorage` a vita — una
  // per sessione — e con essa una coda congelata che nemmeno un reload
  // sbloccava. Senza coda non c'è niente da trattenere.
  releaseHold(sessionKey);
}

/**
 * Porta dentro la vecchia coda per-topic. Le due chiavi convivono per un giro:
 * chi aveva messaggi in attesa sotto `msgQueue:<topicId>` se li ritrova nella
 * coda della sessione, in fondo (i nuovi arrivati sono più recenti solo se
 * scritti dopo — l'ordine di scrittura è comunque preservato per costruzione).
 */
export function adoptLegacyQueue(sessionKey: string, topicId: string): void {
  const legacy = parseQueue(storage.getItem(legacyQueueKey(topicId)));
  storage.removeItem(legacyQueueKey(topicId));
  if (legacy.length === 0) return;
  setQueue(sessionKey, [...readFresh(sessionKey), ...legacy]);
}

// ---------------------------------------------------------------------------
// Prenotazione (una finestra sola drena)
// ---------------------------------------------------------------------------

interface Claim { clientId: string; at: number }

function parseClaim(raw: string | null): Claim | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<Claim>;
    if (typeof c?.clientId === 'string' && typeof c.at === 'number') return { clientId: c.clientId, at: c.at };
  } catch {}
  return null;
}

/**
 * Estrae la testa, ma solo se nessun altro l'ha già presa.
 *
 * `localStorage` non ha una compare-and-swap, quindi si fa la cosa che
 * funziona: si scrive la prenotazione e la si RILEGGE. Se in mezzo è passata
 * un'altra finestra, la rilettura non è più nostra e ci si tira indietro. Il
 * paracadute vero resta comunque il server, che risponde 409 a un secondo turno
 * sulla stessa sessione — e da lì il messaggio torna in testa (`requeueFront`),
 * non si perde.
 */
export function claimHead(sessionKey: string, clientId: string, now: number = Date.now()): QueuedTurn | null {
  const existing = parseClaim(storage.getItem(CLAIM_PREFIX + sessionKey));
  if (existing && existing.clientId !== clientId && now - existing.at < CLAIM_LEASE_MS) return null;

  storage.setItem(CLAIM_PREFIX + sessionKey, JSON.stringify({ clientId, at: now } satisfies Claim));
  const readback = parseClaim(storage.getItem(CLAIM_PREFIX + sessionKey));
  if (!readback || readback.clientId !== clientId) return null;

  const items = readFresh(sessionKey);
  const head = items[0];
  if (!head) { releaseClaim(sessionKey, clientId); return null; }
  setQueue(sessionKey, items.slice(1));
  return head;
}

export function releaseClaim(sessionKey: string, clientId: string): void {
  const existing = parseClaim(storage.getItem(CLAIM_PREFIX + sessionKey));
  if (existing && existing.clientId !== clientId) return;
  storage.removeItem(CLAIM_PREFIX + sessionKey);
}

// ---------------------------------------------------------------------------
// Il freno dello stop
// ---------------------------------------------------------------------------

/**
 * «Ferma» vuol dire fermo. Alza una bandiera DUREVOLE (quindi la vedono anche
 * le altre finestre, che dello stop si accorgerebbero solo come «lo streaming è
 * finito» e ripartirebbero a spedire). La coda resta dov'è, visibile nel badge:
 * la si può correggere, buttare, o far ripartire scrivendo il messaggio dopo.
 */
export function holdQueue(sessionKey: string): void {
  storage.setItem(HOLD_PREFIX + sessionKey, String(Date.now()));
}

export function releaseHold(sessionKey: string): void {
  storage.removeItem(HOLD_PREFIX + sessionKey);
}

export function isHeld(sessionKey: string): boolean {
  return storage.getItem(HOLD_PREFIX + sessionKey) !== null;
}

// ---------------------------------------------------------------------------
// La decisione
// ---------------------------------------------------------------------------

export type SendDecision = 'send' | 'queue' | 'queue-then-drain';

/**
 * Cosa fare di un messaggio appena scritto. Unico punto in cui si decide fra
 * spedire e accodare — prima erano tre (l'effetto della pane, il lock in
 * `sendMessage`, il ramo 409) e non si parlavano.
 *
 *   - la sessione è occupata → in coda, e basta;
 *   - la sessione è libera ma una coda ferma esiste (tipico dopo uno stop) → il
 *     nuovo messaggio va IN FONDO e riparte la TESTA. Senza questo, scrivere
 *     dopo uno stop scavalcherebbe quello che si era scritto prima;
 *   - la sessione è libera e la coda è vuota → si spedisce.
 */
export function decideSend(input: { busy: boolean; queued: number }): SendDecision {
  if (input.busy) return 'queue';
  if (input.queued > 0) return 'queue-then-drain';
  return 'send';
}

// ---------------------------------------------------------------------------
// Aggancio a React
// ---------------------------------------------------------------------------

let storageListenerInstalled = false;

function ensureStorageListener(): void {
  // Capability, non esistenza: un `window` finto e parziale (i test) passa
  // l'`undefined` check ma non sa fare addEventListener.
  if (storageListenerInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  storageListenerInstalled = true;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (!e.key || !e.key.startsWith(QUEUE_PREFIX)) return;
    const sessionKey = e.key.slice(QUEUE_PREFIX.length);
    // Un'altra finestra ha toccato la coda: la cache locale è vecchia.
    const items = parseQueue(e.newValue);
    cache.set(sessionKey, items.length ? items : EMPTY);
    emit(sessionKey);
  });
}

export function subscribeQueue(sessionKey: string, cb: () => void): () => void {
  ensureStorageListener();
  let set = listeners.get(sessionKey);
  if (!set) { set = new Set(); listeners.set(sessionKey, set); }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(sessionKey);
  };
}

/** La coda di una sessione, come stato React. */
export function useChatQueue(sessionKey: string): QueuedTurn[] {
  return useSyncExternalStore(
    (cb) => subscribeQueue(sessionKey, cb),
    () => getQueue(sessionKey),
    () => EMPTY,
  );
}
