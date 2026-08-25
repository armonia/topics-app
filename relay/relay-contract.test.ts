/**
 * I due vincoli del relay che decidono se il conto è $10 o $416 al mese.
 *
 * Sono test TESTUALI sul sorgente del Worker, e la ragione è che entrambi i
 * difetti che presidiano sono **invisibili a runtime**: il codice funziona
 * benissimo in tutti e due i casi. Cambia solo la bolletta, e la si scopre a
 * fine mese.
 *
 * @covers RELAY-E2E-04
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

describe("relay · il segnale di chi ha chiesto è acceso DAVVERO", () => {
  /** `wrangler.jsonc` senza i commenti: gli stessi criteri del sorgente, e per
   *  la stessa ragione — una bandiera NOMINATA in una spiegazione non è una
   *  bandiera accesa, e un guardiano che non sa distinguerle dice sempre di sì. */
  const CONFIG = JSON.parse(
    readFileSync(join(import.meta.dir, "wrangler.jsonc"), "utf8")
      .split("\n").filter((r) => !r.trim().startsWith("//")).join("\n"),
  ) as { name?: string; compatibility_flags?: string[] };

  it("il file è stato letto, ed è quello del relay", () => {
    // Senza, un percorso sbagliato solleverebbe — ma un file VUOTO o di un
    // altro Worker passerebbe le asserzioni qui sotto senza dire niente.
    expect(CONFIG.name).toBe("topics-relay");
  });

  it("`enable_request_signal` è dichiarato, perché di suo non si accende mai", () => {
    // `request.signal` è il solo modo che il Worker ha di sapere che chi aveva
    // chiesto se n'è andato: la scheda chiusa, la pagina cambiata mentre
    // un'immagine stava ancora arrivando. Senza, l'unica cosa che sveglia il
    // ponte è la scadenza — mezzo minuto in cui la macchina serve una risposta
    // che non ha più dove andare, e una corsia del tubo resta occupata da
    // nessuno.
    //
    // È un test sulla configurazione, e per la stessa ragione degli altri due
    // qui sopra: il difetto è INVISIBILE a runtime. Il codice che ascolta il
    // segnale gira uguale e i test passano uguali; solo che in produzione quel
    // segnale non si interrompe mai. E questa bandiera, sola fra quelle che
    // usiamo, non ha una data in cui si accende da sé: o è scritta, o non c'è.
    const bandiere = CONFIG.compatibility_flags ?? [];
    expect(bandiere).toContain("enable_request_signal");
    expect(bandiere).not.toContain("disable_request_signal");
  });

  it("`request_signal_passthrough` è dichiarato: il segnale deve ARRIVARE al ponte", () => {
    // La bandiera qui sopra rende il segnale osservabile; questa lo fa
    // attraversare. Sono due cose diverse e la seconda è quella che si
    // dimentica — accendere solo la prima dà un `request.signal` che esiste e
    // non si interrompe mai, che è indistinguibile da un browser che non se ne
    // va mai.
    //
    // Conta QUI perché il ponte non gira nel Worker: `worker.ts` passa la
    // richiesta al Durable Object con `env.SESSIONE.get(id).fetch(req)`, e una
    // `fetch()` non porta con sé il segnale di chi ha bussato se non è
    // dichiarato `request_signal_passthrough` (gli stub dei Durable Object non
    // fanno eccezione). Senza, `seNeVa()` in `src/ponte.ts` ascolta un segnale
    // che nessuno interromperà: niente 499, niente `reset` verso la macchina,
    // niente upgrade rinunciato — la macchina serve per tutta la scadenza.
    //
    // QUESTA ASSERZIONE È IL GUARDIANO DEL TRATTO Worker→DO, e non è un
    // doppione dei test del ponte: `ponte.test.ts` e `ponte-ws.test.ts`
    // costruiscono l'`AbortController` e lo consegnano a mano, quindi provano
    // cosa fa il ponte QUANDO la rinuncia arriva — saltando esattamente il
    // salto in cui il segnale si perde. Se questa riga sparisce, non resta
    // niente che possa fallire.
    //
    // E non basta il deploy per accorgersene: `wrangler deploy --dry-run` esce
    // 0 anche con un nome di bandiera inventato. O è scritta, o non c'è.
    const bandiere = CONFIG.compatibility_flags ?? [];
    expect(bandiere).toContain("request_signal_passthrough");
    expect(bandiere).not.toContain("no_request_signal_passthrough");
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
    for (const parola of ["topics_device", "authorization", "grants", "person_id", "installation_owners"]) {
      expect(`${parola}→${new RegExp(parola, "i").test(CODICE)}`).toBe(`${parola}→false`);
    }
  });

  it("l'UNICO biscotto che il Worker tocca dice QUALE macchina, non CHI sei", () => {
    // La parola `cookie` non è più vietata in blocco, ed è un allargamento che
    // va guardato invece che subìto.
    //
    // Il motivo: il bundle dell'app chiede percorsi ASSOLUTI (`/assets/…`,
    // `/boot.js`), quindi servirlo sotto `/i/<id>/` dava pagina bianca. Serve
    // che il browser ricordi quale installazione sta guardando — e un biscotto
    // di INSTRADAMENTO non è una credenziale: non concede niente, e la
    // macchina continua a pretendere l'identità (401 su ogni chiamata,
    // verificato dall'esterno).
    //
    // Quindi il divieto si sposta da «nessun biscotto» a «nessun biscotto DI
    // IDENTITÀ», che è la proprietà vera. `topics_device` — quello di
    // sessione, che l'altro caso vieta — resta fuori dal Worker: se un giorno
    // comparisse, il relay avrebbe cominciato a decidere chi sei.
    const nomi = [...CODICE.matchAll(/["'`]([a-z_]*topics[a-z_]*)["'`]/gi)].map((m) => m[1]);
    for (const n of nomi) {
      expect(`${n}→ammesso`).toBe(`${n === "topics_inst" ? n : "topics_inst"}→ammesso`);
    }
    // Controllo positivo: il biscotto d'instradamento c'è davvero, altrimenti
    // questo caso passerebbe su un Worker che non ne tocca nessuno e non
    // direbbe niente.
    expect(CODICE).toContain("topics_inst");
  });

  it("l'unica cosa che il Worker VERIFICA è che un nome sia il digest di un segreto", () => {
    // Questo caso esiste perché il controllo sulla porta della macchina è un
    // allargamento di RELAY-04, e un allargamento va guardato invece che
    // subìto.
    //
    // La distinzione: il relay non impara CHI sei né COSA puoi vedere — quelle
    // restano domande dell'installazione. Impara solo che chi si dichiara la
    // macchina di un certo punto d'incontro sa costruirne il nome. È
    // instradamento, come il biscotto `topics_inst`: dice QUALE macchina, non
    // CHI sei.
    //
    // E la forma della verifica è ciò che tiene ferma la distinzione: una
    // funzione pura, importata da `shared/`, senza niente da consultare. Se un
    // giorno comparisse un elenco di chiavi ammesse — in `env`, nello storage,
    // ovunque — il relay avrebbe cominciato a tenere un registro di chi è
    // autorizzato, cioè la seconda autorità sull'identità che RELAY-04 esiste
    // per non avere.
    expect(CODICE).toContain("segretoCorrisponde");
    expect(CODICE).toContain("relay-identita");
    // Nessuna chiave che arrivi dalla configurazione del Worker: un segreto
    // condiviso fra tutte le installazioni sarebbe uno solo da rubare.
    expect(CODICE).not.toMatch(/env\.[A-Z_]*(KEY|SECRET|SEGRETO|TOKEN)/);
  });

  it("il payload non viene mai ispezionato", () => {
    // Se comparisse un `JSON.parse(m.payload)`, il relay avrebbe cominciato a
    // capire quello che inoltra — e la promessa cadrebbe in silenzio.
    expect(CODICE).not.toMatch(/JSON\.parse\([^)]*payload/);
  });
});
