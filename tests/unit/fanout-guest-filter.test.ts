/**
 * Ogni fan-out consulta il filtro degli ospiti.
 *
 * ── PERCHÉ UN TEST TESTUALE ─────────────────────────────────────────────────
 * Perché il guasto che presidia è già successo, due volte, e nessuna delle due
 * era visibile da un tipo.
 *
 * `server/utils.ts` ha quattro funzioni che scrivono sulle socket di più
 * clienti. Tre consultavano `guestSocketFilter()`; `broadcast` no — e portava
 * `auth:pair-requested` con il riferimento e il codice di un appaiamento in
 * corso. Un ospite lo leggeva e ne ritirava il gettone da
 * `/api/auth/pair/status`, cioè diventava il dispositivo appena approvato
 * (`tests/e2e/guest-confinement.spec.ts`, GUEST-05). La differenza fra la
 * funzione bucata e le altre tre era una riga, in un file di duemila.
 *
 * La seconda volta è stata la raffica di apertura in `server.ts`, che non passa
 * da nessuna di queste quattro: `ws.send` diretti alla socket appena aperta.
 * Consegnava a un ospite il pane-store del proprietario e il contenuto vivo di
 * qualunque turno in corso.
 *
 * Il tratto comune: un percorso che manda dati a una socket **senza attraversare
 * il posto dove il filtro vive**. Non c'è un tipo che lo impedisca — mandare è
 * `ws.send(string)`, e una stringa è una stringa. Quindi la guardia è testuale,
 * e sta qui.
 *
 * ── COSA FALLISCE, E COSA NO ────────────────────────────────────────────────
 * Questo test NON prova che il filtro sia giusto: lo provano
 * `server/lib/grants.test.ts` (le regole) e `guest-confinement.spec.ts` (il
 * comportamento, da fuori). Prova una cosa sola: che non esista una fan-out che
 * il filtro non lo nomina proprio. È il difetto che non si vede rileggendo,
 * perché per vederlo bisogna sapere che le altre tre fanno diversamente.
 *
 * @covers GUEST-04, GUEST-05
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RADICE = join(import.meta.dir, "..", "..");
const UTILS = readFileSync(join(RADICE, "server", "utils.ts"), "utf8");
const SERVER = readFileSync(join(RADICE, "server.ts"), "utf8");

/**
 * Il corpo di una funzione dichiarata con `function <nome>(`, fino alla
 * graffa che la chiude. Conteggio delle graffe e non una regex sulla fine:
 * una fan-out contiene cicli e `try`, quindi il primo `}` a inizio riga
 * chiuderebbe il pezzo sbagliato.
 */
function corpo(sorgente: string, nome: string): string {
  const inizio = sorgente.indexOf(`function ${nome}(`);
  if (inizio === -1) return "";
  const apre = sorgente.indexOf("{", inizio);
  let profondita = 0;
  for (let i = apre; i < sorgente.length; i++) {
    if (sorgente[i] === "{") profondita++;
    else if (sorgente[i] === "}" && --profondita === 0) return sorgente.slice(apre, i + 1);
  }
  return sorgente.slice(apre);
}

/** Il predicato della rete larga, estratto per poterlo provare su un caso finto. */
function sembraUnaFanout(corpoFunzione: string): boolean {
  return /for\s*\(\s*const\s+ws\s+of\s+wsClients/.test(corpoFunzione) && /\bws\.send\(/.test(corpoFunzione);
}

describe("la guardia sa fallire", () => {
  // Una guardia che non si è mai vista fallire è una guardia di cui ti fidi a
  // scatola chiusa. Qui la si mette davanti a una fan-out finta, scritta come
  // la scriverebbe qualcuno domani, e si controlla che la peschi. Sorgente
  // sintetica, così provarlo non richiede di rompere per dieci secondi il file
  // vero — che il watcher porterebbe in produzione.
  const FINTA = `
    function mandaATutti(message: OutboundMessage) {
      const payload = JSON.stringify(message);
      for (const ws of wsClients) {
        if (ws.readyState === 1) { try { ws.send(payload); } catch {} }
      }
    }
  `;

  it("pesca una fan-out nuova che non nomina il filtro", () => {
    expect(sembraUnaFanout(corpo(FINTA, "mandaATutti"))).toBe(true);
    expect(corpo(FINTA, "mandaATutti")).not.toContain("guestSocketFilter()");
  });

  it("e non pesca una funzione che le socket non le cicla", () => {
    const innocua = `function contaSocket() { return wsClients.size; }`;
    expect(sembraUnaFanout(corpo(innocua, "contaSocket"))).toBe(false);
  });

  it("il conteggio delle graffe non si ferma alla prima chiusura annidata", () => {
    // È il motivo per cui `corpo` conta invece di cercare `\n}`: una fan-out
    // contiene cicli e `try`, e fermarsi lì taglierebbe via proprio il pezzo
    // in cui il filtro dovrebbe comparire.
    const c = corpo(FINTA, "mandaATutti");
    expect(c.includes("ws.send(payload)")).toBe(true);
    expect(c.trimEnd().endsWith("}")).toBe(true);
  });
});

describe("le fan-out non possono dimenticare il filtro degli ospiti", () => {
  // I nomi sono elencati a mano DI PROPOSITO: aggiungere una quinta fan-out
  // deve costringere a toccare questa riga. Una scoperta automatica renderebbe
  // il test comodo e cieco — passerebbe da sola su una funzione nuova, che è
  // esattamente il caso che deve fallire.
  const FANOUT = [
    "broadcast", "broadcastToAll", "broadcastToTopic", "broadcastToTopicSubscribers",
    // La quinta: decide per socket CHI vede un progetto (la 092), e il filtro
    // degli ospiti resta comunque il primo dei due — `project:*` non è fra i tipi
    // ammessi, quindi a un ospite non parte né la riga né la ritratta.
    "broadcastProject",
  ];

  for (const nome of FANOUT) {
    it(`${nome} consulta guestSocketFilter()`, () => {
      const c = corpo(UTILS, nome);
      expect(c, `${nome} non esiste più in server/utils.ts: aggiorna questo elenco`).not.toBe("");
      expect(c).toContain("guestSocketFilter()");
      // Consultarlo e non usarlo sarebbe peggio che non averlo: il filtro
      // comparirebbe nel diff e la socket riceverebbe lo stesso.
      expect(c.includes("mayReceiveFrame") || c.includes("mayReadTopic")).toBe(true);
    });
  }

  it("nessuna funzione di server/utils.ts cicla wsClients e manda senza essere in elenco", () => {
    // La rete larga: se domani qualcuno scrive una quinta funzione che itera le
    // socket e manda, il test la trova anche senza che nessuno lo aggiorni.
    // Le due deroghe, con la ragione. Non sono «rumore da zittire»: sono i due
    // casi in cui ciclare le socket NON è una fan-out.
    const ESENTI = new Set([
      // La fabbrica che contiene tutte le altre: il conteggio delle graffe la
      // prende per intera, quindi corrisponde a qualunque cosa ci sia dentro.
      "createAppContext",
      // Colpisce UN dispositivo, scelto per nome dal chiamante — è l'opposto di
      // un broadcast, e il filtro qui romperebbe proprio il caso per cui esiste:
      // `auth:shares-changed` non è fra i tipi ammessi a un ospite, quindi
      // filtrandolo un ospite non saprebbe MAI che le sue condivisioni sono
      // cambiate. La decisione di chi riceve sta al chiamante, non qui.
      "sendToDevice",
    ]);
    const nomi = [...UTILS.matchAll(/function\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]!);
    const colpevoli = nomi.filter((n) => {
      if (FANOUT.includes(n) || ESENTI.has(n)) return false;
      return sembraUnaFanout(corpo(UTILS, n));
    });
    expect(colpevoli, "una fan-out nuova: o filtra gli ospiti, o va spiegata qui").toEqual([]);
  });

  it("la raffica di apertura in server.ts passa dalla sua porta unica", () => {
    // `inviaIniziale` è la porta della raffica: applica la stessa regola dei
    // broadcast ai frame che una socket riceve appena si apre. Il gestore `open`
    // non deve tornare a mandare da solo — è così che il buco è nato.
    const apre = SERVER.indexOf("wsClients.add(ws);");
    expect(apre, "il gestore `open` è cambiato: ritrova il punto").toBeGreaterThan(0);
    const gestore = SERVER.slice(apre, SERVER.indexOf("\n    message(ws, message) {", apre));
    expect(gestore).toContain("const inviaIniziale");
    expect(gestore).toContain("isGuestHandshakeFrame");
    // Nessun `ws.send` nudo nella raffica: quelli sono i frame che sfuggirebbero.
    const nudi = [...gestore.matchAll(/\bws\.send\(/g)].length;
    expect(
      nudi,
      "un `ws.send` diretto nel gestore `open` scavalca il confinamento: usa inviaIniziale",
    ).toBe(1); // solo quello DENTRO inviaIniziale
  });
});
