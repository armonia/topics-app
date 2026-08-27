/**
 * Un WebSocket dell'ospite, rigiocato contro l'ascoltatore del tunnel.
 *
 * ── PERCHÉ QUI C'È UN SERVER VERO ───────────────────────────────────────────
 * Perché la cosa da provare è proprio la STRETTA DI MANO: il percorso che
 * arriva intatto, il biscotto dell'appaiamento che passa, i byte che tornano
 * indietro nei due versi, e la chiusura che porta il suo codice. Un socket
 * finto proverebbe che il proxy chiama una funzione — cioè nient'altro che se
 * stesso. Il server sta su `127.0.0.1` con porta effimera, quindi non tocca né
 * la :3333 di produzione né le porte dei test E2E.
 *
 * ── E PERCHÉ L'OSPITE È QUELLO DI `shared/relay-fake.ts` ────────────────────
 * Perché sia una SECONDA implementazione a leggere ciò che questa scrive: la
 * testa di apertura, il credito, la chiusura. Se il proxy cominciasse a
 * dipendere da un campo che il formato non promette, l'ospite finto
 * smetterebbe di capirlo — che è l'unico modo perché il formato abbia una
 * definizione fuori da chi lo usa.
 * @covers RELAY-E2E-03, RELAY-E2E-05
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { creaProxyTubo, creaRelayClient } from "./relay-client";
import { creaOspiteWs, SEGRETO_FINTO } from "../../shared/relay-fake";
import {
  componiStream, costoMessaggio, creaRiassemblatore, leggiFramePayload, leggiMessaggio,
  scriviFrame, type FrameTubo,
} from "../../shared/relay-protocol";
import {
  GENERE_WS, GENERE_WS_APERTO, GENERE_WS_CHIUSO,
  leggiChiusuraWs, scriviChiusuraWs, scriviTestaWs, type ChiusuraWs,
} from "../../shared/relay-ws";

const SID = "s1";

class SocketFinta {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  consegna: ((d: string) => void) | null = null;
  send(d: string) { this.consegna?.(d); }
  close() { this.readyState = 3; }
}

interface Chiusura { chiudi(): void }
const daChiudere: Chiusura[] = [];
afterEach(() => {
  while (daChiudere.length > 0) daChiudere.pop()?.chiudi();
});

/** `xff`, `host` e `chiave` non servono al proxy: servono a GUARDARE cosa è
 *  arrivato davvero alla stretta di mano locale, cioè quali intestazioni un
 *  ospite che sta fuori dalla rete di casa è riuscito a farsi scrivere
 *  addosso. */
interface DatiSocket {
  percorso: string; cookie: string; xff: string; host: string; chiave: string;
}

/** Lavoro sincrono, misurato in millisecondi: il modo di occupare la macchina
 *  senza cedere il turno a nessuno. Serve a un test solo, e serve a dire una
 *  cosa che con l'attesa non si direbbe — vedi `carico` qui sotto. */
function occupaLaMacchina(ms: number) {
  const fine = Date.now() + ms;
  while (Date.now() < fine) { /* apposta: nessun altro deve poter girare */ }
}

/** L'ascoltatore del tunnel, in piccolo: accetta gli upgrade sotto `/ws` e
 *  rifiuta tutto il resto — come fa il vero quando il percorso non esiste.
 *
 *  `carico` è lavoro SINCRONO dentro l'apertura, e non è un capriccio: è
 *  l'unico modo di separare due istanti che di solito si toccano — «l'upgrade
 *  è stato accolto di sopra» e «il socket di qui è aperto». Nella suite intera
 *  a separarli sono gli altri cinquecento file; qui lo si fa apposta, così la
 *  corsa si può guardare invece di aspettarla. */
function ascoltatore(o: { carico?: number } = {}) {
  const aperti: DatiSocket[] = [];
  const ricevuti: Array<string | Uint8Array> = [];
  const chiusi: Array<{ code: number; reason: string }> = [];
  const vivi = new Set<ServerWebSocket<DatiSocket>>();

  // Il secondo parametro sono i PERCORSI dichiarati (`routes`), che qui non
  // ce ne sono: `never` lo dice, e un oggetto vuoto no.
  const s = Bun.serve<DatiSocket, never>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const u = new URL(req.url);
      if (!u.pathname.startsWith("/ws")) return new Response("non c'è", { status: 404 });
      const dati: DatiSocket = {
        percorso: u.pathname + u.search,
        cookie: req.headers.get("cookie") ?? "",
        xff: req.headers.get("x-forwarded-for") ?? "",
        host: req.headers.get("host") ?? "",
        chiave: req.headers.get("sec-websocket-key") ?? "",
      };
      if (server.upgrade(req, { data: dati })) return undefined;
      return new Response("serve un upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        aperti.push(ws.data); vivi.add(ws);
        if (o.carico !== undefined) occupaLaMacchina(o.carico);
      },
      message(_ws, m) { ricevuti.push(typeof m === "string" ? m : new Uint8Array(m)); },
      close(ws, code, reason) { vivi.delete(ws); chiusi.push({ code, reason }); },
    },
  });
  daChiudere.push({ chiudi: () => { try { s.stop(true); } catch { /* già ferma */ } } });
  return {
    /** `s.port` è opzionale nei tipi di Bun perché un server può stare su un
     *  socket unix; con `port: 0` c'è sempre, e un numero mancante qui non è
     *  un caso da gestire — è un test che non può girare. */
    porta: s.port ?? 0,
    aperti, ricevuti, chiusi,
    /** Parla a tutti i socket vivi: è il terminale che scrive. */
    grida(d: string | Uint8Array) { for (const w of vivi) w.send(d as string); },
    chiudiTutti(code: number, reason: string) { for (const w of [...vivi]) w.close(code, reason); },
    vivi: () => vivi.size,
  };
}

/** La macchina, col suo proxy, agganciata a un relay che è una funzione. */
function macchina(opts: { porta: number | null; credito?: number; arretratoMax?: number }) {
  const sock = new SocketFinta();
  const c = creaRelayClient({
    baseUrl: "http://relay.test",
    relayId: "i1",
    segreto: SEGRETO_FINTO,
    trovaLink: () => null,
    serviRisorsa: async () => ({ status: 200, body: {} }),
    segnaApertura: () => {},
    apriSocket: () => sock as unknown as WebSocket,
    portaTunnel: opts.porta,
    ...(opts.credito !== undefined ? { credito: opts.credito } : {}),
    ...(opts.arretratoMax !== undefined ? { arretratoMax: opts.arretratoMax } : {}),
  });
  daChiudere.push({ chiudi: () => c.ferma() });
  c.avvia();
  sock.onopen?.();
  // The relay CONFIRMS it took us in: without this the client keeps a thread
  // that nobody owns, and after ten seconds it closes it on purpose. The real
  // meeting point sends `ready` the instant it attaches, so simulating the
  // open without it was half a handshake.
  sock.onmessage?.({ data: JSON.stringify({ t: "ready", v: 1 }) });
  return { c, sock };
}

/** L'ospite finto attaccato alla macchina: due funzioni, nessuna rete. */
function guestOn(m: ReturnType<typeof macchina>, o: { credito?: number } = {}) {
  const ospite = creaOspiteWs({
    invia: (p) => m.sock.onmessage?.({ data: JSON.stringify({ t: "to-guest", to: SID, payload: p }) }),
    ...(o.credito !== undefined ? { credito: o.credito } : {}),
  });
  m.sock.consegna = (d) => {
    const msg = leggiMessaggio(JSON.parse(d));
    if (msg && msg.t === "to-guest") ospite.ricevi(msg.payload);
  };
  return ospite;
}

/** Il proxy NUDO, senza il client del relay attorno. Serve dove la cosa da
 *  guardare è un'opzione che `creaRelayClient` non gira — il tetto dei socket —
 *  e dove i frame che escono si vogliono leggere uno per uno. */
function bareProxy(opts: { porta: number; maxSocket?: number }) {
  const arrivati: FrameTubo[] = [];
  const p = creaProxyTubo({
    portaTunnel: opts.porta,
    ...(opts.maxSocket !== undefined ? { maxSocket: opts.maxSocket } : {}),
    invia: (_sid, payload) => {
      const fr = leggiFramePayload(payload);
      if (fr) arrivati.push(fr);
    },
  });
  daChiudere.push({ chiudi: () => p.chiudiTutto() });
  const apri = (s: number, percorso = "/ws") => p.riceviFrame(SID, {
    f: "open", s, n: 0, k: GENERE_WS, h: scriviTestaWs({ p: percorso }), c: true,
  });
  return { p, arrivati, apri };
}

/**
 * La chiusura DICHIARATA dalla macchina, letta davvero.
 *
 * Non basta guardare che uno stream `wsc` esista: il codice è tutta la
 * differenza fra «riprova più tardi» e «è rotto», e un frame che c'è non dice
 * quale dei due. Si rimette insieme con un riassemblatore vero — cioè con la
 * stessa strada che percorre un ospite — invece di sbirciare dentro il primo
 * frame, che sarebbe una seconda regola per leggere lo stesso formato.
 */
function chiusuraDichiarata(frames: FrameTubo[]): ChiusuraWs | null {
  const rias = creaRiassemblatore({ latoRemoto: "host" });
  for (const f of frames) {
    const e = rias.ricevi(f);
    if (e.esito === "completo" && e.k === GENERE_WS_CHIUSO) return leggiChiusuraWs(e.dati);
  }
  return null;
}

async function fino(cond: () => boolean, quanto = 2000): Promise<boolean> {
  const fine = Date.now() + quanto;
  while (Date.now() < fine) {
    if (cond()) return true;
    await Bun.sleep(5);
  }
  return cond();
}

describe("il ciclo di vita di un WebSocket dentro il tubo", () => {
  it("si apre, parla nei due versi e si chiude col suo codice", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = guestOn(m);

    const messaggi: Array<string | Uint8Array> = [];
    let aperto = false;
    const chiusure: Array<{ c: number; r: string }> = [];
    const sk = ospite.apri("/ws/terminal/t1?modo=vivo", {
      // Le ultime tre l'ospite se le è scritte da sé: sono la parte che NON
      // deve arrivare in fondo.
      h: [
        ["Cookie", "topics_session=abc"],
        ["X-Forwarded-For", "9.9.9.9"],
        ["Host", "bugiardo.example"],
        ["Sec-WebSocket-Key", "chiave-inventata-dall-ospite"],
      ],
      suAperto: () => { aperto = true; },
      suMessaggio: (d) => { messaggi.push(d); },
      suChiuso: (c, r) => { chiusure.push({ c, r }); },
    });

    expect(await fino(() => aperto)).toBe(true);
    expect(sk.stato()).toBe("aperto");
    // Il percorso arriva intatto — query compresa — e il biscotto
    // dell'appaiamento con lui: senza, tutto questo finisce su un login.
    expect(up.aperti[0]?.percorso).toBe("/ws/terminal/t1?modo=vivo");
    expect(up.aperti[0]?.cookie).toBe("topics_session=abc");
    // …e sul percorso VERO, non solo dentro il filtro provato a parte:
    // l'indirizzo se lo sceglie chi apre il socket, non chi bussa da fuori —
    // altrimenti il tetto di tre tentativi sull'appaiamento non esiste più,
    // perché basta un `x-forwarded-for` nuovo per avere un secchio nuovo.
    expect(up.aperti[0]?.xff).not.toBe("9.9.9.9");
    // `host` è l'altra metà della stessa famiglia: chi bussa da fuori non
    // sceglie quale macchina crede di stare chiamando.
    expect(up.aperti[0]?.host).not.toBe("bugiardo.example");
    // La chiave della stretta di mano è quella generata QUI: 16 byte in
    // base64. È anche il controllo positivo — se l'ascoltatore non stesse
    // guardando davvero le intestazioni questa sarebbe vuota, e la forma
    // rifiuterebbe comunque la stringa che l'ospite si è scritto da sé.
    //
    // Misurato: il client WebSocket di Bun rigenera i `sec-websocket-*` a
    // prescindere, quindi su questo percorso una riga «non è quella
    // dell'ospite» non potrebbe fallire; il filtro di quel prefisso resta
    // fissato dal suo test in `shared/relay-ws.test.ts`.
    expect(up.aperti[0]?.chiave).toMatch(/^[A-Za-z0-9+/]{22}==$/);

    sk.manda("ls -la\n");
    expect(await fino(() => up.ricevuti.length === 1)).toBe(true);
    expect(up.ricevuti[0]).toBe("ls -la\n");

    up.grida("total 0\r\n");
    expect(await fino(() => messaggi.length === 1)).toBe(true);
    expect(messaggi[0]).toBe("total 0\r\n");

    sk.chiudi(4001, "basta");
    expect(await fino(() => up.chiusi.length === 1)).toBe(true);
    // Il CODICE arriva davvero al socket vero: è la differenza fra chiudere e
    // far cadere il filo. Il motivo no, e non per una scelta di qui: il client
    // WebSocket di Bun non lo mette sul filo (provato: il server vede il
    // codice e una stringa vuota). Viaggia comunque dentro il tubo, e nel
    // verso opposto — dove è la macchina a chiudere — arriva intero.
    expect(up.chiusi[0]?.code).toBe(4001);
    expect(sk.stato()).toBe("chiuso");
    expect(chiusure[0]).toEqual({ c: 4001, r: "basta" });
    expect(m.c.__socket(SID)).toBe(0);
  });

  it("quando è la macchina a chiudere, codice e motivo arrivano interi", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = guestOn(m);
    let aperto = false;
    const chiusure: Array<{ c: number; r: string }> = [];
    const sk = ospite.apri("/ws", {
      suAperto: () => { aperto = true; },
      suChiuso: (c, r) => { chiusure.push({ c, r }); },
    });
    expect(await fino(() => aperto)).toBe(true);

    up.chiudiTutti(4002, "riavvio");
    expect(await fino(() => sk.stato() === "chiuso")).toBe(true);
    // Un `reset` del tubo avrebbe solo la parola «aborted»: chi si riconnette
    // non saprebbe se deve.
    expect(chiusure[0]).toEqual({ c: 4002, r: "riavvio" });
  });

  it("porta i byte, non solo il testo", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = guestOn(m);
    const giu: Array<string | Uint8Array> = [];
    let aperto = false;
    const sk = ospite.apri("/ws/browser/b1", {
      suAperto: () => { aperto = true; },
      suMessaggio: (d) => { giu.push(d); },
    });
    expect(await fino(() => aperto)).toBe(true);

    sk.manda(new Uint8Array([0, 1, 255, 128]));
    expect(await fino(() => up.ricevuti.length === 1)).toBe(true);
    expect([...(up.ricevuti[0] as Uint8Array)]).toEqual([0, 1, 255, 128]);

    up.grida(new Uint8Array([9, 8, 7]));
    expect(await fino(() => giu.length === 1)).toBe(true);
    expect([...(giu[0] as Uint8Array)]).toEqual([9, 8, 7]);
  });

  it("quattro socket insieme hanno ognuno vita sua", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = guestOn(m);

    const arrivati: string[][] = [[], [], [], []];
    const percorsi = ["/ws", "/ws/terminal/t1", "/ws/terminal/t2", "/ws/browser/b1"];
    const sk = percorsi.map((p, i) => ospite.apri(p, {
      suMessaggio: (d) => { arrivati[i]!.push(String(d)); },
    }));

    expect(await fino(() => up.aperti.length === 4)).toBe(true);
    expect(up.aperti.map((a) => a.percorso).sort()).toEqual([...percorsi].sort());
    expect(m.c.__socket(SID)).toBe(4);
    // …e l'apertura è arrivata fino all'OSPITE, non solo fino all'ascoltatore:
    // sono due viaggi diversi, e guardare solo il primo lascia il secondo a
    // metà. Senza questa attesa il controllo di sotto — «gli altri non hanno
    // sentito niente» — legge «apertura» invece di «aperto» quando il frame di
    // ritorno è ancora per strada, e diventa un rosso che parla d'altro.
    expect(await fino(() => sk.every((x) => x.stato() === "aperto"))).toBe(true);

    sk[1]!.chiudi();
    expect(await fino(() => up.vivi() === 3)).toBe(true);
    expect(sk[1]!.stato()).toBe("chiuso");
    // Gli altri tre non hanno sentito niente: è il motivo per cui il tubo
    // esiste.
    expect(sk[0]!.stato()).toBe("aperto");
    up.grida("ancora vivo");
    expect(await fino(() => arrivati[0]!.length === 1 && arrivati[3]!.length === 1)).toBe(true);
    expect(arrivati[1]).toEqual([]);
  });

  it("un messaggio mandato prima della stretta di mano non si perde", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = guestOn(m);
    const sk = ospite.apri("/ws/terminal/t1", {});
    // Nessuna attesa: si scrive mentre il socket vero sta ancora nascendo.
    sk.manda("subito");
    expect(await fino(() => up.ricevuti.length === 1)).toBe(true);
    expect(up.ricevuti[0]).toBe("subito");
  });

  /**
   * Un socket chiuso deve RESTITUIRE il suo canale, non consumarlo.
   *
   * I canali hanno un tetto (`maxStream`, 64), ed è giusto che ce l'abbiano. Ma
   * un tetto che si consuma non è un tetto: è una scadenza. Aprire e chiudere
   * è il gesto più normale che ci sia — un terminale per pannello, un pannello
   * che si apre e si richiude — e dopo un pomeriggio di lavoro il sessantacin-
   * quesimo socket non si aprirebbe più. Non con un errore: resterebbe in
   * «apertura» per sempre, perché il rifiuto arriva su uno stream che nessuno
   * sta più aspettando. È il modo peggiore di rompersi.
   */
  it("aprire e chiudere non consuma i canali: dopo il tetto se ne apre ancora uno", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = guestOn(m);

    // Oltre il `maxStream` di serie del riassemblatore, che è 64.
    const GIRI = 70;
    let openReally = 0;
    for (let i = 0; i < GIRI; i++) {
      let aperto = false;
      const sk = ospite.apri("/ws", { suAperto: () => { aperto = true; } });
      if (!(await fino(() => aperto))) break;
      openReally += 1;
      sk.chiudi();
      if (!(await fino(() => up.vivi() === 0))) break;
    }

    // Il conto è la misura: senza la restituzione si ferma a 64.
    expect(openReally).toBe(GIRI);
    // …e il controllo positivo che l'ascoltatore stava davvero guardando: ogni
    // giro è stata una stretta di mano vera, non un richiamo chiamato a vuoto.
    expect(up.aperti.length).toBe(GIRI);
    expect(m.c.__socket(SID)).toBe(0);
  }, 30_000);

  /**
   * L'altra metà della stessa cosa, guardata dal lato della MACCHINA.
   *
   * Il giro sopra si accontenterebbe che a pulire sia l'ospite: due capi, e
   * basta che uno dei due si ricordi. Ma l'ospite finto è UNA implementazione,
   * e quella vera — un browser, domani — ha solo ciò che il formato promette.
   * Il canale è della macchina, e restituirlo è suo dovere: il `reset` è
   * l'unica frase che dice «dimentica questo stream».
   */
  it("quando è l'ospite a chiudere, la macchina restituisce comunque il PROPRIO canale", async () => {
    const up = ascoltatore();
    const t = bareProxy({ porta: up.porta });
    t.apri(1);
    // Si aspetta il CANALE, non l'ascoltatore: che l'upgrade sia stato accolto
    // di sopra e che la macchina abbia aperto la sua corsia sono due eventi
    // diversi, e il secondo arriva dopo. Fermarsi al primo legge un canale che
    // sta ancora nascendo, e il rosso parla d'altro.
    expect(await fino(() =>
      t.arrivati.some((f) => f.f === "open" && f.k === GENERE_WS_APERTO))).toBe(true);

    // Controllo positivo: il canale della macchina è nato davvero, e ha un
    // numero — è quello che va restituito.
    const apertura = t.arrivati.find((f) => f.f === "open" && f.k === GENERE_WS_APERTO);
    expect(apertura).toBeDefined();
    const sOut = apertura!.s;

    t.arrivati.length = 0;
    for (const fr of componiStream({
      s: 3, k: GENERE_WS_CHIUSO, h: scriviTestaWs({ w: 1 }),
      dati: scriviChiusuraWs({ c: 1000, r: "finito" }),
    })) t.p.riceviFrame(SID, fr);
    expect(await fino(() => up.vivi() === 0)).toBe(true);

    expect(t.arrivati).toContainEqual({ f: "reset", s: sOut, motivo: "aborted" });
    // …e NIENTE sulla corsia dell'ospite: quella l'ha chiusa lui, e rispondergli
    // con una seconda chiusura coprirebbe il codice che ha appena dichiarato.
    expect(t.arrivati.some((f) => f.s === 1)).toBe(false);
  });

  it("l'ospite che se ne va porta con sé il socket vero", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = guestOn(m);
    ospite.apri("/ws/terminal/t1", {});
    expect(await fino(() => up.vivi() === 1)).toBe(true);

    m.sock.onmessage?.({ data: JSON.stringify({ t: "guest-left", sessionId: SID }) });
    // Un terminale che continua a scrivere verso nessuno è un processo che
    // nessuno ferma più.
    expect(await fino(() => up.vivi() === 0)).toBe(true);
    expect(m.c.__socket(SID)).toBe(0);
  });
});

describe("l'apertura che non riesce lo dice, invece di lasciare aspettare", () => {
  it("senza la porta del tunnel: 503, e nessun socket", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: null });
    const ospite = guestOn(m);
    let stato: number | undefined;
    const sk = ospite.apri("/ws", { suChiuso: (_c, _r, s) => { stato = s; } });
    expect(await fino(() => sk.stato() === "chiuso")).toBe(true);
    expect(stato).toBe(503);
    expect(up.aperti.length).toBe(0);
  });

  it("un percorso che sceglie un'altra destinazione: 400, e non si prova nemmeno", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = guestOn(m);
    let stato: number | undefined;
    const sk = ospite.apri("//altra-macchina/ws", { suChiuso: (_c, _r, s) => { stato = s; } });
    expect(await fino(() => sk.stato() === "chiuso")).toBe(true);
    expect(stato).toBe(400);
    expect(up.aperti.length).toBe(0);

    // Il controllo positivo: lo stesso ospite, con un percorso onesto, entra.
    let aperto = false;
    ospite.apri("/ws", { suAperto: () => { aperto = true; } });
    expect(await fino(() => aperto)).toBe(true);
  });

  it("una stretta di mano rifiutata dall'ascoltatore: 502", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = guestOn(m);
    let stato: number | undefined;
    // `/altro` non è sotto `/ws`: l'ascoltatore risponde 404 e l'upgrade non
    // avviene.
    const sk = ospite.apri("/altro", { suChiuso: (_c, _r, s) => { stato = s; } });
    expect(await fino(() => sk.stato() === "chiuso")).toBe(true);
    expect(stato).toBe(502);
  });

  /**
   * Il tetto dei socket per sessione.
   *
   * Un socket aperto è un socket VERO contro l'ascoltatore del tunnel, e chi
   * sta fuori rete può aprirne senza mai parlarci: senza un tetto, tenere
   * occupata la macchina di qualcun altro non costa niente. È l'unico limite
   * che c'è su quel numero, quindi va fissato qui — o si può cancellare senza
   * che niente diventi rosso.
   */
  it("una sessione non può tenere più socket del suo tetto", async () => {
    const up = ascoltatore();
    const t = bareProxy({ porta: up.porta, maxSocket: 3 });

    // Gli stream dell'ospite sono i dispari: la parità è il capo che li apre.
    for (let i = 0; i < 3; i++) t.apri(1 + i * 2);
    // Controllo positivo: i primi tre arrivano fino all'ascoltatore davvero.
    expect(await fino(() => up.aperti.length === 3)).toBe(true);
    expect(t.p.__socket(SID)).toBe(3);

    t.arrivati.length = 0;
    t.apri(7);
    // Il rifiuto è dichiarato sullo stream che ha chiesto, non silenzioso.
    expect(t.arrivati).toEqual([{ f: "reset", s: 7, motivo: "too-many-streams" }]);
    // …e nessun socket in più è nato: il tetto sta davanti alla stretta di
    // mano, non dopo.
    await Bun.sleep(80);
    expect(up.aperti.length).toBe(3);
    expect(t.p.__socket(SID)).toBe(3);
  });

  it("una testa illeggibile uccide QUEL canale e lascia in piedi la sessione", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const rimandati: FrameTubo[] = [];
    m.sock.consegna = (d) => {
      const msg = leggiMessaggio(JSON.parse(d));
      if (!msg || msg.t !== "to-guest") return;
      const fr = leggiFramePayload(msg.payload);
      if (fr) rimandati.push(fr);
    };
    const dammi = (p: string) => m.sock.onmessage?.({ data: JSON.stringify({ t: "to-guest", to: SID, payload: p }) });

    dammi(scriviFrame({ f: "open", s: 1, n: 0, k: GENERE_WS, h: "non json", c: true }));
    expect(rimandati).toEqual([{ f: "reset", s: 1, motivo: "bad-frame" }]);

    // La sessione è ancora buona: un canale onesto dopo quello storto entra.
    rimandati.length = 0;
    dammi(scriviFrame({ f: "open", s: 3, n: 0, k: GENERE_WS, h: scriviTestaWs({ p: "/ws" }), c: true }));
    expect(await fino(() => up.aperti.length === 1)).toBe(true);
  });
});

describe("il credito: chi produce troppo in fretta si deve poter fermare", () => {
  /** Un ospite CRUDO che non restituisce mai credito — è il telefono lento. */
  function silentGuest(m: ReturnType<typeof macchina>) {
    const arrivati: FrameTubo[] = [];
    m.sock.consegna = (d) => {
      const msg = leggiMessaggio(JSON.parse(d));
      if (!msg || msg.t !== "to-guest") return;
      const fr = leggiFramePayload(msg.payload);
      if (fr) arrivati.push(fr);
    };
    const manda = (fr: FrameTubo) =>
      m.sock.onmessage?.({ data: JSON.stringify({ t: "to-guest", to: SID, payload: scriviFrame(fr) }) });
    return {
      arrivati, manda,
      dati: () => arrivati.filter((f) => f.f === "data"),
    };
  }

  it("finita la finestra il canale si ferma, e riparte solo col credito", async () => {
    const up = ascoltatore();
    // Una finestra da due messaggi da cinque byte: abbastanza per vedere il
    // «fermati» senza mezzo MiB di terminale.
    const m = macchina({ porta: up.porta, credito: costoMessaggio(5) * 2 });
    const o = silentGuest(m);

    o.manda({ f: "open", s: 1, n: 0, k: GENERE_WS, h: scriviTestaWs({ p: "/ws/terminal/t1" }), c: true });
    expect(await fino(() => up.vivi() === 1)).toBe(true);

    // Controllo positivo: i primi due passano davvero.
    up.grida("aaaaa");
    up.grida("bbbbb");
    expect(await fino(() => o.dati().length === 2)).toBe(true);

    // …e il terzo no. Senza le due righe di sopra questa asserzione non
    // potrebbe fallire: un canale rotto la soddisferebbe uguale.
    up.grida("ccccc");
    await Bun.sleep(80);
    expect(o.dati().length).toBe(2);

    // Il credito viene dall'ALTRO CAPO, non dal relay: è l'unico posto in cui
    // si sa cosa è stato davvero consumato.
    o.manda({ f: "credit", s: 0, c: costoMessaggio(5) * 2 });
    expect(await fino(() => o.dati().length === 3)).toBe(true);
    expect(o.dati().map((f) => (f.f === "data" ? f.d : ""))).toEqual(["aaaaa", "bbbbb", "ccccc"]);
  });

  it("un ospite che non consuma MAI si fa chiudere, invece di far crescere la memoria", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta, credito: 1, arretratoMax: 32 });
    const o = silentGuest(m);

    o.manda({ f: "open", s: 1, n: 0, k: GENERE_WS, h: scriviTestaWs({ p: "/ws/terminal/t1" }), c: true });
    expect(await fino(() => up.vivi() === 1)).toBe(true);

    for (let i = 0; i < 20; i++) up.grida("0123456789");
    // Il socket vero muore: un guasto dichiarato è meglio di una coda che
    // cresce finché qualcosa si rompe altrove.
    expect(await fino(() => up.vivi() === 0)).toBe(true);
    expect(m.c.__socket(SID)).toBe(0);
    // …e all'ospite arriva la chiusura, con il codice che dice «riprova».
    // `1013` e non `1011`: non è un guasto della macchina, è una rete che non
    // ce la fa. Chi lo riceve deve poter decidere di riconnettersi, e «errore
    // interno» lo manderebbe a cercare un guasto che non c'è. Che il frame
    // esista non basta a dirlo: va letto.
    const c = chiusuraDichiarata(o.arrivati);
    expect(c).not.toBeNull();
    expect(c?.c).toBe(1013);
    expect(c?.r).toBe("backpressure");
  });

  it("il credito torna solo DOPO la consegna, non all'arrivo", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = guestOn(m, { credito: costoMessaggio(4) });
    const sk = ospite.apri("/ws", {});

    // Si scrive mentre la stretta di mano è ancora in corso: il messaggio
    // arriva alla macchina ma non a NESSUNO, e finché è così il credito non
    // torna. È lo stesso meccanismo del verso opposto, guardato da qui.
    expect(sk.credito()).toBe(costoMessaggio(4));
    sk.manda("uno.");
    expect(sk.credito()).toBe(0);

    // …e torna quando il socket vero lo ha davvero ricevuto.
    expect(await fino(() => sk.credito() > 0)).toBe(true);
    // Si aspetta il PROPRIO soggetto prima di leggerlo. Il credito torna
    // appena la macchina ha chiamato `send()`, non quando i byte sono
    // arrivati di sopra: fra le due cose c'è un salto, e leggere `ricevuti`
    // dopo aver atteso il CREDITO è una corsa che sotto carico si perde.
    expect(await fino(() => up.ricevuti.length === 1)).toBe(true);
    expect(up.ricevuti[0]).toBe("uno.");
  });
});

describe("proxy ws · le due righe che nessun test reggeva", () => {
  /**
   * Trovate da una revisione avversariale il 2026-08-09, con il metodo che
   * conta: CANCELLARE la riga e guardare se la suite se ne accorge. Non se ne
   * accorgeva — 124 test verdi in entrambi i casi. Una riga portante senza
   * nessuno che la regga è una riga che il prossimo refactoring toglie.
   */

  it("un ospite che chiude SENZA reset non consuma il tetto degli stream", async () => {
    // `chiudiSocket` fa `sess.rias.dimentica(sk.sIn)`. Senza quella riga il
    // canale in ENTRATA resta nel riassemblatore per sempre quando l'ospite
    // chiude col solo `wsc` e non manda il proprio `reset` — cioè quando
    // l'ospite non collabora. E l'ospite sta fuori dalla rete di casa: è
    // esattamente la metà che deve reggere a chi non collabora.
    //
    // Il sintomo non è un errore: è che dopo 64 giri di apri-e-chiudi ogni
    // socket nuovo viene rifiutato con `too-many-streams`. Un tetto che si
    // CONSUMA è una scadenza travestita da limite.
    const up = ascoltatore();
    const t = bareProxy({ porta: up.porta, maxSocket: 64 });

    for (let i = 0; i < 64; i++) {
      const sIn = 1 + i * 4;
      t.apri(sIn);
      expect(await fino(() => up.aperti.length === i + 1)).toBe(true);
      // Solo il `wsc`: nessun `reset` dell'ospite, che è il caso scortese.
      for (const fr of componiStream({
        s: sIn + 2, k: GENERE_WS_CHIUSO,
        h: scriviTestaWs({ w: sIn }),
        dati: scriviChiusuraWs({ c: 1000, r: "" }),
      })) t.p.riceviFrame(SID, fr);
      expect(await fino(() => up.vivi() === 0)).toBe(true);
    }

    // Il controllo positivo: 64 giri sono davvero avvenuti. Senza, questo test
    // passerebbe anche se il ciclo non avesse aperto niente.
    expect(up.aperti.length).toBe(64);

    const primaDelSessantacinquesimo = t.arrivati.length;
    t.apri(1 + 64 * 4);
    expect(await fino(() => up.aperti.length === 65)).toBe(true);
    const rifiuti = t.arrivati.slice(primaDelSessantacinquesimo)
      .filter((f) => f.f === "reset" && f.motivo === "too-many-streams");
    expect(rifiuti, "il tetto si è consumato: gli stream chiusi non sono stati dimenticati").toEqual([]);
  });

  it("un codice di chiusura NON inviabile diventa 1000 sul percorso vero", async () => {
    // `codiceInviabile` ha un test suo (`shared/relay-ws.test.ts`), ma niente
    // ne reggeva l'USO qui: sostituire la guardia con `c: c.c` lasciava tutto
    // verde. È la stessa forma del difetto già trovato per
    // `intestazioniUpgrade` — un filtro provato a parte e mai sul percorso
    // vero, che è come non averlo.
    //
    // 1006 significa «la connessione è caduta», e per protocollo NON si può
    // mandare: passarlo pari pari a `close()` è un errore che uccide il
    // socket vero invece di chiuderlo.
    const up = ascoltatore();
    const t = bareProxy({ porta: up.porta });
    t.apri(1);
    // Si aspetta il CANALE della macchina, non l'ascoltatore. È la stessa
    // ragione scritta più su, e qui era la riga che rendeva il test un dado:
    // che l'upgrade sia stato accolto di sopra NON vuol dire che il socket di
    // qui sia aperto, e su un socket ancora in apertura un codice non ci va.
    // Fermandosi al primo dei due eventi questo test misurava il percorso «il
    // socket è aperto» o quello «si sta ancora aprendo» a seconda di quanto era
    // occupata la macchina — cioè, dentro la suite intera, a caso. Il secondo
    // percorso ha un test suo, qui sotto.
    expect(await fino(() =>
      t.arrivati.some((f) => f.f === "open" && f.k === GENERE_WS_APERTO))).toBe(true);

    for (const fr of componiStream({
      s: 3, k: GENERE_WS_CHIUSO,
      h: scriviTestaWs({ w: 1 }),
      dati: scriviChiusuraWs({ c: 1006, r: "caduta" }),
    })) t.p.riceviFrame(SID, fr);

    // Il socket di sopra si chiude — e si chiude BENE, non con un errore.
    expect(await fino(() => up.vivi() === 0)).toBe(true);
    expect(await fino(() => up.chiusi.length === 1)).toBe(true);
    expect(up.chiusi[0]!.code, "1006 non è inviabile: va tradotto in 1000").toBe(1000);
  });

  /**
   * L'altra metà: l'ospite chiude MENTRE la stretta di mano non è finita.
   *
   * Non è un caso di scuola, è il caso che ha reso instabile il test qui sopra
   * per tre giorni: fra l'`open` di chi ascolta e l'`onopen` di qui può passare
   * lavoro altrui, e un ospite che chiude nel mezzo trova un socket a metà.
   * `close(1000)` su un socket in apertura non manda nessun codice — per
   * protocollo fa CADERE la connessione — e chi ascolta legge 1006: esattamente
   * il codice che la guardia esiste per non far passare. Il difetto era doppio,
   * e il secondo stava nel codice vero.
   */
  it("l'ospite chiude mentre il socket vero sta ancora nascendo: il codice arriva lo stesso", async () => {
    // 30ms di lavoro sincrono dentro l'apertura di sopra: di qui non può essere
    // ancora arrivato niente, quindi la corsa è armata per costruzione e non
    // per fortuna.
    const up = ascoltatore({ carico: 30 });
    const t = bareProxy({ porta: up.porta });
    t.apri(1);
    expect(await fino(() => up.aperti.length === 1)).toBe(true);
    // La precondizione, dichiarata: l'upgrade è accolto di sopra e il canale
    // della macchina NON è ancora nato — cioè il socket vero è ancora in
    // apertura. Senza questa riga il test resterebbe verde anche il giorno in
    // cui smettesse di provare quello che dice di provare.
    expect(
      t.arrivati.some((f) => f.f === "open" && f.k === GENERE_WS_APERTO),
      "la corsa non è armata: il socket vero è già aperto",
    ).toBe(false);

    for (const fr of componiStream({
      s: 3, k: GENERE_WS_CHIUSO,
      h: scriviTestaWs({ w: 1 }),
      dati: scriviChiusuraWs({ c: 1006, r: "caduta" }),
    })) t.p.riceviFrame(SID, fr);

    expect(await fino(() => up.chiusi.length === 1)).toBe(true);
    expect(
      up.chiusi[0]!.code,
      "chiuso prima di aprirsi: il codice si dice all'apertura, non si perde",
    ).toBe(1000);
    expect(await fino(() => up.vivi() === 0)).toBe(true);
    // E il socket non resta appeso: la sessione non ne tiene più nessuno.
    expect(t.p.__socket(SID)).toBe(0);
  });
});
