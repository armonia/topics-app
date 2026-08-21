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
  type FrameTubo, type MessaggioRelay, type MotivoStream, type RuoloSessione,
} from "../../shared/relay-protocol";
import {
  GENERE_RICHIESTA, GENERE_RISPOSTA, intestazioniRichiesta, intestazioniRisposta,
  leggiTestaRichiesta, risolviUrlLocale, scriviTesta, type Intestazioni,
} from "../../shared/relay-http";
import { INTESTAZIONE_SEGRETO } from "../../shared/relay-identita";
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
  /**
   * Il nome del punto d'incontro presso il relay: sta nei link, e chi lo
   * conosce non apre niente — ciò che protegge una risorsa è la chiave nel
   * frammento.
   *
   * NON è `installationId`, che resta legato alla licenza e non compare da
   * nessuna parte qui: sono due domande diverse, e tenerle sullo stesso valore
   * è ciò che rendeva un nome mostrato in un link sufficiente a spacciarsi per
   * questa macchina. Vedi `shared/relay-identita.ts`.
   */
  relayId: string;
  /**
   * La preimmagine di `relayId`, che non esce da questo processo se non
   * nell'intestazione dell'aggancio.
   *
   * È l'unica cosa che distingue questa macchina da chiunque abbia ricevuto un
   * suo link: il Worker la trasforma e confronta il risultato col nome nel
   * percorso, PRIMA di svegliare il punto d'incontro. Vuota = l'aggancio verrà
   * rifiutato, che è il verso giusto in cui sbagliare.
   */
  segreto: string;
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
  /** L'ascoltatore del tunnel parla TLS? Eredita `opzioniServer`, quindi su
   *  un'installazione con i certificati è HTTPS anche su loopback. */
  tunnelTls?: boolean;
  /** Iniettabile per i test. */
  now?: () => number;
  /** Come si apre il filo verso il relay. Le opzioni portano l'intestazione
   *  col segreto: un test che le ignora prova un aggancio che in produzione
   *  verrebbe respinto, quindi la firma le rende visibili invece di
   *  nasconderle dietro un secondo argomento facoltativo che nessuno guarda. */
  apriSocket?: (url: string, opzioni: { headers: Record<string, string> }) => WebSocket;
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
 * Quanti posti restano comunque a un DISPOSITIVO appaiato.
 *
 * Non è un privilegio: è che i due ruoli non hanno lo stesso costo per chi
 * arriva. Un ospite di link è anonimo e se ne aggancia quanti se ne vuole —
 * basta il link, e il link gira nelle chat. Un dispositivo si è appaiato, ed è
 * la strada con cui il PADRONE di casa entra da fuori rete. Con un tetto solo,
 * chi ha in mano un link condiviso può riempirlo e chiudere fuori proprio lui:
 * il tetto smetterebbe di essere una difesa e diventerebbe l'arma.
 */
const RISERVA_DEVICE = 8;
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

/** `WebSocket.CONNECTING`: la stretta di mano non è finita. Scritto come numero
 *  e non come `WebSocket.CONNECTING` perché `apriSocketLocale` è iniettabile e
 *  un socket finto può non discendere dalla classe globale; il valore invece è
 *  quello in ogni implementazione, ed è parte del contratto. */
const SOCKET_IN_APERTURA = 0;

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
  tunnelTls?: boolean;
  /** Dove finisce un frame già serializzato, per la sessione `sid`. */
  invia(sid: string, payload: string): void;
  fetchLocale?: typeof fetch;
  apriSocketLocale?: ApriSocketLocale;
  max?: number;
  maxStream?: number;
  maxByteStream?: number;
  maxInVolo?: number;
  maxSocket?: number;
  /** Quante sessioni si tengono, e quante di quelle restano ai dispositivi.
   *  Abbassabili nei test: un tetto che si prova aprendo sessantaquattro
   *  sessioni è un test che nessuno legge. */
  maxSessioni?: number;
  riservaDevice?: number;
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
  /** Il codice che l'ospite ha chiesto di far arrivare al socket vero mentre la
   *  stretta di mano non era ancora finita. Un `close(c)` su un socket in
   *  apertura non manda nessun codice — vedi `chiudiSocket` — quindi si tiene
   *  qui e si spende all'apertura, che è il primo istante in cui può viaggiare. */
  chiudiAllApertura: ChiusuraWs | null;
}

interface SessioneOspite {
  /** Da quale porta del relay è entrata. Non si legge da niente che il capo
   *  abbia scritto: lo dichiara il relay, che lo sa dall'URL. */
  ruolo: RuoloSessione;
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
  /** I socket veri che restano attaccati SOLO per finire di aprirsi e poter
   *  dire il codice con cui l'ospite li ha chiusi. Non stanno in `socket`: lì
   *  ci sono i vivi, e questi sono già morti per tutti. Servono a un elenco
   *  perché quando l'ospite se ne va non c'è più nessun codice da consegnare, e
   *  senza un posto dove trovarli resterebbero a finire una stretta di mano che
   *  non interessa più a nessuno. */
  inApertura: Set<WebSocket>;
}

export function creaProxyTubo(deps: ProxyTuboDeps) {
  const max = deps.max ?? TUBO_BYTE_PER_FRAME;
  const maxInVolo = deps.maxInVolo ?? MAX_IN_VOLO;
  const maxSocket = deps.maxSocket ?? MAX_SOCKET;
  const maxSessioni = deps.maxSessioni ?? MAX_SESSIONI;
  // La riserva non può mangiarsi il tetto intero: se lo facesse, nessun ospite
  // entrerebbe mai più e la condivisione di un link smetterebbe di funzionare
  // per una costante scritta storta.
  const riservaDevice = Math.min(Math.max(deps.riservaDevice ?? RISERVA_DEVICE, 0), Math.max(maxSessioni - 1, 0));
  const log = deps.log ?? (() => {});
  const f = deps.fetchLocale ?? fetch;
  const apriSocketLocale = deps.apriSocketLocale ?? apriSocketLocaleVero;
  const sessioni = new Map<string, SessioneOspite>();

  /**
   * Un frame verso una sessione.
   *
   * ── PERCHÉ UNA SESSIONE CHE SE N'È ANDATA NON RICEVE PIÙ NIENTE ───────────
   * Non è un'economia: è che il nome di una sessione si può RIUSARE. Il ponte
   * del relay ne ha uno FISSO (`SID_PONTE`), e ogni istanza nuova del Durable
   * Object congeda la vecchia e ricomincia con lo stesso nome. Un frame in
   * ritardo — il congedo di un socket che si stava chiudendo, la rinuncia di
   * una richiesta interrotta — non cade quindi nel vuoto: arriva a CHI HA
   * PRESO QUEL NOME DOPO.
   *
   * E lì fa un danno che non si vede: brucia un numero di stream che l'altro
   * capo non ha ancora usato. Un riassemblatore rifiuta per sempre un numero
   * già visto (`massimoVisto`), quindi da quell'istante ogni apertura più
   * bassa cade — e la sessione nuova nasce già morta, senza che nessuno abbia
   * sbagliato niente di visibile.
   *
   * L'unico frame che deve uscire per una sessione che NON esiste è il rifiuto
   * a chi sta bussando adesso (`too-many-streams`): lì c'è qualcuno che sta
   * ascoltando, ed è l'unico caso. Passa da `deps.invia` diretto, così questo
   * cancello resta senza eccezioni.
   */
  const manda = (sid: string, fr: FrameTubo) => {
    if (!sessioni.has(sid)) return;
    deps.invia(sid, scriviFrame(fr));
  };

  /**
   * C'è posto per un'altra sessione di questo ruolo?
   *
   * Il conto è sul TOTALE e non sui pari-ruolo, di proposito: la promessa è
   * «restano sempre `riservaDevice` posti raggiungibili da un dispositivo», e
   * quella la mantiene solo un tetto più basso per gli ospiti. Contare i soli
   * ospiti lascerebbe che a riempire siano i dispositivi — che però sono quelli
   * appaiati, cioè il caso in cui il tetto ha già fatto il suo lavoro.
   */
  function cePosto(ruolo: RuoloSessione): boolean {
    if (sessioni.size >= maxSessioni) return false;
    return ruolo === "device" || sessioni.size < maxSessioni - riservaDevice;
  }

  function nuovaSessione(ruolo: RuoloSessione): SessioneOspite {
    return {
      ruolo,
      rias: creaRiassemblatore({
        latoRemoto: "guest",
        ...(deps.maxStream !== undefined ? { maxStream: deps.maxStream } : {}),
        ...(deps.maxByteStream !== undefined ? { maxByteStream: deps.maxByteStream } : {}),
      }),
      prossimo: creaContatoreStream("host"),
      inVolo: new Map(),
      socket: new Map(),
      perCanale: new Map(),
      inApertura: new Set(),
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

    const url = risolviUrlLocale(deps.portaTunnel, t.p, deps.tunnelTls === true);
    // Un percorso che sceglie un'altra destinazione non è una richiesta storta:
    // è un tentativo di usare questa macchina come ponte verso il resto della
    // sua rete.
    if (!url) { rispondiSubito(sid, sess, s, 400, "bad-path"); return; }

    if (sess.inVolo.size >= maxInVolo) { manda(sid, { f: "reset", s, motivo: "too-many-streams" }); return; }

    const ferma = new AbortController();
    sess.inVolo.set(s, ferma);
    try {
      const senzaCorpo = t.m === "GET" || t.m === "HEAD";
      // L'indirizzo VERO torna nell'intestazione di inoltro, ma solo qui e
      // solo dopo che `leggiTestaRichiesta` l'ha validato: `intestazioniRichiesta`
      // ha appena spogliato quella che l'ospite poteva essersi scritto da sé,
      // quindi ciò che passa di qua viene dal relay e da nessun altro.
      const intestazioni = new Headers(intestazioniRichiesta(t.h));
      if (t.ip) intestazioni.set("x-forwarded-for", t.ip);
      const res = await f(url, {
        method: t.m,
        headers: intestazioni,
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
    if (opts.avvisa !== false && opts.chiusura) dichiaraChiusura(sid, sess, sk.sIn, opts.chiusura);
    // Il canale della MACCHINA si chiude SEMPRE, anche quando è l'ospite ad
    // aver chiuso per primo e non c'è più niente da avvisare. Il `reset` non
    // serve a raccontare la chiusura — quella l'ha dichiarata lui — serve a
    // dire all'altro capo di DIMENTICARE questo stream. Senza, il canale resta
    // nel suo riassemblatore per tutta la sessione, e i canali hanno un tetto:
    // dopo `maxStream` aperture e chiusure ogni socket nuovo si vedrebbe
    // rifiutare l'apertura. Un tetto che si consuma non è un tetto, è una
    // scadenza.
    sk.canale.chiudi("aborted");
    if (opts.avvisa !== false) manda(sid, { f: "reset", s: sk.sIn, motivo: "aborted" });
    // Un codice di chiusura si può dire solo su una stretta di mano FINITA.
    // `close(c)` su un socket ancora in apertura non manda nessun codice: per
    // protocollo fa cadere la connessione, e l'altro capo legge 1006 — cioè
    // esattamente il codice che la guardia di `chiusuraDallOspite` esiste per
    // non lasciar passare. Quando il codice conta, allora, si aspetta
    // l'apertura e si chiude LÌ: è il primo istante in cui può viaggiare.
    //
    // È anche il solo modo perché il risultato non dipenda da quanto era
    // occupata la macchina: fra l'`open` di chi ascolta e l'`onopen` di qui c'è
    // altro lavoro, e sotto carico l'ospite chiude nel mezzo. Con la chiusura
    // immediata il codice arrivava o no a seconda del tempo — misurato, non
    // dedotto: 30ms di lavoro sincrono in mezzo bastano a farlo diventare 1006.
    if (opts.chiudiSu && sk.su !== null && sk.su.readyState === SOCKET_IN_APERTURA) {
      sk.chiudiAllApertura = opts.chiudiSu;
      sess.inApertura.add(sk.su);
    } else {
      try {
        if (opts.chiudiSu) sk.su?.close(opts.chiudiSu.c, opts.chiudiSu.r);
        else sk.su?.close();
      } catch { /* già chiusa */ }
    }
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
    const sk: SocketProxy = {
      sIn, sOut, su: null, canale, coda: [], su_aperto: false, finito: false,
      chiudiAllApertura: null,
    };
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
    const url = risolviUrlLocale(deps.portaTunnel, t.p, deps.tunnelTls === true);
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
      sess.inApertura.delete(su);
      if (sk.finito) {
        // Morto prima di nascere. Se qualcuno aveva chiesto un codice, questo è
        // il primo — e ultimo — istante in cui glielo si può dire.
        try {
          const c = sk.chiudiAllApertura;
          if (c) su.close(c.c, c.r);
          else su.close();
        } catch { /* già chiusa */ }
        return;
      }
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
      sess.inApertura.delete(su);
      if (sk.su_aperto) return; // ci pensa `onclose`, che porta anche il codice
      rifiuta(502);
    };

    su.onclose = (ev) => {
      // La stretta di mano è finita male: non c'è nessuna apertura da aspettare
      // per dire un codice, e l'elenco non deve tenersi un socket morto.
      sess.inApertura.delete(su);
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

  /**
   * Un capo si è agganciato al relay: qui comincia la sua sessione.
   *
   * ── PERCHÉ ENTRARE È UN EVENTO, E NON IL PRIMO FRAME ──────────────────────
   * Perché il relay tiene una socket aperta per ogni capo agganciato, e quella
   * costa da subito — anche a chi non dice niente. Aspettare il primo frame per
   * accorgersene vorrebbe dire che il tetto conta gli OPEROSI e non gli
   * agganciati: cento sessioni mute passerebbero sotto, e la prima che parla
   * troverebbe la macchina già occupata da loro.
   *
   * ── PERCHÉ IL RUOLO ARRIVA DA QUI ─────────────────────────────────────────
   * Perché è l'unica cosa che il relay aggiunge di suo, e la sa senza guardare
   * dentro niente: da quale porta ci si è agganciati. Un ospite di link e un
   * dispositivo appaiato non hanno lo stesso costo per chi arriva, e questa è
   * la sola occasione in cui si può distinguerli.
   *
   * Assente vuol dire `guest` — il meno che si possa essere: un relay più
   * vecchio che non lo manda non promuove nessuno.
   */
  function ospiteEntrato(sid: string, ruolo: RuoloSessione = "guest"): void {
    // Lo stesso identificatore che torna è una sessione NUOVA, non la vecchia
    // che continua: il relay lo assegna a chi si aggancia. Tenersi quella di
    // prima vorrebbe dire consegnare a questo capo i socket di un altro, e
    // lasciare al vecchio dei socket veri che nessuno chiuderà più.
    if (sessioni.has(sid)) ospiteUscito(sid);
    if (!cePosto(ruolo)) {
      // Non si crea niente, e non c'è nessuna corsia su cui rispondere: il
      // frame che arriverà troverà lo stesso tetto e si vedrà dire di no là,
      // dove esiste uno stream a cui il rifiuto può essere appeso.
      log(`[relay] sessione ${ruolo} rifiutata: ${sessioni.size} sessioni gia' aperte`);
      return;
    }
    sessioni.set(sid, nuovaSessione(ruolo));
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
    // …e quelli che stavano finendo di aprirsi solo per poter dire un codice:
    // il codice era per l'ospite di prima, che non c'è più. Si chiudono e
    // basta, invece di restare appesi a una stretta di mano che non serve a
    // nessuno.
    for (const su of [...sess.inApertura]) { try { su.close(); } catch { /* già chiusa */ } }
    sess.inApertura.clear();
  }

  return {
    /** Un frame arrivato per la sessione `sid`. */
    riceviFrame(sid: string, fr: FrameTubo): void {
      let sess = sessioni.get(sid);
      if (!sess) {
        // Un frame per una sessione che non si è annunciata: si serve lo
        // stesso — è il relay a garantire il mittente, e un `guest-joined`
        // perso non deve rompere il lavoro — ma come OSPITE, che è il meno
        // che si possa essere. Prendere il ruolo da chi non lo ha dichiarato
        // sarebbe il solo modo per promuoversi da soli.
        if (!cePosto("guest")) {
          // `deps.invia` e non `manda`: qui la sessione non esiste APPOSTA — è
          // il rifiuto a chi sta bussando adesso, l'unico caso in cui c'è
          // qualcuno ad ascoltare senza una sessione dietro.
          deps.invia(sid, scriviFrame({ f: "reset", s: fr.s, motivo: "too-many-streams" }));
          return;
        }
        sess = nuovaSessione("guest");
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

    /** Un capo si è agganciato: la sua sessione comincia qui, col suo ruolo. */
    ospiteEntrato,

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
    /** Test-only: con che ruolo è registrata una sessione, o `null` se non
     *  esiste. */
    __ruolo: (sid: string): RuoloSessione | null => sessioni.get(sid)?.ruolo ?? null,
  };
}

/** Attese fra un tentativo e l'altro. Crescono e si fermano: insistere ogni
 *  secondo su un relay giù è rumore, e la macchina intanto lavora lo stesso. */
const ATTESE = [1_000, 2_000, 5_000, 15_000, 60_000];

/**
 * How long we wait for `ready` before treating a newly opened thread as dead.
 *
 * Generous next to the real round trip (the relay answers in tens of
 * milliseconds): this is not a performance limit, it is the net that separates
 * "attached" from "connected to nobody". Whoever has not confirmed by then
 * never will, because `ready` is the FIRST thing the meeting point says.
 */
const ATTESA_CONFERMA_MS = 10_000;

export function creaRelayClient(deps: RelayDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  let ws: WebSocket | null = null;
  let tentativo = 0;
  /**
   * The meeting point has CONFIRMED that it took us in.
   *
   * Not the same thing as "the socket is open", and that difference kept
   * remote access down for minutes on 2026-08-21: the TCP thread to Cloudflare
   * was alive, `readyState === 1`, and the log announced a healthy connection
   * on every line.
   * But on the far side the Durable Object had been recreated and that thread
   * belonged to nobody: every request from the phone got `host-offline`, and
   * this side had no way to notice, because `onclose` never arrives for a
   * thread nobody closes.
   *
   * The confirmation is the `ready` the relay sends right after attaching. It
   * was already in the protocol (`shared/relay-protocol.ts`), already sent,
   * and nobody looked at it. From here on IT is what says we are attached.
   */
  let confermato = false;
  /** The confirmation wait for the current thread, cleared when it ends. */
  let timerConferma: ReturnType<typeof setTimeout> | null = null;
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
    tunnelTls: deps.tunnelTls === true,
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
    // ── THE CONFIRMATION, and why it is the first line of this handler.
    //
    // `onopen` says the THREAD is open; this says somebody on the far side
    // took us in. The log used to announce success on the first of the two,
    // which is why a thread hanging off a meeting point that no longer existed
    // kept looking healthy.
    if (m.t === "ready") {
      if (!confermato) {
        confermato = true;
        log(`[relay] collegato a ${deps.baseUrl}`);
      }
      return;
    }
    // Un capo si è agganciato. Il relay lo dice PRIMA di girare qualunque suo
    // frame — è la stessa socket, quindi l'ordine è garantito — e questa è la
    // sola occasione in cui si sa da quale porta è entrato.
    if (m.t === "guest-joined") { proxy.ospiteEntrato(m.sessionId, m.ruolo ?? "guest"); return; }
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
    const url = `${deps.baseUrl.replace(/^http/, "ws")}/agent/${encodeURIComponent(deps.relayId)}`;
    // Il segreto viaggia in un'INTESTAZIONE della stretta di mano, e non nel
    // percorso né in un parametro: quelli finiscono nei registri di chi sta in
    // mezzo, e un segreto scritto in un log vive più a lungo della connessione
    // che lo usava. Il Worker lo verifica prima di svegliare qualsiasi cosa.
    const apriIlFilo = deps.apriSocket
      ?? ((u: string, o: { headers: Record<string, string> }) => new WebSocket(u, o as never));
    const s = apriIlFilo(url, { headers: { [INTESTAZIONE_SEGRETO]: deps.segreto } });
    ws = s;

    s.onopen = () => {
      tentativo = 0;
      confermato = false;
      // The thread is open, but we do not yet know whether anyone is on the
      // far side. If `ready` never comes, this closes it: `onclose` restarts
      // the loop and the reconnection re-attaches to the live meeting point.
      // Without it the thread sits there forever, looking healthy.
      //
      // `unref` because waiting for a confirmation must not keep the process
      // alive: at shutdown there is nothing left to confirm.
      const attesaConferma = setTimeout(() => {
        if (confermato || ws !== s) return;
        log(`[relay] nessuna conferma dal punto d'incontro: rifaccio il filo`);
        try { s.close(); } catch { /* already closed: `onclose` handles it */ }
      }, ATTESA_CONFERMA_MS);
      (attesaConferma as unknown as { unref?: () => void }).unref?.();
      timerConferma = attesaConferma;
      // Un ANNUNCIO, non una credenziale: a questo punto il relay ha già
      // deciso, guardando l'intestazione, che siamo noi. `token` resta nel
      // protocollo perché è la forma del messaggio, ma non concede niente e
      // non deve MAI portare il segreto — finirebbe dentro il punto d'incontro
      // e nei suoi registri, che è esattamente ciò da cui l'intestazione lo
      // tiene fuori.
      s.send(JSON.stringify({
        t: "hello", v: RELAY_PROTOCOL_VERSION,
        installationId: deps.relayId, token: deps.relayId,
      } satisfies MessaggioRelay));
    };

    s.onmessage = (e) => {
      const m = leggiMessaggio((() => { try { return JSON.parse(String(e.data)); } catch { return null; } })());
      if (m) void gestisci(m);
    };

    const riprova = () => {
      ws = null;
      // The thread is over: its confirmation wait has nothing left to watch,
      // and leaving it armed would close the NEXT thread when it fires.
      if (timerConferma) { clearTimeout(timerConferma); timerConferma = null; }
      confermato = false;
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
      if (timerConferma) { clearTimeout(timerConferma); timerConferma = null; }
      proxy.chiudiTutto();
      try { ws?.close(); } catch { /* già chiusa */ }
      ws = null;
    },
    /**
     * Attached FOR REAL, not "the thread is open".
     *
     * The two diverge, and when they do it is exactly the bad case: a live
     * thread to a meeting point that no longer knows us answers `host-offline`
     * to every request while this side looks fine. What is needed is the
     * relay's confirmation, not the socket's state.
     */
    collegato: () => ws?.readyState === 1 && confermato,
    /** Test-only: serve una richiesta senza passare dal filo. */
    __servi: servi,
    /** Test-only: le sessioni ospiti vive su questo filo. */
    __sessioni: () => proxy.sessioniAperte(),
    /** Test-only: i socket vivi di una sessione. */
    __socket: (sid: string) => proxy.__socket(sid),
    /** Test-only: il ruolo con cui una sessione è registrata. */
    __ruolo: (sid: string) => proxy.__ruolo(sid),
  };
}
