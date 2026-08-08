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
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { creaRelayClient } from "./relay-client";
import { creaOspiteWs } from "../../shared/relay-fake";
import {
  costoMessaggio, leggiFramePayload, leggiMessaggio, scriviFrame, type FrameTubo,
} from "../../shared/relay-protocol";
import { GENERE_WS, scriviTestaWs } from "../../shared/relay-ws";

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

interface DatiSocket { percorso: string; cookie: string }

/** L'ascoltatore del tunnel, in piccolo: accetta gli upgrade sotto `/ws` e
 *  rifiuta tutto il resto — come fa il vero quando il percorso non esiste. */
function ascoltatore() {
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
      };
      if (server.upgrade(req, { data: dati })) return undefined;
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
    installationId: "i1",
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
  return { c, sock };
}

/** L'ospite finto attaccato alla macchina: due funzioni, nessuna rete. */
function ospiteSu(m: ReturnType<typeof macchina>, o: { credito?: number } = {}) {
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
    const ospite = ospiteSu(m);

    const messaggi: Array<string | Uint8Array> = [];
    let aperto = false;
    const chiusure: Array<{ c: number; r: string }> = [];
    const sk = ospite.apri("/ws/terminal/t1?modo=vivo", {
      h: [["Cookie", "topics_session=abc"]],
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
    const ospite = ospiteSu(m);
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
    const ospite = ospiteSu(m);
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
    const ospite = ospiteSu(m);

    const arrivati: string[][] = [[], [], [], []];
    const percorsi = ["/ws", "/ws/terminal/t1", "/ws/terminal/t2", "/ws/browser/b1"];
    const sk = percorsi.map((p, i) => ospite.apri(p, {
      suMessaggio: (d) => { arrivati[i]!.push(String(d)); },
    }));

    expect(await fino(() => up.aperti.length === 4)).toBe(true);
    expect(up.aperti.map((a) => a.percorso).sort()).toEqual([...percorsi].sort());
    expect(m.c.__socket(SID)).toBe(4);

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
    const ospite = ospiteSu(m);
    const sk = ospite.apri("/ws/terminal/t1", {});
    // Nessuna attesa: si scrive mentre il socket vero sta ancora nascendo.
    sk.manda("subito");
    expect(await fino(() => up.ricevuti.length === 1)).toBe(true);
    expect(up.ricevuti[0]).toBe("subito");
  });

  it("l'ospite che se ne va porta con sé il socket vero", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = ospiteSu(m);
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
    const ospite = ospiteSu(m);
    let stato: number | undefined;
    const sk = ospite.apri("/ws", { suChiuso: (_c, _r, s) => { stato = s; } });
    expect(await fino(() => sk.stato() === "chiuso")).toBe(true);
    expect(stato).toBe(503);
    expect(up.aperti.length).toBe(0);
  });

  it("un percorso che sceglie un'altra destinazione: 400, e non si prova nemmeno", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = ospiteSu(m);
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
    const ospite = ospiteSu(m);
    let stato: number | undefined;
    // `/altro` non è sotto `/ws`: l'ascoltatore risponde 404 e l'upgrade non
    // avviene.
    const sk = ospite.apri("/altro", { suChiuso: (_c, _r, s) => { stato = s; } });
    expect(await fino(() => sk.stato() === "chiuso")).toBe(true);
    expect(stato).toBe(502);
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
  function ospiteSordo(m: ReturnType<typeof macchina>) {
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
    const o = ospiteSordo(m);

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
    const o = ospiteSordo(m);

    o.manda({ f: "open", s: 1, n: 0, k: GENERE_WS, h: scriviTestaWs({ p: "/ws/terminal/t1" }), c: true });
    expect(await fino(() => up.vivi() === 1)).toBe(true);

    for (let i = 0; i < 20; i++) up.grida("0123456789");
    // Il socket vero muore: un guasto dichiarato è meglio di una coda che
    // cresce finché qualcosa si rompe altrove.
    expect(await fino(() => up.vivi() === 0)).toBe(true);
    expect(m.c.__socket(SID)).toBe(0);
    // …e all'ospite arriva la chiusura, con il codice che dice «riprova».
    expect(o.arrivati.some((f) => f.f === "open" && f.k === "wsc")).toBe(true);
  });

  it("il credito torna solo DOPO la consegna, non all'arrivo", async () => {
    const up = ascoltatore();
    const m = macchina({ porta: up.porta });
    const ospite = ospiteSu(m, { credito: costoMessaggio(4) });
    const sk = ospite.apri("/ws", {});

    // Si scrive mentre la stretta di mano è ancora in corso: il messaggio
    // arriva alla macchina ma non a NESSUNO, e finché è così il credito non
    // torna. È lo stesso meccanismo del verso opposto, guardato da qui.
    expect(sk.credito()).toBe(costoMessaggio(4));
    sk.manda("uno.");
    expect(sk.credito()).toBe(0);

    // …e torna quando il socket vero lo ha davvero ricevuto.
    expect(await fino(() => sk.credito() > 0)).toBe(true);
    expect(up.ricevuti[0]).toBe("uno.");
  });
});
