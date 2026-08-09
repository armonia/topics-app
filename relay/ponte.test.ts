/**
 * IL PONTE, guidato con la macchina VERA dall'altra parte.
 *
 * ── PERCHÉ NON BASTA UN FINTO PER OGNI CAPO ─────────────────────────────────
 * Perché ciò che si sta provando è che due capi scritti separatamente si
 * capiscono. Qui il capo della macchina è `creaProxyTubo` — lo stesso codice
 * che gira in produzione, riga per riga — e il capo ospite è il ponte del
 * Worker. L'unica cosa finta è il contorno: la socket fra i due, e la porta
 * locale che la macchina rigioca. Se uno dei due cominciasse a dipendere da un
 * campo che il formato non promette, l'altro smetterebbe di capirlo e questi
 * test diventerebbero rossi.
 *
 * ── LA POMPA ────────────────────────────────────────────────────────────────
 * Non c'è nessuna rete: i messaggi restano in due code e li si travasa a mano,
 * finché la richiesta non è finita. Vuol dire che l'ordine è quello vero (una
 * socket consegna in ordine) e che nessun test dipende da un tempo.
 */
import { describe, expect, it } from "bun:test";
import worker from "./src/worker";
import { SessioneRelay } from "./src/relay-do";
import { creaPonte, SID_PONTE } from "./src/ponte";
import { creaProxyTubo } from "../server/services/relay-client";
import {
  leggiFramePayload, scriviFrame, TUBO_LIMITE_CLOUDFLARE,
} from "../shared/relay-protocol";
import { GENERE_RISPOSTA, scriviTesta } from "../shared/relay-http";

// ───────────────────────────────────────────────────────────────────────────
// IL CONTORNO FINTO
// ───────────────────────────────────────────────────────────────────────────

/** La socket della macchina, vista dal Durable Object. */
class SocketFinta {
  inviati: string[] = [];
  chiusa = false;
  send(d: string): void { this.inviati.push(d); }
  close(): void { this.chiusa = true; }
}

/** Lo stato del Durable Object, ridotto a ciò che il relay usa: i TAG sono
 *  l'unica memoria, com'è sotto ibernazione. */
class StatoFinto {
  storage = {};
  private tag = new Map<SocketFinta, string[]>();
  acceptWebSocket(ws: SocketFinta, tags: string[] = []): void { this.tag.set(ws, tags); }
  getWebSockets(tag?: string): SocketFinta[] {
    return [...this.tag.keys()].filter((w) => tag === undefined || (this.tag.get(w) ?? []).includes(tag));
  }
  getTags(ws: SocketFinta): string[] { return this.tag.get(ws) ?? []; }
  dimentica(ws: SocketFinta): void { this.tag.delete(ws); }
}

type StatoDelDO = ConstructorParameters<typeof SessioneRelay>[0];

/** Ciò che la macchina si è vista arrivare sulla sua porta locale. */
interface Arrivata {
  metodo: string;
  percorso: string;
  intestazioni: Record<string, string>;
  corpo: Uint8Array;
}

interface OpzioniScena {
  /** Cosa risponde la porta locale della macchina. */
  servi?: (a: Arrivata) => Response | Promise<Response>;
  /** La porta dedicata non è configurata: la macchina rifiuta in modo
   *  dichiarato invece di rigiocare da nessuna parte. */
  senzaPorta?: boolean;
  /** La macchina non è collegata affatto. */
  senzaMacchina?: boolean;
}

function scena(o: OpzioniScena = {}) {
  const stato = new StatoFinto();
  let oggetto = new SessioneRelay(stato as unknown as StatoDelDO);
  const host = new SocketFinta();
  if (!o.senzaMacchina) stato.acceptWebSocket(host, ["host"]);

  const arrivate: Arrivata[] = [];
  /** Ciò che la macchina manda verso il relay, in attesa di essere travasato. */
  const daMacchina: Array<{ sid: string; payload: string }> = [];
  /** Ogni busta uscita dal Durable Object verso la macchina, per misurarle. */
  const versoMacchinaViste: string[] = [];

  const proxy = creaProxyTubo({
    portaTunnel: o.senzaPorta ? null : 3334,
    invia: (sid, payload) => { daMacchina.push({ sid, payload }); },
    fetchLocale: (async (u: unknown, init: RequestInit = {}) => {
      const url = new URL(String(u));
      const intestazioni: Record<string, string> = {};
      for (const [n, v] of (init.headers as Headers) ?? new Headers()) intestazioni[n] = v;
      const b = init.body;
      const corpo = b === undefined || b === null
        ? new Uint8Array()
        : typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b as Uint8Array);
      const a: Arrivata = { metodo: init.method ?? "GET", percorso: `${url.pathname}${url.search}`, intestazioni, corpo };
      arrivate.push(a);
      return o.servi ? await o.servi(a) : new Response("ok");
    }) as unknown as typeof fetch,
  });

  /** Il Durable Object ha parlato: la macchina lo riceve, come fa il client
   *  vero (`creaRelayClient.gestisci`). */
  function versoMacchina(): void {
    while (host.inviati.length > 0) {
      const raw = host.inviati.shift()!;
      versoMacchinaViste.push(raw);
      const m = JSON.parse(raw) as { t: string; to?: string; payload?: string; sessionId?: string };
      if (m.t === "to-guest" && typeof m.to === "string" && typeof m.payload === "string") {
        const fr = leggiFramePayload(m.payload);
        if (fr) proxy.riceviFrame(m.to, fr);
        continue;
      }
      if (m.t === "guest-left" && typeof m.sessionId === "string") proxy.ospiteUscito(m.sessionId);
    }
  }

  /** …e il contrario. */
  async function versoPonte(): Promise<void> {
    while (daMacchina.length > 0) {
      const b = daMacchina.shift()!;
      await oggetto.webSocketMessage(
        host as unknown as WebSocket,
        JSON.stringify({ t: "to-guest", to: b.sid, payload: b.payload }),
      );
    }
  }

  /**
   * Aspetta una risposta travasando i messaggi.
   *
   * Se non arriva si SOLLEVA invece di restare appesi: un test che scade dopo
   * cinque secondi racconta «lento», un errore racconta «non è arrivata».
   */
  async function conPompa<T>(p: Promise<T>): Promise<T> {
    let fatto = false;
    void p.then(() => { fatto = true; }, () => { fatto = true; });
    for (let i = 0; i < 3000 && !fatto; i++) {
      versoMacchina();
      await versoPonte();
      await new Promise((r) => setTimeout(r, 0));
    }
    if (!fatto) throw new Error("nessuna risposta dal ponte: la pompa si e' fermata");
    return p;
  }

  const env = {
    SESSIONE: {
      idFromName: (nome: string) => ({ nome }),
      get: () => ({ fetch: (r: Request) => oggetto.fetch(r) }),
    },
  } as unknown as Parameters<typeof worker.fetch>[1];

  return {
    stato, host, arrivate, versoMacchinaViste, proxy, conPompa, versoMacchina, versoPonte,
    /** Una richiesta come la manda un browser. */
    chiedi: (percorso: string, init?: RequestInit) =>
      conPompa(worker.fetch(new Request(`https://relay.test${percorso}`, init), env)),
    /** La stessa cosa, ma senza aspettare: serve a guardare cosa succede
     *  MENTRE è in volo. */
    avvia: (percorso: string, init?: RequestInit) =>
      worker.fetch(new Request(`https://relay.test${percorso}`, init), env),
    /** L'istanza è stata sfrattata dalla memoria: ne nasce una nuova sullo
     *  stesso stato, che è esattamente ciò che fa l'ibernazione. */
    sfratta: () => { oggetto = new SessioneRelay(stato as unknown as StatoDelDO); },
    /** Una richiesta consegnata al Durable Object senza passare dal Worker: è
     *  il solo modo di guardare cosa fa lui quando l'instradamento non lo ha
     *  già deciso. */
    diretto: (percorso: string, init?: RequestInit) =>
      conPompa(oggetto.fetch(new Request(`https://relay.test${percorso}`, init))),
    chiudiMacchina: () => oggetto.webSocketClose(host as unknown as WebSocket),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// LA PORTA D'INGRESSO
// ───────────────────────────────────────────────────────────────────────────

describe("ponte · una richiesta del browser attraversa il tubo", () => {
  it("metodo, percorso, query e corpo arrivano alla macchina; stato, intestazioni e corpo tornano indietro", async () => {
    const s = scena({
      servi: () => new Response("ciao", {
        status: 201,
        headers: { "content-type": "text/plain; charset=utf-8", "x-prova": "uno" },
      }),
    });

    const r = await s.chiedi("/i/inst-1/api/topics?q=uno&b=due", {
      method: "POST",
      headers: { "x-mio": "abc" },
      body: "corpo della domanda",
    });

    expect(r.status).toBe(201);
    expect(await r.text()).toBe("ciao");
    expect(r.headers.get("x-prova")).toBe("uno");
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");

    expect(s.arrivate).toHaveLength(1);
    const a = s.arrivate[0]!;
    expect(a.metodo).toBe("POST");
    // Il percorso rigiocato è ciò che resta DOPO l'installazione, con la query
    // intatta: `/i/inst-1` è l'indirizzo del ponte, non un pezzo del sito.
    expect(a.percorso).toBe("/api/topics?q=uno&b=due");
    expect(new TextDecoder().decode(a.corpo)).toBe("corpo della domanda");
    expect(a.intestazioni["x-mio"]).toBe("abc");
  });

  it("un corpo più grande di un frame viaggia A PEZZI, nei due versi, e nessuna busta sfonda il tetto per messaggio", async () => {
    // 250 KiB: più di `TUBO_BYTE_PER_FRAME` (96 KiB) in tutti e due i versi,
    // quindi sia la domanda sia la risposta devono spezzarsi davvero.
    const su = "s".repeat(250 * 1024);
    const giu = new Uint8Array(250 * 1024).map((_, i) => i % 251);
    const s = scena({ servi: () => new Response(giu) });

    const r = await s.chiedi("/i/inst-1/upload", { method: "PUT", body: su });

    expect(r.status).toBe(200);
    const tornato = new Uint8Array(await r.arrayBuffer());
    expect(tornato.length).toBe(giu.length);
    expect(tornato).toEqual(giu);
    expect(new TextDecoder().decode(s.arrivate[0]!.corpo)).toBe(su);

    // Controllo POSITIVO che i pezzi ci sono davvero: un corpo così non entra
    // in un frame solo, quindi le buste verso la macchina devono essere più di
    // una — se un giorno il ponte smettesse di spezzare, questo si accorgerebbe.
    const buste = s.versoMacchinaViste.filter((b) => b.includes('"to-guest"'));
    expect(buste.length).toBeGreaterThan(2);
    // …e nessuna sfiora il tetto per messaggio del Durable Object.
    const piuGrossa = Math.max(...buste.map((b) => b.length));
    expect(piuGrossa).toBeLessThan(TUBO_LIMITE_CLOUDFLARE);
    expect(piuGrossa).toBeLessThan(400 * 1024);
  });

  it("le intestazioni della risposta che compaiono più volte non si perdono", async () => {
    // È il caso che morde: un oggetto ne terrebbe una sola, e quella persa
    // sarebbe proprio quella che fa entrare un dispositivo appaiato.
    const s = scena({
      servi: () => {
        const h = new Headers();
        h.append("set-cookie", "a=1; Path=/; HttpOnly");
        h.append("set-cookie", "b=2; Path=/; HttpOnly");
        return new Response("ok", { headers: h });
      },
    });
    const r = await s.chiedi("/i/inst-1/api/entra");
    expect(r.headers.getSetCookie?.() ?? []).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; HttpOnly",
    ]);
  });

  it("un rimando relativo resta dentro il ponte; uno assoluto non si tocca", async () => {
    const s = scena({
      servi: (a) => new Response(null, {
        status: 302,
        headers: { location: a.percorso === "/vai" ? "/login?next=/vai" : "https://altro.example/x" },
      }),
    });
    const dentro = await s.chiedi("/i/inst-1/vai");
    expect(dentro.status).toBe(302);
    expect(dentro.headers.get("location")).toBe("/i/inst-1/login?next=/vai");

    const fuori = await s.chiedi("/i/inst-1/altrove");
    expect(fuori.headers.get("location")).toBe("https://altro.example/x");
  });

  it("uno stato che non può avere un corpo non ne riceve uno, nemmeno se di là ce n'era", async () => {
    // `new Response(corpo, { status: 304 })` è un'eccezione e non una risposta:
    // uno stato «senza corpo» con dentro dei byte fa cadere il Worker, e
    // cadrebbe SOLO sulla risposta che quel corpo ce l'ha per sbaglio — cioè
    // in produzione, su un caso che nessuno aveva provato. Qui la macchina lo
    // manda apposta.
    const s = scena({ servi: () => new Response("byte che non devono passare", { status: 304 }) });
    const r = await s.chiedi("/i/inst-1/api/niente");
    expect(r.status).toBe(304);
    expect(await r.text()).toBe("");

    const vuoto = scena({ servi: () => new Response(null, { status: 204 }) });
    const v = await vuoto.chiedi("/i/inst-1/api/niente", { method: "DELETE" });
    expect(v.status).toBe(204);
    expect(await v.text()).toBe("");
  });

  it("una HEAD torna senza corpo, con le sue intestazioni", async () => {
    const s = scena({ servi: () => new Response("corpo che non deve tornare", { headers: { "x-c": "1" } }) });
    const r = await s.chiedi("/i/inst-1/api/x", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-c")).toBe("1");
    expect(await r.text()).toBe("");
  });

  it("un metodo che non si porta si dice, invece di morire più in là", async () => {
    const s = scena();
    const r = await s.chiedi("/i/inst-1/api/x", { method: "PROPFIND" });
    expect(r.status).toBe(405);
    expect(await r.text()).toContain("method");
    // …e non è nemmeno arrivato alla macchina.
    expect(s.arrivate).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// QUANDO NON SI PUÒ SERVIRE, LO SI DICE
// ───────────────────────────────────────────────────────────────────────────

describe("ponte · un guasto si legge, e non resta appeso", () => {
  it("macchina spenta = 503 con una frase, non un'attesa", async () => {
    const spenta = scena({ senzaMacchina: true });
    const r = await spenta.chiedi("/i/inst-1/api/topics");
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("not connected");

    // Controllo POSITIVO: lo stesso indirizzo, con la macchina collegata,
    // risponde — quindi il 503 dice «spenta» e non «questa porta non esiste».
    const accesa = scena();
    expect((await accesa.chiedi("/i/inst-1/api/topics")).status).toBe(200);
  });

  it("la macchina se ne va MENTRE la richiesta è in volo: si risponde subito", async () => {
    // Senza questo, la scheda del browser girerebbe fino alla scadenza per
    // dire alla fine una cosa che si sapeva già.
    let mai: (() => void) | null = null;
    const s = scena({ servi: () => new Promise<Response>(() => { mai = () => {}; }) });
    const p = s.avvia("/i/inst-1/api/lento");
    // Si fa arrivare la domanda alla macchina, poi le si taglia il filo.
    for (let i = 0; i < 5; i++) { s.versoMacchina(); await s.versoPonte(); await new Promise((r) => setTimeout(r, 0)); }
    expect(s.arrivate).toHaveLength(1);
    expect(mai).not.toBeNull();
    await s.chiudiMacchina();
    const r = await s.conPompa(p);
    expect(r.status).toBe(502);
  });

  it("senza porta dedicata la macchina rifiuta, e il rifiuto arriva al browser così com'è", async () => {
    const s = scena({ senzaPorta: true });
    const r = await s.chiedi("/i/inst-1/api/topics");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "remote-access-not-configured" });
  });

  it("una risposta che non arriva scade in 504 invece di restare appesa", async () => {
    // Sul ponte nudo, senza Durable Object: è il solo modo di guardare la
    // scadenza senza aspettare mezzo minuto.
    const p = creaPonte({ invia: () => { /* nessuno risponde, mai */ }, scadenzaMs: 5 });
    const r = await p.servi(new Request("https://x/api/y"), "/api/y", "/i/x");
    expect(r.status).toBe(504);
    expect(await r.text()).toContain("in time");
    expect(p.inAttesa()).toBe(0);
  });

  it("un corpo più grande del tetto si rifiuta qui, invece di spezzarlo in buste che l'altro capo butta", async () => {
    const inviati: string[] = [];
    const p = creaPonte({ invia: (x) => inviati.push(x), maxCorpo: 16 });
    const r = await p.servi(
      new Request("https://x/api/y", { method: "POST", body: "x".repeat(64) }),
      "/api/y", "/i/x",
    );
    expect(r.status).toBe(413);
    // Controllo POSITIVO che il tetto è la ragione: nulla è partito, e un corpo
    // che ci sta invece parte.
    expect(inviati).toHaveLength(0);
    void p.servi(new Request("https://x/api/y", { method: "POST", body: "corto" }), "/api/y", "/i/x");
    await new Promise((res) => setTimeout(res, 0));
    expect(inviati.length).toBeGreaterThan(0);
  });

  it("una risposta più grande del tetto non si accumula: si dichiara", async () => {
    const inviati: string[] = [];
    const p = creaPonte({ invia: (x) => inviati.push(x), maxRisposta: 64, max: 32 });
    const attesa = p.servi(new Request("https://x/api/y"), "/api/y", "/i/x");
    // La corsia di risposta si apre e poi sfonda: la macchina non lo sa, ma
    // chi riceve sì, e non deve tenere in memoria ciò che non ha promesso.
    p.ricevi(scriviFrame({
      f: "open", s: 0, n: 0, k: GENERE_RISPOSTA,
      h: scriviTesta({ re: 1, s: 200 }), e: "u", d: "x".repeat(40),
    }));
    p.ricevi(scriviFrame({ f: "data", s: 0, n: 1, e: "u", d: "x".repeat(40), fin: true }));
    expect((await attesa).status).toBe(502);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// L'IBERNAZIONE
// ───────────────────────────────────────────────────────────────────────────

describe("ponte · una istanza nuova riparte pulita", () => {
  it("dopo lo sfratto dalla memoria le richieste continuano a essere servite", async () => {
    // È il difetto che non si vede scrivendo il codice: la numerazione degli
    // stream riparte da capo con l'istanza, mentre la macchina si ricorda fin
    // dove era arrivata — e un numero già visto lo rifiuta PER SEMPRE. Senza
    // il congedo della sessione, questa seconda richiesta è un 502, e lo sono
    // tutte quelle dopo.
    const s = scena({ servi: (a) => new Response(`servito ${a.percorso}`) });
    expect((await s.chiedi("/i/inst-1/prima")).status).toBe(200);

    s.sfratta();

    const r = await s.chiedi("/i/inst-1/seconda");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("servito /seconda");

    // …e il congedo è stato detto davvero: è quello che fa ripartire pulito.
    const congedi = s.versoMacchinaViste.filter((b) => b.includes('"guest-left"'));
    expect(congedi.length).toBe(2);
    expect(JSON.parse(congedi[0]!)).toMatchObject({ t: "guest-left", sessionId: SID_PONTE });
  });

  it("due richieste in parallelo sulla stessa istanza non si scambiano le risposte", async () => {
    const s = scena({ servi: (a) => new Response(`eco ${a.percorso}`) });
    const a = s.avvia("/i/inst-1/uno");
    const b = s.avvia("/i/inst-1/due");
    const [ra, rb] = await s.conPompa(Promise.all([a, b]));
    expect(await ra.text()).toBe("eco /uno");
    expect(await rb.text()).toBe("eco /due");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CHI DECIDE COSA SI VEDE È LA MACCHINA
// ───────────────────────────────────────────────────────────────────────────

describe("ponte · il confinamento regge anche da qui (RELAY-04)", () => {
  /** Una macchina che decide come decide la vera: guarda la richiesta, e
   *  serve solo ciò per cui quella richiesta ha una capacità. */
  const macchinaCheDecide = (a: Arrivata): Response => {
    const buono = a.intestazioni["x-topics-share"] === "buono";
    if (!buono) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    if (a.metodo !== "GET") return new Response(JSON.stringify({ error: "read-only" }), { status: 403 });
    if (!a.percorso.startsWith("/api/topics/condiviso")) {
      return new Response(JSON.stringify({ error: "not-shared" }), { status: 404 });
    }
    return new Response(JSON.stringify({ ok: true }));
  };

  it("chi non porta la capacità non vede niente, e chi la porta vede solo quella", async () => {
    const s = scena({ servi: macchinaCheDecide });

    // Controllo POSITIVO: con la capacità, la risorsa condivisa si apre.
    const dentro = await s.chiedi("/i/inst-1/api/topics/condiviso/1", { headers: { "x-topics-share": "buono" } });
    expect(dentro.status).toBe(200);

    // Senza, non si apre niente.
    expect((await s.chiedi("/i/inst-1/api/topics/condiviso/1")).status).toBe(403);
    // Con la capacità ma su un'altra risorsa: la capacità è su UNA cosa.
    expect((await s.chiedi("/i/inst-1/api/topics/altro", { headers: { "x-topics-share": "buono" } })).status).toBe(404);
    // …e non si scrive.
    const scrivi = await s.chiedi("/i/inst-1/api/topics/condiviso/1", {
      method: "POST", headers: { "x-topics-share": "buono" }, body: "{}",
    });
    expect(scrivi.status).toBe(403);
  });

  it("il ponte non aggiunge nessuna dichiarazione di identità, e non ne toglie", async () => {
    const s = scena();
    await s.chiedi("/i/inst-1/api/x", { headers: { "x-topics-share": "buono", "x-altro": "2" } });
    const visto = s.arrivate[0]!.intestazioni;
    // Ciò che il browser ha scritto arriva com'era…
    expect(visto["x-topics-share"]).toBe("buono");
    expect(visto["x-altro"]).toBe("2");
    // …e ciò che il relay avrebbe potuto inventarsi non c'è: chi bussa non ha
    // un indirizzo che il relay conosca, e un numero inventato è un numero che
    // qualcuno un giorno legge come vero.
    for (const n of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"]) {
      expect(`${n}→${n in visto}`).toBe(`${n}→false`);
    }
  });

  it("una dichiarazione scritta da chi bussa non trasforma un'altra porta in un ponte", async () => {
    // Il ruolo nasce dal PERCORSO, che è roba del relay. Se nascesse da
    // un'intestazione o da un parametro, chi bussa a un'altra porta potrebbe
    // farsi tradurre una richiesta dichiarandolo — e la porta scelta non
    // sarebbe più quella su cui si è deciso qualcosa.
    //
    // Si guarda il Durable Object DIRETTAMENTE perché è lì che la decisione
    // vive: dal Worker un `/d/:id` senza upgrade non ci arriva nemmeno, quindi
    // di lassù questa prova non potrebbe fallire.
    const s = scena();
    for (const q of ["/x?ruolo=host", "/x?ruolo=ponte", "/d/inst-1"]) {
      const r = await s.diretto(q, { headers: { "x-relay-ruolo": "ponte", "x-relay-prefisso": "/i/altro" } });
      expect(`${q}→${r.status}`).toBe(`${q}→426`);
    }
    expect(s.arrivate).toHaveLength(0);

    // Controllo POSITIVO del criterio: sul percorso giusto la traduzione c'è.
    expect((await s.diretto("/i/inst-1/api/x")).status).toBe(200);
    expect(s.arrivate).toHaveLength(1);
  });

  it("un upgrade sulla porta del ponte si dichiara, invece di essere tradotto male", async () => {
    const s = scena();
    const r = await s.chiedi("/i/inst-1/ws", { headers: { upgrade: "websocket" } });
    expect(r.status).toBe(501);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// LE ALTRE PORTE RESTANO QUELLE DI PRIMA
// ───────────────────────────────────────────────────────────────────────────

describe("ponte · l'instradamento di prima non si muove", () => {
  it("solo `/i/:id/...` è il ponte: tutto ciò che gli somiglia resta un 404", async () => {
    const s = scena();
    for (const p of ["/i", "/i/", "/ii/x", "/x/i", "/i/con spazio"]) {
      expect(`${p}→${(await s.chiedi(p)).status}`).toBe(`${p}→404`);
    }
    // Controllo positivo del criterio: la forma buona invece passa.
    expect((await s.chiedi("/i/inst-1")).status).toBe(200);
    expect(s.arrivate[0]!.percorso).toBe("/");
  });
});
