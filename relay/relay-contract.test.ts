/**
 * I due vincoli del relay che decidono se il conto è $10 o $416 al mese.
 *
 * Sono test TESTUALI sul sorgente del Worker, e la ragione è che entrambi i
 * difetti che presidiano sono **invisibili a runtime**: il codice funziona
 * benissimo in tutti e due i casi. Cambia solo la bolletta, e la si scopre a
 * fine mese.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SORGENTE = ["src/worker.ts", "src/relay-do.ts"]
  .map((f) => readFileSync(join(import.meta.dir, f), "utf8"))
  .join("\n");

/** Il codice senza commenti: una regola citata in una spiegazione non è una
 *  violazione, e un guardiano che non sa distinguerle grida al lupo. */
const CODICE = SORGENTE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((r) => !r.trim().startsWith("//")).join("\n");

describe("relay · il guardiano guarda davvero", () => {
  it("il sorgente è stato letto, ed è quello vero", () => {
    // Senza, un percorso sbagliato darebbe una stringa vuota e TUTTE le
    // asserzioni «non contiene» passerebbero — un guardiano cieco che dice
    // sempre di sì è peggio di nessun guardiano.
    expect(CODICE.length).toBeGreaterThan(1500);
    expect(CODICE).toContain("SessioneRelay");
    expect(CODICE).toContain("idFromName");
  });

  it("e sa riconoscere una violazione, se ci fosse", () => {
    // La prova che il criterio funziona: su un sorgente finto che viola le
    // regole, gli stessi controlli scattano.
    const finto = 'ws.accept(); document.addEventListener("x"); const c = req.headers.get("cookie");';
    expect(/\.accept\(\s*\)/.test(finto)).toBe(true);
    expect(finto.includes("addEventListener")).toBe(true);
    expect(/cookie/i.test(finto)).toBe(true);
  });
});

describe("relay · l'ibernazione è obbligatoria", () => {
  it("si accetta con `state.acceptWebSocket`, mai con `ws.accept()`", () => {
    // L'esempio ufficiale di Cloudflare misura lo stesso identico carico nei
    // due modi: $10/mese contro $416. Quaranta volte, appese a quale funzione
    // si chiama — e con `accept()` il codice funziona uguale, quindi non c'è
    // nessun sintomo prima della fattura.
    expect(CODICE).toContain("acceptWebSocket");
    expect(CODICE).not.toMatch(/\.accept\(\s*\)/);
  });

  it("i gestori sono METODI, non listener", () => {
    // È la conseguenza dell'ibernazione: fra un messaggio e l'altro l'istanza
    // può essere sfrattata dalla memoria, quindi un `addEventListener` sparisce
    // con lei. Se questo test fallisce, l'ibernazione è stata aggirata.
    expect(CODICE).toContain("webSocketMessage");
    expect(CODICE).toContain("webSocketClose");
    expect(CODICE).not.toContain("addEventListener");
  });

  it("nessuno stato vive in un campo dell'oggetto fra un messaggio e l'altro", () => {
    // Chi è ogni socket si legge dai TAG, che sopravvivono allo sfratto. Un
    // campo no: dopo l'ibernazione sarebbe vuoto, e il difetto comparirebbe
    // solo sotto carico basso — cioè quando nessuno sta guardando.
    expect(CODICE).toContain("getTags");
  });
});

describe("relay · il co-browse a pixel non entra qui", () => {
  it("il Worker non conosce nessun frame video o binario", () => {
    // Un flusso di pixel dentro un Durable Object è un altro ordine di
    // grandezza di costo, e sbatte contro i limiti di dimensione dei messaggi.
    // Resta WebRTC peer-to-peer, come già è.
    for (const parola of ["video", "rtc", "track", "MediaStream", "frame:", "codec"]) {
      expect(`${parola}→${new RegExp(parola, "i").test(CODICE)}`).toBe(`${parola}→false`);
    }
  });

  it("i messaggi binari si scartano invece di essere inoltrati", () => {
    // La porta si chiude qui, non a valle: un binario che passa è un binario
    // che qualcuno userà per farci scorrere qualcosa di grosso.
    expect(CODICE).toContain('typeof raw !== "string"');
  });
});

describe("relay · non decide chi sei (RELAY-04)", () => {
  it("il Worker non conosce sessioni, credenziali, permessi", () => {
    // Due autorità sull'identità vanno tenute d'accordo per sempre, e quella
    // che sbaglia è sempre quella che nessuno guarda. Qui si instrada e basta.
    //
    // NOTA su cosa NON è vietato: le parole `host` e `guest` compaiono, e vanno
    // bene — lì dicono da quale capo del tubo arrivi, non chi sei. Vietarle
    // sarebbe confondere il vocabolario dell'instradamento con quello
    // dell'identità, che è esattamente la distinzione che questo test difende.
    for (const parola of ["cookie", "topics_device", "authorization", "grants", "person_id", "installation_owners"]) {
      expect(`${parola}→${new RegExp(parola, "i").test(CODICE)}`).toBe(`${parola}→false`);
    }
  });

  it("il payload non viene mai ispezionato", () => {
    // Se comparisse un `JSON.parse(m.payload)`, il relay avrebbe cominciato a
    // capire quello che inoltra — e la promessa cadrebbe in silenzio.
    expect(CODICE).not.toMatch(/JSON\.parse\([^)]*payload/);
  });
});
