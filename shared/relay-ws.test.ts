/**
 * Un WebSocket dentro il tubo, e il «fermati» che deve poterci viaggiare.
 *
 * ── COSA PRESIDIA ───────────────────────────────────────────────────────────
 * Tre cose che non hanno sintomi finché non è tardi.
 *
 * La prima: un canale non è uno stream. Uno stream si accumula e si consegna
 * intero; un canale consegna messaggi per tutta la sua vita. Confonderli vuol
 * dire un socket che non consegna mai niente, oppure un socket che muore al
 * primo messaggio — e nessuno dei due si vede da un tipo.
 *
 * La seconda: il credito. Senza, un terminale che produce più in fretta di
 * quanto un telefono consumi riempie una coda da qualche parte, e il posto in
 * cui si rompe non è quello che ha sbagliato. Qui si guarda il FILO: quando la
 * finestra è chiusa non deve partire NIENTE, e la prova che il canale di
 * osservazione funziona è che prima partiva.
 *
 * La terza: il relay non deve poter leggere niente di tutto questo. Credito e
 * canali stanno dentro `payload`, e l'involucro resta quello di prima.
 *
 * @covers RELAY-E2E-03
 */
import { describe, expect, it } from "bun:test";
import {
  ARRETRATO_MAX, costoMessaggio, creaCapoCanale, creaRiassemblatore, involucro,
  leggiFrame, ricaricaPer, scriviFrame,
  type EsitoInvio, type EsitoTubo, type FrameTubo,
} from "./relay-protocol";
import {
  WS_CHIUSURA_ANOMALA, WS_CHIUSURA_NORMALE,
  codiceInviabile, intestazioniUpgrade, leggiChiusuraWs, leggiTestaWs, leggiTestaWsAperto,
  leggiTestaWsChiuso, scriviChiusuraWs, scriviTestaWs,
} from "./relay-ws";

// L'ospite apre i DISPARI: un capo che riceve da lui si aspetta quella parità.
const daOspite = () => creaRiassemblatore({ latoRemoto: "guest" });

describe("il canale: molti messaggi su una corsia sola", () => {
  it("consegna un messaggio per volta e resta aperto", () => {
    const r = daOspite();
    expect(r.ricevi({ f: "open", s: 1, n: 0, k: "ws", c: true }))
      .toEqual({ esito: "aperto", s: 1, k: "ws", canale: true });

    const uno = r.ricevi({ f: "data", s: 1, n: 1, e: "u", d: "ciao", m: true });
    expect(uno).toEqual({ esito: "messaggio", s: 1, k: "ws", e: "u", dati: "ciao", byte: 4 });
    const due = r.ricevi({ f: "data", s: 1, n: 2, e: "u", d: "ancora", m: true });
    expect(due).toEqual({ esito: "messaggio", s: 1, k: "ws", e: "u", dati: "ancora", byte: 6 });
    // Il secondo messaggio è la prova che il primo non ha chiuso la corsia:
    // su uno stream normale sarebbe stato un `bad-frame`.
    expect(r.apertiOra()).toBe(1);
  });

  it("rimette insieme un messaggio spezzato, e non consegna prima della fine", () => {
    const r = daOspite();
    r.ricevi({ f: "open", s: 1, n: 0, k: "ws", c: true });
    expect(r.ricevi({ f: "data", s: 1, n: 1, e: "u", d: "primo " }))
      .toEqual({ esito: "parziale", s: 1, byte: 6 });
    expect(r.ricevi({ f: "data", s: 1, n: 2, e: "u", d: "pezzo", m: true }))
      .toEqual({ esito: "messaggio", s: 1, k: "ws", e: "u", dati: "primo pezzo", byte: 11 });
  });

  it("porta testo e poi byte, come un WebSocket vero", () => {
    const r = daOspite();
    r.ricevi({ f: "open", s: 1, n: 0, k: "ws", c: true });
    r.ricevi({ f: "data", s: 1, n: 1, e: "u", d: "testo", m: true });
    const e = r.ricevi({ f: "data", s: 1, n: 2, e: "b", d: "AQID", m: true });
    expect(e.esito).toBe("messaggio");
    if (e.esito !== "messaggio" || e.e !== "b") throw new Error("atteso un messaggio binario");
    expect([...e.dati]).toEqual([1, 2, 3]);
  });

  it("un canale non nasce con dei dati addosso, né già chiuso", () => {
    expect(leggiFrame({ f: "open", s: 1, n: 0, k: "ws", c: true, e: "u", d: "x" })).toBeNull();
    expect(leggiFrame({ f: "open", s: 1, n: 0, k: "ws", c: true, fin: true })).toBeNull();
    expect(leggiFrame({ f: "open", s: 1, n: 0, k: "ws", c: true, m: true })).toBeNull();
    // Il controllo positivo: senza, le tre righe sopra passerebbero anche su un
    // lettore che rifiuta ogni canale.
    expect(leggiFrame({ f: "open", s: 1, n: 0, k: "ws", c: true }))
      .toEqual({ f: "open", s: 1, n: 0, k: "ws", c: true });
  });

  it("i due bit non si scambiano di posto", () => {
    // `m` fuori da un canale: i messaggi lì non esistono.
    expect(leggiFrame({ f: "open", s: 1, n: 0, k: "req", m: true })).toBeNull();
    // …e i due insieme non stanno in piedi da nessuna parte.
    expect(leggiFrame({ f: "data", s: 1, n: 1, e: "u", d: "x", fin: true, m: true })).toBeNull();

    // Su un canale la fine è un `reset`, mai un `fin`.
    const r = daOspite();
    r.ricevi({ f: "open", s: 1, n: 0, k: "ws", c: true });
    expect(r.ricevi({ f: "data", s: 1, n: 1, e: "u", d: "x", fin: true }))
      .toEqual({ esito: "errore", s: 1, motivo: "bad-frame" });

    // …e fuori da un canale `m` non vuol dire niente.
    const r2 = daOspite();
    r2.ricevi({ f: "open", s: 3, n: 0, k: "req" });
    expect(r2.ricevi({ f: "data", s: 3, n: 1, e: "u", d: "x", m: true }))
      .toEqual({ esito: "errore", s: 3, motivo: "bad-frame" });
  });

  it("un reset chiude il canale, e il canale sparisce", () => {
    const r = daOspite();
    r.ricevi({ f: "open", s: 1, n: 0, k: "ws", c: true });
    expect(r.ricevi({ f: "reset", s: 1, motivo: "aborted" }))
      .toEqual({ esito: "chiuso", s: 1, motivo: "aborted" });
    expect(r.apertiOra()).toBe(0);
    expect(r.ricevi({ f: "data", s: 1, n: 1, e: "u", d: "x", m: true }))
      .toEqual({ esito: "errore", s: 1, motivo: "bad-frame" });
  });

  it("un messaggio più grande del tetto uccide QUEL canale e non gli altri", () => {
    const r = creaRiassemblatore({ latoRemoto: "guest", maxByteStream: 8 });
    r.ricevi({ f: "open", s: 1, n: 0, k: "ws", c: true });
    r.ricevi({ f: "open", s: 3, n: 0, k: "ws", c: true });
    expect(r.ricevi({ f: "data", s: 1, n: 1, e: "u", d: "0123456789", m: true }))
      .toEqual({ esito: "errore", s: 1, motivo: "overflow" });
    // L'altro canale non ha sentito niente: è il motivo per cui il tubo esiste.
    expect(r.ricevi({ f: "data", s: 3, n: 1, e: "u", d: "ok", m: true }))
      .toEqual({ esito: "messaggio", s: 3, k: "ws", e: "u", dati: "ok", byte: 2 });
  });

  it("il conto dei byte riparte a ogni messaggio, o il tetto si chiuderebbe da solo", () => {
    const r = creaRiassemblatore({ latoRemoto: "guest", maxByteStream: 8 });
    r.ricevi({ f: "open", s: 1, n: 0, k: "ws", c: true });
    for (let n = 1; n <= 5; n++) {
      expect(r.ricevi({ f: "data", s: 1, n, e: "u", d: "12345678", m: true }).esito).toBe("messaggio");
    }
  });
});

describe("il credito: cammina al contrario dei dati", () => {
  it("un incremento è un numero positivo e intero", () => {
    expect(leggiFrame({ f: "credit", s: 2, c: 0 })).toBeNull();
    expect(leggiFrame({ f: "credit", s: 2, c: -5 })).toBeNull();
    expect(leggiFrame({ f: "credit", s: 2, c: 1.5 })).toBeNull();
    expect(leggiFrame({ f: "credit", s: 2, c: "10" })).toBeNull();
    expect(leggiFrame({ f: "credit", s: 2, c: 10 })).toEqual({ f: "credit", s: 2, c: 10 });
  });

  it("si accetta sulla parità di CHI MANDA, e si rifiuta sull'altra", () => {
    const r = daOspite(); // qui la macchina: apre i PARI, riceve i DISPARI
    expect(r.ricevi({ f: "credit", s: 2, c: 42 })).toEqual({ esito: "credito", s: 2, c: 42 });
    // Un credito sulla parità dell'ospite vorrebbe dire che si sta dando corsa
    // da solo su una corsia che è sua.
    expect(r.ricevi({ f: "credit", s: 1, c: 42 })).toEqual({ esito: "errore", s: 1, motivo: "bad-frame" });
  });

  it("il credito non tocca lo spazio dei numeri: dopo, un open più basso passa ancora", () => {
    const r = daOspite();
    r.ricevi({ f: "credit", s: 8, c: 10 });
    expect(r.ricevi({ f: "open", s: 1, n: 0, k: "ws", c: true }).esito).toBe("aperto");
  });
});

describe("la finestra di chi scrive: il «fermati» che arriva fino a chi produce", () => {
  function capo(credito: number, extra: { arretratoMax?: number } = {}) {
    const filo: FrameTubo[] = [];
    const segnali: boolean[] = [];
    const c = creaCapoCanale({
      s: 0, invia: (f) => filo.push(f), credito, max: 1024,
      scorre: (p) => segnali.push(p),
      ...(extra.arretratoMax !== undefined ? { arretratoMax: extra.arretratoMax } : {}),
    });
    c.apri("wsok", "{}");
    filo.length = 0; // l'apertura non è traffico
    return { c, filo, segnali };
  }

  it("finita la corsa non parte più niente, e riparte tutto in ordine col credito", () => {
    const { c, filo, segnali } = capo(costoMessaggio(5) + costoMessaggio(5));

    // Controllo positivo: finché c'è credito, il filo si muove.
    expect(c.manda("primo")).toBe("inviato");
    expect(c.manda("secon")).toBe("inviato");
    expect(filo.length).toBe(2);
    expect(c.creditoOra()).toBe(0);
    expect(segnali).toEqual([false]);

    // …e adesso non si muove più. È l'asserzione che conta, e senza le due
    // righe di sopra non potrebbe fallire.
    const beforeBlock = filo.length;
    expect(c.manda("terzo")).toBe("in-coda");
    expect(c.manda("quart")).toBe("in-coda");
    expect(filo.length).toBe(beforeBlock);
    expect(c.inCoda()).toBe(2);

    c.ricarica(costoMessaggio(5) * 2);
    expect(filo.length).toBe(4);
    expect(c.inCoda()).toBe(0);
    const testi = filo.map((f) => (f.f === "data" ? f.d : ""));
    expect(testi).toEqual(["primo", "secon", "terzo", "quart"]);

    // Credito che basta esattamente a svuotare la coda NON è «riparti»: la
    // corsa è finita di nuovo, e dirlo sarebbe un segnale falso — chi produce
    // ricomincerebbe per essere fermato al primo messaggio.
    expect(segnali).toEqual([false]);
    c.ricarica(1);
    expect(segnali).toEqual([false, true]);
  });

  it("un messaggio più grande dell'intera finestra parte lo stesso: il contrario è uno stallo", () => {
    const { c, filo } = capo(1);
    expect(c.manda("questo è molto più lungo della finestra")).toBe("inviato");
    expect(filo.length).toBeGreaterThan(0);
    // Si resta in DEBITO, ed è il modo giusto di restare: il prossimo aspetta.
    expect(c.creditoOra()).toBeLessThan(0);
    expect(c.manda("il prossimo")).toBe("in-coda");
  });

  it("un messaggio vuoto è un messaggio, e costa", () => {
    const { c, filo } = capo(costoMessaggio(0));
    expect(c.manda("")).toBe("inviato");
    // Un frame con dati vuoti dice «messaggio vuoto»; il silenzio direbbe
    // «nessun messaggio», che è un'altra cosa.
    expect(filo).toEqual([{ f: "data", s: 0, n: 1, e: "u", d: "", m: true }]);
    expect(c.creditoOra()).toBe(0);
    expect(c.manda("")).toBe("in-coda");
  });

  it("la coda ha un tetto: oltre, il canale non regge e lo dice", () => {
    const { c } = capo(1, { arretratoMax: 10 });
    c.manda("0123456789");           // consuma la finestra
    expect(c.manda("012345")).toBe("in-coda");
    expect(c.manda("012345")).toBe("troppo");
    expect(c.byteInCoda()).toBe(6);
  });

  it("chiuso, non manda più niente e non riparte col credito", () => {
    const { c, filo } = capo(1);
    c.chiudi("aborted");
    expect(filo.at(-1)).toEqual({ f: "reset", s: 0, motivo: "aborted" });
    const dopo = filo.length;
    expect(c.manda("x")).toBe("troppo");
    c.ricarica(1000);
    expect(filo.length).toBe(dopo);
  });

  it("il tetto di serie della coda è dichiarato, non inventato al volo", () => {
    expect(ARRETRATO_MAX).toBeGreaterThan(0);
    expect(costoMessaggio(0)).toBeGreaterThan(0);
  });
});

describe("le teste del WebSocket: chi le manda è fuori dalla rete di casa", () => {
  it("un sottoprotocollo è un token, e basta", () => {
    expect(leggiTestaWs(scriviTestaWs({ p: "/ws", sp: ["topics.v1"] })))
      .toEqual({ p: "/ws", sp: ["topics.v1"] });
    expect(leggiTestaWs('{"p":"/ws","sp":["a, b"]}')).toBeNull();
    expect(leggiTestaWs('{"p":"/ws","sp":["a\\r\\nX: y"]}')).toBeNull();
    expect(leggiTestaWs('{"p":"/ws","sp":[7]}')).toBeNull();
  });

  it("senza percorso non è una richiesta di apertura", () => {
    expect(leggiTestaWs('{"sp":["a"]}')).toBeNull();
    expect(leggiTestaWs("non json")).toBeNull();
    expect(leggiTestaWs(undefined)).toBeNull();
  });

  it("l'esito dell'apertura porta uno stato HTTP vero", () => {
    expect(leggiTestaWsAperto(scriviTestaWs({ re: 1, s: 101 }))).toEqual({ re: 1, s: 101 });
    expect(leggiTestaWsAperto('{"re":1,"s":99}')).toBeNull();
    expect(leggiTestaWsAperto('{"re":-1,"s":101}')).toBeNull();
    expect(leggiTestaWsAperto('{"s":101}')).toBeNull();
  });

  it("una chiusura porta un codice che esiste", () => {
    expect(leggiChiusuraWs(scriviChiusuraWs({ c: 1000, r: "" }))).toEqual({ c: 1000, r: "" });
    expect(leggiChiusuraWs('{"c":0,"r":""}')).toBeNull();
    expect(leggiChiusuraWs('{"c":5000,"r":""}')).toBeNull();
    expect(leggiChiusuraWs('{"c":1000}')).toBeNull();
    // Arriva come byte quando il canale è binario: è la stessa cosa.
    expect(leggiChiusuraWs(new TextEncoder().encode('{"c":1011,"r":"ops"}')))
      .toEqual({ c: 1011, r: "ops" });
    expect(leggiTestaWsChiuso(scriviTestaWs({ w: 3 }))).toEqual({ w: 3 });
    expect(leggiTestaWsChiuso('{"w":"3"}')).toBeNull();
  });

  it("1006 non si può mandare, 1000 sì", () => {
    expect(codiceInviabile(WS_CHIUSURA_NORMALE)).toBe(true);
    expect(codiceInviabile(WS_CHIUSURA_ANOMALA)).toBe(false);
    expect(codiceInviabile(1011)).toBe(false);
    expect(codiceInviabile(4000)).toBe(true);
  });

  it("le intestazioni della stretta di mano non si copiano; il biscotto sì", () => {
    const fuori = intestazioniUpgrade([
      ["Cookie", "topics_session=abc"],
      ["Sec-WebSocket-Key", "inventata"],
      ["sec-websocket-version", "13"],
      ["X-Forwarded-For", "1.2.3.4"],
      ["User-Agent", "prova"],
    ]);
    // Il biscotto è ciò che fa entrare un dispositivo appaiato: senza, tutto
    // questo lavoro finisce su una pagina di login.
    expect(fuori).toContainEqual(["cookie", "topics_session=abc"]);
    expect(fuori).toContainEqual(["user-agent", "prova"]);
    expect(fuori.map(([n]) => n)).not.toContain("sec-websocket-key");
    expect(fuori.map(([n]) => n)).not.toContain("sec-websocket-version");
    // …e l'indirizzo continua a non poterselo scegliere chi bussa.
    expect(fuori.map(([n]) => n)).not.toContain("x-forwarded-for");
  });
});

describe("il relay non vede niente di tutto questo", () => {
  it("credito e canali stanno dentro payload, e l'involucro resta cieco", () => {
    for (const f of [
      { f: "open", s: 1, n: 0, k: "ws", h: scriviTestaWs({ p: "/ws/terminal/SEGRETO" }), c: true },
      { f: "data", s: 1, n: 1, e: "u", d: "SEGRETO", m: true },
      { f: "credit", s: 2, c: 4242 },
    ] as FrameTubo[]) {
      const busta = involucro({ t: "to-guest", to: "s1", payload: scriviFrame(f) });
      expect(JSON.stringify(busta)).not.toContain("SEGRETO");
      expect(JSON.stringify(busta)).not.toContain("4242");
      // Il controllo positivo: l'involucro contiene ciò che serve a consegnare,
      // e nient'altro. Senza, le due righe sopra passerebbero su un oggetto
      // vuoto per sbaglio.
      expect(busta).toEqual({ t: "to-guest", to: "s1" });
    }
  });
});

describe("un giro completo fra due capi, senza rete", () => {
  it("apertura, dati nei due versi, chiusura", () => {
    // Due riassemblatori incrociati: quello che scrive i pari legge i dispari.
    const daGuest = creaRiassemblatore({ latoRemoto: "guest" });
    const daHost = creaRiassemblatore({ latoRemoto: "host" });
    const versoHost: EsitoTubo[] = [];
    const versoGuest: EsitoTubo[] = [];

    const headGuest = creaCapoCanale({ s: 1, invia: (f) => versoHost.push(daGuest.ricevi(f)) });
    const headHost = creaCapoCanale({ s: 0, invia: (f) => versoGuest.push(daHost.ricevi(f)) });

    headGuest.apri("ws", scriviTestaWs({ p: "/ws/terminal/t1" }));
    expect(versoHost.at(-1)).toEqual({
      esito: "aperto", s: 1, k: "ws", h: scriviTestaWs({ p: "/ws/terminal/t1" }), canale: true,
    });

    headHost.apri("wsok", scriviTestaWs({ re: 1, s: 101 }));
    expect(versoGuest.at(-1)?.esito).toBe("aperto");

    headGuest.manda("ls -la\n");
    const su = versoHost.at(-1);
    if (su?.esito !== "messaggio") throw new Error("atteso un messaggio verso la macchina");
    expect(su.dati).toBe("ls -la\n");

    headHost.manda("total 0\r\n");
    const giu = versoGuest.at(-1);
    if (giu?.esito !== "messaggio") throw new Error("atteso un messaggio verso l'ospite");
    expect(giu.dati).toBe("total 0\r\n");

    // Il credito che torna indietro è quello che chi RICEVE ha contato.
    headGuest.ricarica(costoMessaggio(giu.byte));

    headHost.chiudi("aborted");
    expect(versoGuest.at(-1)).toEqual({ esito: "chiuso", s: 0, motivo: "aborted" });
  });

  it("con un trasporto sincrono la finestra non si stringe da sola", () => {
    // Il caso che il codice di `emetti` dichiara e che nessun altro test
    // tocca: chi riceve RICARICA dentro `opts.invia`, cioè a metà del giro di
    // chi manda. Se il costo si scalasse DOPO aver mandato i pezzi, quella
    // ricarica finirebbe sotto un valore calcolato prima — pagata due volte —
    // e la finestra si chiuderebbe da sé dopo tre scambi, per sempre.
    //
    // Il credito iniziale è stretto apposta: tre messaggi. Se il conto fosse
    // sbagliato, dal quarto in poi resterebbero in coda senza che nulla li
    // sblocchi più.
    const rias = creaRiassemblatore({ latoRemoto: "guest" });
    const arrivati: string[] = [];
    const iniziale = costoMessaggio(5) * 3;
    let capo: ReturnType<typeof creaCapoCanale>;
    capo = creaCapoCanale({
      s: 1,
      credito: iniziale,
      invia: (f) => {
        const e = rias.ricevi(f);
        if (e.esito !== "messaggio") return;
        arrivati.push(String(e.dati));
        capo.ricarica(ricaricaPer(e.s, e.byte).c);
      },
    });
    capo.apri("ws");

    const esiti: EsitoInvio[] = [];
    for (let i = 0; i < 10; i++) esiti.push(capo.manda("12345"));

    // Il controllo positivo: i messaggi sono passati DAVVERO dal riassemblatore
    // — senza, le due righe sotto passerebbero anche su un canale morto.
    expect(arrivati).toEqual(Array<string>(10).fill("12345"));
    expect(esiti.every((e) => e === "inviato")).toBe(true);
    // E la finestra è larga come all'inizio: ogni messaggio è costato una
    // volta sola.
    expect(capo.creditoOra()).toBe(iniziale);
    expect(capo.inCoda()).toBe(0);
  });
});
