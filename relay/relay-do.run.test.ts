/**
 * Il relay — Worker e Durable Object — ESEGUITO.
 *
 * ── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * `relay-contract.test.ts` legge `relay-do.ts` come una STRINGA: presidia i due
 * difetti invisibili a runtime (l'ibernazione, il binario) e non poteva fare
 * altro, perché nessuno eseguiva quel file. Un guardiano che sa solo leggere
 * approva anche un instradamento sbagliato, purché sia scritto con le parole
 * giuste.
 *
 * Qui il Durable Object viene istanziato per davvero e guidato come lo guida il
 * runtime dei Worker: `fetch()` per l'aggancio, poi i METODI `webSocketMessage`
 * e `webSocketClose` — che è l'unica forma ammessa quando si ibernà, ed è anche
 * il motivo per cui questa prova è possibile senza workerd. L'unico pezzo finto
 * è il contorno: la coppia di socket, i tag e lo storage. Il codice del relay è
 * quello vero, riga per riga.
 *
 * ── COSA NON PROVA ──────────────────────────────────────────────────────────
 * Che Cloudflare sfratti davvero l'istanza dalla memoria fra un messaggio e
 * l'altro. Quello lo presidia il contract test, testualmente, ed è giusto così:
 * l'ibernazione non ha nessun sintomo osservabile a runtime — cambia la
 * bolletta, non il comportamento. Qui si controlla la CONSEGUENZA che invece si
 * osserva: nessuno stato in un campo, l'identità letta dai tag, l'accettazione
 * fatta passare dallo stato e mai dalla socket.
 */
import { describe, expect, it } from "bun:test";
import { SessioneRelay } from "./src/relay-do";
import worker from "./src/worker";
import { creaRelayFinto } from "../shared/relay-fake";
import { derivaRelayId, INTESTAZIONE_SEGRETO } from "../shared/relay-identita";
import { leggiMessaggio, type MessaggioRelay } from "../shared/relay-protocol";

// ───────────────────────────────────────────────────────────────────────────
// IL CONTORNO FINTO: coppia di socket, tag, stato
// ───────────────────────────────────────────────────────────────────────────

interface Chiusura { code: number; motivo: string }

/** Quante volte qualcuno ha accettato una socket dalla socket stessa. Deve
 *  restare zero: è la differenza fra $10 e $416 al mese. */
let accettazioniDirette = 0;
/** Quante volte si è passati dallo stato. Serve da controllo POSITIVO: senza,
 *  «zero accettazioni diritte» passerebbe anche su un oggetto che non ha
 *  accettato niente. */
let accettazioniIbernate = 0;
let ultimaCoppia: [CapoFinto, CapoFinto] | null = null;

class CapoFinto {
  peer: CapoFinto | null = null;
  /** Ciò che è ARRIVATO su questo capo, così com'è sul filo. */
  arrivati: string[] = [];
  chiusa: Chiusura | null = null;

  send(d: string): void {
    if (this.peer) this.peer.arrivati.push(d);
  }

  close(code = 1000, motivo = ""): void {
    if (this.chiusa === null) this.chiusa = { code, motivo };
    if (this.peer && this.peer.chiusa === null) this.peer.chiusa = { code, motivo };
  }

  /** Non deve MAI essere chiamata dal relay. */
  accept(): void { accettazioniDirette += 1; }

  /** I messaggi del protocollo arrivati qui, già letti. */
  letti(): MessaggioRelay[] {
    const out: MessaggioRelay[] = [];
    for (const r of this.arrivati) {
      const m = leggiMessaggio(JSON.parse(r) as unknown);
      if (m) out.push(m);
    }
    return out;
  }
}

function CoppiaFinta(this: unknown) {
  const a = new CapoFinto();
  const b = new CapoFinto();
  a.peer = b;
  b.peer = a;
  ultimaCoppia = [a, b];
  return { 0: a, 1: b };
}
(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = CoppiaFinta;

/**
 * Lo stato del Durable Object, ridotto a ciò che il relay usa davvero.
 *
 * I tag sono l'unica memoria: è la conseguenza dell'ibernazione, e riprodurla
 * qui è ciò che rende la prova utile — un relay che tenesse lo stato in un
 * campo passerebbe lo stesso, ma la sua identità qui non si troverebbe.
 */
class StatoFinto {
  private tag = new Map<CapoFinto, string[]>();

  acceptWebSocket(ws: CapoFinto, tags: string[] = []): void {
    this.tag.set(ws, tags);
    accettazioniIbernate += 1;
  }

  getWebSockets(tag?: string): CapoFinto[] {
    return [...this.tag.keys()].filter(
      (w) => tag === undefined || (this.tag.get(w) ?? []).includes(tag),
    );
  }

  getTags(ws: CapoFinto): string[] {
    return this.tag.get(ws) ?? [];
  }

  dimentica(ws: CapoFinto): void { this.tag.delete(ws); }
}

type StatoDelDO = ConstructorParameters<typeof SessioneRelay>[0];

/** Un aggancio: la richiesta di upgrade e i due capi che ne escono. */
interface Aggancio {
  /** Il capo che il relay tiene: è quello che i metodi del DO ricevono. */
  suo: CapoFinto;
  /** Il capo del chiamante: è dove ARRIVA ciò che il relay manda. */
  mio: CapoFinto;
  res: Response;
}

function scena() {
  const stato = new StatoFinto();
  const oggetto = new SessioneRelay(stato as unknown as StatoDelDO);

  async function collega(ruolo: string, upgrade = true): Promise<Aggancio> {
    ultimaCoppia = null;
    const res = await oggetto.fetch(new Request(
      `https://relay.test/x?ruolo=${encodeURIComponent(ruolo)}`,
      upgrade ? { headers: { upgrade: "websocket" } } : {},
    ));
    const coppia = ultimaCoppia;
    // Se non c'è coppia il relay ha rifiutato: si restituiscono capi vuoti, e
    // chi chiama guarda `res`.
    const suo = coppia ? coppia[1] : new CapoFinto();
    const mio = coppia ? coppia[0] : new CapoFinto();
    return { suo, mio, res };
  }

  /** Un messaggio ricevuto dal relay su quella socket, come fa il runtime. */
  const parla = (a: Aggancio, m: unknown) =>
    oggetto.webSocketMessage(a.suo as unknown as WebSocket, JSON.stringify(m));

  /** Il filo cade. Il runtime chiama il metodo e poi la socket sparisce
   *  dall'elenco: qui si riproduce lo stesso ordine. */
  async function chiudi(a: Aggancio): Promise<void> {
    await oggetto.webSocketClose(a.suo as unknown as WebSocket);
    stato.dimentica(a.suo);
  }

  return { stato, oggetto, collega, parla, chiudi };
}

/** L'identificatore che il relay ha assegnato, letto dal `ready`. */
function sessioneDi(a: Aggancio): string {
  const pronto = a.mio.letti().find((m) => m.t === "ready");
  return pronto && "sessionId" in pronto && pronto.sessionId ? pronto.sessionId : "";
}

/**
 * Il Worker davanti ai Durable Object, con un `SESSIONE` finto che si comporta
 * come quello vero nell'unica cosa che conta qui: `idFromName` dà SEMPRE lo
 * stesso oggetto per lo stesso nome. È ciò che fa incontrare una macchina e i
 * suoi dispositivi senza tenere un registro da nessuna parte, e provarlo vuol
 * dire far entrare i due da percorsi diversi e vederli parlare.
 */
function scenaWorker() {
  const nodi = new Map<string, SessioneRelay>();
  const nodo = (nome: string) => {
    let n = nodi.get(nome);
    if (!n) { n = new SessioneRelay(new StatoFinto() as unknown as StatoDelDO); nodi.set(nome, n); }
    return n;
  };

  const env = {
    SESSIONE: {
      idFromName: (nome: string) => ({ nome }),
      get: (id: { nome: string }) => ({ fetch: (req: Request) => nodo(id.nome).fetch(req) }),
    },
  } as unknown as Parameters<typeof worker.fetch>[1];

  async function chiedi(
    percorso: string,
    upgrade: boolean,
    extra: Record<string, string> = {},
  ): Promise<Aggancio> {
    ultimaCoppia = null;
    const res = await worker.fetch(new Request(
      `https://relay.test${percorso}`,
      { headers: { ...(upgrade ? { upgrade: "websocket" } : {}), ...extra } },
    ), env);
    const coppia = ultimaCoppia;
    return {
      suo: coppia ? coppia[1] : new CapoFinto(),
      mio: coppia ? coppia[0] : new CapoFinto(),
      res,
    };
  }

  return {
    /** Un aggancio WebSocket su un percorso, con le intestazioni che servono. */
    collega: (percorso: string, extra: Record<string, string> = {}) => chiedi(percorso, true, extra),
    /**
     * L'aggancio della MACCHINA, con la preimmagine del nome.
     *
     * Esiste perché scrivere ogni volta l'intestazione a mano è il modo in cui
     * un test finisce per provare il rifiuto invece della cosa che voleva
     * provare — e quel rifiuto assomiglia molto a «funziona».
     */
    macchina: (p: PuntoDIncontro) => chiedi(`/agent/${p.id}`, true, { [INTESTAZIONE_SEGRETO]: p.segreto }),
    /** Una richiesta normale, senza upgrade. */
    semplice: (percorso: string) => chiedi(percorso, false),
    nodi,
  };
}

/** Un punto d'incontro: il segreto e il nome che ne discende. */
interface PuntoDIncontro { segreto: string; id: string }

/**
 * Una coppia VERA, derivata con la stessa funzione che usa il Worker.
 *
 * Non una coppia inventata a mano: quella non corrisponderebbe, ogni aggancio
 * verrebbe respinto, e mezza suite proverebbe il rifiuto credendo di provare
 * l'inoltro.
 */
async function puntoDIncontro(seme: string): Promise<PuntoDIncontro> {
  const segreto = `segreto-di-prova-${seme}-0123456789abcdef`;
  return { segreto, id: await derivaRelayId(segreto) };
}

// ───────────────────────────────────────────────────────────────────────────
// LA PROVA CHE LA PROVA FUNZIONA
// ───────────────────────────────────────────────────────────────────────────

describe("relay-do eseguito · il banco di prova regge", () => {
  it("il Durable Object si aggancia davvero, e dice di essere pronto", async () => {
    // Controllo POSITIVO prima di tutto: senza questo, ogni «non è successo X»
    // qui sotto passerebbe anche su un oggetto che non ha fatto niente.
    const s = scena();
    const host = await s.collega("host");
    expect(host.res.status).toBe(101);
    expect(host.mio.letti()).toMatchObject([{ t: "ready" }]);
  });

  it("senza upgrade non si aggancia niente", async () => {
    const s = scena();
    const a = await s.collega("host", false);
    expect(a.res.status).toBe(426);
  });

  it("si accetta SEMPRE dallo stato, mai dalla socket", async () => {
    const prima = accettazioniIbernate;
    const s = scena();
    await s.collega("host");
    await s.collega("guest");
    // Il controllo positivo e quello negativo insieme: è passato dallo stato
    // due volte, e dalla socket nessuna.
    expect(accettazioniIbernate - prima).toBe(2);
    expect(accettazioniDirette).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// IL WORKER: quale porta porta a quale ruolo
// ───────────────────────────────────────────────────────────────────────────

describe("worker eseguito · le tre porte", () => {
  it("`/d/:id` è la porta del DISPOSITIVO, e la macchina lo vede arrivare come tale", async () => {
    // Il giro intero: due percorsi diversi, lo stesso nome di installazione, lo
    // stesso Durable Object. Se `idFromName` non facesse incontrare i due, qui
    // il dispositivo troverebbe la macchina spenta.
    const w = scenaWorker();
    const p = await puntoDIncontro("1");
    const host = await w.macchina(p);
    const disp = await w.collega(`/d/${p.id}`);

    expect(disp.res.status).toBe(101);
    expect(w.nodi.size).toBe(1);
    expect(host.mio.letti().at(-1)).toMatchObject({ t: "guest-joined", ruolo: "device" });
  });

  it("`/s/:id` resta la porta del LINK", async () => {
    const w = scenaWorker();
    const p = await puntoDIncontro("2");
    const host = await w.macchina(p);
    await w.collega(`/s/${p.id}`);
    expect(host.mio.letti().at(-1)).toMatchObject({ t: "guest-joined", ruolo: "guest" });
  });

  it("`/agent/:id` è la macchina, e non è una sessione", async () => {
    const w = scenaWorker();
    const host = await w.macchina(await puntoDIncontro("3"));
    expect(host.res.status).toBe(101);
    // Nessun identificatore di sessione: la macchina non è un capo da servire.
    expect(host.mio.letti()[0]).toEqual({ t: "ready", v: 1 });
  });

  it("due installazioni diverse non si incontrano", async () => {
    const w = scenaWorker();
    const a = await puntoDIncontro("A");
    const b = await puntoDIncontro("B");
    await w.macchina(a);
    const disp = await w.collega(`/d/${b.id}`);
    // La macchina di A non è la macchina di B, e il dispositivo di B lo scopre
    // dicendoglielo — non con una pagina vuota.
    expect(disp.res.status).toBe(503);
    expect(w.nodi.size).toBe(2);
  });

  it("senza upgrade non si passa, su nessuna delle tre", async () => {
    const w = scenaWorker();
    for (const p of ["/agent/i", "/s/i", "/d/i"]) {
      expect(`${p}→${(await w.semplice(p)).res.status}`).toBe(`${p}→426`);
    }
  });

  it("tutto il resto è 404: un relay che risponde a caso invita a frugare", async () => {
    const w = scenaWorker();
    for (const p of ["/", "/d", "/d/", "/d/i/x", "/dd/i", "/x/i", "/d/con spazio", "/d/i%2Fx"]) {
      expect(`${p}→${(await w.collega(p)).res.status}`).toBe(`${p}→404`);
    }
  });

  it("un percorso con `..` si giudica DOPO essere stato ridotto, non prima", async () => {
    // `new URL()` riduce i segmenti — anche quelli codificati — quindi ciò che
    // si confronta col modello è già la forma finale. Vale la pena fissarlo:
    // il giorno in cui il confronto si spostasse sulla stringa grezza, `..`
    // diventerebbe un modo per farsi assegnare un ruolo che il percorso scritto
    // non nomina, e questo caso lo direbbe subito.
    const w = scenaWorker();
    const p = await puntoDIncontro("9");
    const host = await w.macchina(p);
    const finto = await w.collega(`/d/%2e%2e/agent/${p.id}`);
    // La riduzione avviene: è letto come `/agent/:id`, non come una sessione di
    // dispositivo travestita. E lì la porta chiede la preimmagine, che questo
    // non ha — quindi non entra, e soprattutto NON sfratta chi c'era.
    //
    // Prima questo stesso caso finiva con la macchina vera cacciata da una
    // richiesta che aveva solo indovinato un nome scritto in un link.
    expect(finto.res.status).toBe(404);
    expect(host.suo.chiusa).toBeNull();
  });

  it("il nome NON basta per dichiararsi la macchina", async () => {
    // IL DIFETTO CHE QUESTO CHIUDE, e valeva la pena scriverlo per esteso.
    //
    // Il nome del punto d'incontro sta nei link condivisi: chiunque ne abbia
    // ricevuto uno lo conosce. Prima era anche l'unica cosa che serviva per
    // agganciarsi su `/agent/:id` — e siccome un host nuovo SFRATTA quello
    // vecchio (`relay-do.ts`), chi aveva il link poteva cacciare la macchina e
    // mettersi a ricevere il traffico dei suoi ospiti. La macchina si
    // riconnetteva, il ladro pure, e chi vinceva era chi arrivava per ultimo.
    const w = scenaWorker();
    const p = await puntoDIncontro("assediato");
    const vera = await w.macchina(p);
    expect(vera.res.status, "controllo positivo: con la preimmagine si entra").toBe(101);

    // Chi ha SOLO il nome — cioè chiunque abbia ricevuto un link.
    const senza = await w.collega(`/agent/${p.id}`);
    const sbagliato = await w.collega(`/agent/${p.id}`, { [INTESTAZIONE_SEGRETO]: "un-altro-segreto-lungo-abbastanza" });
    // Vuoto e quasi-giusto contano come sbagliati: un digest di stringa vuota è
    // comunque un digest, e senza il rifiuto anticipato verrebbe confrontato.
    const vuoto = await w.collega(`/agent/${p.id}`, { [INTESTAZIONE_SEGRETO]: "" });
    const troncato = await w.collega(`/agent/${p.id}`, { [INTESTAZIONE_SEGRETO]: p.segreto.slice(0, -1) });

    for (const [nome, a] of [["senza", senza], ["sbagliato", sbagliato], ["vuoto", vuoto], ["troncato", troncato]] as const) {
      // Lo stesso corpo di un nome che non esiste: a chi bussa senza la
      // preimmagine non si conferma nemmeno che quel punto d'incontro ci sia.
      expect(`${nome}→${a.res.status}`).toBe(`${nome}→404`);
    }

    // E la cosa che conta davvero: la macchina vera è ancora lì. Il rifiuto
    // arriva PRIMA che il punto d'incontro venga svegliato, quindi nessuno
    // sfratto — un 404 che passasse dopo l'aggancio avrebbe già fatto il danno.
    expect(vera.suo.chiusa, "la macchina vera non è stata cacciata").toBeNull();
    expect(w.nodi.size, "nessun punto d'incontro svegliato dai rifiutati").toBe(1);
  });

  it("le porte degli OSPITI non chiedono niente, ed è deliberato", async () => {
    // Il controllo nuovo vale per una porta sola. Se scivolasse sulle altre due
    // avremmo rotto la condivisione: un ospite arriva con un link e non ha —
    // né deve avere — la preimmagine del nome.
    const w = scenaWorker();
    const p = await puntoDIncontro("ospiti");
    await w.macchina(p);
    expect((await w.collega(`/s/${p.id}`)).res.status).toBe(101);
    expect((await w.collega(`/d/${p.id}`)).res.status).toBe(101);
  });

  it("la pagina dell'ospite resta servita, e non finisce in nessun indice", async () => {
    // Controllo positivo del criterio qui sopra: il Worker una pagina la serve
    // davvero, quindi i 404 non sono «risponde 404 a tutto».
    const w = scenaWorker();
    const r = (await w.semplice("/g/abc/def")).res;
    expect(r.status).toBe(200);
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// IL CANALE DI SESSIONE
// ───────────────────────────────────────────────────────────────────────────

describe("relay-do eseguito · un canale di SESSIONE, non un link", () => {
  it("un dispositivo apre una sessione, e la macchina sa che è un dispositivo", async () => {
    // È la differenza che permette alla macchina di scegliere la postura: un
    // ospite di un link può vedere UNA risorsa, un dispositivo appaiato passa
    // dall'ascoltatore dedicato e si autentica lì. Senza questo campo le due
    // cose arrivano identiche, e chi le riceve deve indovinare dal contenuto —
    // cioè dalla sola cosa che non deve guardare nessuno tranne lui.
    const s = scena();
    const host = await s.collega("host");
    const disp = await s.collega("device");

    expect(disp.res.status).toBe(101);
    const sid = sessioneDi(disp);
    expect(sid.length).toBeGreaterThan(0);
    expect(host.mio.letti().at(-1)).toEqual({ t: "guest-joined", sessionId: sid, ruolo: "device" });
  });

  it("un ospite di un link resta un ospite, e lo dice", async () => {
    const s = scena();
    const host = await s.collega("host");
    const osp = await s.collega("guest");
    expect(host.mio.letti().at(-1)).toEqual({ t: "guest-joined", sessionId: sessioneDi(osp), ruolo: "guest" });
  });

  it("due dispositivi sulla stessa installazione non si mescolano", async () => {
    // Una sessione = un canale. Se il relay instradasse su qualcosa di diverso
    // dall'identificatore assegnato, qui uno dei due riceverebbe la busta
    // dell'altro — ed è il difetto che non si vede finché non c'è un secondo
    // dispositivo.
    const s = scena();
    const host = await s.collega("host");
    const a = await s.collega("device");
    const b = await s.collega("device");
    const sa = sessioneDi(a);
    const sb = sessioneDi(b);
    expect(sa).not.toBe(sb);

    await s.parla(host, { t: "to-guest", to: sa, payload: "PER-A" });
    await s.parla(host, { t: "to-guest", to: sb, payload: "PER-B" });

    expect(a.mio.letti().filter((m) => m.t === "to-guest")).toMatchObject([{ payload: "PER-A" }]);
    expect(b.mio.letti().filter((m) => m.t === "to-guest")).toMatchObject([{ payload: "PER-B" }]);
  });

  it("il dispositivo che se ne va lo dice, e la sua sessione smette di esistere", async () => {
    const s = scena();
    const host = await s.collega("host");
    const disp = await s.collega("device");
    const sid = sessioneDi(disp);

    await s.chiudi(disp);
    expect(host.mio.letti().at(-1)).toEqual({ t: "guest-left", sessionId: sid, ruolo: "device" });

    // E una busta per quella sessione si lascia cadere in silenzio: non è un
    // errore della macchina, è il mondo che è cambiato.
    const prima = disp.mio.arrivati.length;
    await s.parla(host, { t: "to-guest", to: sid, payload: "TARDI" });
    expect(disp.mio.arrivati.length).toBe(prima);
  });

  it("senza macchina non c'è nessuna sessione da aprire", async () => {
    const s = scena();
    const disp = await s.collega("device");
    expect(disp.res.status).toBe(503);
    expect(await disp.res.json()).toEqual({ t: "denied", motivo: "host-offline" });
  });

  it("se la macchina se ne va, i dispositivi collegati lo sanno", async () => {
    const s = scena();
    const host = await s.collega("host");
    const disp = await s.collega("device");
    await s.chiudi(host);
    expect(disp.mio.letti().at(-1)).toEqual({ t: "denied", motivo: "host-offline" });
  });

  it("una seconda macchina sfratta la prima", async () => {
    // Due host sullo stesso oggetto vorrebbe dire due risposte alla stessa
    // domanda, e nessun modo di sapere quale è viva.
    const s = scena();
    const uno = await s.collega("host");
    await s.collega("host");
    expect(uno.suo.chiusa).toMatchObject({ code: 4000 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// I FRAME NEI DUE VERSI, SENZA LEGGERLI
// ───────────────────────────────────────────────────────────────────────────

describe("relay-do eseguito · inoltra nei due versi e non capisce", () => {
  it("dal dispositivo alla macchina, col mittente attaccato dal RELAY", async () => {
    const s = scena();
    const host = await s.collega("host");
    const disp = await s.collega("device");
    const sid = sessioneDi(disp);

    // Un frame del tubo: per il relay è una stringa e basta.
    const dentro = JSON.stringify({ f: "open", s: 1, n: 0, k: "req", h: "GET /api/topics" });
    // `to` inventato dal mittente: il relay non lo deve nemmeno guardare, o un
    // dispositivo potrebbe spacciarsi per un altro.
    await s.parla(disp, { t: "to-host", payload: dentro, to: "SESSIONE-DI-UN-ALTRO" });

    expect(host.mio.letti().at(-1)).toEqual({ t: "to-guest", to: sid, payload: dentro });
  });

  it("dalla macchina al dispositivo, identico byte per byte", async () => {
    const s = scena();
    const host = await s.collega("host");
    const disp = await s.collega("device");
    const sid = sessioneDi(disp);

    const dentro = JSON.stringify({ f: "data", s: 1, n: 3, e: "b", d: "QUESTO-E-CIFRATO" });
    await s.parla(host, { t: "to-guest", to: sid, payload: dentro });

    const arrivato = disp.mio.letti().at(-1);
    expect(arrivato).toEqual({ t: "to-guest", to: sid, payload: dentro });
  });

  it("un payload che NON è JSON passa lo stesso, intero", async () => {
    // La prova che il relay non prova a leggerlo: se lo interpretasse, questo
    // sarebbe un errore invece che una consegna.
    const s = scena();
    const host = await s.collega("host");
    const disp = await s.collega("device");
    const sid = sessioneDi(disp);

    const opaco = "\u0000\u0001 non-è-json { ][ 日本語 🙂";
    await s.parla(disp, { t: "to-host", payload: opaco });
    expect(host.mio.letti().at(-1)).toEqual({ t: "to-guest", to: sid, payload: opaco });

    await s.parla(host, { t: "to-guest", to: sid, payload: opaco });
    expect(disp.mio.letti().at(-1)).toEqual({ t: "to-guest", to: sid, payload: opaco });
  });

  it("i messaggi binari si scartano invece di essere inoltrati", async () => {
    const s = scena();
    const host = await s.collega("host");
    const disp = await s.collega("device");

    const prima = host.mio.arrivati.length;
    await s.oggetto.webSocketMessage(disp.suo as unknown as WebSocket, new ArrayBuffer(8));
    expect(host.mio.arrivati.length).toBe(prima);

    // Controllo positivo: sullo stesso canale una stringa passa. Senza, il
    // «non è arrivato niente» qui sopra proverebbe solo che il canale è morto.
    await s.parla(disp, { t: "to-host", payload: "x" });
    expect(host.mio.arrivati.length).toBe(prima + 1);
  });

  it("un messaggio che non si capisce si nega, e il canale resta vivo", async () => {
    const s = scena();
    const host = await s.collega("host");
    const disp = await s.collega("device");
    const sid = sessioneDi(disp);

    await s.parla(disp, { t: "esegui", comando: "rm -rf /" });
    expect(disp.mio.letti().at(-1)).toEqual({ t: "denied", motivo: "bad-version" });

    await s.parla(disp, { t: "to-host", payload: "dopo" });
    expect(host.mio.letti().at(-1)).toEqual({ t: "to-guest", to: sid, payload: "dopo" });
  });

  it("un dispositivo non può mandare una busta a un altro dispositivo", async () => {
    // `to-guest` è un verbo della MACCHINA. Se un capo di sessione potesse
    // usarlo, il relay diventerebbe una rete fra ospiti — e l'installazione non
    // avrebbe più modo di sapere chi ha parlato con chi.
    const s = scena();
    await s.collega("host");
    const a = await s.collega("device");
    const b = await s.collega("device");

    const prima = b.mio.arrivati.length;
    await s.parla(a, { t: "to-guest", to: sessioneDi(b), payload: "DI-NASCOSTO" });
    expect(b.mio.arrivati.length).toBe(prima);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DUE IMPLEMENTAZIONI, LO STESSO PROTOCOLLO
// ───────────────────────────────────────────────────────────────────────────
/**
 * Il relay finto esiste per tenere onesto il protocollo: finché ci sono due
 * implementazioni, il formato non può scivolare dentro una delle due senza che
 * l'altra smetta di capirlo. Finora però nessuno le aveva mai messe una accanto
 * all'altra sullo STESSO copione — e due implementazioni che non si confrontano
 * mai sono due implementazioni, non una specifica.
 */
describe("relay · il Durable Object e il relay finto dicono la stessa cosa", () => {
  /** I messaggi visti dalla macchina, con l'identificatore reso confrontabile:
   *  uno lo genera `crypto.randomUUID`, l'altro è un contatore. */
  const normalizza = (visti: MessaggioRelay[], sid: string) =>
    JSON.parse(JSON.stringify(visti).split(sid).join("SID")) as unknown[];

  it("lo stesso copione, la stessa sequenza dal lato della macchina", async () => {
    // ── Il Durable Object vero.
    const s = scena();
    const hostVero = await s.collega("host");
    const dispVero = await s.collega("device");
    const sidVero = sessioneDi(dispVero);
    await s.parla(dispVero, { t: "to-host", payload: "BUSTA-OPACA" });
    await s.chiudi(dispVero);

    // ── Il relay finto, stessa scena.
    const finto = creaRelayFinto();
    const hostFinto: MessaggioRelay[] = [];
    const capoFinto = finto.collegaMacchina((m) => hostFinto.push(m));
    capoFinto.ricevi({ t: "hello", v: 1, installationId: "i1", token: "tok" });
    const dispFinto = finto.collegaDispositivo("i1", () => {});
    const sidFinto = dispFinto.sessionId() ?? "";
    dispFinto.ricevi({ t: "to-host", payload: "BUSTA-OPACA" });
    dispFinto.scollega();

    // Controllo POSITIVO: le due sequenze non sono vuote e nominano davvero
    // una sessione, altrimenti «sono uguali» sarebbe l'uguaglianza di due
    // nienti.
    const vero = normalizza(hostVero.mio.letti(), sidVero);
    const fake = normalizza(hostFinto, sidFinto);
    expect(sidVero.length).toBeGreaterThan(0);
    expect(sidFinto.length).toBeGreaterThan(0);
    expect(vero).toMatchObject([
      { t: "ready" },
      { t: "guest-joined", sessionId: "SID", ruolo: "device" },
      { t: "to-guest", to: "SID", payload: "BUSTA-OPACA" },
      { t: "guest-left", sessionId: "SID", ruolo: "device" },
    ]);
    expect(fake).toEqual(vero);
  });
});
