/**
 * La macchina che CHIAMA FUORI.
 *
 * ── LA FORMA, E PERCHÉ NON È UN TUNNEL ──────────────────────────────────────
 * Non si apre nessuna porta, non si inoltra niente sul router, non serve un
 * DNS. È questa macchina ad aprire una connessione verso il relay e a dire
 * «sono io, sono viva». È ciò che fanno tutti i prodotti di questa categoria, e
 * il motivo per cui nessuno di loro nomina mai la parola «tunnel»: non c'è
 * niente da esporre.
 *
 * ── COSA VIAGGIA, E COSA NO ─────────────────────────────────────────────────
 * Sul filo passano richieste e risposte CIFRATE fra questa macchina e il
 * browser dell'ospite. Il relay instrada e non capisce: la chiave sta nel
 * frammento del link, che il browser non manda a nessun server.
 *
 * ── ARRIVARE NON È ESSERE AUTORIZZATI (RELAY-04) ────────────────────────────
 * Un ospite che arriva dal relay non diventa nessuno. Il link è una CAPACITÀ su
 * UNA risorsa: si serve quella e nient'altro, e la verifica non passa da un
 * ruolo o da una sessione ma dalla riga di `share_links`. Non c'è nessuna
 * scorciatoia di fiducia — è la stessa lezione del tunnel, dove «arriva da
 * loopback» significava «è il padrone di casa».
 */
import { apri, sigilla } from "../../shared/relay-crypto";
import {
  leggiMessaggio, leggiFramePayload, scriviFrame,
  componiStream, creaContatoreStream, creaRiassemblatore, creaCapoCanale, dividiBinario, ricaricaPer,
  RELAY_PROTOCOL_VERSION, TUBO_BYTE_PER_FRAME,
  type FrameTubo, type MessaggioRelay, type MotivoStream,
} from "../../shared/relay-protocol";
import {
  GENERE_RICHIESTA, GENERE_RISPOSTA, intestazioniRichiesta, intestazioniRisposta,
  leggiTestaRichiesta, risolviUrlLocale, scriviTesta, type Intestazioni,
} from "../../shared/relay-http";
import {
  GENERE_WS, GENERE_WS_APERTO, GENERE_WS_CHIUSO, WS_APERTO,
  WS_CHIUSURA_ANOMALA, WS_CHIUSURA_NORMALE,
  codiceInviabile, intestazioniUpgrade, leggiChiusuraWs, leggiTestaWs, leggiTestaWsChiuso,
  scriviChiusuraWs, scriviTestaWs, type ChiusuraWs,
} from "../../shared/relay-ws";

export interface RichiestaOspite {
  /** Cosa vuole. Una sola forma: «dammi la cosa di questo link».
   *
   *  Resta accanto al proxy e non al suo posto: la pagina dell'ospite servita
   *  dal Worker parla ANCORA questo verbo, e toglierlo qui non la aggiorna —
   *  la lascia a parlare con un capo che non risponde più. Le due grammatiche
   *  sono disgiunte (un frame ha `f` e `s`, questa busta ha `ref` e `b`),
   *  quindi la porta è una sola e non c'è niente da indovinare. */
  t: "fetch";
}

export interface RispostaOspite {
  status: number;
  body: unknown;
}

export interface LinkCondivisione {
  ref: string;
  key: string;
  resourceType: "task" | "topic";
  resourceId: string;
  expiresAt: number;
  revokedAt: number | null;
}

export interface RelayDeps {
  /** L'URL del relay, senza percorso. `null` = spento, e allora questo modulo
   *  non fa niente: il relay è un di più, mai la strada del lavoro locale. */
  baseUrl: string | null;
  /** Identifica questa installazione presso il relay. Non è un segreto che
   *  apre qualcosa: è un nome. Ciò che protegge una risorsa è il link. */
  installationId: string;
  /** Il link, se esiste ed è ancora buono. `null` fa rispondere «non trovato»
   *  senza distinguere scaduto da inesistente — vedi sotto. */
  trovaLink(ref: string): LinkCondivisione | null;
  /** Il contenuto da servire. È la stessa strada dei dati locali: qui non si
   *  duplica nessuna regola di permesso. */
  serviRisorsa(l: LinkCondivisione): Promise<RispostaOspite>;
  /** Segna un'apertura. Non è statistica: è l'unico modo per accorgersi che un
   *  link è finito dove non doveva. */
  segnaApertura(ref: string): void;
  /**
   * La porta dell'ascoltatore dedicato — `TOPICS_TUNNEL_PORT`, letta da
   * `tunnelPort()`. `null` = raggiungibilità da fuori non configurata, e allora
   * una richiesta arrivata dal relay si RIFIUTA dicendolo.
   *
   * Non si inventa una porta e non si cade su 3333: quella è la porta di cui
   * ogni richiesta è LOCALE, cioè proprietaria senza credenziali
   * (`server/lib/tunnel.ts`). Indovinarla qui vorrebbe dire far entrare
   * Internet come padrone di casa — il rovesciamento esatto che l'ascoltatore
   * dedicato esiste per impedire.
   */
  portaTunnel?: number | null;
  /** Iniettabile per i test. */
  now?: () => number;
  apriSocket?: (url: string) => WebSocket;
  fetchLocale?: typeof fetch;
  /** Come si apre un socket verso l'ascoltatore del tunnel. Iniettabile per la
   *  stessa ragione di `fetchLocale`: un test deve poter guardare la stretta di
   *  mano, non solo il suo esito. */
  apriSocketLocale?: ApriSocketLocale;
  /** La finestra iniziale di un canale, e quanto si tiene in coda quando è
   *  chiusa. Abbassabili nei test: un «fermati» si deve poter provocare senza
   *  mezzo MiB di terminale. */
  credito?: number;
  arretratoMax?: number;
  /** Byte di contenuto per frame. Abbassabile nei test, dove uno stream
   *  spezzato in venti frame si scrive in una riga invece che in mezzo MiB. */
  maxFrame?: number;
  log?: (m: string) => void;
}

// ───────────────────────────────────────────────────────────────────────────
// IL PROXY: una richiesta arrivata dal tubo, rigiocata sulla porta del tunnel
// ───────────────────────────────────────────────────────────────────────────
/**
 * ── PERCHÉ È UN PROXY E NON UN SECONDO SERVER ───────────────────────────────
 * `server.ts` alza già un `Bun.serve` COMPLETO sulla porta del tunnel: stesse
 * rotte, stesso upgrade dei WebSocket, stessi file statici, e — la parte che
 * conta — chi entra da lì non è locale per definizione. Quindi qui non si
 * reimplementa niente: si prende ciò che è arrivato dal relay e lo si RIGIOCA
 * contro `127.0.0.1:<porta>`. Tutta la postura di fiducia, il confinamento
 * degli ospiti e l'appaiamento si ereditano invece di essere riscritti — ed è
 * l'unico modo perché restino UNA regola sola. Una seconda copia sarebbe due
 * risposte alla stessa domanda, e quella dimenticata sarebbe il buco.
 *
 * ── PERCHÉ IL CORPO TORNA A PEZZI ───────────────────────────────────────────
 * Perché una risposta non è sempre un oggetto: è anche uno stream di eventi che
 * dura quanto un turno. Accumularla per mandarla intera vorrebbe dire che da
 * fuori la chat non si vede scrivere — arriva tutta insieme alla fine, cioè il
 * prodotto smette di essere quello. Si legge il corpo mentre arriva e si emette
 * un frame per pezzo, tenendone UNO in canna: `fin` va sull'ultimo, e l'ultimo
 * si conosce solo quando ne è arrivato un altro (o quando il corpo finisce).
 */

/** Quante richieste possono essere in volo insieme su UNA sessione ospite.
 *  Senza tetto, aprire e non chiudere è un modo gratuito per tenere occupata
 *  la macchina di qualcun altro. */
const MAX_IN_VOLO = 32;
/** Quante sessioni ospiti si tengono. Il `to` lo sceglie il relay, e un relay
 *  che ne inventasse infinite farebbe crescere questa mappa per sempre. */
const MAX_SESSIONI = 64;
/**
 * Quanti WebSocket può tenere aperti UNA sessione ospite.
 *
 * Il client ne apre quattro generi — l'applicazione, un terminale per pannello,
 * un browser per pannello — quindi la misura non è due; ma un socket aperto è
 * un socket vero contro l'ascoltatore, e senza tetto una sessione da fuori rete
 * può tenerne quanti ne vuole senza mai parlarci.
 */
const MAX_SOCKET = 16;

/**
 * Il codice con cui muore un socket che l'ospite non riesce a consumare.
 *
 * `1013` — «riprova più tardi» — e non `1011`: non è un guasto della macchina,
 * è una rete che non ce la fa. Chi lo riceve deve poter decidere di
 * riconnettersi, e un codice che dice «errore interno» lo manderebbe a cercare
 * un guasto che non c'è.
 */
const WS_TROPPO_ARRETRATO = 1013;

/**
 * Cosa è arrivato dal socket vero, in una forma sola.
 *
 * Le implementazioni consegnano stringhe, `ArrayBuffer` o viste su un buffer, e
 * una vista NON è il suo buffer: `new Uint8Array(view.buffer)` prende tutto il
 * buffer, che può essere più grande — è il modo classico per far uscire byte
 * che non appartenevano a questo messaggio.
 */
function normalizza(d: unknown): string | Uint8Array | null {
  if (typeof d === "string") return d;
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return null;
}

/**
 * Come si apre un socket verso l'ascoltatore del tunnel.
 *
 * Iniettabile perché i test possano guardarci dentro; il valore vero è un
 * `WebSocket` di Bun, che accetta le intestazioni — ed è l'unico modo per
 * portare il biscotto dell'appaiamento fino alla stretta di mano, cioè per
 * ereditare l'identità invece di riscriverla.
 */
export type ApriSocketLocale = (
  url: string,
  o: { intestazioni: Intestazioni; protocolli: string[] },
) => WebSocket;

const apriSocketLocaleVero: ApriSocketLocale = (url, o) => {
  const opzioni: Record<string, unknown> = { headers: Object.fromEntries(o.intestazioni) };
  if (o.protocolli.length > 0) opzioni.protocols = o.protocolli;
  // Il tipo del DOM vuole i soli sottoprotocolli come secondo argomento; Bun
  // accetta un oggetto di opzioni, ed è il solo modo di far viaggiare le
  // intestazioni. Il cast dice esattamente questo e niente di più.
  return new WebSocket(url, opzioni as unknown as string[]);
};

export interface ProxyTuboDeps {
  /** `null` = non configurata: si rifiuta in modo dichiarato. */
  portaTunnel: number | null;
  /** Dove finisce un frame già serializzato, per la sessione `sid`. */
  invia(sid: string, payload: string): void;
  fetchLocale?: typeof fetch;
  apriSocketLocale?: ApriSocketLocale;
  max?: number;
  maxStream?: number;
  maxByteStream?: number;
  maxInVolo?: number;
  maxSocket?: number;
  /** Quanti byte si tengono in coda per un socket che non riceve credito. */
  arretratoMax?: number;
  /** La finestra iniziale di un canale. Abbassabile nei test, dove un
   *  «fermati» si deve poter provocare senza mezzo MiB di terminale. */
  credito?: number;
  log?: (m: string) => void;
}

/**
 * Un WebSocket dell'ospite, e il socket vero che gli corrisponde.
 *
 * `sIn` — lo stream del canale dell'OSPITE — è il nome del socket per tutti e
 * due i capi: un identificatore solo, e nessuna tabella da tenere d'accordo.
 */
interface SocketProxy {
  sIn: number;
  /** Lo stream del canale della MACCHINA. È quello che l'ospite nomina quando
   *  restituisce credito, quindi serve una mappa che parta da lui. */
  sOut: number;
  su: WebSocket | null;
  /** Il canale della macchina verso l'ospite, con la sua finestra. */
  canale: ReturnType<typeof creaCapoCanale>;
  /** Quello che l'ospite ha mandato prima che il socket vero fosse aperto. Non
   *  si butta: l'ospite lo ha già pagato in credito, e perderlo si vedrebbe
   *  come un comando che non ha fatto niente. */
  coda: Array<{ d: string | Uint8Array; byte: number }>;
  /** La stretta di mano è riuscita: serve a distinguere «l'upgrade è stato
   *  rifiutato» da «il socket è stato chiuso», che per chi guarda da fuori
   *  sono due cose diverse. */
  su_aperto: boolean;
  /** La chiusura è già stata dichiarata: non se ne manda una seconda. */
  finito: boolean;
}

interface SessioneOspite {
  rias: ReturnType<typeof creaRiassemblatore>;
  prossimo: () => number;
  /** Le richieste in volo, per stream della RICHIESTA: è quello che l'ospite
   *  nomina quando rinuncia. */
  inVolo: Map<number, AbortController>;
  /** I socket vivi, per stream del canale dell'ospite. */
  socket: Map<number, SocketProxy>;
  /** …e gli stessi, per stream del canale della macchina: è da lì che arriva
   *  il credito, e cercarlo scorrendo tutti i socket sarebbe un giro lineare
   *  su ogni ricarica. */
  perCanale: Map<number, SocketProxy>;
}

export function creaProxyTubo(deps: ProxyTuboDeps) {
  const max = deps.max ?? TUBO_BYTE_PER_FRAME;
  const maxInVolo = deps.maxInVolo ?? MAX_IN_VOLO;
  const maxSocket = deps.maxSocket ?? MAX_SOCKET;
  const log = deps.log ?? (() => {});
  const f = deps.fetchLocale ?? fetch;
  const apriSocketLocale = deps.apriSocketLocale ?? apriSocketLocaleVero;
  const sessioni = new Map<string, SessioneOspite>();

  const manda = (sid: string, fr: FrameTubo) => deps.invia(sid, scriviFrame(fr));

  function nuovaSessione(): SessioneOspite {
    return {
      rias: creaRiassemblatore({
        latoRemoto: "guest",
        ...(deps.maxStream !== undefined ? { maxStream: deps.maxStream } : {}),
        ...(deps.maxByteStream !== undefined ? { maxByteStream: deps.maxByteStream } : {}),
      }),
      prossimo: creaContatoreStream("host"),
      inVolo: new Map(),
      socket: new Map(),
      perCanale: new Map(),
    };
  }

  /**
   * La corsia di RISPOSTA di una richiesta.
   *
   * Tiene un pezzo in canna perché `fin` deve stare sull'ultimo frame, e quale
   * sia l'ultimo si sa solo dopo. La testa viaggia sull'`open`, insieme al
   * primo pezzo: una risposta piccola diventa UN frame invece di due, e su un
   * Durable Object che si paga a messaggio la differenza non è estetica.
   */
  function apriUscita(sid: string, sOut: number, testa: string) {
    let n = 0;
    let aperto = false;
    let pendente: string | null = null;
    let finito = false;

    const emetti = (d: string, fin: boolean) => {
      if (!aperto) {
        aperto = true;
        manda(sid, { f: "open", s: sOut, n: 0, k: GENERE_RISPOSTA, h: testa, e: "b", d, ...(fin ? { fin: true } : {}) });
        return;
      }
      n += 1;
      manda(sid, { f: "data", s: sOut, n, e: "b", d, ...(fin ? { fin: true } : {}) });
    };

    return {
      pezzo(d: string) {
        if (finito) return;
        if (pendente !== null) emetti(pendente, false);
        pendente = d;
      },
      finisci() {
        if (finito) return;
        finito = true;
        if (pendente !== null) { emetti(pendente, true); pendente = null; return; }
        // Nessun pezzo: una risposta senza corpo è un `open` con `fin`, e non
        // uno stream che non arriva mai.
        if (!aperto) {
          aperto = true;
          manda(sid, { f: "open", s: sOut, n: 0, k: GENERE_RISPOSTA, h: testa, fin: true });
        }
      },
      /** Il corpo si è rotto a metà. Se non è ancora uscito niente si apre lo
       *  stesso — senza l'`open` l'ospite non saprebbe A QUALE richiesta
       *  appartiene questa morte, e resterebbe ad aspettare per sempre. */
      annulla(motivo: MotivoStream) {
        if (finito) return;
        finito = true;
        if (!aperto) {
          aperto = true;
          manda(sid, { f: "open", s: sOut, n: 0, k: GENERE_RISPOSTA, h: testa });
        }
        manda(sid, { f: "reset", s: sOut, motivo });
      },
    };
  }

  /** Una risposta corta, tutta insieme: i rifiuti dichiarati. */
  function rispondiSubito(sid: string, sess: SessioneOspite, re: number, stato: number, errore: string) {
    const corpo = new TextEncoder().encode(JSON.stringify({ error: errore }));
    const u = apriUscita(sid, sess.prossimo(), scriviTesta({
      re, s: stato, h: [["content-type", "application/json"]],
    }));
    for (const p of dividiBinario(corpo, max)) u.pezzo(p);
    u.finisci();
  }

  async function serviRichiesta(
    sid: string, sess: SessioneOspite, s: number,
    testaGrezza: string | undefined, corpo: string | Uint8Array | undefined,
  ): Promise<void> {
    const t = leggiTestaRichiesta(testaGrezza);
    if (!t) { manda(sid, { f: "reset", s, motivo: "bad-frame" }); return; }

    if (deps.portaTunnel === null) {
      // Dichiarato, non inventato: senza l'ascoltatore dedicato non esiste
      // nessuna porta a cui rigiocare questa richiesta SENZA farla passare per
      // locale, e «locale» qui vuol dire proprietario senza credenziali.
      log("[relay] richiesta dal relay rifiutata: TOPICS_TUNNEL_PORT non e' impostata");
      rispondiSubito(sid, sess, s, 503, "remote-access-not-configured");
      return;
    }

    const url = risolviUrlLocale(deps.portaTunnel, t.p);
    // Un percorso che sceglie un'altra destinazione non è una richiesta storta:
    // è un tentativo di usare questa macchina come ponte verso il resto della
    // sua rete.
    if (!url) { rispondiSubito(sid, sess, s, 400, "bad-path"); return; }

    if (sess.inVolo.size >= maxInVolo) { manda(sid, { f: "reset", s, motivo: "too-many-streams" }); return; }

    const ferma = new AbortController();
    sess.inVolo.set(s, ferma);
    try {
      const senzaCorpo = t.m === "GET" || t.m === "HEAD";
      const res = await f(url, {
        method: t.m,
        headers: new Headers(intestazioniRichiesta(t.h)),
        ...(senzaCorpo || corpo === undefined ? {} : { body: corpo as BodyInit }),
        redirect: "manual",
        signal: ferma.signal,
      });

      // `set-cookie` si prende a parte: iterando le intestazioni compare una
      // volta sola, con i valori uniti da virgola — e una data di scadenza
      // contiene una virgola, quindi rimetterli insieme non è più possibile a
      // valle. È esattamente il biscotto dell'appaiamento.
      const coppie: Intestazioni = [];
      for (const [n, v] of res.headers) {
        if (n.toLowerCase() !== "set-cookie") coppie.push([n, v]);
      }
      for (const c of res.headers.getSetCookie?.() ?? []) coppie.push(["set-cookie", c]);

      const u = apriUscita(sid, sess.prossimo(), scriviTesta({
        re: s, s: res.status, h: intestazioniRisposta(coppie),
      }));

      const flusso = res.body;
      if (!flusso) { u.finisci(); return; }
      const lettore = flusso.getReader();
      try {
        for (;;) {
          const { done, value } = await lettore.read();
          if (done) break;
          if (ferma.signal.aborted) { await lettore.cancel().catch(() => {}); u.annulla("aborted"); return; }
          if (value && value.length > 0) for (const p of dividiBinario(value, max)) u.pezzo(p);
        }
        u.finisci();
      } catch {
        // Il corpo si è interrotto a metà: la testa è già partita, quindi
        // l'unica cosa onesta è chiudere QUELLA corsia.
        u.annulla("aborted");
      }
    } catch {
      // Non è stato possibile nemmeno parlare con l'ascoltatore: il server è
      // giù, o si è rinunciato. Un 502 lo dice; il silenzio no.
      if (!ferma.signal.aborted) rispondiSubito(sid, sess, s, 502, "upstream-unreachable");
    } finally {
      sess.inVolo.delete(s);
    }
  }

  // ── I WEBSOCKET ──────────────────────────────────────────────────────────
  /**
   * ── PERCHÉ UN SOCKET È DUE CANALI E UN NOME SOLO ────────────────────────
   * I numeri di stream sono spartiti per parità, quindi nessuno dei due capi
   * può scrivere sulla corsia dell'altro: un socket è perciò una COPPIA di
   * canali. Il nome, per tutti e due, è lo stream dell'OSPITE — così non c'è
   * nessuna tabella di corrispondenza da tenere d'accordo, e una chiusura che
   * arriva dai due lati insieme parla della stessa cosa.
   *
   * ── PERCHÉ LA CODA VERSO L'ALTO NON HA BISOGNO DI UN TETTO ──────────────
   * Perché il credito lo si restituisce DOPO aver consegnato al socket vero:
   * finché la stretta di mano non è finita non torna niente, e la finestra
   * dell'ospite si chiude da sola. È lo stesso meccanismo del verso opposto,
   * guardato dall'altra parte.
   */

  /** La chiusura, con codice e motivo, su uno stream suo. Un `reset` del tubo
   *  ha solo una parola di un vocabolario che parla del TUBO: buttare via
   *  «1000 normale» contro «1011 errore» vorrebbe dire che da fuori rete ogni
   *  chiusura si legge uguale, e chi si riconnette non sa se deve. */
  function dichiaraChiusura(sid: string, sess: SessioneOspite, sIn: number, c: ChiusuraWs) {
    for (const fr of componiStream({
      s: sess.prossimo(), k: GENERE_WS_CHIUSO,
      h: scriviTestaWs({ w: sIn }), dati: scriviChiusuraWs(c), max,
    })) manda(sid, fr);
  }

  /**
   * Il socket muore, e lo si dice una volta sola.
   *
   * `finito` si alza PRIMA di toccare il socket vero, e non è pignoleria:
   * `close()` può far scattare il proprio evento dentro la stessa pila di
   * chiamate, e allora `onclose` rientrerebbe qui a dichiarare una SECONDA
   * chiusura — quella del filo, senza codice — che arriva all'ospite prima di
   * quella vera e la copre. Si vede solo come un motivo che sparisce.
   */
  function chiudiSocket(
    sid: string, sess: SessioneOspite, sk: SocketProxy,
    opts: { chiusura?: ChiusuraWs; avvisa?: boolean; chiudiSu?: ChiusuraWs } = {},
  ) {
    if (sk.finito) return;
    sk.finito = true;
    sess.socket.delete(sk.sIn);
    sess.perCanale.delete(sk.sOut);
    // Il canale dell'ospite non lo chiude nessun altro: senza questo resta
    // dentro il riassemblatore per tutta la sessione, e i canali hanno un
    // tetto.
    sess.rias.dimentica(sk.sIn);
    if (opts.avvisa !== false) {
      if (opts.chiusura) dichiaraChiusura(sid, sess, sk.sIn, opts.chiusura);
      sk.canale.chiudi("aborted");
      manda(sid, { f: "reset", s: sk.sIn, motivo: "aborted" });
    }
    try {
      if (opts.chiudiSu) sk.su?.close(opts.chiudiSu.c, opts.chiudiSu.r);
      else sk.su?.close();
    } catch { /* già chiusa */ }
    sk.su = null;
  }

  /** Un messaggio dell'ospite verso il socket vero, e il credito che torna
   *  indietro. Il credito si restituisce solo DOPO la consegna: prima sarebbe
   *  una promessa su qualcosa che non è ancora successo. */
  function versoAlto(sid: string, sk: SocketProxy, d: string | Uint8Array, byte: number): boolean {
    try {
      // Il tipo del DOM vuole `string | ArrayBufferLike | Blob`; un
      // `Uint8Array` è una vista, ed è ciò che `send` accetta davvero.
      sk.su?.send(d as string);
    } catch {
      return false;
    }
    manda(sid, ricaricaPer(sk.sIn, byte));
    return true;
  }

  function apriSocket(sid: string, sess: SessioneOspite, sIn: number, testaGrezza: string | undefined) {
    const scarta = (motivo: MotivoStream) => {
      manda(sid, { f: "reset", s: sIn, motivo });
      sess.rias.dimentica(sIn);
    };

    const t = leggiTestaWs(testaGrezza);
    if (!t) { scarta("bad-frame"); return; }
    if (sess.socket.size >= maxSocket) { scarta("too-many-streams"); return; }

    const sOut = sess.prossimo();
    const canale = creaCapoCanale({
      s: sOut,
      invia: (fr) => manda(sid, fr),
      max,
      ...(deps.credito !== undefined ? { credito: deps.credito } : {}),
      ...(deps.arretratoMax !== undefined ? { arretratoMax: deps.arretratoMax } : {}),
    });
    const sk: SocketProxy = { sIn, sOut, su: null, canale, coda: [], su_aperto: false, finito: false };
    sess.socket.set(sIn, sk);
    sess.perCanale.set(sOut, sk);

    /** L'apertura non è riuscita. Il canale della macchina si apre LO STESSO,
     *  perché è l'unico posto in cui l'ospite può leggere PERCHÉ: senza,
     *  resterebbe ad aspettare un socket che non arriverà mai. */
    const rifiuta = (stato: number) => {
      if (sk.finito) return;
      canale.apri(GENERE_WS_APERTO, scriviTestaWs({ re: sIn, s: stato }));
      chiudiSocket(sid, sess, sk);
    };

    if (deps.portaTunnel === null) {
      // Dichiarato, non inventato: la porta di casa è quella di cui ogni
      // richiesta è locale, cioè proprietaria senza credenziali.
      log("[relay] socket dal relay rifiutato: TOPICS_TUNNEL_PORT non e' impostata");
      rifiuta(503);
      return;
    }
    const url = risolviUrlLocale(deps.portaTunnel, t.p);
    // Un percorso che sceglie un'altra destinazione non è un percorso storto:
    // è un tentativo di usare questa macchina come ponte verso il resto della
    // sua rete. Il cancello è lo stesso delle richieste, di proposito.
    if (!url) { rifiuta(400); return; }

    let su: WebSocket;
    try {
      su = apriSocketLocale(url.toString().replace(/^http/, "ws"), {
        intestazioni: intestazioniUpgrade(t.h),
        protocolli: t.sp ?? [],
      });
    } catch {
      rifiuta(502);
      return;
    }
    sk.su = su;
    try { su.binaryType = "arraybuffer"; } catch { /* non tutte le implementazioni lo espongono */ }

    su.onopen = () => {
      if (sk.finito) { try { su.close(); } catch { /* già chiusa */ } return; }
      sk.su_aperto = true;
      const scelto = typeof su.protocol === "string" && su.protocol.length > 0 ? su.protocol : undefined;
      canale.apri(GENERE_WS_APERTO, scriviTestaWs({
        re: sIn, s: WS_APERTO, ...(scelto !== undefined ? { sp: scelto } : {}),
      }));
      for (const q of sk.coda.splice(0)) versoAlto(sid, sk, q.d, q.byte);
    };

    su.onmessage = (ev) => {
      if (sk.finito) return;
      const dato = normalizza((ev as { data: unknown }).data);
      if (dato === null) return;
      // `troppo` vuol dire che l'ospite non consuma e la coda ha sfondato il
      // tetto. Un guasto dichiarato è meglio di una memoria che cresce senza
      // che nessuno sappia perché.
      if (canale.manda(dato) === "troppo") {
        chiudiSocket(sid, sess, sk, { chiusura: { c: WS_TROPPO_ARRETRATO, r: "backpressure" } });
      }
    };

    su.onerror = () => {
      if (sk.su_aperto) return; // ci pensa `onclose`, che porta anche il codice
      rifiuta(502);
    };

    su.onclose = (ev) => {
      if (!sk.su_aperto) { rifiuta(502); return; }
      const e = ev as unknown as { code?: unknown; reason?: unknown };
      const codice = typeof e.code === "number" && Number.isInteger(e.code) && e.code >= 1000 && e.code <= 4999
        ? e.code
        : WS_CHIUSURA_ANOMALA;
      const motivo = typeof e.reason === "string" ? e.reason.slice(0, 512) : "";
      chiudiSocket(sid, sess, sk, { chiusura: { c: codice, r: motivo } });
    };
  }

  /** L'ospite chiude: si gira al socket vero il codice che ha chiesto, quando
   *  è un codice che si può mandare. `1006` non lo si può — è quello che il
   *  browser produce da solo — e girarlo sarebbe un'eccezione al posto di una
   *  chiusura. */
  function chiusuraDallOspite(sid: string, sess: SessioneOspite, s: number, testa: string | undefined, corpo: string | Uint8Array) {
    const t = leggiTestaWsChiuso(testa);
    const c = leggiChiusuraWs(corpo);
    if (!t || !c) { manda(sid, { f: "reset", s, motivo: "bad-frame" }); return; }
    const sk = sess.socket.get(t.w);
    // Un socket già morto non è un errore: i due capi possono chiudere nello
    // stesso istante e nessuno dei due ha sbagliato.
    if (!sk) return;
    chiudiSocket(sid, sess, sk, {
      avvisa: false,
      chiudiSu: { c: codiceInviabile(c.c) ? c.c : WS_CHIUSURA_NORMALE, r: c.r },
    });
  }

  function fermaVolo(sess: SessioneOspite, s: number) {
    const c = sess.inVolo.get(s);
    if (!c) return;
    sess.inVolo.delete(s);
    try { c.abort(); } catch { /* già fermato */ }
  }

  function ospiteUscito(sid: string): void {
    const sess = sessioni.get(sid);
    if (!sess) return;
    sessioni.delete(sid);
    for (const s of [...sess.inVolo.keys()]) fermaVolo(sess, s);
    // I socket veri restano aperti finché non li si chiude: nessuno li chiude
    // di suo perché l'ospite se n'è andato, e un terminale che continua a
    // scrivere verso nessuno è un processo che nessuno ferma più. Non si
    // avvisa: la corsia su cui avvisare è proprio quella che non c'è più.
    for (const sk of [...sess.socket.values()]) chiudiSocket(sid, sess, sk, { avvisa: false });
  }

  return {
    /** Un frame arrivato per la sessione `sid`. */
    riceviFrame(sid: string, fr: FrameTubo): void {
      let sess = sessioni.get(sid);
      if (!sess) {
        if (sessioni.size >= MAX_SESSIONI) {
          manda(sid, { f: "reset", s: fr.s, motivo: "too-many-streams" });
          return;
        }
        sess = nuovaSessione();
        sessioni.set(sid, sess);
      }

      const e = sess.rias.ricevi(fr);
      switch (e.esito) {
        case "completo":
          if (e.k === GENERE_WS_CHIUSO) { chiusuraDallOspite(sid, sess, e.s, e.h, e.dati); return; }
          // Un genere che non si conosce chiude QUELLO stream invece di far
          // cadere la sessione: è il punto di estensione del tubo.
          if (e.k !== GENERE_RICHIESTA) { manda(sid, { f: "reset", s: e.s, motivo: "bad-frame" }); return; }
          void serviRichiesta(sid, sess, e.s, e.h, e.dati);
          return;
        case "aperto":
          // Un canale è un socket, e uno stream normale una richiesta: le due
          // forme non si scambiano di posto. Un `req` come canale non
          // finirebbe mai, e un `ws` senza canale consegnerebbe un socket
          // intero alla sua chiusura.
          if (e.canale) {
            if (e.k === GENERE_WS) { apriSocket(sid, sess, e.s, e.h); return; }
            sess.rias.dimentica(e.s);
            manda(sid, { f: "reset", s: e.s, motivo: "bad-frame" });
            return;
          }
          if (e.k !== GENERE_RICHIESTA) {
            sess.rias.dimentica(e.s);
            manda(sid, { f: "reset", s: e.s, motivo: "bad-frame" });
          }
          return;
        case "messaggio": {
          const sk = sess.socket.get(e.s);
          if (!sk || sk.finito) { manda(sid, { f: "reset", s: e.s, motivo: "bad-frame" }); return; }
          // Il credito NON torna finché il messaggio non è stato consegnato:
          // è così che la stretta di mano ancora in corso stringe da sola la
          // finestra dell'ospite, senza nessun tetto scritto a parte.
          if (sk.su_aperto) versoAlto(sid, sk, e.dati, e.byte);
          else sk.coda.push({ d: e.dati, byte: e.byte });
          return;
        }
        case "credito": {
          const sk = sess.perCanale.get(e.s);
          // Credito per uno stream che non è un canale vivo: non c'è niente da
          // ricaricare, e non è un errore — può essere arrivato dopo la
          // chiusura.
          if (sk) sk.canale.ricarica(e.c);
          return;
        }
        case "errore": {
          fermaVolo(sess, e.s);
          const sk = sess.socket.get(e.s);
          if (sk) chiudiSocket(sid, sess, sk, { avvisa: false });
          manda(sid, { f: "reset", s: e.s, motivo: e.motivo });
          return;
        }
        case "chiuso": {
          fermaVolo(sess, e.s);
          const sk = sess.socket.get(e.s);
          // L'ospite ha chiuso la sua corsia senza dichiarare un codice: per
          // il socket vero è una caduta, e si chiude senza rimandare indietro
          // niente su una corsia che non c'è più.
          if (sk) chiudiSocket(sid, sess, sk, { avvisa: false });
          return;
        }
        default:
          return; // «parziale»: il pezzo è arrivato, la richiesta non ancora
      }
    },

    /** L'ospite se n'è andato: ciò che stava aspettando non lo aspetta più. */
    ospiteUscito,

    /** Il filo è caduto: nessuna delle risposte in volo ha più dove andare. */
    chiudiTutto(): void {
      for (const sid of [...sessioni.keys()]) ospiteUscito(sid);
    },

    sessioniAperte: () => sessioni.size,
    /** Test-only: quante richieste sono davvero in volo. */
    __inVolo: (sid: string) => sessioni.get(sid)?.inVolo.size ?? 0,
    /** Test-only: quanti socket sono vivi per una sessione. */
    __socket: (sid: string) => sessioni.get(sid)?.socket.size ?? 0,
  };
}

/** Attese fra un tentativo e l'altro. Crescono e si fermano: insistere ogni
 *  secondo su un relay giù è rumore, e la macchina intanto lavora lo stesso. */
const ATTESE = [1_000, 2_000, 5_000, 15_000, 60_000];

export function creaRelayClient(deps: RelayDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  let ws: WebSocket | null = null;
  let tentativo = 0;
  let fermato = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Serve una richiesta di un ospite.
   *
   * Il rifiuto è UNO SOLO per ogni modo di fallire — link inesistente, scaduto,
   * revocato, busta illeggibile. Distinguerli racconterebbe a chi prova quale
   * dei quattro gli è capitato, e da lì si costruisce un oracolo: «questo ref
   * esiste ma è scaduto» è un'informazione che non si deve poter comprare
   * tirando a indovinare.
   */
  async function servi(ref: string, bustaCifrata: string): Promise<{ chiave: string; risposta: RispostaOspite } | null> {
    const l = deps.trovaLink(ref);
    if (!l) return null;
    if (l.revokedAt !== null || l.expiresAt <= now()) return null;

    const chiaro = await apri(l.key, bustaCifrata);
    if (chiaro === null) return null;

    let richiesta: RichiestaOspite;
    try { richiesta = JSON.parse(chiaro) as RichiestaOspite; } catch { return null; }
    if (richiesta?.t !== "fetch") return null;

    deps.segnaApertura(ref);
    return { chiave: l.key, risposta: await deps.serviRisorsa(l) };
  }

  const proxy = creaProxyTubo({
    portaTunnel: deps.portaTunnel ?? null,
    invia: (sid, payload) => {
      ws?.send(JSON.stringify({ t: "to-guest", to: sid, payload } satisfies MessaggioRelay));
    },
    ...(deps.fetchLocale !== undefined ? { fetchLocale: deps.fetchLocale } : {}),
    ...(deps.apriSocketLocale !== undefined ? { apriSocketLocale: deps.apriSocketLocale } : {}),
    ...(deps.maxFrame !== undefined ? { max: deps.maxFrame } : {}),
    ...(deps.credito !== undefined ? { credito: deps.credito } : {}),
    ...(deps.arretratoMax !== undefined ? { arretratoMax: deps.arretratoMax } : {}),
    log,
  });

  async function gestisci(m: MessaggioRelay): Promise<void> {
    // L'ospite se n'è andato: chi stava servendo la sua richiesta lo deve
    // sapere, o continua a leggere un corpo che non ha più dove andare.
    if (m.t === "guest-left") { proxy.ospiteUscito(m.sessionId); return; }
    if (m.t !== "to-guest") return; // il relay ci gira le buste già etichettate

    // ── Il TUBO, prima ────────────────────────────────────────────────────
    // Le due grammatiche sono disgiunte e `leggiFrame` è stretto: un frame ha
    // `f` e `s`, la busta del link ha `ref` e `b`. Quindi non c'è niente da
    // indovinare, e nessuna delle due può essere letta come l'altra.
    const frame = leggiFramePayload(m.payload);
    if (frame) { proxy.riceviFrame(m.to, frame); return; }

    // ── …e il LINK di condivisione, che la pagina servita dal Worker parla
    // ancora oggi.
    // Il payload dell'ospite: `ref` in chiaro (serve a trovare la chiave) e il
    // resto cifrato. Il `ref` è pubblico per costruzione — sta nel link.
    let ref = ""; let busta = "";
    try {
      const p = JSON.parse(m.payload) as { ref?: unknown; b?: unknown };
      ref = typeof p.ref === "string" ? p.ref : "";
      busta = typeof p.b === "string" ? p.b : "";
    } catch { return; }
    if (!ref || !busta) return;

    const esito = await servi(ref, busta);
    const risposta: RispostaOspite = esito?.risposta ?? { status: 404, body: { error: "non disponibile" } };
    // Anche il rifiuto viaggia cifrato quando si può: una risposta in chiaro
    // direbbe al relay che quel link non è valido, che è comunque qualcosa.
    const payload = esito
      ? await sigilla(esito.chiave, JSON.stringify(risposta))
      : JSON.stringify(risposta);
    ws?.send(JSON.stringify({ t: "to-guest", to: m.to, payload } satisfies MessaggioRelay));
  }

  function collega(): void {
    if (fermato || !deps.baseUrl) return;
    const url = `${deps.baseUrl.replace(/^http/, "ws")}/agent/${encodeURIComponent(deps.installationId)}`;
    const s = (deps.apriSocket ?? ((u: string) => new WebSocket(u)))(url);
    ws = s;

    s.onopen = () => {
      tentativo = 0;
      log(`[relay] collegato a ${deps.baseUrl}`);
      s.send(JSON.stringify({
        t: "hello", v: RELAY_PROTOCOL_VERSION,
        installationId: deps.installationId, token: deps.installationId,
      } satisfies MessaggioRelay));
    };

    s.onmessage = (e) => {
      const m = leggiMessaggio((() => { try { return JSON.parse(String(e.data)); } catch { return null; } })());
      if (m) void gestisci(m);
    };

    const riprova = () => {
      ws = null;
      // Le sessioni ospiti vivevano su QUESTO filo: alla riconnessione il relay
      // ne assegna di nuove, e tenere le vecchie vorrebbe dire leggere corpi
      // per destinatari che non esistono più.
      proxy.chiudiTutto();
      if (fermato) return;
      const attesa = ATTESE[Math.min(tentativo, ATTESE.length - 1)];
      tentativo += 1;
      timer = setTimeout(collega, attesa);
    };
    s.onclose = riprova;
    s.onerror = () => { try { s.close(); } catch { /* già chiusa */ } };
  }

  return {
    avvia() { fermato = false; collega(); },
    /** Spegnerlo non deve togliere niente al lavoro locale: è un di più. */
    ferma() {
      fermato = true;
      if (timer) clearTimeout(timer);
      proxy.chiudiTutto();
      try { ws?.close(); } catch { /* già chiusa */ }
      ws = null;
    },
    collegato: () => ws?.readyState === 1,
    /** Test-only: serve una richiesta senza passare dal filo. */
    __servi: servi,
    /** Test-only: le sessioni ospiti vive su questo filo. */
    __sessioni: () => proxy.sessioniAperte(),
    /** Test-only: i socket vivi di una sessione. */
    __socket: (sid: string) => proxy.__socket(sid),
  };
}
