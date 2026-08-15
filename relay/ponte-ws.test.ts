/**
 * IL PONTE-WEBSOCKET, con un ascoltatore VERO in fondo.
 *
 * ── COSA SI STA PROVANDO ────────────────────────────────────────────────────
 * Che un browser che apre `wss://relay…/i/<installazione>/ws` finisce dentro
 * l'ascoltatore di casa senza sapere niente del protocollo del tubo. Quindi i
 * capi sono quelli veri: `creaProxyTubo` — lo stesso codice che gira in
 * produzione — dalla parte della macchina, `SessioneRelay` con il suo ponte
 * dalla parte del relay, e in fondo un `Bun.serve` che accetta upgrade su
 * porta effimera. Finti sono solo il filo fra relay e macchina (due code che
 * si travasano a mano) e la coppia di socket che il runtime di Cloudflare
 * regala al Worker, che qui non c'è.
 *
 * L'ascoltatore sta su `127.0.0.1` con `port: 0`: non tocca né la :3333 di
 * produzione né la porta del tunnel di questa macchina.
 *
 * ── LA POMPA ────────────────────────────────────────────────────────────────
 * Non c'è nessuna rete fra relay e macchina: i messaggi restano in due code e
 * li si travasa. L'ordine è quello vero (una socket consegna in ordine) e
 * nessuna asserzione dipende da un tempo — si pompa finché la cosa attesa non
 * è arrivata, e se non arriva ci si SOLLEVA invece di restare appesi.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import worker from "./src/worker";
import { SessioneRelay } from "./src/relay-do";
import {
  creaPonte, SID_PONTE, upgradeRifiutato, WS_PONTE_GIU, WS_PONTE_RIPARTITO,
} from "./src/ponte";
import { creaProxyTubo } from "../server/services/relay-client";
import { leggiFramePayload, scriviFrame, type FrameTubo } from "../shared/relay-protocol";
import { derivaRelayId, INTESTAZIONE_SEGRETO } from "../shared/relay-identita";
import {
  GENERE_WS_APERTO, GENERE_WS_CHIUSO, leggiChiusuraWs, leggiTestaWsChiuso,
  scriviTestaWs, WS_APERTO,
} from "../shared/relay-ws";

// ───────────────────────────────────────────────────────────────────────────
// IL CONTORNO FINTO
// ───────────────────────────────────────────────────────────────────────────

/** La socket della macchina, vista dal Durable Object. */
class SocketRelay {
  inviati: string[] = [];
  send(d: string): void { this.inviati.push(d); }
  close(): void { /* il filo col relay qui non serve chiuderlo */ }
}

/**
 * Un capo della coppia che Cloudflare regala al Worker.
 *
 * Quello che il ponte tiene è il capo del SERVER: ciò che ci scrive sopra è
 * ciò che il browser riceve, e la sua chiusura è quella che il browser vede.
 */
class MetaSocket {
  ricevuti: Array<string | Uint8Array> = [];
  chiusa: { c?: number; r?: string } | null = null;
  send(d: string | Uint8Array | ArrayBuffer): void {
    if (this.chiusa) throw new Error("socket chiusa");
    this.ricevuti.push(typeof d === "string" ? d : new Uint8Array(d as Uint8Array));
  }
  close(c?: number, r?: string): void { this.chiusa ??= { c, r }; }
  /** Il testo ricevuto, per le asserzioni che non guardano i byte. */
  testi(): string[] { return this.ricevuti.filter((d): d is string => typeof d === "string"); }
}

/** Le mezze socket del server create finora: `collegaWs` riceve l'ultima. */
const meta: MetaSocket[] = [];

class CoppiaFinta {
  0: MetaSocket;
  1: MetaSocket;
  constructor() {
    this[0] = new MetaSocket();
    this[1] = new MetaSocket();
    meta.push(this[1]);
  }
}
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = CoppiaFinta;

/** Lo stato del Durable Object, ridotto a ciò che il relay usa: i TAG sono
 *  l'unica memoria, com'è sotto ibernazione. */
class StatoFinto {
  private tag = new Map<object, string[]>();
  acceptWebSocket(ws: object, tags: string[] = []): void { this.tag.set(ws, tags); }
  getWebSockets(tag?: string): object[] {
    return [...this.tag.keys()].filter((w) => tag === undefined || (this.tag.get(w) ?? []).includes(tag));
  }
  getTags(ws: object): string[] { return this.tag.get(ws) ?? []; }
}

type StatoDelDO = ConstructorParameters<typeof SessioneRelay>[0];

interface Chiusura { chiudi(): void }
const daChiudere: Chiusura[] = [];
afterEach(() => {
  while (daChiudere.length > 0) daChiudere.pop()?.chiudi();
  meta.length = 0;
});

/** Ciò che è arrivato alla stretta di mano locale: serve a GUARDARE cosa un
 *  ospite che sta fuori dalla rete di casa è riuscito a farsi scrivere
 *  addosso. */
interface DatiSocket {
  percorso: string;
  intestazioni: Record<string, string>;
}

interface OpzioniAscolto {
  /** L'ascoltatore decide se aprire, come fa il vero quando il percorso non
   *  esiste o la richiesta non porta nessuna capacità. */
  accetta?: (d: DatiSocket) => boolean;
  /** Il sottoprotocollo che l'ascoltatore sceglie. */
  protocollo?: string;
}

/** L'ascoltatore del tunnel, in piccolo. */
function ascoltatore(o: OpzioniAscolto = {}) {
  const aperti: DatiSocket[] = [];
  const ricevuti: Array<string | Uint8Array> = [];
  const chiusi: Array<{ code: number; reason: string }> = [];
  const vivi = new Set<ServerWebSocket<DatiSocket>>();

  const s = Bun.serve<DatiSocket, never>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const u = new URL(req.url);
      const intestazioni: Record<string, string> = {};
      for (const [n, v] of req.headers) intestazioni[n] = v;
      const dati: DatiSocket = { percorso: u.pathname + u.search, intestazioni };
      if (o.accetta && !o.accetta(dati)) return new Response("non si può", { status: 403 });
      const su = o.protocollo !== undefined
        ? server.upgrade(req, { data: dati, headers: { "sec-websocket-protocol": o.protocollo } })
        : server.upgrade(req, { data: dati });
      if (su) return undefined;
      return new Response("serve un upgrade", { status: 426 });
    },
    websocket: {
      open(ws) { aperti.push(ws.data); vivi.add(ws); },
      message(_ws, m) { ricevuti.push(typeof m === "string" ? m : new Uint8Array(m)); },
      close(ws, code, reason) { vivi.delete(ws); chiusi.push({ code, reason }); },
    },
  });
  daChiudere.push({ chiudi: () => { try { s.stop(true); } catch { /* già ferma */ } } });

  return {
    porta: s.port ?? 0,
    aperti, ricevuti, chiusi,
    /** Parla a tutti i socket vivi: è il terminale che scrive. */
    grida(d: string | Uint8Array) { for (const w of vivi) w.send(d as string); },
    chiudiTutti(code: number, reason: string) { for (const w of [...vivi]) w.close(code, reason); },
    vivi: () => vivi.size,
  };
}

interface OpzioniScena {
  /** La porta dedicata non è configurata: la macchina rifiuta in modo
   *  dichiarato invece di rigiocare da nessuna parte. */
  senzaPorta?: boolean;
  ascolto?: OpzioniAscolto;
}

function scena(o: OpzioniScena = {}) {
  const giu = ascoltatore(o.ascolto ?? {});
  const stato = new StatoFinto();
  let oggetto = new SessioneRelay(stato as unknown as StatoDelDO);
  const relay = new SocketRelay();
  stato.acceptWebSocket(relay, ["host"]);

  const daMacchina: Array<{ sid: string; payload: string }> = [];
  const proxy = creaProxyTubo({
    portaTunnel: o.senzaPorta ? null : giu.porta,
    invia: (sid, payload) => { daMacchina.push({ sid, payload }); },
  });

  /** Il Durable Object ha parlato: la macchina lo riceve, come fa il client
   *  vero (`creaRelayClient.gestisci`). */
  function versoMacchina(): void {
    while (relay.inviati.length > 0) {
      const raw = relay.inviati.shift()!;
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
        relay as unknown as WebSocket,
        JSON.stringify({ t: "to-guest", to: b.sid, payload: b.payload }),
      );
    }
  }

  async function unGiro(): Promise<void> {
    versoMacchina();
    await versoPonte();
    await new Promise((r) => setTimeout(r, 1));
  }

  /** Pompa finché `pronto` non dice di sì. Solleva invece di restare appesi:
   *  un test che scade dopo cinque secondi racconta «lento», un errore
   *  racconta «non è arrivata». */
  async function finche(pronto: () => boolean, cosa: string, giri = 400): Promise<void> {
    for (let i = 0; i < giri; i++) {
      if (pronto()) return;
      await unGiro();
    }
    if (!pronto()) throw new Error(`la pompa si e' fermata prima di: ${cosa}`);
  }

  async function conPompa<T>(p: Promise<T>): Promise<T> {
    let fatto = false;
    void p.then(() => { fatto = true; }, () => { fatto = true; });
    await finche(() => fatto, "una risposta dal ponte");
    return p;
  }

  const env = {
    SESSIONE: {
      idFromName: (nome: string) => ({ nome }),
      get: () => ({ fetch: (r: Request) => oggetto.fetch(r) }),
    },
  } as unknown as Parameters<typeof worker.fetch>[1];

  /** Un upgrade come lo manda un browser. Torna la risposta e, quando è
   *  riuscito, la mezza socket che il ponte ha in mano. `segnale` è quello che
   *  il runtime interrompe quando chi ha bussato se ne va prima della fine. */
  async function apri(
    percorso: string,
    intestazioni: Record<string, string> = {},
    segnale?: AbortSignal,
  ) {
    const prima = meta.length;
    const res = await conPompa(worker.fetch(
      new Request(`https://relay.test${percorso}`, {
        headers: {
          upgrade: "websocket", connection: "Upgrade",
          "sec-websocket-version": "13",
          "sec-websocket-key": "chiave-del-browser",
          ...intestazioni,
        },
        ...(segnale ? { signal: segnale } : {}),
      }),
      env,
    ));
    return { res, browser: meta.length > prima ? meta[meta.length - 1]! : null };
  }

  return {
    giu, stato, relay, proxy, env, oggetto: () => oggetto,
    apri, conPompa, finche, unGiro,
    /** Il browser manda: nel runtime vero lo fa il gestore dell'ibernazione. */
    dalBrowser: (ws: MetaSocket, d: string | ArrayBuffer) =>
      oggetto.webSocketMessage(ws as unknown as WebSocket, d),
    chiudeIlBrowser: (ws: MetaSocket, c?: number, r?: string) =>
      oggetto.webSocketClose(ws as unknown as WebSocket, c, r),
    chiudiMacchina: () => oggetto.webSocketClose(relay as unknown as WebSocket),
    /** L'istanza è stata sfrattata dalla memoria: ne nasce una nuova sullo
     *  stesso stato, che è esattamente ciò che fa l'ibernazione. */
    sfratta: () => { oggetto = new SessioneRelay(stato as unknown as StatoDelDO); },
    /** Una richiesta HTTP qualunque: serve a far nascere l'istanza nuova del
     *  ponte dopo lo sfratto. */
    chiedi: (percorso: string) =>
      conPompa(worker.fetch(new Request(`https://relay.test${percorso}`), env)),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// UN SOCKET ATTRAVERSA IL TUBO
// ───────────────────────────────────────────────────────────────────────────

describe("ponte-ws · l'upgrade del browser arriva all'ascoltatore di casa", () => {
  it("percorso e query intatti, e i due versi scorrono", async () => {
    const s = scena();
    const { res, browser } = await s.apri("/i/inst-1/ws?tab=uno");
    expect(res.status).toBe(101);
    expect(browser).not.toBeNull();

    await s.finche(() => s.giu.aperti.length === 1, "la stretta di mano locale");
    // `/i/inst-1` è l'indirizzo del ponte, non un pezzo del sito.
    expect(s.giu.aperti[0]!.percorso).toBe("/ws?tab=uno");

    // Dal browser verso la macchina…
    await s.dalBrowser(browser!, "ciao macchina");
    await s.finche(() => s.giu.ricevuti.length === 1, "il messaggio verso l'alto");
    expect(s.giu.ricevuti[0]).toBe("ciao macchina");

    // …e dalla macchina verso il browser.
    s.giu.grida("ciao browser");
    await s.finche(() => browser!.ricevuti.length === 1, "il messaggio verso il basso");
    expect(browser!.ricevuti[0]).toBe("ciao browser");
  });

  it("i byte di un terminale scendono come byte, e un messaggio più grande di un frame arriva intero", async () => {
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws/terminal/t1");
    await s.finche(() => s.giu.aperti.length === 1, "la stretta di mano locale");
    expect(s.giu.aperti[0]!.percorso).toBe("/ws/terminal/t1");

    // 250 KiB: più di `TUBO_BYTE_PER_FRAME` (96 KiB), quindi il messaggio si
    // spezza davvero e si rimette insieme dall'altra parte.
    const schermata = new Uint8Array(250 * 1024).map((_, i) => i % 251);
    s.giu.grida(schermata);
    await s.finche(() => browser!.ricevuti.length === 1, "la schermata del terminale");
    const arrivata = browser!.ricevuti[0];
    expect(arrivata).toBeInstanceOf(Uint8Array);
    expect((arrivata as Uint8Array).length).toBe(schermata.length);
    expect(arrivata).toEqual(schermata);

    // E nel verso opposto: quello che il browser scrive come byte resta byte.
    const tasti = new Uint8Array([0x1b, 0x5b, 0x41]);
    await s.dalBrowser(browser!, tasti.buffer as ArrayBuffer);
    await s.finche(() => s.giu.ricevuti.length === 1, "i tasti verso l'alto");
    expect(s.giu.ricevuti[0]).toEqual(tasti);
  });

  it("quattro socket sulla stessa sessione non si scambiano i messaggi", async () => {
    // È la forma vera: il client ne apre uno per l'applicazione, uno per ogni
    // terminale e uno per ogni pannello browser. Se il ponte ne reggesse uno
    // solo, il secondo pannello aperto ucciderebbe il primo.
    const s = scena();
    const a = await s.apri("/i/inst-1/ws");
    const b = await s.apri("/i/inst-1/ws/terminal/t1");
    const c = await s.apri("/i/inst-1/ws/terminal/t2");
    const d = await s.apri("/i/inst-1/ws/browser/b1");
    for (const r of [a, b, c, d]) expect(r.res.status).toBe(101);

    await s.finche(() => s.giu.aperti.length === 4, "quattro strette di mano");
    expect(s.giu.aperti.map((x) => x.percorso).sort()).toEqual([
      "/ws", "/ws/browser/b1", "/ws/terminal/t1", "/ws/terminal/t2",
    ]);

    // Ognuno parla per sé: quattro messaggi distinti, e ogni socket riceve
    // solo il proprio.
    await s.dalBrowser(a.browser!, "da-a");
    await s.dalBrowser(d.browser!, "da-d");
    await s.finche(() => s.giu.ricevuti.length === 2, "i due messaggi verso l'alto");
    expect([...s.giu.ricevuti].sort()).toEqual(["da-a", "da-d"]);

    // …e nel verso opposto ognuno riceve una copia, nessuno due.
    s.giu.grida("a tutti");
    await s.finche(
      () => [a, b, c, d].every((r) => r.browser!.ricevuti.length === 1),
      "una copia per socket",
    );
    for (const r of [a, b, c, d]) expect(r.browser!.ricevuti).toEqual(["a tutti"]);
  });

  it("il sottoprotocollo lo sceglie la macchina, e torna nella risposta di apertura", async () => {
    // Un browser che aveva chiesto un sottoprotocollo e non se lo vede tornare
    // rifiuta la connessione: la scelta viaggia fino in fondo o non serve.
    const s = scena({ ascolto: { protocollo: "topics.v1" } });
    const { res } = await s.apri("/i/inst-1/ws", { "sec-websocket-protocol": "topics.v1, topics.v0" });
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe("topics.v1");

    await s.finche(() => s.giu.aperti.length === 1, "la stretta di mano locale");
    // Le preferenze sono arrivate come preferenze, e in ordine.
    expect(s.giu.aperti[0]!.intestazioni["sec-websocket-protocol"]).toBe("topics.v1, topics.v0");
  });

  it("senza sottoprotocollo chiesto la risposta non ne inventa uno", async () => {
    const s = scena();
    const { res } = await s.apri("/i/inst-1/ws");
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// LA CHIUSURA PORTA IL SUO CODICE
// ───────────────────────────────────────────────────────────────────────────

describe("ponte-ws · una chiusura si legge, nei due versi", () => {
  it("il codice del browser arriva fino all'ascoltatore", async () => {
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");

    await s.chiudeIlBrowser(browser!, 4321, "chiudo io");
    await s.finche(() => s.giu.chiusi.length === 1, "la chiusura in fondo");
    // Il MOTIVO non si guarda qui, e non perché non conti: il client
    // WebSocket di Bun non lo mette sul filo (misurato: l'ascoltatore vede
    // `""` anche quando `close(4321, "…")` lo dichiara). È un limite del
    // trasporto locale, non del ponte — che il motivo attraversi il tubo lo
    // prova il test qui sotto, sul frame.
    expect(s.giu.chiusi[0]!.code).toBe(4321);
  });

  it("il motivo viaggia dentro il tubo, accanto al codice", async () => {
    // Il capo che lo scrive è il ponte, quindi lo si legge dove il ponte lo
    // scrive: `close()` di Bun perde il motivo più in là, e un test che si
    // fermasse là non saprebbe distinguere «il ponte non lo manda» da «il
    // trasporto lo butta».
    const uscite: string[] = [];
    const p = creaPonte({ invia: (payload) => { uscite.push(payload); }, scadenzaMs: 5 });
    const req = new Request("https://relay.test/i/inst-1/ws", { headers: { upgrade: "websocket" } });
    const chiesto = p.apriWs(req, "/ws");

    // La macchina risponde che è aperto, sul suo canale (pari).
    const apertura = leggiFramePayload(uscite[0]!)!;
    p.ricevi(scriviFrame({
      f: "open", s: 0, n: 0, k: GENERE_WS_APERTO, c: true,
      h: scriviTestaWs({ re: apertura.s, s: WS_APERTO }),
    }));
    const e = await chiesto;
    expect(e).toEqual({ ok: true, sIn: apertura.s });

    uscite.length = 0;
    if (e.ok) p.chiudiWs(e.sIn, 4321, "chiudo io");

    const chiusure = uscite
      .map((u) => leggiFramePayload(u))
      .filter((f): f is Extract<FrameTubo, { f: "open" }> => f?.f === "open" && f.k === GENERE_WS_CHIUSO);
    expect(chiusure).toHaveLength(1);
    expect(leggiTestaWsChiuso(chiusure[0]!.h)).toEqual({ w: apertura.s });
    expect(leggiChiusuraWs(chiusure[0]!.d)).toEqual({ c: 4321, r: "chiudo io" });
  });

  it("`1006` non è un codice che si dichiara: diventa una chiusura normale", async () => {
    // È il codice che il browser produce da solo quando il filo cade, ed è
    // riservato: girarlo a un `close()` vero è un'eccezione, non una chiusura.
    // Chi lo traduce è la macchina (`codiceInviabile`), e questo prova che il
    // ponte glielo consegna invece di inventarsi qualcosa per conto suo.
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");

    await s.chiudeIlBrowser(browser!, 1006, "il filo è caduto");
    await s.finche(() => s.giu.chiusi.length === 1, "la chiusura in fondo");
    expect(s.giu.chiusi[0]!.code).toBe(1000);
  });

  it("il codice dell'ascoltatore arriva fino al browser", async () => {
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");

    s.giu.chiudiTutti(4009, "finito di là");
    await s.finche(() => browser!.chiusa !== null, "la chiusura al browser");
    expect(browser!.chiusa).toEqual({ c: 4009, r: "finito di là" });
  });

  it("un codice che `close()` non accetta si posa, invece di sollevare", async () => {
    // `1011` è legittimo su un socket vero e NON è dichiarabile da un
    // `close()` del browser: passarlo di peso sarebbe un'eccezione a metà di
    // una chiusura, e il socket resterebbe aperto per sempre.
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");

    s.giu.chiudiTutti(1011, "errore di là");
    await s.finche(() => browser!.chiusa !== null, "la chiusura al browser");
    expect(browser!.chiusa).toEqual({ c: undefined, r: undefined });
  });

  it("chiudere un socket non tocca gli altri", async () => {
    const s = scena();
    const a = await s.apri("/i/inst-1/ws");
    const b = await s.apri("/i/inst-1/ws/terminal/t1");
    await s.finche(() => s.giu.vivi() === 2, "due strette di mano");

    await s.chiudeIlBrowser(a.browser!, 4321, "solo io");
    await s.finche(() => s.giu.chiusi.length === 1, "una sola chiusura in fondo");
    expect(s.giu.vivi()).toBe(1);
    expect(b.browser!.chiusa).toBeNull();

    // Controllo POSITIVO che il superstite è ancora un socket e non un
    // guscio: continua a portare messaggi nei due versi.
    s.giu.grida("ancora vivo");
    await s.finche(() => b.browser!.ricevuti.length === 1, "il messaggio al superstite");
    expect(b.browser!.ricevuti).toEqual(["ancora vivo"]);
    expect(a.browser!.ricevuti).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UN GUASTO SI LEGGE, E NON RESTA APPESO
// ───────────────────────────────────────────────────────────────────────────

describe("ponte-ws · quando non si apre, si dice perché", () => {
  it("un percorso che sceglie un'altra destinazione è un 400, e nessun socket parte", async () => {
    // Il cancello è quello delle richieste, di proposito: un percorso che
    // porta altrove non è una richiesta storta, è un tentativo di usare questa
    // macchina come ponte verso il resto della sua rete.
    const s = scena();
    const { res, browser } = await s.apri("/i/inst-1//altrove/ws");
    expect(res.status).toBe(400);
    // Nessun `101`, quindi nessuna coppia di socket: il browser si è visto
    // rifiutare l'upgrade, non aprire e chiudere.
    expect(browser).toBeNull();
    expect(s.giu.aperti).toHaveLength(0);
  });

  it("l'ascoltatore rifiuta l'upgrade: 502, e non un socket che nasce morto", async () => {
    const s = scena({ ascolto: { accetta: (d) => d.intestazioni["x-topics-share"] === "buono" } });
    const { res, browser } = await s.apri("/i/inst-1/ws");
    expect(res.status).toBe(502);
    expect(browser).toBeNull();
    expect(s.giu.aperti).toHaveLength(0);

    // Controllo POSITIVO del criterio: con la capacità addosso lo stesso
    // percorso si apre. Senza, questo test non saprebbe distinguere «rifiuta»
    // da «non funziona niente».
    const buono = await s.apri("/i/inst-1/ws", { "x-topics-share": "buono" });
    expect(buono.res.status).toBe(101);
    await s.finche(() => s.giu.aperti.length === 1, "la stretta di mano buona");
  });

  it("la macchina non risponde: 504, e non una clessidra per sempre", async () => {
    // Qui il ponte si guida da solo, senza macchina in fondo: è il solo modo
    // di avere un silenzio che dura.
    const uscite: string[] = [];
    const p = creaPonte({ invia: (payload) => { uscite.push(payload); }, scadenzaMs: 5 });
    const e = await p.apriWs(
      new Request("https://relay.test/i/inst-1/ws", { headers: { upgrade: "websocket" } }),
      "/ws",
    );
    expect(e).toEqual({ ok: false, stato: 504 });
    // …e di là si rinuncia davvero: il canale si chiude, invece di lasciare
    // alla macchina un socket vero con nessuno davanti.
    expect(uscite.some((u) => u.includes('"reset"'))).toBe(true);
    expect(p.wsVivi()).toBe(0);
  });

  it("il tetto dei socket è un rifiuto dichiarato, non un `reset` senza motivo", async () => {
    const p = creaPonte({ invia: () => {}, maxSocket: 1, scadenzaMs: 5 });
    const req = () => new Request("https://relay.test/i/inst-1/ws", { headers: { upgrade: "websocket" } });
    // Il primo occupa il posto: resta in attesa finché non scade, ed è quello
    // che serve — un socket «in apertura» conta come aperto.
    const primo = p.apriWs(req(), "/ws");
    // Un numero suo, non il `503` con cui la macchina dice «niente accesso da
    // fuori»: qui l'accesso c'è, sono i posti a essere finiti, e chi legge il
    // guasto ci deve poter decidere sopra.
    expect(await p.apriWs(req(), "/ws")).toEqual({ ok: false, stato: 429 });
    expect(upgradeRifiutato(429).status).toBe(429);
    expect(await upgradeRifiutato(429).text()).not.toBe(await upgradeRifiutato(503).text());
    // …e il posto si libera quando il primo muore, altrimenti il tetto non
    // sarebbe un tetto ma una scadenza.
    expect(await primo).toEqual({ ok: false, stato: 504 });
    expect(await p.apriWs(req(), "/ws")).toEqual({ ok: false, stato: 504 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UN FILO SENZA CAPO SI CHIUDE, INVECE DI SOMIGLIARE A FUNZIONARE
// ───────────────────────────────────────────────────────────────────────────

describe("ponte-ws · quando il capo sparisce", () => {
  it("la macchina se ne va: i socket si chiudono dicendo perché", async () => {
    const s = scena();
    const a = await s.apri("/i/inst-1/ws");
    const b = await s.apri("/i/inst-1/ws/terminal/t1");
    await s.finche(() => s.giu.vivi() === 2, "due strette di mano");

    await s.chiudiMacchina();
    expect(a.browser!.chiusa).toEqual({ c: WS_PONTE_GIU, r: "installation offline" });
    expect(b.browser!.chiusa).toEqual({ c: WS_PONTE_GIU, r: "installation offline" });
  });

  it("dopo lo sfratto dalla memoria un socket sopravvissuto si chiude, e non consegna niente", async () => {
    // È il difetto che non si vede scrivendo il codice: l'ibernazione può
    // portare via l'istanza fra un messaggio e l'altro, e con lei la
    // numerazione degli stream — che la macchina invece si ricorda, e non
    // riaccetta. Un socket sopravvissuto è un filo che non arriva più da
    // nessuna parte: restare aperti somiglia a funzionare.
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");
    const primaDelloSfratto = s.giu.ricevuti.length;

    s.sfratta();
    await s.dalBrowser(browser!, "questo non deve arrivare");

    expect(browser!.chiusa).toEqual({ c: WS_PONTE_RIPARTITO, r: "relay bridge restarted" });
    await s.finche(() => true, "un giro di pompa");
    expect(s.giu.ricevuti.length).toBe(primaDelloSfratto);
  });

  it("l'istanza nuova spazza via gli orfani prima di ricominciare", async () => {
    // Un socket che riceve e basta — un terminale che scrive da solo — non
    // manda mai niente, quindi non passerebbe mai dal controllo di sopra:
    // resterebbe aperto per sempre davanti a una sessione che non esiste.
    const s = scena({ ascolto: {} });
    const { browser } = await s.apri("/i/inst-1/ws/terminal/t1");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");

    s.sfratta();
    // Basta che l'istanza nuova torni a lavorare: qui una richiesta qualunque.
    await s.chiedi("/i/inst-1/api/x");
    expect(browser!.chiusa).toEqual({ c: WS_PONTE_RIPARTITO, r: "relay bridge restarted" });
  });

  it("dopo lo sfratto i socket NUOVI funzionano", async () => {
    // La contro-prova: spazzare via gli orfani non deve rompere il ricominciare.
    const s = scena();
    await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.vivi() === 1, "la prima stretta di mano");

    s.sfratta();

    const dopo = await s.apri("/i/inst-1/ws/terminal/t9");
    expect(dopo.res.status).toBe(101);
    await s.finche(() => s.giu.aperti.length === 2, "la seconda stretta di mano");
    expect(s.giu.aperti[1]!.percorso).toBe("/ws/terminal/t9");

    s.giu.grida("dopo lo sfratto");
    await s.finche(() => dopo.browser!.ricevuti.length === 1, "il messaggio al socket nuovo");
    expect(dopo.browser!.ricevuti).toEqual(["dopo lo sfratto"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// LA VISITA DI UN BROWSER FINISCE, E FINISCE ANCHE DI LÀ
// ───────────────────────────────────────────────────────────────────────────
/**
 * Una visita non è una richiesta: sono decine di richieste e più socket, tenuti
 * insieme dalla stessa sessione del tubo verso la stessa macchina. Quindi ha
 * anche una FINE, e la fine deve arrivare fino in fondo — nei due versi. Il
 * caso che non si vede scrivendo il codice è quello in cui la fine capita
 * mentre l'istanza è stata sfrattata dalla memoria: lì non c'è più nessun ponte
 * a cui riferirla, e chi non la riceve resta acceso davanti a nessuno.
 */
describe("ponte-ws · la visita finisce, e la fine arriva fino in fondo", () => {
  it("il browser se ne va dopo lo sfratto: di là il socket non resta acceso", async () => {
    // Un terminale aperto da un telefono, il telefono che chiude la scheda, e
    // in mezzo un'istanza sfrattata. La chiusura si dichiara sullo stream di
    // quel filo, e quello stream se n'è andato con l'istanza: senza dire
    // NIENT'ALTRO, di là resta un socket vero — un processo che scrive verso
    // nessuno e che nessuno fermerà più.
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws/terminal/t1");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");

    s.sfratta();
    await s.chiudeIlBrowser(browser!, 1001, "scheda chiusa");

    await s.finche(() => s.giu.vivi() === 0, "la chiusura fino all'ascoltatore");
    expect(s.giu.vivi()).toBe(0);
  });

  it("una visita con DUE socket: se ne va il browser, non ne resta acceso nemmeno uno", async () => {
    // Una visita non è un socket: sono l'applicazione, i terminali, i pannelli
    // browser — tutti sulla stessa sessione del tubo. Il congedo di là li
    // spegne tutti insieme, quindi di qua devono cadere tutti insieme: un
    // socket che RICEVE e basta — un terminale che scrive da solo — non manda
    // mai niente, e il controllo che chiude gli orfani che scrivono non lo
    // toccherà mai. Resterebbe aperto e muto, che è il modo peggiore di
    // guastarsi perché somiglia a funzionare.
    const s = scena();
    const a = await s.apri("/i/inst-1/ws/terminal/t1");
    const b = await s.apri("/i/inst-1/ws/terminal/t2");
    await s.finche(() => s.giu.vivi() === 2, "due strette di mano");

    // Controllo POSITIVO del canale di osservazione: prima dello sfratto tutti
    // e due sono socket veri e aperti, e la loro chiusura si vede da qui.
    s.giu.grida("tutti e due");
    await s.finche(
      () => a.browser!.ricevuti.length === 1 && b.browser!.ricevuti.length === 1,
      "il messaggio a tutti e due",
    );
    expect(a.browser!.chiusa).toBeNull();
    expect(b.browser!.chiusa).toBeNull();

    s.sfratta();
    await s.chiudeIlBrowser(a.browser!, 1001, "scheda chiusa");
    await s.finche(() => s.giu.vivi() === 0, "la chiusura fino all'ascoltatore");

    // Di là il congedo ha spento tutti e due i fili. Di qua il FRATELLO deve
    // saperlo, e con la stessa parola: chi sta davanti riapre invece di
    // guardare qualcosa che non si aggiornerà mai più.
    expect(b.browser!.chiusa).toEqual({ c: WS_PONTE_RIPARTITO, r: "relay bridge restarted" });
  });

  it("il socket NUOVO non muore per la chiusura tardiva di un orfano", async () => {
    // L'istanza nuova nasce da un UPGRADE, senza nessuna richiesta in mezzo: la
    // numerazione degli stream riparte da capo, quindi il socket nuovo prende
    // lo stesso numero che l'orfano si porta addosso nel tag. Se il nome del
    // filo non dice anche DA QUALE ponte viene, una chiusura vecchia arriva a
    // un filo vivo e lo taglia.
    const s = scena();
    const vecchio = await s.apri("/i/inst-1/ws/terminal/t1");
    await s.finche(() => s.giu.aperti.length === 1, "la prima stretta di mano");

    s.sfratta();

    const nuovo = await s.apri("/i/inst-1/ws/terminal/t2");
    expect(nuovo.res.status).toBe(101);
    await s.finche(() => s.giu.aperti.length === 2, "la stretta di mano del socket nuovo");
    await s.finche(() => s.giu.vivi() === 1, "l'orfano spento e il nuovo vivo");

    // …e solo ADESSO il runtime consegna la chiusura dell'orfano.
    await s.chiudeIlBrowser(vecchio.browser!, 1006, "il filo era caduto");
    for (let i = 0; i < 40; i++) await s.unGiro();

    expect(s.giu.vivi()).toBe(1);
    expect(nuovo.browser!.chiusa).toBeNull();

    // Controllo POSITIVO: è ancora un socket vero, e porta nei due versi.
    s.giu.grida("ancora vivo");
    await s.finche(() => nuovo.browser!.ricevuti.length === 1, "il messaggio al socket nuovo");
    expect(nuovo.browser!.ricevuti).toEqual(["ancora vivo"]);
    await s.dalBrowser(nuovo.browser!, "e anche in su");
    await s.finche(() => s.giu.ricevuti.includes("e anche in su"), "il messaggio verso l'alto");
  });

  it("il messaggio tardivo di un orfano non finisce sul socket nuovo", async () => {
    // Il gemello del caso di sopra, dalla parte di chi SCRIVE: se il nome del
    // filo non porta la generazione, un messaggio dell'orfano scende nel tubo
    // sulla corsia del socket nuovo — cioè il terminale di prima che parla
    // dentro il terminale di adesso.
    const s = scena();
    const vecchio = await s.apri("/i/inst-1/ws/terminal/t1");
    await s.finche(() => s.giu.aperti.length === 1, "la prima stretta di mano");

    s.sfratta();
    const nuovo = await s.apri("/i/inst-1/ws/terminal/t2");
    await s.finche(() => s.giu.aperti.length === 2, "la stretta di mano del socket nuovo");
    await s.finche(() => s.giu.vivi() === 1, "l'orfano spento e il nuovo vivo");
    const prima = s.giu.ricevuti.length;

    await s.dalBrowser(vecchio.browser!, "roba di un'altra vita");
    for (let i = 0; i < 40; i++) await s.unGiro();
    expect(s.giu.ricevuti.length).toBe(prima);

    // Controllo POSITIVO: dal socket NUOVO lo stesso giro arriva davvero, e
    // quindi il silenzio di sopra non è il tubo che non porta niente.
    await s.dalBrowser(nuovo.browser!, "questo invece sì");
    await s.finche(() => s.giu.ricevuti.includes("questo invece sì"), "il messaggio del socket nuovo");
  });

  it("…e la visita DOPO riparte pulita", async () => {
    // La contro-prova del congedo: dire alla macchina che la sessione del ponte
    // è finita non deve rendere impossibile ricominciare. Senza questa, il
    // rimedio potrebbe essere «chiudi tutto per sempre» e passerebbe lo stesso.
    const s = scena();
    const primo = await s.apri("/i/inst-1/ws/terminal/t1");
    await s.finche(() => s.giu.vivi() === 1, "la prima stretta di mano");

    s.sfratta();
    await s.chiudeIlBrowser(primo.browser!, 1001, "scheda chiusa");
    await s.finche(() => s.giu.vivi() === 0, "la chiusura fino all'ascoltatore");

    const dopo = await s.apri("/i/inst-1/ws/terminal/t2");
    expect(dopo.res.status).toBe(101);
    await s.finche(() => s.giu.vivi() === 1, "la seconda stretta di mano");
    s.giu.grida("dopo il congedo");
    await s.finche(() => dopo.browser!.ricevuti.length === 1, "il messaggio al socket nuovo");
    expect(dopo.browser!.ricevuti).toEqual(["dopo il congedo"]);
  });

  it("la macchina cade dopo lo sfratto: il browser non resta davanti a un filo morto", async () => {
    // Il verso opposto, e lo stesso buco: quando la macchina se ne va, a
    // chiudere i socket dei browser è il ponte — ma dopo uno sfratto il ponte
    // non c'è, e nessuno li chiude. La scheda resta aperta su qualcosa che non
    // si aggiornerà mai più, che è il modo peggiore di guastarsi perché
    // somiglia a funzionare.
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");

    s.sfratta();
    await s.chiudiMacchina();

    expect(browser!.chiusa).toEqual({ c: WS_PONTE_GIU, r: "installation offline" });
  });

  it("la macchina viene SOSTITUITA dopo lo sfratto: i socket di prima non restano appesi a lei", async () => {
    // Una macchina che si riaggancia — riavvio, rete che torna — sfratta quella
    // di prima, e con lei se ne va la numerazione su cui vivevano questi
    // socket: la macchina nuova ha un proxy pulito, che di loro non sa niente.
    // È lo stesso buco della caduta, per una strada che nessuno chiude: qui il
    // congedo della vecchia non passa nemmeno da `webSocketClose`.
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");

    s.sfratta();
    // La porta della macchina chiede la preimmagine del proprio nome
    // (`shared/relay-identita.ts`), quindi il riaggancio si scrive per intero:
    // il nome derivato dal segreto, e il segreto nell'intestazione. In questa
    // scena `get()` ignora il nome e torna sempre lo stesso oggetto, quindi
    // resta il punto d'incontro di prima — cambia solo come ci si entra.
    const segreto = "segreto-della-macchina-che-si-riaggancia";
    const nuova = await s.apri(`/agent/${await derivaRelayId(segreto)}`, { [INTESTAZIONE_SEGRETO]: segreto });
    expect(nuova.res.status).toBe(101);

    expect(browser!.chiusa).toEqual({ c: WS_PONTE_GIU, r: "installation offline" });
  });

  it("l'upgrade abbandonato non lascia un socket vero acceso di là", async () => {
    // Chi ha bussato se n'è andato prima che la stretta di mano finisse. Senza
    // dirlo, la macchina tiene aperto un socket vero fino alla scadenza —
    // mezzo minuto di processo acceso per nessuno.
    //
    // Anche qui il segnale è costruito nel test e passato a mano: prova la
    // reazione del ponte, non che la rinuncia lo raggiunga dopo il salto
    // `env.SESSIONE.get(id).fetch(req)`. Quel tratto vive o muore su
    // `request_signal_passthrough`, presidiato da `relay-contract.test.ts`.
    const s = scena();

    // Controllo POSITIVO: lo stesso percorso, senza rinuncia, apre davvero.
    await s.apri("/i/inst-1/ws/terminal/t1");
    await s.finche(() => s.giu.vivi() === 1, "la prima stretta di mano");

    const andato = new AbortController();
    andato.abort();
    const { res } = await s.apri("/i/inst-1/ws/terminal/t2", {}, andato.signal);
    expect(res.status).toBe(499);

    // …e di là non se ne accende un secondo: quello vivo è ancora solo il
    // primo, anche dopo aver lasciato scorrere il tubo.
    for (let i = 0; i < 30; i++) await s.unGiro();
    expect(s.giu.vivi()).toBe(1);
    // I VIVI non bastano: contano anche le strette di mano AVVENUTE. Con la
    // sola riga sopra, togliere la guardia in `ponte.ts` lasciava il test
    // verde — perché a quel punto lo smontaggio aveva già chiuso il socket, e
    // «uno vivo» tornava comunque. Ma di là una stretta di mano vera era
    // partita per un browser che se n'era già andato: misurato, `aperti` va a
    // 2. È la differenza fra aver pulito e non aver sporcato.
    expect(s.giu.aperti.length, "nessuna stretta di mano per chi se n'è già andato").toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CHI DECIDE COSA SI VEDE È LA MACCHINA (RELAY-04)
// ───────────────────────────────────────────────────────────────────────────

describe("ponte-ws · il confinamento regge anche da qui", () => {
  it("le intestazioni di chi bussa passano intatte, e il relay non ne inventa nessuna", async () => {
    const s = scena();
    await s.apri("/i/inst-1/ws", { "x-topics-share": "buono", "x-altro": "2" });
    await s.finche(() => s.giu.aperti.length === 1, "la stretta di mano locale");
    const visto = s.giu.aperti[0]!.intestazioni;

    // Ciò che il browser ha scritto arriva com'era: è la macchina a decidere
    // cosa quel socket può vedere, con le stesse regole della rete locale.
    expect(visto["x-topics-share"]).toBe("buono");
    expect(visto["x-altro"]).toBe("2");

    // …e ciò che il relay avrebbe potuto inventarsi non c'è: chi bussa non ha
    // un indirizzo che il relay conosca, e un numero inventato è un numero che
    // qualcuno un giorno legge come vero.
    for (const n of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"]) {
      expect(`${n}→${n in visto}`).toBe(`${n}→false`);
    }
  });

  it("la stretta di mano è quella fra la macchina e l'ascoltatore, non quella del browser", async () => {
    // `sec-websocket-key` appartiene alla connessione fra due capi VICINI, e
    // questa connessione non è quella: farla passare vorrebbe dire mandarne
    // due copie diverse nella stessa richiesta, e quale delle due vince lo
    // decide un parser — cioè nessuno.
    const s = scena();
    await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.aperti.length === 1, "la stretta di mano locale");
    const chiave = s.giu.aperti[0]!.intestazioni["sec-websocket-key"];
    expect(typeof chiave).toBe("string");
    expect(chiave).not.toBe("chiave-del-browser");
  });

  it("un ospite che non porta la capacità non apre niente, e non scrive niente", async () => {
    // La macchina qui decide come decide la vera: apre solo il socket per cui
    // quella richiesta ha una capacità, e solo su ciò che è stato condiviso.
    const s = scena({
      ascolto: {
        accetta: (d) =>
          d.intestazioni["x-topics-share"] === "buono" && d.percorso.startsWith("/ws/browser/condiviso"),
      },
    });

    // Controllo POSITIVO: con la capacità, sulla risorsa condivisa, si apre.
    const dentro = await s.apri("/i/inst-1/ws/browser/condiviso-1", { "x-topics-share": "buono" });
    expect(dentro.res.status).toBe(101);
    await s.finche(() => s.giu.aperti.length === 1, "la stretta di mano buona");

    // Senza capacità non si apre…
    expect((await s.apri("/i/inst-1/ws/browser/condiviso-1")).res.status).toBe(502);
    // …e con la capacità ma su un'altra risorsa nemmeno: la capacità è su UNA
    // cosa, e il ponte non la allarga.
    expect((await s.apri("/i/inst-1/ws/terminal/t1", { "x-topics-share": "buono" })).res.status).toBe(502);
    // Un solo socket aperto in fondo, quello di prima.
    expect(s.giu.aperti).toHaveLength(1);

    // …e ciò che passa sul socket che si è aperto è solo suo: nessun altro
    // filo esiste su cui scrivere.
    await s.dalBrowser(dentro.browser!, "sul mio");
    await s.finche(() => s.giu.ricevuti.length === 1, "il messaggio sul socket buono");
    expect(s.giu.ricevuti).toEqual(["sul mio"]);
  });

  it("una sessione del ponte è UNA: il socket di un'istanza non risponde a un nome inventato", async () => {
    // Il nome del socket sta in un tag, che lo scrive il relay. Se lo si
    // potesse dichiarare da fuori, un capo qualunque potrebbe scrivere sul
    // filo di un altro.
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");

    // Una socket che nessuno ha accettato non ha tag, quindi non è un socket
    // del ponte: quello che ci si scrive sopra non arriva da nessuna parte.
    const intrusa = new MetaSocket();
    await s.dalBrowser(intrusa, "sono un altro");
    await s.finche(() => true, "un giro di pompa");
    expect(s.giu.ricevuti).toEqual([]);

    // Controllo POSITIVO: dal socket vero, invece, passa.
    await s.dalBrowser(browser!, "sono io");
    await s.finche(() => s.giu.ricevuti.length === 1, "il messaggio vero");
    expect(s.giu.ricevuti).toEqual(["sono io"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// IL RESTO DEL PONTE NON SI MUOVE
// ───────────────────────────────────────────────────────────────────────────

describe("ponte-ws · le richieste normali continuano a passare", () => {
  it("un socket aperto e una richiesta HTTP convivono sulla stessa sessione", async () => {
    // Sono la stessa sessione del tubo e la stessa numerazione: se un socket
    // consumasse i numeri delle richieste, la prima richiesta dopo un socket
    // sarebbe un 502 — e lo sarebbero tutte quelle dopo.
    const s = scena();
    const { browser } = await s.apri("/i/inst-1/ws");
    await s.finche(() => s.giu.vivi() === 1, "la stretta di mano locale");

    // L'ascoltatore risponde 426 alle richieste che non sono upgrade: basta
    // che ARRIVI, ed è quello che si sta guardando.
    const r = await s.chiedi("/i/inst-1/api/topics");
    expect(r.status).toBe(426);

    // …e il socket è ancora vivo dopo la richiesta.
    s.giu.grida("ancora qui");
    await s.finche(() => browser!.ricevuti.length === 1, "il messaggio dopo la richiesta");
    expect(browser!.ricevuti).toEqual(["ancora qui"]);
  });

  it("un `guest-left` per la sessione del ponte non esce a ogni socket", async () => {
    // Il congedo serve una volta per istanza: se uscisse a ogni apertura, il
    // secondo socket ucciderebbe il primo — la macchina butta la sessione
    // intera, con dentro tutti i socket.
    const s = scena();
    await s.apri("/i/inst-1/ws");
    await s.apri("/i/inst-1/ws/terminal/t1");
    await s.finche(() => s.giu.vivi() === 2, "due strette di mano");
    expect(s.giu.chiusi).toHaveLength(0);
    expect(SID_PONTE).toBe("ponte");
  });
});
