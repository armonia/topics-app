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
 *     streamma), durevole, condivisa da tutte le finestre e visibile in UN posto
 *     solo — le bolle «da inviare» nel trascritto (`components/Chat/QueuedTurns`);
 *   - **chi drena è uno solo**: la testa si estrae con `claimBatch`, che prende
 *     una prenotazione a scadenza — due finestre non spediscono lo stesso
 *     messaggio due volte;
 *   - **si parte tutti insieme**: quel che è in coda esce in UN turno unito
 *     (`claimBatch` + `mergeBatch`), non uno alla volta;
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
import { lastStopOf, onStopHeard, serverTurnOf, type ServerTurn, type TurnRef } from './serverTurn';

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
  /**
   * The turn that was running when this was written (the server's word, see
   * `state/serverTurn.ts`). The message may leave only once the server has
   * said THAT turn is over: shared across windows, so a window that missed the
   * end of it does not send on a stale "free".
   */
  waitsFor?: TurnRef;
  /**
   * This item already left once under its `id` as the send's key, and the
   * server may hold it (an error after the POST reached it, a network error).
   * It travels ALONE and under that key (`claimBatch`): merged with what was
   * written after it, the server's `duplicate_message` for the key took the
   * new words away with it (verifier, 03/10).
   */
  sent?: true;
}

export const QUEUE_PREFIX = 'msgQueue:v2:';
export const CLAIM_PREFIX = 'msgQueue:claim:';
export const HOLD_PREFIX = 'msgQueue:hold:';
/** The latest Stop a person has already lifted on a session (`releaseHold`), shared by every window of the profile. */
export const LIFT_PREFIX = 'msgQueue:lift:';

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
    const w = rec.waitsFor;
    out.push({
      id: typeof rec.id === 'string' && rec.id ? rec.id : newId(),
      content: rec.content,
      options: rec.options,
      queuedAt: typeof rec.queuedAt === 'string' ? rec.queuedAt : new Date(0).toISOString(),
      ...(w && typeof w.boot === 'string' && typeof w.turnId === 'number' ? { waitsFor: { boot: w.boot, turnId: w.turnId } } : {}),
      ...(rec.sent === true ? { sent: true as const } : {}),
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

/**
 * Every session with a queue on disk, hydrated here or not. A window that
 * reloads with the chat closed has none of them in its cache, and its queue
 * would wait for the pane to mount: the socket's snapshot tries them all.
 */
export function storedQueueSessions(): string[] {
  const keys = new Set<string>();
  for (const [sessionKey, items] of cache) if (items.length) keys.add(sessionKey);
  try {
    if (typeof localStorage !== 'undefined' && storage === browserStorage) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(QUEUE_PREFIX)) keys.add(k.slice(QUEUE_PREFIX.length));
      }
    }
  } catch { /* storage unavailable: the cache is all there is */ }
  return [...keys];
}

/** Rilegge dallo STORAGE ignorando la cache: usata dove un'altra finestra può aver scritto. */
function readFresh(sessionKey: string): QueuedTurn[] {
  return parseQueue(storage.getItem(queueKey(sessionKey)));
}

/**
 * Quanti turni sono in coda adesso, su quante sessioni. Per l'inventario del
 * peso (`lib/featureWeight.ts`).
 *
 * Legge la CACHE e non lo storage: l'inventario dice cosa questa finestra
 * trattiene in memoria, non cosa c'è su disco. Sono due domande diverse e
 * confonderle farebbe comparire, in una finestra appena aperta, code che qui
 * non sono mai state idratate.
 */
export function queueCount(): { entries: number; items: number } {
  let items = 0;
  for (const q of cache.values()) items += q.length;
  // Le sessioni con coda VUOTA sono in cache lo stesso (idratate e trovate
  // vuote): contarle direbbe «cinque code» quando non ce n'è nessuna.
  let entries = 0;
  for (const q of cache.values()) if (q.length > 0) entries++;
  return { entries, items };
}

function setQueue(sessionKey: string, items: QueuedTurn[]): void {
  const next = items.length ? items : EMPTY;
  cache.set(sessionKey, next);
  if (items.length) storage.setItem(queueKey(sessionKey), JSON.stringify(items));
  else storage.removeItem(queueKey(sessionKey));
  emit(sessionKey);
}

/**
 * A new item. A message that already carries its key (`clientMessageId`: an
 * outbound resend that met a turn in flight) keeps it as its id and is marked
 * `sent`: under a new key, a first attempt the server did store would be
 * stored a second time.
 */
function newItem(content: string, options?: SendMessageOptions, waitsFor?: TurnRef): QueuedTurn {
  const key = options?.clientMessageId;
  return { id: key ?? newId(), content, options, queuedAt: new Date().toISOString(), ...(waitsFor ? { waitsFor } : {}), ...(key ? { sent: true as const } : {}) };
}

/** Accoda in FONDO. Ritorna l'item, o null se non c'era niente da accodare. */
export function enqueueTurn(sessionKey: string, content: string, options?: SendMessageOptions, waitsFor?: TurnRef): QueuedTurn | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const item = newItem(trimmed, options, waitsFor);
  setQueue(sessionKey, [...readFresh(sessionKey).filter(i => i.id !== item.id), item]);
  return item;
}

/**
 * Rimette in TESTA. È la strada del ritorno: il server ha risposto 409 («c'è
 * già un turno in volo») su un messaggio che avevamo appena estratto, e
 * rimetterlo in fondo lo farebbe scavalcare da chi era in coda dietro di lui.
 *
 * Prende una LISTA perché `claimBatch` estrae tutta la testa omogenea in un
 * colpo: se quel turno non parte, tornano indietro tutti, nel loro ordine.
 */
export function requeueFront(sessionKey: string, batch: QueuedTurn[], waitsFor?: TurnRef, sentAs?: { content: string; options?: SendMessageOptions }): void {
  const items = readFresh(sessionKey);
  const known = new Set(items.map(i => i.id));
  // The server may hold what was sent (`sentAs`): it goes back as ONE item,
  // under the key and with the very words it left with, so the server's
  // `duplicate_message` and the row's echo both name all of it.
  const head = batch[0];
  const returning = sentAs && head ? [{ ...head, content: sentAs.content, options: sentAs.options, sent: true as const }] : batch;
  // Refused because a turn is in flight: the batch now waits for THAT turn.
  const back = returning.filter(i => !known.has(i.id)).map(i => (waitsFor ? { ...i, waitsFor } : i));
  if (back.length === 0) return;
  setQueue(sessionKey, [...back, ...items]);
}

/** Come `requeueFront`, ma per chi ha in mano solo il testo (il ramo 409 dell'invio). */
export function unshiftTurn(sessionKey: string, content: string, options?: SendMessageOptions, waitsFor?: TurnRef): QueuedTurn | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const item = newItem(trimmed, options, waitsFor);
  setQueue(sessionKey, [item, ...readFresh(sessionKey).filter(i => i.id !== item.id)]);
  return item;
}

export function updateTurn(sessionKey: string, id: string, content: string): void {
  const items = readFresh(sessionKey);
  // Edited words are a new message: a `sent` item takes a new key, or the
  // server would answer `duplicate_message` for the old words and drop these.
  const next = items.map((i) => {
    if (i.id !== id) return i;
    if (!i.sent || i.content === content) return { ...i, content };
    const { sent: _sent, ...unsent } = i;
    return { ...unsent, id: newId(), content };
  });
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
 * sulla stessa sessione — e da lì i messaggi tornano in testa (`requeueFront`),
 * non si perdono.
 *
 * **Esce un BATCH, non un item.** Chi scrive tre righe mentre l'agente lavora
 * sta scrivendo UN pensiero in tre pezzi: drenarle una alla volta ne fa tre
 * turni, e l'agente parte a lavorare sulla prima senza aver mai visto le altre
 * due — che è il modo più caro possibile di leggere una domanda a metà. Il
 * server prende come prompt solo l'ULTIMO messaggio utente della richiesta
 * (`server/routes/chat.ts`), quindi «insieme» qui vuol dire davvero *unite*:
 * vedi `mergeBatch`.
 *
 * Si ferma dove le OPZIONI cambiano: fast mode, provider e modello sono quelli
 * che l'umano vedeva accesi quando ha premuto invio (vedi `QueuedTurn.options`)
 * e unire due righe scritte con impostazioni diverse ne tradirebbe una. Il
 * resto della coda resta lì e parte al turno dopo.
 */
export function claimBatch(sessionKey: string, clientId: string, now: number = Date.now()): QueuedTurn[] {
  const existing = parseClaim(storage.getItem(CLAIM_PREFIX + sessionKey));
  if (existing && existing.clientId !== clientId && now - existing.at < CLAIM_LEASE_MS) return [];

  storage.setItem(CLAIM_PREFIX + sessionKey, JSON.stringify({ clientId, at: now } satisfies Claim));
  const readback = parseClaim(storage.getItem(CLAIM_PREFIX + sessionKey));
  if (!readback || readback.clientId !== clientId) return [];

  const items = readFresh(sessionKey);
  const head = items[0];
  if (!head) { releaseClaim(sessionKey, clientId); return []; }
  let end = 1;
  // A `sent` item travels alone, and nothing is merged into it.
  while (!head.sent && end < items.length && !items[end].sent && sameOptions(head.options, items[end].options)) end++;
  setQueue(sessionKey, items.slice(end));
  return items.slice(0, end);
}

/** Due turni si possono unire solo se partirebbero con la stessa richiesta. */
function sameOptions(a?: SendMessageOptions, b?: SendMessageOptions): boolean {
  return !!a?.fastMode === !!b?.fastMode
    && (a?.provider ?? null) === (b?.provider ?? null)
    && (a?.model ?? null) === (b?.model ?? null);
}

/**
 * Riga vuota fra un pezzo e l'altro: è la separazione che il markdown della
 * chat (e il modello) leggono già come «paragrafi distinti», senza inventare
 * un'intestazione che l'umano non ha scritto.
 */
export const BATCH_SEPARATOR = '\n\n';

/** Il batch come UN turno solo: testo unito, opzioni della testa (sono uguali per costruzione). */
export function mergeBatch(batch: QueuedTurn[]): { content: string; options?: SendMessageOptions } {
  return {
    content: batch.map(i => i.content).join(BATCH_SEPARATOR),
    options: batch[0]?.options,
  };
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
 * finito» e ripartirebbero a spedire). La coda resta dov'è, in chiaro nel
 * trascritto: la si può correggere sul posto, buttare, far ripartire subito
 * («invia subito») o scrivendo il messaggio dopo.
 */
export function holdQueue(sessionKey: string, stop?: TurnRef): void {
  storage.setItem(HOLD_PREFIX + sessionKey, JSON.stringify({ at: Date.now(), ...(stop ? { stop } : {}) }));
}

function readRef(raw: string | null, field?: string): TurnRef | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    const v = (field ? parsed?.[field] : parsed) as Partial<TurnRef> | undefined;
    return v && typeof v.boot === 'string' && typeof v.turnId === 'number' ? { boot: v.boot, turnId: v.turnId } : undefined;
  } catch { return undefined; }
}

/** The Stop a hold was raised for, when it was said (a hold of an older build is a bare timestamp). */
function heldStop(sessionKey: string): TurnRef | undefined {
  return readRef(storage.getItem(HOLD_PREFIX + sessionKey), 'stop');
}

/** The latest Stop a person has lifted on this session, in any window of the profile. */
export function liftedStop(sessionKey: string): TurnRef | undefined {
  return readRef(storage.getItem(LIFT_PREFIX + sessionKey));
}

/** Whether `lift` already covers `stop`: same server boot, and not older. */
export function stopLifted(stop: TurnRef, lift: TurnRef | undefined): boolean {
  return !!lift && lift.boot === stop.boot && lift.turnId >= stop.turnId;
}

/**
 * Lifts the hold: the person's own send, «send now», an emptied queue. The
 * Stops it lifts are written down for every window of the profile, because
 * the word of a Stop keeps coming after it: the close that says `stopped`
 * reaches each window on its own clock (a second window read it after the
 * first had already sent, and held the queue again for good), and a socket
 * that reopens gets it again in the snapshot. Lifted is the Stop the hold was
 * raised for, or the latest one this window has heard of, whichever is newer.
 */
export function releaseHold(sessionKey: string): void {
  const candidates = [heldStop(sessionKey), lastStopOf(sessionKey), liftedStop(sessionKey)].filter((r): r is TurnRef => !!r);
  storage.removeItem(HOLD_PREFIX + sessionKey);
  if (candidates.length === 0) return;
  // The server's current boot first: a Stop of an older boot says nothing about this one's turns.
  const boot = serverTurnOf(sessionKey)?.boot ?? candidates[0]!.boot;
  const sameBoot = candidates.filter((r) => r.boot === boot);
  const lift = sameBoot.length ? sameBoot.reduce((a, b) => (b.turnId > a.turnId ? b : a)) : candidates[0]!;
  storage.setItem(LIFT_PREFIX + sessionKey, JSON.stringify(lift));
}

export function isHeld(sessionKey: string): boolean {
  return storage.getItem(HOLD_PREFIX + sessionKey) !== null;
}

/**
 * A Stop heard by any path (`serverTurn`'s `noteStop`): the queue written
 * before it is held durably, for every window and across a restart, until the
 * person sends or lifts it. A Stop already lifted, or a head written after it,
 * holds nothing (`stopHolds`).
 */
function holdForStop(sessionKey: string, stop: TurnRef): void {
  const head = getQueue(sessionKey)[0];
  if (!head || !stopHolds(stop, liftedStop(sessionKey), head)) return;
  // The hold keeps the newest Stop of the boot. The one this window pressed is
  // written by `stopSession` before the server has said it, so `stop` (this
  // window's latest word) can be OLDER: rewriting the hold with it made the
  // lift cover only the older Stop, and the word of the newer one then held
  // the queue again after the person had sent.
  const held = heldStop(sessionKey);
  if (held && held.boot === stop.boot && held.turnId >= stop.turnId) return;
  holdQueue(sessionKey, stop);
}
onStopHeard(holdForStop);

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
 *     nuovo messaggio va IN FONDO e riparte dalla testa (tutta la coda, unita).
 *     Senza questo, scrivere dopo uno stop scavalcherebbe quello che si era
 *     scritto prima;
 *   - la sessione è libera e la coda è vuota → si spedisce.
 */
export function decideSend(input: { busy: boolean; queued: number }): SendDecision {
  if (input.busy) return 'queue';
  if (input.queued > 0) return 'queue-then-drain';
  return 'send';
}

/**
 * What the drain does now. `drain`: send the head batch. `wait-own-send`: this
 * window's own send is still streaming, try again in a moment. `wait-turn`: the
 * server has a turn open, or has not yet said that the turn the head waits for
 * is over; a `turn:state` close tries again. `hold`: nothing leaves on its own
 * (stopped by the person, nothing queued, or a question on screen that the
 * person answers first).
 */
export type DrainVerdict = 'drain' | 'wait-own-send' | 'wait-turn' | 'hold' | 'hold-stop';

/**
 * Whether a person's Stop holds the queue whose head is `head`: a Stop not yet
 * lifted, heard after the head was written. A head written during a later
 * turn than the stopped one came after the Stop, and the Stop is not its word.
 */
export function stopHolds(stop: TurnRef | undefined, lifted: TurnRef | undefined, head?: Pick<QueuedTurn, 'waitsFor'>): boolean {
  if (!stop || stopLifted(stop, lifted)) return false;
  const w = head?.waitsFor;
  return !(w && w.boot === stop.boot && w.turnId > stop.turnId);
}

/**
 * WHEN THE QUEUE LEAVES: after the server says the turn is over, and only then.
 *
 * The only condition used to be this window's own `streaming` flag, and every
 * path that reset it drained the queue into a turn still running: a history
 * read (which set it false before asking), a 409's `finally`, a reconnect, the
 * silence watchdog, the orphan reconciler. The flag is not an input here on
 * purpose: `serverTurn` is the server's ledger, which also sees the turn a CLI
 * opened by itself before anyone adopted it. When the server has said nothing
 * yet (no socket), the head leaves unless it waits for a known turn: the
 * server's 409 is the last word, and it answers with the turn to wait for.
 * A turn that ended on a question for the person (`awaitsHuman`) holds like
 * the question on screen: the answer is a new turn, and its close is the next word.
 * A person's Stop heard after the head was written, and not lifted since
 * (`stopHolds`), is `hold-stop`. The durable hold for it is raised where the
 * Stop is heard (`holdForStop`); here it also keeps a head that another window
 * wrote before hearing the Stop, until that window hears it and holds it.
 */
export function decideDrain(input: {
  held: boolean;
  queued: number;
  /** This window's own send is still streaming (its SSE is open). */
  sendLocked: boolean;
  serverTurn?: ServerTurn;
  head?: Pick<QueuedTurn, 'waitsFor'>;
  /** A question or a plan approval is on screen: the person answers it first. */
  pendingAsk: boolean;
  /** The latest Stop by a person heard on the session (`lastStopOf`). */
  stop?: TurnRef;
  /** The latest Stop the person has lifted (`liftedStop`). */
  lifted?: TurnRef;
}): DrainVerdict {
  const t = input.serverTurn;
  // The server's word that the turn ended on a question for a person counts as
  // the question on screen: this window's copy of the transcript may not show
  // it yet when the close arrives, and a window with the chat closed has none.
  if (input.held || input.queued === 0 || input.pendingAsk || t?.awaitsHuman) return 'hold';
  if (stopHolds(input.stop, input.lifted, input.head)) return 'hold-stop';
  if (input.sendLocked) return 'wait-own-send';
  if (t?.open) return 'wait-turn';
  const w = input.head?.waitsFor;
  if (w) {
    // Nothing heard since the message started waiting: no word that its turn ended.
    if (!t) return 'wait-turn';
    // Same server, and its "closed" is not newer than the opening of the turn
    // waited for (a turn is named by the revision that opened it): stale.
    if (t.boot === w.boot && t.asOf <= w.turnId) return 'wait-turn';
  }
  return 'drain';
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
