/**
 * Il CICLO DI VITA di una sessione, dal lato della macchina.
 *
 * ── COSA C'È QUI DENTRO, E PERCHÉ NON STA NEGLI ALTRI DUE FILE ──────────────
 * `relay-proxy.test.ts` guarda una richiesta e `relay-proxy-ws.test.ts` guarda
 * un socket: tutti e due dentro UNA sessione, che lì è un dato di fatto. Qui la
 * sessione è la cosa in prova — quando nasce, con che ruolo, quando muore, e
 * quante ne stanno insieme. È l'unico posto in cui il tetto e la riserva si
 * possono guardare senza aprire sessantaquattro sessioni per vederne una.
 *
 * ── PERCHÉ IL SOCKET DI SOPRA È FINTO ───────────────────────────────────────
 * Perché la stretta di mano vera è già provata contro un ascoltatore vero
 * altrove, e ripeterla qui coprirebbe la sola domanda di questo file: quando
 * una sessione se ne va, il socket di sopra viene CHIUSO davvero? Un finto lo
 * dice in modo esatto e sincrono; uno vero lo direbbe fra due `await`.
 *
 * @covers RELAY-E2E-13
 */
import { describe, expect, it } from "bun:test";
import { creaProxyTubo, creaRelayClient, type ApriSocketLocale } from "./relay-client";
import { leggiFramePayload, RELAY_PROTOCOL_VERSION, type FrameTubo } from "../../shared/relay-protocol";
import { creaRelayFinto, SEGRETO_FINTO } from "../../shared/relay-fake";
import { GENERE_WS, scriviTestaWs } from "../../shared/relay-ws";

/** Il socket verso l'ascoltatore, ridotto a ciò che il proxy gli chiede. */
class SocketSu {
  static aperti: SocketSu[] = [];
  chiusure: Array<{ c?: number; r?: string }> = [];
  binaryType = "arraybuffer";
  protocol = "";
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { SocketSu.aperti.push(this); }
  send() { /* qui non si guarda cosa esce */ }
  close(c?: number, r?: string) { this.chiusure.push({ c, r }); }
  get chiuso() { return this.chiusure.length > 0; }
}

const apriSocketLocale: ApriSocketLocale = () => new SocketSu() as unknown as WebSocket;

/** Il proxy nudo, con i frame che escono leggibili uno per uno. */
function proxy(opts: { maxSessioni?: number; riservaDevice?: number } = {}) {
  SocketSu.aperti = [];
  const usciti: Array<{ sid: string; fr: FrameTubo }> = [];
  const p = creaProxyTubo({
    portaTunnel: 13999,
    apriSocketLocale,
    ...(opts.maxSessioni !== undefined ? { maxSessioni: opts.maxSessioni } : {}),
    ...(opts.riservaDevice !== undefined ? { riservaDevice: opts.riservaDevice } : {}),
    invia: (sid, payload) => {
      const fr = leggiFramePayload(payload);
      if (fr) usciti.push({ sid, fr });
    },
  });
  /**
   * Apre un WebSocket dell'ospite `sid` sullo stream `s` (dispari: la corsia
   * dell'ospite), e restituisce il socket finto di sopra — o `null` se il proxy
   * non ne ha aperto nessuno, che è proprio ciò che si guarda quando la
   * sessione è stata respinta.
   */
  const apriWs = (sid: string, s = 1): SocketSu | null => {
    const prima = SocketSu.aperti.length;
    p.riceviFrame(sid, { f: "open", s, n: 0, k: GENERE_WS, h: scriviTestaWs({ p: "/ws" }), c: true });
    if (SocketSu.aperti.length === prima) return null;
    const su = SocketSu.aperti.at(-1)!;
    su.onopen?.();
    return su;
  };
  return { p, usciti, apriWs };
}

const rifiuti = (usciti: Array<{ sid: string; fr: FrameTubo }>, sid: string) =>
  usciti.filter((u) => u.sid === sid && u.fr.f === "reset" && u.fr.motivo === "too-many-streams");

describe("sessioni · entrare è un evento, e porta con sé il ruolo", () => {
  it("una sessione nasce all'ingresso, prima di qualunque frame", () => {
    const t = proxy();
    // Il controllo positivo del canale di osservazione: prima non c'è niente,
    // quindi un `null` dopo l'ingresso sarebbe una differenza vera.
    expect(t.p.__ruolo("s1")).toBeNull();
    expect(t.p.sessioniAperte()).toBe(0);

    t.p.ospiteEntrato("s1", "device");
    expect(t.p.__ruolo("s1")).toBe("device");
    expect(t.p.sessioniAperte()).toBe(1);
  });

  it("un relay che non dichiara il ruolo non promuove nessuno", () => {
    const t = proxy();
    t.p.ospiteEntrato("s1");
    expect(t.p.__ruolo("s1")).toBe("guest");
  });

  it("una sessione che non si è annunciata entra come OSPITE, non come dispositivo", () => {
    // Altrimenti basterebbe tacere per prendersi la riserva di chi si è
    // appaiato: il ruolo lo dichiara il relay, e chi non lo dichiara è il meno
    // che si possa essere.
    const t = proxy();
    t.apriWs("mai-annunciata");
    expect(t.p.sessioniAperte()).toBe(1);
    expect(t.p.__ruolo("mai-annunciata")).toBe("guest");
  });

  it("uscire cancella la sessione", () => {
    const t = proxy();
    t.p.ospiteEntrato("s1", "device");
    t.p.ospiteUscito("s1");
    expect(t.p.__ruolo("s1")).toBeNull();
    expect(t.p.sessioniAperte()).toBe(0);
  });
});

describe("sessioni · un identificatore che torna è una sessione NUOVA", () => {
  it("il socket del vecchio capo si chiude, invece di passare al nuovo", () => {
    const t = proxy();
    t.p.ospiteEntrato("s1", "device");
    const su = t.apriWs("s1")!;
    // Controllo positivo: prima del secondo ingresso il socket è vivo davvero.
    expect(su).not.toBeNull();
    expect(t.p.__socket("s1")).toBe(1);
    expect(su.chiuso).toBe(false);

    t.p.ospiteEntrato("s1", "guest");

    // Consegnare questo socket al capo nuovo vorrebbe dire dargli il terminale
    // di un altro; lasciarlo aperto vorrebbe dire un processo che nessuno
    // ferma più.
    expect(su.chiuso).toBe(true);
    expect(t.p.__socket("s1")).toBe(0);
    // …e il ruolo è quello del capo che è entrato adesso, non quello di prima.
    expect(t.p.__ruolo("s1")).toBe("guest");
    expect(t.p.sessioniAperte()).toBe(1);
  });
});

describe("sessioni · il tetto, e i posti che restano al dispositivo", () => {
  it("gli ospiti si fermano prima del tetto; un dispositivo entra lo stesso", () => {
    // Quattro posti, due riservati: gli ospiti ne prendono al massimo due.
    const t = proxy({ maxSessioni: 4, riservaDevice: 2 });
    t.p.ospiteEntrato("g1");
    t.p.ospiteEntrato("g2");
    expect(t.p.sessioniAperte()).toBe(2);

    t.p.ospiteEntrato("g3");
    expect(t.p.__ruolo("g3")).toBeNull();
    expect(t.p.sessioniAperte()).toBe(2);

    // Il controllo positivo, ed è tutto il senso della riserva: con lo stesso
    // stato in cui un ospite è stato respinto, il dispositivo entra.
    t.p.ospiteEntrato("d1", "device");
    expect(t.p.__ruolo("d1")).toBe("device");
    t.p.ospiteEntrato("d2", "device");
    expect(t.p.sessioniAperte()).toBe(4);

    // Il tetto però resta un tetto anche per lui.
    t.p.ospiteEntrato("d3", "device");
    expect(t.p.__ruolo("d3")).toBeNull();
    expect(t.p.sessioniAperte()).toBe(4);
  });

  it("un posto che si libera si riprende: il tetto non è una scadenza", () => {
    const t = proxy({ maxSessioni: 4, riservaDevice: 2 });
    t.p.ospiteEntrato("g1");
    t.p.ospiteEntrato("g2");
    t.p.ospiteEntrato("g3");
    expect(t.p.__ruolo("g3")).toBeNull();

    t.p.ospiteUscito("g1");
    t.p.ospiteEntrato("g3");
    expect(t.p.__ruolo("g3")).toBe("guest");
  });

  it("chi è stato respinto se lo sente dire anche sul suo primo frame", () => {
    const t = proxy({ maxSessioni: 4, riservaDevice: 2 });
    t.p.ospiteEntrato("g1");
    t.p.ospiteEntrato("g2");
    t.p.ospiteEntrato("g3"); // respinto: non esiste nessuna sessione `g3`

    // Senza questo, il frame di chi è stato respinto all'ingresso si
    // creerebbe la sessione da solo, e il tetto sarebbe una decorazione.
    expect(t.apriWs("g3")).toBeNull(); // e non si prova nemmeno a salire
    expect(rifiuti(t.usciti, "g3").length).toBe(1);
    expect(t.p.__ruolo("g3")).toBeNull();

    // Controllo positivo: lo stesso frame, con un posto libero, entra e NON si
    // vede rifiutare niente.
    t.p.ospiteUscito("g1");
    t.usciti.length = 0;
    expect(t.apriWs("g4")).not.toBeNull();
    expect(rifiuti(t.usciti, "g4").length).toBe(0);
    expect(t.p.__ruolo("g4")).toBe("guest");
  });

  it("una riserva più larga del tetto non chiude fuori tutti", () => {
    // Una costante scritta storta non deve poter spegnere la condivisione dei
    // link: resta sempre almeno un posto raggiungibile da un ospite.
    const t = proxy({ maxSessioni: 2, riservaDevice: 99 });
    t.p.ospiteEntrato("g1");
    expect(t.p.__ruolo("g1")).toBe("guest");
  });
});

describe("sessioni · il tubo che cade non lascia niente appeso", () => {
  it("`chiudiTutto` chiude i socket veri di ogni sessione", () => {
    const t = proxy();
    t.p.ospiteEntrato("s1", "device");
    t.p.ospiteEntrato("s2");
    const a = t.apriWs("s1")!;
    const b = t.apriWs("s2")!;
    expect(a.chiuso).toBe(false);
    expect(b.chiuso).toBe(false);

    t.p.chiudiTutto();
    expect(a.chiuso).toBe(true);
    expect(b.chiuso).toBe(true);
    expect(t.p.sessioniAperte()).toBe(0);
  });
});

// ── E ora dal filo: le stesse cose, ma dette dal relay ─────────────────────

class FiloFinto {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** Dove finisce ciò che la macchina dice al relay. Nudo resta un buco nero;
   *  agganciato al relay finto diventa il filo vero. */
  versoRelay: ((d: string) => void) | null = null;
  send(d: string) { this.versoRelay?.(d); }
  close() { this.readyState = 3; }
}

function macchina(opts: { avvia?: boolean } = {}): {
  c: ReturnType<typeof creaRelayClient>; filo: FiloFinto; di: (m: unknown) => void;
} {
  SocketSu.aperti = [];
  const filo = new FiloFinto();
  const c = creaRelayClient({
    baseUrl: "http://relay.test",
    relayId: "i1",
    segreto: SEGRETO_FINTO,
    trovaLink: () => null,
    serviRisorsa: async () => ({ status: 200, body: {} }),
    segnaApertura: () => {},
    apriSocket: () => filo as unknown as WebSocket,
    apriSocketLocale,
    portaTunnel: 13999,
  });
  if (opts.avvia !== false) {
    c.avvia();
    filo.onopen?.();
    // The relay CONFIRMS it took us in. Without it the client holds a thread
    // nobody owns and closes it after ten seconds: simulating the open alone
    // was half a handshake, and the real meeting point sends `ready` at once.
    filo.onmessage?.({ data: JSON.stringify({ t: "ready", v: 1 }) });
  }
  const di = (m: unknown) => filo.onmessage?.({ data: JSON.stringify(m) });
  return { c, filo, di };
}

describe("relay client · il ciclo di vita arriva dal filo", () => {
  it("`guest-joined` apre la sessione col ruolo che il relay dichiara", () => {
    const m = macchina();
    expect(m.c.__ruolo("s1")).toBeNull(); // controllo positivo

    m.di({ t: "guest-joined", sessionId: "s1", ruolo: "device" });
    expect(m.c.__ruolo("s1")).toBe("device");
    expect(m.c.__sessioni()).toBe(1);

    m.di({ t: "guest-left", sessionId: "s1", ruolo: "device" });
    expect(m.c.__ruolo("s1")).toBeNull();
    expect(m.c.__sessioni()).toBe(0);
    m.c.ferma();
  });

  it("il filo che cade porta via le sessioni E i socket di sopra", () => {
    const m = macchina();
    m.di({ t: "guest-joined", sessionId: "s1", ruolo: "device" });
    m.di({
      t: "to-guest", to: "s1",
      payload: JSON.stringify({ f: "open", s: 1, n: 0, k: GENERE_WS, h: scriviTestaWs({ p: "/ws" }), c: true }),
    });
    const su = SocketSu.aperti.at(-1)!;
    su.onopen?.();
    expect(m.c.__socket("s1")).toBe(1);
    expect(su.chiuso).toBe(false);

    // Le sessioni vivevano su QUESTO filo: alla riconnessione il relay ne
    // assegna di nuove, e un socket rimasto aperto è un processo che scrive
    // verso nessuno.
    m.filo.onclose?.();
    expect(su.chiuso).toBe(true);
    expect(m.c.__sessioni()).toBe(0);
    m.c.ferma();
  });
});

describe("sessioni · il relay finto e la macchina vera dicono la stessa cosa", () => {
  /** La macchina vera agganciata al relay finto: nessuna rete, due
   *  implementazioni. Se la macchina cominciasse a pretendere un campo che il
   *  protocollo non promette, il relay finto smetterebbe di soddisfarla. */
  function agganciata() {
    const relay = creaRelayFinto();
    // Il filo si aggancia PRIMA di avviare: il «sono io» parte all'apertura, e
    // una macchina che lo dice a nessuno non risulta registrata.
    const m = macchina({ avvia: false });
    const capo = relay.collegaMacchina((x) => m.filo.onmessage?.({ data: JSON.stringify(x) }));
    m.filo.versoRelay = (d) => capo.ricevi(JSON.parse(d));
    m.c.avvia();
    m.filo.onopen?.(); // il «sono io» che registra l'installazione
    return { relay, ...m };
  }

  it("il ruolo che il relay dichiara è quello con cui la macchina registra", () => {
    const t = agganciata();

    const disp = t.relay.collegaDispositivo("i1", () => {});
    const sidD = disp.sessionId();
    expect(sidD).not.toBeNull();

    let sidO = "";
    const osp = t.relay.collegaOspite((x) => { if (x.t === "ready" && x.sessionId) sidO = x.sessionId; });
    osp.ricevi({ t: "guest-open", v: RELAY_PROTOCOL_VERSION, installationId: "i1", shareRef: "r1" });
    expect(sidO).not.toBe("");

    // Le due porte del relay restano due cose diverse fin dentro la macchina:
    // se qui si leggessero uguali, la riserva dei dispositivi non proteggerebbe
    // nessuno.
    expect(t.c.__ruolo(sidD!)).toBe("device");
    expect(t.c.__ruolo(sidO)).toBe("guest");
    expect(t.c.__sessioni()).toBe(2);

    disp.scollega();
    expect(t.c.__ruolo(sidD!)).toBeNull();
    expect(t.c.__ruolo(sidO)).toBe("guest"); // e l'altra non si è mossa
    osp.scollega();
    expect(t.c.__sessioni()).toBe(0);
    t.c.ferma();
  });
});
