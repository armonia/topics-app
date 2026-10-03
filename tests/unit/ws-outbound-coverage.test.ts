/**
 * Il registro degli schemi WS in uscita deve COPRIRE quello che il server
 * emette davvero.
 *
 * `validateOutbound` fa passthrough sui tipi che non conosce: è la scelta che
 * ha reso possibile migrare a pezzi, ma è anche il motivo per cui un tipo nuovo
 * non fa MAI rumore — nessuno se ne accorge finché un client non esplode su un
 * payload malformato. Questo test chiude il buco dalla parte dell'autore:
 * scansiona i punti di emissione reali e fallisce se un tipo emesso non ha uno
 * schema, e viceversa se uno schema descrive un messaggio che il server non
 * manda più (contratto di finzione).
 *
 * Lo scan è statico, quindi vede solo le emissioni con il tipo scritto come
 * LETTERALE. Un tipo costruito da una variabile gli sfugge: quel buco lo chiude
 * la tipizzazione di `broadcast` (fase B), non questo test.
  * @covers WIRE-08
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REGISTERED_OUTBOUND_TYPES } from "../../shared/ws-outbound";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * Tipi con uno schema ma nessuna emissione nel sorgente. Ognuno va motivato:
 * un'entrata senza motivo è un contratto morto che nessuno ha ancora tolto.
 */
const DORMANT: Record<string, string> = {
  // `browser:force-open` è uscito da questa lista l'11/08/2026: lo emette
  // `routes/browser-bridge.ts` quando nessuna pane si aggancia al contextId
  // dopo `open-pane`. Era il caso di scuola di un contratto dormiente che
  // qualcuno CREDEVA collegato — il commento del gestore diceva «il server
  // emette force-open», e non lo faceva nessuno.
  // L'unico emittente era il roster agenti (`routes/agent-profiles.ts`), uscito
  // col concetto di agente. `useDashboard` lo ascolta ancora e nel frattempo si
  // aggiorna da solo ogni 60s: il gestore resta, il frame lo riprenderà chi
  // avrà un motivo vero per dire "i numeri sono cambiati".
  "dashboard:updated": "ascoltato da useDashboard, emissione server assente",
  "topic:switch:complete": "gestito da usePanelLifecycle, emissione server assente",
  // I sette `chat:*` / `provider:*` / `agent:status` che stavano qui sono stati
  // RIMOSSI dal registro il 30/07: nessuno li mandava e nessuno li ascoltava.
  // Un tipo dormiente è un contratto che qualcuno potrebbe ancora onorare; quelli
  // erano finzione, e la finzione si cancella invece di motivarla. Il 05/08 è
  // toccato al resto della famiglia `agent:*` / `agents:*`, uscita dal registro
  // insieme alle pane che la mostravano.
};

/**
 * Tipi EMESSI dal server che il client non ascolta. Il verso opposto ai
 * `DORMANT`, e il buco che ha permesso a `stream:slow`, `scripts:output` e ai
 * tre `agent:profile:*` di restare anni senza consumatore mentre il loro lavoro
 * lo faceva qualcos'altro, peggio: un'annotazione incollata nel contenuto di un
 * messaggio, e un polling a 2 secondi.
 *
 * Ogni voce va motivata. Un broadcast senza ascoltatori è banda buttata nel caso
 * migliore, e nel peggiore è una funzione che l'autore CREDE collegata.
 */
const UNCONSUMED: Record<string, string> = {
  // `pong` e' USCITO da qui il 19/08/2026, ed e' il senso di questa mappa: la
  // riga diceva «il client non deve gestirlo, gli basta ricevere un frame», e
  // ricevere e basta era esattamente il guasto. Nessuno guardava l'orologio
  // sulla risposta, quindi su una connessione mezza aperta la socket restava
  // `OPEN` per sempre e la board mostrava lo stato di prima del guasto finche'
  // non si ricaricava. Adesso `useWebSocket` lo consuma davvero (il cane da
  // guardia sul `lastPongAt`), e il test qui sotto lo pretende.
  // Il suo unico ascoltatore era il chip delle sessioni in terminale in barra
  // alla kanban, tolto il 13/08 su richiesta di Attilio. Il CENSIMENTO resta
  // vivo e ha ancora un lettore vero, ma per via sincrona: il dispatcher chiama
  // `externalSessions.activeAt(path)` per avvertire quando un repo è già
  // lavorato a mano da qualcun altro. È il FRAME a non avere più nessuno.
  // Toglierlo significa toccare il registro del protocollo (e il suo conteggio)
  // per una modifica di contorno, che è esattamente ciò che la nota in cima allo
  // schema dice di non fare: si decide quando si versiona.
  "external-sessions": "censimento senza superficie da quando il chip in barra è stato tolto; il dispatcher lo legge da activeAt(), non dal filo",
};

/** Sorgenti del CLIENT: quelli che possono ascoltare. Test esclusi. */
function clientSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "demo") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) clientSources(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** Sorgenti del server: quelli che possono emettere. Test e schemi esclusi. */
function serverSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "schemas") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) serverSources(p, out);
    else if (/\.(ts|mjs)$/.test(p) && !/\.(test|fixture)\.ts$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * I punti di emissione: un literal `type: "x"` in testa a un oggetto (che sia
 * passato inline al broadcast o assegnato a una variabile), e gli helper
 * `emit("x", payload)` che ogni router si definisce in cima al file.
 */
const EMISSION_PATTERNS = [
  /\btype:\s*["'`]([a-z][a-zA-Z0-9:_-]*)["'`]/g,
  /\bemit\w*\(\s*["'`]([a-z][a-zA-Z0-9:_-]*)["'`]/g,
  /\bbroadcast\w*\(\s*["'`]([a-z][a-zA-Z0-9:_-]*)["'`]/g,
];

function scanEmitted(): Map<string, Set<string>> {
  const files = [...serverSources(join(ROOT, "server")), join(ROOT, "server.ts")];
  const found = new Map<string, Set<string>>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const re of EMISSION_PATTERNS) {
      for (const m of src.matchAll(re)) {
        const type = m[1]!;
        // Un `type` senza `:` è quasi sempre un discriminante di dominio
        // (`type: "shell"`, `type: "text"`), non un messaggio WS. I pochi
        // messaggi senza namespace sono già tutti nel registro, quindi
        // filtrare così non perde nulla e toglie centinaia di falsi positivi.
        if (!type.includes(":") && !REGISTERED_OUTBOUND_TYPES.includes(type)) continue;
        if (!found.has(type)) found.set(type, new Set());
        found.get(type)!.add(file.slice(ROOT.length + 1));
      }
    }
  }
  return found;
}

const emitted = scanEmitted();

/** I tipi nominati come letterale da qualche parte nel client. */
const listened = (() => {
  const blob = clientSources(join(ROOT, "client", "src"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  return new Set(REGISTERED_OUTBOUND_TYPES.filter((t) => blob.includes(`'${t}'`) || blob.includes(`"${t}"`)));
})();

describe("copertura del registro ws-outbound", () => {
  test("ogni tipo EMESSO dal server ha uno schema", () => {
    const missing = [...emitted.entries()]
      .filter(([type]) => !REGISTERED_OUTBOUND_TYPES.includes(type))
      .map(([type, files]) => `${type} (${[...files].sort().join(", ")})`)
      .sort();

    // Il messaggio elenca i colpevoli col file: chi aggiunge un broadcast nuovo
    // sa esattamente dove mettere lo schema, senza cercarlo.
    expect(missing).toEqual([]);
  });

  test("ogni tipo DICHIARATO è emesso, o è dormiente con una motivazione", () => {
    const fiction = REGISTERED_OUTBOUND_TYPES
      .filter((type) => !emitted.has(type) && !(type in DORMANT))
      .sort();

    expect(fiction).toEqual([]);
  });

  test("la lista dei dormienti non contiene tipi tornati vivi", () => {
    const resurrected = Object.keys(DORMANT).filter((type) => emitted.has(type)).sort();

    expect(resurrected).toEqual([]);
  });

  test("la lista dei dormienti non contiene tipi USCITI dal registro", () => {
    // Il verso che mancava. Togliere uno schema lasciava la sua voce dormiente
    // lì a marcire, e la motivazione scritta accanto continuava a descrivere un
    // contratto che non esiste più: la mappa diventa una mappa di fantasmi.
    const stale = Object.keys(DORMANT)
      .filter((type) => !REGISTERED_OUTBOUND_TYPES.includes(type))
      .sort();

    expect(stale).toEqual([]);
  });

  test("ogni tipo EMESSO è ascoltato dal client, o è motivato in UNCONSUMED", () => {
    const orphans = [...emitted.keys()]
      .filter((t) => REGISTERED_OUTBOUND_TYPES.includes(t))
      .filter((t) => !listened.has(t) && !(t in UNCONSUMED))
      .sort();

    expect(orphans).toEqual([]);
  });

  test("UNCONSUMED non contiene tipi tornati ascoltati, o usciti dal registro", () => {
    const stale = Object.keys(UNCONSUMED)
      .filter((t) => listened.has(t) || !REGISTERED_OUTBOUND_TYPES.includes(t))
      .sort();

    expect(stale).toEqual([]);
  });

  test("lo scan del client trova davvero gli ascoltatori (guardia anti-test-vuoto)", () => {
    // Se i sorgenti del client smettessero di essere letti, il test sopra
    // dichiarerebbe orfano tutto il registro — o, con UNCONSUMED pieno, niente.
    expect(listened.size).toBeGreaterThan(50);
    expect(listened.has("stream:end")).toBe(true);
  });

  test("lo scan trova davvero le emissioni (guardia anti-test-vuoto)", () => {
    // Se un refactor sposta i broadcast e i pattern smettono di matchare, i
    // test sopra passerebbero tutti a vuoto. Questa soglia lo impedisce.
    expect(emitted.size).toBeGreaterThan(60);
    expect(emitted.get("stream:end")?.size).toBeGreaterThan(0);
  });
});
