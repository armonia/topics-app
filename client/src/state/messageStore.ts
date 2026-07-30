import type { ChatMessage } from '../types';

/**
 * I messaggi delle chat, fuori dallo stato di `App`.
 *
 * IL PROBLEMA. `useChat` è chiamato dentro `App`, quindi i messaggi di TUTTE le
 * sessioni erano uno `useState` della radice: ogni token in arrivo ri-renderizza
 * l'intero albero — sidebar, tab bar, ogni pane — per aggiornare una chat sola.
 * Durante uno streaming sono decine di volte al secondo.
 *
 * Il costo si vede nel profilo, e non è dove ci si aspetta: `sample` sul renderer
 * della UI (2026-07-29) mostra `ElementRuleCollector::collectMatchingRulesForList`
 * e `Style::Builder::applyProperty` — RICALCOLO DEGLI STILI, non layout né paint.
 * È la firma di troppi commit React, non di un albero troppo profondo: la leva è
 * ridurre i render, non i `div`.
 *
 * LA FORMA. Uno store di modulo con sottoscrizione PER SESSIONE. Chi guarda una
 * chat si iscrive alla sua chiave e si sveglia solo per quella; `App` non si
 * iscrive affatto, quindi un token non la tocca più.
 *
 * `update()` ha di proposito la stessa firma dell'updater di `useState`
 * (`prev => next` sull'intera mappa): i venticinque punti di `useChat` che
 * chiamavano `setMessages` non cambiano di una riga, e restano leggibili come
 * prima. È l'unico modo di fare questo spostamento senza riscrivere la logica
 * della chat insieme al meccanismo che la ospita — che è esattamente come si
 * introducono i bug che poi nessuno ritrova.
 *
 * IDENTITÀ. `getSession()` restituisce lo stesso array finché quella sessione
 * non cambia: `useSyncExternalStore` lo richiede (uno snapshot nuovo a ogni
 * chiamata è un loop infinito), e per i consumatori memoizzati significa che una
 * chat ferma non si ri-renderizza mai.
 */

export type MessageMap = Record<string, ChatMessage[]>;

/** Riferimento stabile per una sessione senza messaggi: mai un array nuovo. */
const EMPTY: ChatMessage[] = [];

let state: MessageMap = {};
/** Iscritti per chiave di sessione, più quelli che vogliono sapere tutto. */
const perSession = new Map<string, Set<() => void>>();
const global = new Set<() => void>();
/**
 * Ultimo istante in cui una sessione è stata scritta o LASCIATA (l'ultimo che la
 * guardava si è disiscritto). È il dato su cui `messageResidency` sceglie chi
 * tenere caldo: senza, «la più recente» non si può nemmeno definire.
 */
const touchedAt = new Map<string, number>();

/** L'intera mappa. Per le letture sincrone dentro le callback di `useChat`. */
export function getAllMessages(): MessageMap {
  return state;
}

/** I messaggi di una sessione, con identità stabile finché non cambiano. */
export function getSessionMessagesFromStore(sessionKey: string): ChatMessage[] {
  return state[sessionKey] ?? EMPTY;
}

/**
 * Sostituisce la mappa, e sveglia SOLO chi guarda una sessione cambiata.
 *
 * Il confronto è per riferimento, ed è corretto perché ogni scrittura costruisce
 * un array nuovo per la sessione toccata (`{...prev, [sk]: next}`): è la stessa
 * invariante da cui dipendevano già i `memo` a valle.
 */
export function updateMessages(updater: (prev: MessageMap) => MessageMap): void {
  const prev = state;
  const next = updater(prev);
  if (next === prev) return;
  state = next;

  // Chi è cambiato: le chiavi con un array diverso, in un verso o nell'altro.
  const touched = new Set<string>();
  for (const k of Object.keys(next)) {
    if (next[k] !== prev[k]) touched.add(k);
  }
  for (const k of Object.keys(prev)) {
    if (!(k in next)) touched.add(k);
  }

  const at = Date.now();
  for (const k of touched) {
    if (k in next) touchedAt.set(k, at);
    else touchedAt.delete(k);
    const subs = perSession.get(k);
    if (subs) for (const fn of subs) fn();
  }
  // I globali si svegliano solo se qualcosa è cambiato davvero, non a ogni giro.
  if (touched.size > 0) for (const fn of global) fn();
}

/** Rimpiazza tutto (idratazione al boot, reset nei test). */
export function replaceAllMessages(next: MessageMap): void {
  updateMessages(() => next);
}

/** Si iscrive a UNA sessione. È questa la ragione per cui lo store esiste. */
export function subscribeSession(sessionKey: string, fn: () => void): () => void {
  let subs = perSession.get(sessionKey);
  if (!subs) {
    subs = new Set();
    perSession.set(sessionKey, subs);
  }
  subs.add(fn);
  return () => {
    const s = perSession.get(sessionKey);
    if (!s) return;
    s.delete(fn);
    // Poteratura: senza, questa mappa cresce quanto il numero di sessioni mai
    // aperte, e resterebbe piena di Set vuoti per sempre.
    if (s.size === 0) {
      perSession.delete(sessionKey);
      // Da adesso è «lasciata»: il conto della grazia parte da qui, non
      // dall'ultima scrittura. Una chat guardata per un'ora senza che arrivi un
      // messaggio sarebbe altrimenti vecchia di un'ora nell'istante in cui la
      // chiudi, e sfrattabile al primo giro dello spazzino.
      touchedAt.set(sessionKey, Date.now());
    }
  };
}

/** Si iscrive a QUALSIASI cambiamento. Per i pochi che devono sapere tutto. */
export function subscribeAllMessages(fn: () => void): () => void {
  global.add(fn);
  return () => {
    global.delete(fn);
  };
}

/**
 * I fatti che servono a decidere chi tiene il proprio trascritto in memoria.
 *
 * `watched` lo sa SOLO questo modulo: una pane montata è iscritta alla sua
 * sessione, una smontata no. È il segnale più diretto che esista di «qualcuno la
 * sta guardando» — più diretto del tetto di residenza delle pane, che parla di
 * chiavi di pane e non di sessioni.
 */
export function listSessions(): { key: string; watched: boolean; messages: number; lastTouchedAt: number }[] {
  return Object.keys(state).map((key) => ({
    key,
    watched: (perSession.get(key)?.size ?? 0) > 0,
    messages: state[key]?.length ?? 0,
    // Una sessione idratata al boot dalla cache non è mai stata toccata: vale
    // come «toccata all'origine dei tempi», cioè sfrattabile per prima.
    lastTouchedAt: touchedAt.get(key) ?? 0,
  }));
}

/**
 * Restituisce la memoria di queste sessioni. La chat ricarica da `/api/history`
 * quando rientra: qui si butta una CACHE, non un dato.
 *
 * Rifiuta di sfrattare una sessione che qualcuno sta guardando: è l'invariante
 * che rende innocuo lo spazzino, e va difesa qui e non solo nella politica —
 * chiamare questa funzione a mano dalla console non deve poter svuotare una
 * lista a schermo.
 */
export function evictSessions(keys: readonly string[]): string[] {
  const evicted = keys.filter((k) => k in state && (perSession.get(k)?.size ?? 0) === 0);
  if (evicted.length === 0) return [];
  updateMessages((prev) => {
    const next = { ...prev };
    for (const k of evicted) delete next[k];
    return next;
  });
  return evicted;
}

/** Solo per i test: riporta lo store allo stato di boot. */
export function __resetMessageStore(): void {
  state = {};
  perSession.clear();
  global.clear();
  touchedAt.clear();
}

/** Solo per i test e per la sonda di memoria: quanti iscritti ci sono. */
export function __messageStoreDebug(): { sessioni: number; iscritti: number; globali: number } {
  let iscritti = 0;
  for (const s of perSession.values()) iscritti += s.size;
  return { sessioni: Object.keys(state).length, iscritti, globali: global.size };
}
