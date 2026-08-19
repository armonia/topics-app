/**
 * IL CANALE DI PROGETTO NON RISCRIVE CIÒ CHE HA GIÀ SCRITTO.
 *
 * PERCHÉ ESISTE. Chiuso il ciclo di `pane-store-v2` (una finestra ferma che
 * PUT-tava 75 KB ogni 1,15 s), sotto ne è emerso un secondo che il primo
 * copriva: `topics-project-panes-<hash>` riscriveva corpi IDENTICI — diffati
 * due a due, nessuna differenza — a 2,5-16 s di distanza, a schermo fermo.
 *
 * La guardia contro questo c'è già (`lastSyncedJsonByKey`, confrontata sul JSON
 * serializzato) e nessun test la copriva: era quindi impossibile dire se il
 * ciclo osservato fosse un buco nella guardia o qualcosa che la aggira. La
 * differenza conta, perché porta a due rimedi opposti, e il modo per deciderla
 * non è rileggere il codice — è una misura che il carico della macchina non può
 * falsare, cioè un test.
 *
 * COSA BLOCCA. Le tre metà del contratto, e la terza è quella che il difetto
 * del gemello (`syncServer.ts`) ha insegnato a chiedere: non basta che un save
 * identico non scriva, serve anche che uno DIVERSO scriva sempre — un dedupe
 * troppo zelante non è un'ottimizzazione, è uno stato che non si sincronizza.
 *
 * COSA QUESTO TEST HA STABILITO, E COSA RESTA APERTO. Tutti e tre passano: la
 * guardia fa il suo lavoro, quindi il ciclo osservato NON è un buco qui dentro
 * — è qualcosa che la aggira, e va cercato fuori da questo modulo.
 *
 * Il candidato ovvio è già stato escluso, e vale la pena scriverlo perché il
 * prossimo non ci ricada: `subscribeLifecycle('open')` azzera `lastSyncedJson`
 * a ogni riconnessione del socket (di proposito — dopo un riavvio del server la
 * riga potrebbe non esserci più, e un dedupe che sopravvive a quello lascia il
 * server con le schede vuote). Ma nella misura del 19/08 il socket si apriva
 * UNA volta sola, e il server viveva da due ore senza riavvii. Quindi non è
 * quello.
 *
 * Le due piste che restano, per chi riprende: un chiamante che salva un valore
 * OSCILLANTE (due sorgenti che si rincorrono, ognuna delle quali vede l'altra
 * come una modifica — il dedupe confronta con l'ULTIMO scritto, non con la
 * storia, ed è giusto così: vedi il terzo test), oppure più CHIAVI di progetto
 * diverse che nella sonda sembravano la stessa. Entrambe si distinguono
 * guardando il corpo E la chiave dei PUT consecutivi, a macchina scarica.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

type StorageArea = Record<string, string>;
function installFakeWindow(): void {
  const store: StorageArea = Object.create(null);
  const storageApi = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: storageApi,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = storageApi;
  (globalThis as unknown as { document: unknown }).document = { visibilityState: "visible" };
}

installFakeWindow();

const mod = await import("./projectLayoutSync");
const { saveProjectLayout, projectPanesLocalKey, __resetProjectSyncForTests } =
  mod as typeof import("./projectLayoutSync") & { __resetProjectSyncForTests: () => void };

const PROJECT = "/work/dedupe";
const KEY = projectPanesLocalKey(PROJECT);

// Stessa cautela del file gemello: i globali VERI si catturano una volta sola,
// al caricamento del modulo. Catturarli dentro l'installatore avvelena l'intero
// processo di bun test — un file che installa due volte registrerebbe il PRIMO
// STUB come "originale" e lo lascerebbe a tutti i file successivi.
const REAL_FETCH: unknown = (globalThis as unknown as { fetch?: unknown }).fetch;
const REAL_NAVIGATOR: unknown = (globalThis as unknown as { navigator?: unknown }).navigator;

let putBodies: string[];
function installFetch(): void {
  putBodies = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init?: { body?: string; method?: string },
  ): Promise<Response> => {
    if (String(url).includes(encodeURIComponent(KEY))) putBodies.push(init?.body ?? "");
    return { ok: true, json: async () => ({ server_seq: putBodies.length }) } as unknown as Response;
  };
}

const layout = (paneId: string) => ({
  nonChatPanes: [{ id: paneId, type: "terminal" }],
  openChatTopicIds: [],
});

/** Il sync è debounced a 500 ms: si aspetta oltre. */
const settle = () => new Promise((r) => setTimeout(r, 650));

beforeEach(() => {
  __resetProjectSyncForTests();
  installFetch();
  (globalThis as unknown as { navigator: unknown }).navigator = { sendBeacon: () => true };
});

afterEach(() => {
  __resetProjectSyncForTests();
  if (REAL_FETCH === undefined) delete (globalThis as unknown as { fetch?: unknown }).fetch;
  else (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
  if (REAL_NAVIGATOR === undefined) delete (globalThis as unknown as { navigator?: unknown }).navigator;
  else (globalThis as unknown as { navigator: unknown }).navigator = REAL_NAVIGATOR;
});

describe("canale di progetto — non riscrive ciò che ha già scritto", () => {
  test("due save IDENTICI, separati nel tempo, producono UNA sola PUT", async () => {
    // È la forma esatta del ciclo osservato il 19/08: corpi identici a distanza
    // di secondi, quindi ben oltre la finestra del debounce — che infatti non
    // c'entra, ed è il motivo per cui i due save sono separati da un `settle`
    // invece che sparati insieme.
    saveProjectLayout(KEY, PROJECT, layout("terminal:aaa"));
    await settle();
    expect(putBodies.length).toBe(1);

    saveProjectLayout(KEY, PROJECT, layout("terminal:aaa"));
    await settle();
    expect(putBodies.length, "il secondo save è identico: non deve scrivere").toBe(1);
  });

  test("un save DIVERSO scrive sempre, anche subito dopo uno identico", async () => {
    // L'altra metà, e non è simmetrica per importanza: un dedupe che sbaglia
    // QUI non spreca banda, perde uno stato — la lezione del gate ritirato in
    // `syncServer.ts`, che passava i suoi test e non faceva arrivare al server
    // la chiusura di una scheda.
    saveProjectLayout(KEY, PROJECT, layout("terminal:aaa"));
    await settle();
    saveProjectLayout(KEY, PROJECT, layout("terminal:aaa"));
    await settle();
    saveProjectLayout(KEY, PROJECT, layout("terminal:bbb"));
    await settle();
    expect(putBodies.length).toBe(2);
    expect(putBodies[1]).toContain("terminal:bbb");
  });

  test("il valore che ritorna a uno GIÀ SCRITTO scrive: il confronto è con l'ULTIMO, non con la storia", async () => {
    // A → B → A. Il terzo save torna a un corpo già visto, ma non è quello che
    // il server ha adesso: saltarlo lascerebbe il server su B per sempre.
    saveProjectLayout(KEY, PROJECT, layout("terminal:aaa"));
    await settle();
    saveProjectLayout(KEY, PROJECT, layout("terminal:bbb"));
    await settle();
    saveProjectLayout(KEY, PROJECT, layout("terminal:aaa"));
    await settle();
    expect(putBodies.length).toBe(3);
    expect(putBodies[2]).toContain("terminal:aaa");
  });
});
