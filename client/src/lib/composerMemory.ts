// composerMemory — da dove parte una chat quando apre il composer.
//
// Le scelte del composer (provider/modello, tier di effort) sono per-chat: sul
// topic reale le tiene il server, sulla BOZZA (`draft:<uuid>`, che sul server
// non esiste ancora) le tiene questo dispositivo. Sopra le due c'è una terza
// memoria, l'ULTIMA scelta fatta su qualunque chat: è quella che una chat NUOVA
// eredita, cosi' scegliere Codex una volta non va rifatto a ogni nuova chat.
//
// Perché qui e non dentro ChatPane: la regola ha tre ingressi (il topic, la
// chiave della bozza, l'ultima scelta) e due casi che si erano gia' sbagliati
// una volta — la bozza che si azzerava e il "torna al default" che lasciava in
// memoria il modello vecchio. Fuori dal componente si prova con un finto
// storage, dentro no.

/** Selezione provider+modello. Vale solo COMPLETA: un provider senza modello
 *  non è un override, è il default di quel provider (lo risolve il picker). */
export interface ProviderSelection {
  provider: string;
  model: string;
}

/** Il minimo di `Storage` che serve qui — cosi' i test passano un oggetto. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const LAST_PROVIDER_KEY = 'providerOverride:last';
const LAST_EFFORT_KEY = 'effort:last';

export function providerOverrideKey(topicId: string): string {
  return `providerOverride:${topicId}`;
}

export function effortKey(topicId: string): string {
  return `effort:${topicId}`;
}

export function isDraftTopicId(topicId: string): boolean {
  return topicId.startsWith('draft:');
}

/** localStorage quando c'è ed è concesso, altrimenti un buco nero silenzioso:
 *  in incognito o con lo storage negato `getItem` lancia, e una chat che non
 *  parte perché non ha potuto RICORDARE sarebbe il peggiore dei baratti. */
export function safeStore(): KeyValueStore {
  return {
    getItem(key) {
      try { return localStorage.getItem(key); } catch { return null; }
    },
    setItem(key, value) {
      try { localStorage.setItem(key, value); } catch { /* storage negato */ }
    },
    removeItem(key) {
      try { localStorage.removeItem(key); } catch { /* storage negato */ }
    },
  };
}

function parseSelection(raw: string | null): ProviderSelection | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { provider, model } = parsed as Record<string, unknown>;
    if (typeof provider !== 'string' || typeof model !== 'string') return null;
    if (!provider || !model) return null;
    return { provider, model };
  } catch {
    return null;
  }
}

/** L'ultima selezione fatta su qualunque chat, se leggibile. */
export function readLastProviderSelection(store: KeyValueStore): ProviderSelection | null {
  return parseSelection(store.getItem(LAST_PROVIDER_KEY));
}

/** Registra la scelta appena fatta come memoria per le chat nuove.
 *  `null` (= torna al default dell'app) CANCELLA la memoria: è una scelta come
 *  le altre, e tenere il modello vecchio farebbe resuscitare nella chat dopo
 *  quello che qui si è appena tolto. */
export function rememberProviderSelection(store: KeyValueStore, next: ProviderSelection | null): void {
  if (next) store.setItem(LAST_PROVIDER_KEY, JSON.stringify(next));
  else store.removeItem(LAST_PROVIDER_KEY);
}

export function readLastEffort(store: KeyValueStore): string | null {
  const raw = store.getItem(LAST_EFFORT_KEY);
  return raw || null;
}

export function rememberEffort(store: KeyValueStore, next: string | null): void {
  if (next) store.setItem(LAST_EFFORT_KEY, next);
  else store.removeItem(LAST_EFFORT_KEY);
}

/** Con cosa parte il picker su questa pane.
 *  Ordine: quello che il topic PERSISTE (server) → la scelta fatta su questa
 *  bozza → l'ultima scelta fatta altrove. Gli ultimi due valgono solo per le
 *  bozze: una chat vecchia che non ha mai scelto un modello resta sul default
 *  dell'app, non si prende quello di una chat aperta ieri. */
export function seedProviderOverride(args: {
  topicId: string;
  topicProvider?: string | null;
  topicModel?: string | null;
  store: KeyValueStore;
}): ProviderSelection | null {
  const { topicId, topicProvider, topicModel, store } = args;
  if (topicProvider && topicModel) return { provider: topicProvider, model: topicModel };
  if (!isDraftTopicId(topicId)) return null;
  return parseSelection(store.getItem(providerOverrideKey(topicId)))
    ?? readLastProviderSelection(store);
}

/** Stesso ordine per il tier di effort. */
export function seedEffort(args: {
  topicId: string;
  topicEffort?: string | null;
  store: KeyValueStore;
}): string | null {
  const { topicId, topicEffort, store } = args;
  if (topicEffort) return topicEffort;
  if (!isDraftTopicId(topicId)) return null;
  return store.getItem(effortKey(topicId)) || readLastEffort(store);
}

/** Due selezioni sono la stessa cosa? Serve a NON ricreare l'oggetto di stato
 *  quando il valore non è cambiato: un riseed che assegna `{...}` nuovo a ogni
 *  render è un ciclo di render, non un aggiornamento. */
export function sameSelection(a: ProviderSelection | null, b: ProviderSelection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.provider === b.provider && a.model === b.model;
}
