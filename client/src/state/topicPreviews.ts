import { useCallback, useSyncExternalStore } from 'react';

/**
 * L'anteprima dell'ultimo messaggio di ogni chat, per la riga di sidebar.
 *
 * IL PROBLEMA. Sotto al nome di una chat c'è UNA riga da 11px, e finora la
 * riempiva solo `SessionActivity` — che rende `null` appena la sessione è ferma
 * (`starting/completed/error/dormant`, o nessuno stato affatto). Cioè: quasi
 * sempre. La riga di una chat a riposo non diceva niente, e per sapere di cosa
 * parlasse bisognava aprirla. Le due cose non convivono, si alternano: sessione
 * viva → stato live; sessione ferma → l'ultimo messaggio, troncato.
 *
 * LA FORMA. Uno store di modulo con sottoscrizione PER TOPIC, come
 * `messageStore.ts` — e per lo stesso motivo. La sidebar ha N righe: se
 * l'anteprima vivesse in uno stato di `App` (o in una mappa a cui tutte si
 * iscrivono), UN messaggio in arrivo su UNA chat ri-renderizzerebbe l'intero
 * albero. Qui ogni riga si sveglia solo per la propria chiave.
 *
 * DUE FONTI, UN CANALE. Al boot `hydrateTopicPreviews()` fa una sola fetch
 * (`GET /api/topics/previews`, una query batch: non una richiesta per topic);
 * poi ci pensa il `message:new` che il client ha già in mano — nessun secondo
 * listener WS. Entrambe passano da `applyMessagePreview`, quindi la pulizia del
 * testo e la regola di ordinamento sono scritte una volta sola.
 *
 * IDENTITÀ. `getTopicPreview` restituisce lo stesso oggetto finché quel topic
 * non cambia: `useSyncExternalStore` lo pretende (uno snapshot nuovo a ogni
 * chiamata è un loop infinito), e per le righe memoizzate significa che una chat
 * ferma non si ri-renderizza mai.
 */

/** Lunghezza dell'anteprima. GEMELLA di `PREVIEW_MAX_CHARS` in
 *  `server/routes/topics.ts`: il server manda testo già potato di questa misura,
 *  e questa pulizia — idempotente — su quel testo non fa niente. */
export const TOPIC_PREVIEW_MAX = 120;

/** Quanti caratteri GREZZI far entrare nella potatura. GEMELLA di
 *  `PREVIEW_SOURCE_CHARS` in `server/routes/topics.ts`, che tronca lì il testo
 *  che manda al boot — sul canale WS quel taglio non c'era, e `msg.content`
 *  arriva INTERO. Misurato sul messaggio più lungo dell'archivio (158.122
 *  caratteri): 0,3 ms di regex per chiamata contro 0,008 ms con questo taglio
 *  davanti, in OGNI finestra aperta e ora anche in quella che sta streammando
 *  (l'anteprima si aggiorna PRIMA del bail su `isOwnStream`). 600 è largo
 *  abbastanza da sopravvivere a un blocco di codice in testa al messaggio e a
 *  120 caratteri di prosa dopo.
 *
 *  COSA CAMBIA NEL RISULTATO: sull'archivio vero, zero su 11.085 messaggi da
 *  ≤600 caratteri, e 4 su 2.263 fra quelli più lunghi — dove l'anteprima si
 *  accorcia perché la prosa oltre il 600° carattere non si vede più. Quei 4 ora
 *  leggono ESATTAMENTE come li manda il server, che tronca da sempre allo stesso
 *  punto: prima le due sorgenti dicevano due cose diverse per la stessa chat, a
 *  seconda di chi l'avesse riempita. */
export const TOPIC_PREVIEW_SOURCE_MAX = 600;

/** Il prefisso delle buste di contesto di OpenClaw: impalcatura, non un
 *  messaggio. Il server le esclude già in SQL; qui serve per il canale WS. */
const CONTEXT_ENVELOPE_PREFIX = '[Chat messages since your last reply';

export interface TopicPreview {
  /** Testo già potato e troncato: pronto da mettere in una riga da 11px. */
  text: string;
  /** Chi ha parlato per ultimo. `user` = l'ha scritto l'umano di questo client. */
  role: 'user' | 'assistant';
  /** Epoch ms del messaggio. Serve a NON far vincere un frame arrivato tardi. */
  at: number;
}

/**
 * Il testo di un messaggio ridotto a UNA riga.
 *
 * Non è un troncamento: è una potatura. Quasi tutto ciò che rende leggibile un
 * messaggio in chat, su una riga da 11px diventa rumore — un blocco di codice
 * occupa l'anteprima intera senza dire niente, un `#` a inizio riga si legge
 * come un carattere a caso, un a-capo diventa uno spazio doppio.
 *
 * IDEMPOTENTE di proposito: la stessa potatura gira sul server (dove accorcia
 * ciò che viaggia sul filo) e qui (dove è l'unica, sul testo grezzo del WS), e
 * applicarla due volte deve dare lo stesso risultato. Vedi `topicPreviewText`
 * in `server/routes/topics.ts`: le due copie vanno tenute in passo.
 */
export function cleanPreviewText(raw: string): string {
  // Il taglio va PRIMA delle regex, non dopo: sotto ce ne sono una decina, e
  // ciascuna riscorre tutto il testo. Il server tronca già a 600 caratteri, il
  // WS no — di qui passa il `content` intero, fino a 158.122 caratteri per il
  // messaggio più lungo in archivio. Vedi TOPIC_PREVIEW_SOURCE_MAX per la misura.
  let s = raw.length > TOPIC_PREVIEW_SOURCE_MAX ? raw.slice(0, TOPIC_PREVIEW_SOURCE_MAX) : raw;
  // I blocchi di codice non stanno in una riga da 11px, e di solito SONO il
  // messaggio: via il blocco intero, resta la frase che lo introduceva. Anche la
  // recinzione APERTA — è così che arriva un turno tagliato a metà.
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/```[\s\S]*$/, ' ');
  // Impalcatura iniettata: non l'ha scritta né l'umano né il modello.
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
  // Immagini via, link ridotti alla loro etichetta: l'URL non si legge comunque.
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Segni di struttura a inizio riga (titoli, citazioni, elenchi): quando le
  // righe vengono compresse in una sola non delimitano più niente.
  // `(?:…)+`, non `(?:…)`: i marcatori si IMPILANO — «> > citato», «## # x»,
  // «1. 2. x» — e togliendone uno solo per passata questa potatura smetteva
  // di essere IDEMPOTENTE, che e' la proprieta' su cui si regge il patto con
  // la gemella lato server. Il testo che arriva dal WS fa UNA passata, quello
  // dell'idratazione ne fa DUE (il server ha gia' pulito): la stessa chat
  // mostrava due testi diversi prima e dopo un ricarico. Consumandoli tutti in
  // una volta, la seconda passata non trova piu' niente da togliere.
  s = s.replace(/^[ \t]{0,3}(?:(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+)+/gm, '');
  // Righe orizzontali: una riga di soli `---` compressa in una riga sola
  // diventa il primo "carattere a caso" che si legge.
  s = s.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, ' ');
  // Enfasi. `__` e `_` NON si toccano: qui dentro passano `session_key` e
  // `mcp__topics__browser_navigate`, e toglierli storpierebbe le parole. Il
  // corsivo si toglie solo a coppia CHIUSA sulla stessa riga e con l'interno
  // attaccato agli asterischi, così una moltiplicazione («2 * 3 * 4») resta.
  s = s.replace(/\*\*|~~/g, '');
  s = s.replace(/\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*/g, '$1');
  s = s.replace(/`/g, '');
  // UNA riga: gli a-capo diventano spazi e gli spazi si comprimono.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= TOPIC_PREVIEW_MAX) return s;
  return s.slice(0, TOPIC_PREVIEW_MAX - 1).trimEnd() + '…';
}

/**
 * LA COPIA LOCALE, e cioè: un refresh è un RITORNO.
 *
 * Le anteprime c'erano già sullo schermo un istante prima del ricarico, ma lo
 * store nasceva vuoto e le riaspettava da `GET /api/topics/previews`. Finché
 * quella risposta non arrivava, `TopicPreviewLine` rendeva `null` — e la riga di
 * sidebar era ALTA UNA RIGA SOLA: misurato al refresh, il blocco nome+sottotitolo
 * passa da 17px a 31px quando l'anteprima atterra, cioè OGNI riga della sidebar
 * cresce sotto gli occhi. Non è lentezza: è aver trattato un ritorno come una
 * partenza da zero.
 *
 * Il caso a freddo (nessuna cache, primo avvio vero) resta quello di prima:
 * riga muta finché la rete non risponde. Lì il patto è l'altro — la riga si
 * riserva comunque la sua altezza, vedi `TopicSubline`.
 */
const CACHE_KEY = 'topic-previews-cache';
/** Quante chat tenere in cache. La sidebar ne mostra qualche decina; il resto
 *  sarebbe peso in `localStorage` (che è condiviso, e satura — vedi la potatura
 *  della cache dei messaggi in `useChat.ts`). Si tengono le più recenti. */
const CACHE_MAX_TOPICS = 200;

function readCache(): Record<string, TopicPreview> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, TopicPreview> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const p = v as Partial<TopicPreview>;
      if (typeof p?.text !== 'string' || !p.text) continue;
      out[id] = {
        text: p.text,
        role: p.role === 'user' ? 'user' : 'assistant',
        at: typeof p.at === 'number' ? p.at : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

let cacheTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Scrittura DIFFERITA. `applyMessagePreview` gira per ogni `message:new` di ogni
 * finestra aperta: serializzare la mappa lì dentro metterebbe un `JSON.stringify`
 * sul percorso caldo dello streaming. Un solo giro d'orologio dopo l'ultimo
 * cambiamento è abbastanza — l'unico lettore è il boot successivo.
 */
function scheduleCacheWrite(): void {
  if (typeof localStorage === 'undefined') return;
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    try {
      const entries = Object.entries(state)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, CACHE_MAX_TOPICS);
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* localStorage pieno: la prossima sessione riparte dalla rete, come prima */
    }
  }, 1000);
}

let state: Record<string, TopicPreview> = typeof localStorage === 'undefined' ? {} : readCache();
/** Iscritti per topic. È l'unica ragione per cui questo store esiste. */
const perTopic = new Map<string, Set<() => void>>();

/** L'anteprima di un topic, con identità stabile finché non cambia. */
export function getTopicPreview(topicId: string): TopicPreview | undefined {
  return state[topicId];
}

/**
 * Quante anteprime sono in memoria adesso, per l'inventario del peso.
 *
 * CONTEGGI, non byte: questo stato vive nel renderer condiviso, dove nessuna
 * lettura di sistema può separarne il costo da quello di chiunque altro (vedi
 * `lib/featureWeight.ts`). Il numero utile è quanto TIENE — e ha un tetto
 * dichiarato (`CACHE_MAX_TOPICS`), quindi conta anche sapere quanto ci si è
 * vicini.
 */
export function previewsCount(): { entries: number; max: number } {
  return { entries: Object.keys(state).length, max: CACHE_MAX_TOPICS };
}

/** Si iscrive a UN topic: un messaggio su un'altra chat non lo sveglia. */
export function subscribeTopicPreview(topicId: string, fn: () => void): () => void {
  let subs = perTopic.get(topicId);
  if (!subs) {
    subs = new Set();
    perTopic.set(topicId, subs);
  }
  subs.add(fn);
  return () => {
    const s = perTopic.get(topicId);
    if (!s) return;
    s.delete(fn);
    // Potatura: senza, questa mappa resterebbe piena di Set vuoti per ogni
    // riga mai montata.
    if (s.size === 0) perTopic.delete(topicId);
  };
}

/**
 * Registra l'ultimo messaggio di un topic. Punto d'ingresso UNICO: lo chiamano
 * sia il `message:new` del WS sia l'idratazione al boot.
 *
 * Non notifica nessuno quando non c'è niente di nuovo — ed è la parte che conta:
 * lo stesso messaggio ri-annunciato (il `message:new` viaggia in broadcast, e
 * ogni finestra lo riceve anche per le chat che non guarda) non deve costare un
 * render. La mutazione è in place di proposito: qui non esiste uno snapshot
 * globale a cui qualcuno si iscriva, quindi copiare la mappa a ogni messaggio
 * sarebbe lavoro per nessuno.
 */
export function applyMessagePreview(
  topicId: string,
  role: 'user' | 'assistant',
  rawText: string,
  at: number = Date.now(),
): void {
  if (!topicId || !rawText) return;
  if (rawText.startsWith(CONTEXT_ENVELOPE_PREFIX)) return;
  const text = cleanPreviewText(rawText);
  // Restava solo impalcatura (un messaggio tutto codice): meglio una riga muta
  // che una riga di rumore — e soprattutto meglio dell'anteprima PRECEDENTE
  // cancellata da una stringa vuota.
  if (!text) return;
  const prev = state[topicId];
  // Fuori ordine: l'idratazione del boot legge dal DB e può atterrare DOPO un
  // `message:new` più recente. Il più vecchio non deve poter vincere.
  if (prev && prev.at > at) return;
  if (prev && prev.text === text && prev.role === role) return;
  state[topicId] = { text, role, at };
  scheduleCacheWrite();
  const subs = perTopic.get(topicId);
  if (subs) for (const fn of subs) fn();
}

/**
 * Toglie l'anteprima di un topic: la riga di sidebar torna muta.
 *
 * Serve perché finora NESSUNO cancellava una preview, e lo store era a senso
 * unico. Dopo «Svuota chat» il buffer locale dei messaggi si svuotava (il frame
 * WS `clear`) ma la riga continuava a mostrare — per sempre — l'ultimo messaggio
 * appena cancellato: l'unica cosa che poteva sovrascriverla era un messaggio
 * NUOVO, e una chat svuotata per definizione non ne ha.
 *
 * Non notifica se non c'era niente da togliere: lo stesso patto di
 * `applyMessagePreview`, un frame che non cambia niente non costa un render.
 */
export function clearTopicPreview(topicId: string): void {
  if (!topicId || !(topicId in state)) return;
  delete state[topicId];
  scheduleCacheWrite();
  const subs = perTopic.get(topicId);
  if (subs) for (const fn of subs) fn();
}

/**
 * La fotografia iniziale, una volta al boot. Senza, una chat ferma da ieri
 * resterebbe muta finché non le arriva un messaggio nuovo.
 *
 * UNA richiesta per tutte le chat: il server risponde con una query batch. Al
 * meglio che può — se fallisce, le righe restano come prima e il WS le
 * riempirà via via.
 */
export async function hydrateTopicPreviews(): Promise<void> {
  try {
    const res = await fetch('/api/topics/previews');
    if (!res.ok) return;
    const data = (await res.json()) as {
      previews?: Record<string, { text?: string; role?: string; at?: number }>;
    };
    for (const [topicId, p] of Object.entries(data.previews ?? {})) {
      if (!p?.text) continue;
      applyMessagePreview(
        topicId,
        p.role === 'user' ? 'user' : 'assistant',
        p.text,
        typeof p.at === 'number' ? p.at : 0,
      );
    }
  } catch {
    /* boot best-effort: nessuna anteprima è meglio di un boot che si ferma qui */
  }
}

/** L'anteprima di un topic, con un risveglio che arriva solo per quella. */
export function useTopicPreview(topicId: string | undefined): TopicPreview | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => (topicId ? subscribeTopicPreview(topicId, onChange) : () => {}),
    [topicId],
  );
  const snapshot = useCallback(() => (topicId ? getTopicPreview(topicId) : undefined), [topicId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Solo per i test: riporta lo store allo stato di boot. Anche la copia locale,
 *  o un test che ne scrive una la lascerebbe al successivo. */
export function __resetTopicPreviews(): void {
  state = {};
  perTopic.clear();
  if (cacheTimer) { clearTimeout(cacheTimer); cacheTimer = null; }
  try { localStorage.removeItem(CACHE_KEY); } catch { /* niente localStorage */ }
}
