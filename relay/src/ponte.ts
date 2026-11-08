/**
 * Il PONTE: una richiesta HTTPS normale del browser, dentro il tubo e ritorno.
 *
 * ── COSA MANCAVA ────────────────────────────────────────────────────────────
 * Il tubo esisteva, ed era provato: la macchina rigioca contro la sua porta
 * quello che le arriva, e il capo ospite sa comporre le domande. Mancava che
 * quel capo ospite fosse RAGGIUNGIBILE da un browser. Le tre porte del relay
 * chiedono tutte un upgrade WebSocket, quindi un telefono davanti a
 * `relay.topics.armonia.io` non poteva ottenere niente: per entrare ci voleva
 * già un client che parlasse il protocollo, cioè esattamente la cosa che non si
 * ha quando si apre un link.
 *
 * Qui la traduzione la fa il relay. Una `Request` diventa uno stream `req`, la
 * risposta torna come stream `res`, e chi ha chiesto riceve una `Response`
 * qualunque. Il telefono non ha bisogno di niente: è un sito web.
 *
 * ── PERCHÉ QUESTO CAPO NON RIUSA `shared/relay-fake.ts` ─────────────────────
 * Perché `creaOspiteHttp` è la SECONDA implementazione del formato, e serve che
 * resti tale: due implementazioni tengono onesto un protocollo, una sola lo fa
 * scivolare dentro sé stessa senza che nessuno se ne accorga. Qui si parte dagli
 * stessi mattoni di `shared/` — comporre, riassemblare, leggere le teste — e non
 * dal capo già montato.
 *
 * ── E LA PROMESSA «IL RELAY NON CAPISCE»? ───────────────────────────────────
 * Regge, perché qui il relay non è in mezzo: è un CAPO. Di questa sessione il
 * ponte è l'ospite — è lui che ha composto la domanda, è a lui che risponde la
 * macchina — e un capo legge la propria posta. Le buste che il relay INOLTRA
 * fra la macchina e gli altri capi restano opache come prima, e `relay-do.ts`
 * continua a non aprirne nessuna. È anche la scelta già presa: il relay decifra
 * e inoltra, e la traduzione sta qui invece che addosso al telefono.
 *
 * ── LA REGOLA CHE GOVERNA OGNI SCELTA QUI ───────────────────────────────────
 * Chi arriva è FUORI dalla rete di casa, e il ponte non decide chi sia. Le
 * intestazioni si girano com'erano — è la macchina a filtrarle
 * (`intestazioniRichiesta`) e a decidere cosa quella richiesta può vedere, con
 * le stesse regole della rete locale. Il ponte non aggiunge, non toglie e non
 * inventa nessuna dichiarazione di identità: se lo facesse, ci sarebbero due
 * autorità sul chi-sei, e quella che sbaglia è sempre quella che nessuno guarda.
 */
import {
  componiStream, creaCapoCanale, creaContatoreStream, creaRiassemblatore, leggiFramePayload,
  ricaricaPer, scriviFrame,
  TUBO_BYTE_PER_FRAME,
  type FrameTubo,
} from "../../shared/relay-protocol";
import {
  GENERE_RICHIESTA, GENERE_RISPOSTA, leggiTestaRisposta, scriviTesta,
  type Intestazioni,
} from "../../shared/relay-http";
import {
  codiceInviabile, GENERE_WS, GENERE_WS_APERTO, GENERE_WS_CHIUSO,
  leggiChiusuraWs, leggiTestaWsAperto, leggiTestaWsChiuso,
  scriviChiusuraWs, scriviTestaWs, WS_APERTO, WS_CHIUSURA_NORMALE,
  type ChiusuraWs,
} from "../../shared/relay-ws";

/**
 * Il nome della sessione del ponte, uno per installazione.
 *
 * Non è un UUID di proposito: le sessioni vere ne hanno uno, quindi un nome che
 * un UUID non può assumere non può collidere con nessuna di loro. Ed è FISSO
 * perché una sessione per richiesta costerebbe un annuncio e un congedo a ogni
 * immagine di una pagina — su un Durable Object che si paga a messaggio è il
 * genere di terzo messaggio che si moltiplica per tutto.
 */
export const SID_PONTE = "ponte";

/**
 * La porta del browser, letta dal PERCORSO.
 *
 * Il ruolo non viaggia in un parametro — la query appartiene a chi chiede, e
 * finisce dentro ciò che la macchina rigioca — né in un'intestazione, che chi
 * bussa può scriversi da solo: sarebbe un modo per far leggere come traduzione
 * una richiesta arrivata a un'altra porta. Il percorso è la sola cosa che il
 * relay sa di suo, ed è da lì che nasce il ruolo, come per le altre tre.
 *
 * Il primo gruppo è l'installazione, il secondo ciò che la macchina rigiocherà.
 */
export const PERCORSO_PONTE = /^\/i\/([A-Za-z0-9_-]{1,128})(\/.*)?$/;

/**
 * I metodi che il ponte compone.
 *
 * Stessa lista chiusa della macchina, e non per simmetria estetica: un metodo
 * che lì verrebbe rifiutato con un `reset` qui diventerebbe un 502 muto, cioè
 * un guasto raccontato male. Meglio dirlo dove si sa perché.
 */
const METODI = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Gli stati che non possono avere un corpo: costruire una `Response` con un
 *  corpo su uno di questi è un'eccezione, non una risposta. */
const SENZA_CORPO = new Set([101, 204, 205, 304]);

/** Quanto si accetta di caricare, in entrata e in uscita, prima di dire di no.
 *  Un tetto dichiarato è un rifiuto; nessun tetto è memoria che chiunque può
 *  far crescere. */
const MAX_CORPO = 16 * 1024 * 1024;

/** Quante risposte possono essere in volo insieme. Una pagina apre decine di
 *  richieste in parallelo, quindi il tetto di serie del riassemblatore (64)
 *  sarebbe stretto proprio nel caso normale. */
const MAX_STREAM = 256;

/** Quanto si aspetta una risposta prima di dichiarare che non arriverà. Senza,
 *  una macchina che smette di rispondere a metà lascia la scheda del browser a
 *  girare per sempre — che è il modo peggiore di guastarsi, perché non dice
 *  niente. */
const SCADENZA_MS = 30_000;

/**
 * Quanti socket vivi insieme si portano su questa sessione.
 *
 * È il tetto della MACCHINA (`MAX_SOCKET` in `relay-client.ts`), ricopiato di
 * proposito: sfondarlo di là si legge come un `reset`, cioè come «il socket è
 * morto» senza dire perché. Qui diventa un rifiuto dichiarato, con un numero
 * addosso. Il conto ci sta: un pannello del client ne apre quattro — quello
 * dell'applicazione, quello di ogni terminale, quello di ogni pannello browser.
 */
const MAX_SOCKET = 16;

/**
 * Il socket è morto perché l'installazione non è più collegata al relay.
 *
 * Sta nell'intervallo delle applicazioni (3000-4999) e non su `1001` o `1012`,
 * e non è una scelta estetica: `close()` accetta solo `1000` e quell'intervallo
 * (`codiceInviabile`), quindi qualsiasi altro numero sarebbe un'eccezione al
 * posto di una chiusura. E `1000` direbbe «tutto a posto», che è l'unica cosa
 * che qui non è vera.
 */
export const WS_PONTE_GIU = 4001;

/**
 * L'istanza del relay è ripartita, e questo socket non ha più un capo.
 *
 * L'ibernazione può sfrattare l'oggetto dalla memoria fra un messaggio e
 * l'altro: quello che se ne va è la NUMERAZIONE degli stream, e con lei ogni
 * socket aperto — la macchina si ricorda i numeri di prima e non li riaccetta.
 * Un socket sopravvissuto allo sfratto è perciò un filo che non arriva più da
 * nessuna parte: si chiude dicendolo, e chi sta di là riapre. Restare aperti
 * sarebbe peggio, perché somiglia a funzionare.
 */
export const WS_PONTE_RIPARTITO = 4002;

/**
 * Il socket del browser, ridotto a ciò che il ponte usa davvero.
 *
 * Un'interfaccia locale e non il tipo del runtime: il ponte non deve sapere
 * niente di Durable Object — è la stessa ragione per cui `invia` è una
 * funzione — e un test può guidarlo con due oggetti in memoria.
 */
export interface SocketPonte {
  send(dato: string | Uint8Array | ArrayBuffer): void;
  close(codice?: number, motivo?: string): void;
}

/** Com'è andata la richiesta di aprire un socket. `stato` parla il vocabolario
 *  dell'HTTP, come `TestaWsAperto.s`: è quello che chi instrada rigira a chi
 *  ha bussato. */
export type EsitoWs =
  | { ok: true; sIn: number; sp?: string }
  | { ok: false; stato: number };

/** Il nome di un sottoprotocollo è un token HTTP. Stessa forma di
 *  `PROTOCOLLO_VALIDO` in `shared/relay-ws.ts`, e per lo stesso motivo: tutto
 *  ciò che non è un token — spazi, virgole, ritorni a capo — è ciò con cui si
 *  spezza in due un'intestazione a valle. */
const PROTOCOLLO_VALIDO = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_PROTOCOLLI = 16;

/**
 * I sottoprotocolli chiesti dal browser, letti dall'intestazione.
 *
 * Diventano `sp` nella testa del canale e NON viaggiano come intestazione: la
 * macchina filtra via ogni `sec-websocket-*` (`intestazioniUpgrade`), perché
 * quelle appartengono alla stretta di mano fra due capi vicini e questa
 * connessione non è quella. Chi non è un token si scarta invece di far cadere
 * l'apertura: una preferenza storta è una preferenza in meno, non un guasto.
 */
function protocolliChiesti(v: string | null): string[] {
  if (!v) return [];
  return v.split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.length <= 128 && PROTOCOLLO_VALIDO.test(p))
    .slice(0, MAX_PROTOCOLLI);
}

export interface PonteOpts {
  /** Dove finisce un frame già serializzato, verso la macchina. È il solo
   *  contatto col trasporto: il ponte non sa niente di Durable Object. */
  invia(payload: string): void;
  /** Byte di contenuto per frame. Abbassabile nei test, dove un corpo spezzato
   *  in venti pezzi si scrive in una riga invece che in mezzo MiB. Il tetto
   *  resta quello di `TUBO_BYTE_PER_FRAME`, che in base64 sta due ordini di
   *  grandezza sotto `TUBO_LIMITE_CLOUDFLARE`. */
  max?: number;
  maxCorpo?: number;
  maxRisposta?: number;
  scadenzaMs?: number;
  /** Quanti socket vivi insieme. Abbassabile nei test: provare un tetto
   *  aprendo sedici socket è un test che nessuno legge. */
  maxSocket?: number;
}

/** Ciò che torna dalla macchina, o `null` quando la corsia è morta. */
interface Esito {
  stato: number;
  intestazioni: Intestazioni;
  corpo: Uint8Array;
}

/** Una risposta dichiarata del ponte: un guasto che si legge, mai una pagina
 *  vuota. Le stringhe sono in inglese perché le legge chi apre il link. */
function dillo(stato: number, testo: string): Response {
  return new Response(`${testo}\n`, {
    status: stato,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/** La macchina non è collegata. Sta qui e non nel Durable Object perché è la
 *  frase che l'utente legge, e le frasi che l'utente legge stanno in un posto
 *  solo. */
export function macchinaSpenta(): Response {
  return dillo(503, "This installation is not connected to the relay right now.");
}

/**
 * L'upgrade non si apre, e si dice con lo stato che ha detto la macchina.
 *
 * Un `101` dato lo stesso e poi chiuso subito sarebbe, per chi guarda, un
 * socket che muore senza motivo — e i motivi qui sono diversi fra loro: un
 * percorso che di là sceglie un'altra destinazione non è la stessa cosa di una
 * installazione senza accesso da fuori. Le frasi sono in inglese perché sono
 * quelle che si leggono negli strumenti di chi apre il link.
 */
export function upgradeRifiutato(stato: number): Response {
  const frasi: Record<number, string> = {
    400: "That path is not served over the relay.",
    429: "Too many sockets are already open over the relay for this installation.",
    499: "The client went away before the socket was opened.",
    503: "This installation has no remote access configured.",
    504: "The installation did not answer in time.",
  };
  return dillo(stato, frasi[stato] ?? "The installation could not open this socket.");
}

/**
 * Chi ha chiesto se n'è andato PRIMA della risposta.
 *
 * ── PERCHÉ NON BASTA LA SCADENZA ────────────────────────────────────────────
 * Una scheda che si chiude, o una pagina che cambia mentre un'immagine sta
 * ancora arrivando, non è l'eccezione: è quello che succede tutto il giorno. Il
 * runtime lo dice interrompendo il segnale della richiesta, e senza guardarlo
 * l'unica cosa che sveglia il ponte è la scadenza — mezzo minuto in cui la
 * macchina continua a leggere un corpo che non ha più dove andare, e in cui una
 * corsia del tubo resta occupata da nessuno. Il tubo le corsie le CONTA, quindi
 * non è solo lavoro sprecato: è il tetto che si consuma.
 *
 * ── UN ASCOLTATORE QUI NON È STATO CHE L'IBERNAZIONE PORTA VIA ──────────────
 * Vive quanto la `fetch()` che lo ha creato, e un oggetto con una richiesta in
 * volo non viene sfrattato — è la stessa ragione per cui il ponte può stare in
 * un campo. Si stacca comunque appena non serve: un ascoltatore lasciato su un
 * segnale è la richiesta di prima che non si riesce più a liberare.
 */
function seNeVa(req: Request): { andato: Promise<"andato">; stacca: () => void } {
  const segnale: AbortSignal | undefined = req.signal;
  let stacca = () => { /* niente da staccare */ };
  const andato = new Promise<"andato">((res) => {
    // Un contorno senza segnale non se ne va mai: la promessa resta in silenzio
    // invece di dichiarare una rinuncia che nessuno ha chiesto.
    if (!segnale) return;
    if (segnale.aborted) { res("andato"); return; }
    const su = () => res("andato");
    segnale.addEventListener("abort", su, { once: true });
    stacca = () => { try { segnale.removeEventListener("abort", su); } catch { /* già sparito */ } };
  });
  return { andato, stacca: () => stacca() };
}

/**
 * La strada di un `set-cookie`, riportata sotto il prefisso da cui si è entrati.
 *
 * ── IL CASO CHE MORDE ───────────────────────────────────────────────────────
 * La macchina emette il cookie di sessione con `Path=/` (`buildSessionCookie`,
 * e deve farlo: di là serve anche a `/media`, `/uploads`, `/ws`). Ma su questo
 * relay OGNI installazione vive sullo STESSO indirizzo, e a distinguerle c'è
 * solo il tratto `/i/<installazione>`. Un cookie con `Path=/` il browser lo
 * memorizza sull'origine del relay e lo rimanda anche a `/i/<un'altra>/…`,
 * cioè lo consegna alla macchina di CHIUNQUE altro sia collegato allo stesso
 * relay — che a quel punto se lo rigioca contro la vittima. `SameSite=Lax` non
 * ferma niente: una navigazione in cima a una scheda se lo porta dietro.
 *
 * Il verso opposto si rompe da solo, e in silenzio: un cookie SENZA `Path`
 * prende per impostazione la cartella della richiesta — `/i/inst-1/api` — e
 * non tornerebbe più indietro su `/i/inst-1/altro`.
 *
 * Quindi la strada si riscrive sempre, esattamente come si fa con `location`:
 * quella che c'è si porta sotto il prefisso, quella che manca si scrive.
 *
 * ── PERCHÉ IL PREFISSO NON BASTA PIÙ, E COSA LO SOSTITUISCE ─────────────────
 * Questo confinava il cookie a `/i/<installazione>/`, ed era giusto FINCHÉ
 * l'app viveva là sotto. Il giorno dopo (`7cf2b9686`, «Pagina bianca dal
 * telefono») il prefisso è diventato un ingresso di passaggio: la prima
 * navigazione deposita il biscotto `topics_inst` e RIMANDA a `/`, perché il
 * bundle chiede percorsi assoluti. Da lì in poi il browser sta su `/`.
 *
 * Nessuno dei due sapeva dell'altro, e il risultato si vedeva solo alla fine
 * di un appaiamento: il telefono mostrava il codice, il computer approvava,
 * `/api/auth/pair/status` rispondeva `approved` con il suo `Set-Cookie`… e la
 * sessione veniva scritta sotto `/i/<id>/`, dove l'app non torna mai più.
 * Misurato il 21/08/2026 sul relay vero: con lo STESSO cookie in mano,
 * `/api/auth/session` diceva `paired:false` e
 * `/i/<id>/api/auth/session` diceva `paired:true`. Il telefono restava alla
 * schermata di appaiamento per sempre, riappaiandosi a vuoto.
 *
 * Il cookie quindi torna su `Path=/`, che è dove sta l'app.
 *
 * E l'isolamento? Il percorso non lo reggeva davvero, perché il gettone non è
 * una password comune: è un valore casuale che vale SOLO nel database che lo
 * ha coniato. `resolveIdentity` lo cerca con `SELECT * FROM devices WHERE
 * token_hash = ?` nel DB di quella installazione, quindi un gettone arrivato
 * a una macchina diversa non trova nessuna riga e non è nessuno. Il confine è
 * il database, non la cartella.
 *
 * Resta vero ciò che il caso di prima aveva visto: con `Path=/` il browser
 * MANDA il cookie anche a `/i/<un'altra>/…`. È una perdita di RISERVATEZZA,
 * non di autorizzazione — l'altra macchina vede passare un gettone che non
 * può spendere in casa propria, ma potrebbe rigiocarlo verso la vittima. Per
 * questo non basta fermarsi qui: `servi` non consegna più alla macchina i
 * cookie di un'installazione che non è la sua (vedi `soloCookieNostri`), così
 * ciò che non le spetta non le arriva nemmeno.
 */
function stradaCookie(v: string): string {
  const pezzi = v.split(";");
  // Si parte da 1: il primo pezzo è `nome=valore`, e un cookie che si chiama
  // `path` non è l'attributo `Path`.
  for (let i = 1; i < pezzi.length; i++) {
    const pezzo = pezzi[i]!;
    const eq = pezzo.indexOf("=");
    if ((eq === -1 ? pezzo : pezzo.slice(0, eq)).trim().toLowerCase() !== "path") continue;
    // Qualunque strada la macchina abbia scritto, di qua vale la radice:
    // l'app sta su `/`, e un cookie confinato altrove è un cookie che non
    // torna mai. Una strada che non comincia da `/` non vale nemmeno come
    // strada — il browser la butta e ricade sulla cartella della richiesta,
    // che è proprio il modo silenzioso di sparire.
    pezzi[i] = " Path=/";
    return pezzi.join(";");
  }
  // Senza `Path` il browser userebbe la cartella della richiesta
  // (`/i/<id>/api`): si scrive, invece di lasciarlo accadere.
  return `${v}; Path=/`;
}

/**
 * Quale installazione il browser dice di star guardando.
 *
 * È il biscotto che il Worker deposita alla prima navigazione col prefisso
 * (`BISCOTTO_INSTALLAZIONE` in `worker.ts`). Qui serve a una sola domanda: i
 * cookie che stanno viaggiando appartengono a QUESTA macchina o a un'altra?
 */
const BISCOTTO_INSTALLAZIONE = "topics_inst";

/**
 * I cookie del browser, meno quelli che non spettano a questa installazione.
 *
 * ── PERCHÉ SERVE, ED È IL PEZZO CHE REGGE `Path=/` ──────────────────────────
 * Da quando il cookie di sessione vive su `/` (vedi `stradaCookie`), il
 * browser lo manda a ogni percorso di questa origine, quindi anche a
 * `/i/<un'altra installazione>/…`. Il gettone non VALE su un'altra macchina —
 * si risolve in `SELECT * FROM devices WHERE token_hash = ?` nel database di
 * chi lo ha coniato — ma consegnarglielo lo stesso significa farglielo VEDERE,
 * e chi lo vede può rigiocarlo verso la vittima. È esattamente il difetto che
 * il confinamento per percorso aveva chiuso il 09/08, e riaprirlo per far
 * funzionare l'appaiamento sarebbe stato uno scambio, non una correzione.
 *
 * Quindi il confine si sposta dove il dato è: il ponte consegna i cookie di
 * sessione SOLO alla macchina che il browser dichiara di star guardando. Se
 * `topics_inst` non è questa installazione, i cookie non attraversano il tubo.
 *
 * `topics_inst` stesso passa sempre: non è un segreto, lo scrive il relay, e
 * serve a sapere di chi sono gli altri.
 */
function soloCookieNostri(v: string, installazione: string): string | null {
  const pezzi = v.split(";");
  const tenuti: string[] = [];
  let dichiarata: string | null = null;

  for (const pezzo of pezzi) {
    const eq = pezzo.indexOf("=");
    if (eq === -1) continue;
    const nome = pezzo.slice(0, eq).trim();
    if (nome === BISCOTTO_INSTALLAZIONE) {
      dichiarata = pezzo.slice(eq + 1).trim();
      tenuti.push(pezzo.trim());
      continue;
    }
    tenuti.push(pezzo.trim());
  }

  // Il browser sta guardando un'ALTRA macchina: le sue credenziali non sono
  // affari di questa. Resta solo la dichiarazione di chi sta guardando, che il
  // relay ha scritto lui e non è di nessuno.
  if (dichiarata !== null && dichiarata !== installazione) {
    const solo = tenuti.filter((p) => p.startsWith(`${BISCOTTO_INSTALLAZIONE}=`));
    return solo.length > 0 ? solo.join("; ") : null;
  }

  return tenuti.length > 0 ? tenuti.join("; ") : null;
}

export function creaPonte(opts: PonteOpts) {
  // Si può abbassare e non alzare: un frame più grosso di così avvicinerebbe il
  // tetto per messaggio del Durable Object senza nessun vantaggio, e chi lo
  // alzasse non vedrebbe niente finché non si rompe.
  const max = Math.min(opts.max ?? TUBO_BYTE_PER_FRAME, TUBO_BYTE_PER_FRAME);
  const maxCorpo = opts.maxCorpo ?? MAX_CORPO;
  const maxRisposta = opts.maxRisposta ?? MAX_CORPO;
  const scadenzaMs = opts.scadenzaMs ?? SCADENZA_MS;
  const maxSocket = opts.maxSocket ?? MAX_SOCKET;

  const prossimo = creaContatoreStream("guest");
  const rias = creaRiassemblatore({
    latoRemoto: "host",
    maxStream: MAX_STREAM,
    maxByteStream: maxRisposta,
  });

  /** Chi aspetta, per stream della RICHIESTA. */
  const attese = new Map<number, (e: Esito | null) => void>();
  /** Da quale corsia di risposta si risale a quale richiesta. Serve perché una
   *  corsia può MORIRE, e allora chi aspetta va svegliato lo stesso: un `null`
   *  è una risposta, un'attesa per sempre no. */
  const daRisposta = new Map<number, number>();

  const manda = (f: FrameTubo) => opts.invia(scriviFrame(f));

  // ── I WEBSOCKET ────────────────────────────────────────────────────────
  /**
   * Un socket è una COPPIA di canali e un nome solo.
   *
   * I numeri di stream sono spartiti per parità, quindi nessuno dei due capi
   * può scrivere sulla corsia dell'altro: l'ospite apre il suo (dispari)
   * chiedendo il percorso, la macchina apre il proprio (pari) dicendo com'è
   * andata. Il nome, per tutti e due, è lo stream dell'OSPITE — così non c'è
   * nessuna tabella di corrispondenza da tenere d'accordo, ed è lo stesso
   * accordo che `relay-client.ts` tiene dall'altra parte.
   */
  interface Filo {
    /** Il canale dell'ospite: è anche il nome del socket. */
    sIn: number;
    /** Il canale della macchina, noto solo dopo il suo `wsok`. */
    sOut: number | null;
    su: SocketPonte | null;
    canale: ReturnType<typeof creaCapoCanale>;
    /** Chi aspetta l'esito dell'apertura, finché non è arrivato. */
    apertura: ((e: EsitoWs) => void) | null;
    /**
     * Ciò che la macchina ha mandato PRIMA che il socket del browser fosse
     * attaccato. Non serve un tetto scritto: il credito torna solo DOPO la
     * consegna, quindi la finestra del canale della macchina (mezzo MiB) si
     * chiude da sola. È lo stesso meccanismo del verso opposto, guardato
     * dall'altra parte.
     */
    giu: Array<{ d: string | Uint8Array; byte: number }>;
    finito: boolean;
  }

  /** I socket vivi, per stream del canale dell'OSPITE. */
  const fili = new Map<number, Filo>();
  /** …e gli stessi, per stream del canale della MACCHINA: è da lì che arrivano
   *  i suoi messaggi, e cercarli scorrendo tutti i fili sarebbe un giro
   *  lineare a ogni riga di terminale. */
  const perCanale = new Map<number, Filo>();

  /** La chiusura, con codice e motivo, su uno stream suo. Un `reset` del tubo
   *  ha una sola parola di un vocabolario che parla del TUBO: buttare via
   *  «1000 normale» contro «1011 errore» vorrebbe dire che da fuori rete ogni
   *  chiusura si legge uguale, e chi si riconnette non sa se deve. */
  function dichiaraChiusura(f: Filo, c: ChiusuraWs): void {
    for (const fr of componiStream({
      s: prossimo(), k: GENERE_WS_CHIUSO,
      h: scriviTestaWs({ w: f.sIn }), dati: scriviChiusuraWs(c), max,
    })) manda(fr);
  }

  /**
   * Il socket muore, e lo si dice una volta sola.
   *
   * `finito` si alza PRIMA di toccare il socket del browser: `close()` può far
   * scattare il proprio evento dentro la stessa pila di chiamate, e allora si
   * rientrerebbe qui a dichiarare una SECONDA chiusura — quella del filo,
   * senza codice — che arriva alla macchina dopo quella vera e la copre.
   */
  function spegni(
    f: Filo,
    o: { versoMacchina?: ChiusuraWs; versoBrowser?: ChiusuraWs } = {},
  ): void {
    if (f.finito) return;
    f.finito = true;
    fili.delete(f.sIn);
    if (f.sOut !== null) { perCanale.delete(f.sOut); rias.dimentica(f.sOut); }
    if (o.versoMacchina) dichiaraChiusura(f, o.versoMacchina);
    // Il canale dell'ospite si chiude SEMPRE, anche quando è la macchina ad
    // aver chiuso per prima. Il `reset` non racconta la chiusura — quella l'ha
    // già dichiarata lei — serve a dire all'altro capo di DIMENTICARE questo
    // stream: senza, resta nel suo riassemblatore per tutta la sessione, e i
    // canali hanno un tetto. Un tetto che si consuma non è un tetto, è una
    // scadenza.
    f.canale.chiudi("aborted");

    const risolvi = f.apertura;
    f.apertura = null;
    // Chi stava aspettando l'apertura non aspetta più. `502` e non un silenzio:
    // un upgrade che non risponde lascia la scheda del browser a girare, che è
    // il modo peggiore di guastarsi perché non dice niente.
    risolvi?.({ ok: false, stato: 502 });

    const su = f.su;
    f.su = null;
    f.giu.length = 0;
    if (!su) return;
    try {
      const c = o.versoBrowser;
      // `1006` e `1005` li produce il browser da solo e sono riservati:
      // passarli a `close()` è un'eccezione, non una chiusura. Chi li riceve
      // dal tubo chiude e basta — che è esattamente ciò che vogliono dire.
      if (c && codiceInviabile(c.c)) su.close(c.c, c.r);
      else su.close();
    } catch { /* già chiusa */ }
  }

  /** Un messaggio della macchina verso il browser, e il credito che torna
   *  indietro. Il credito si restituisce solo DOPO la consegna: prima sarebbe
   *  una promessa su qualcosa che non è ancora successo. */
  function consegnaGiu(f: Filo, d: string | Uint8Array, byte: number): void {
    if (!f.su) { f.giu.push({ d, byte }); return; }
    try {
      f.su.send(d);
    } catch {
      // Il browser non c'è più: alla macchina lo si dice come una chiusura,
      // non come un silenzio che le lascia il processo acceso.
      spegni(f, { versoMacchina: { c: WS_CHIUSURA_NORMALE, r: "guest gone" } });
      return;
    }
    if (f.sOut !== null) manda(ricaricaPer(f.sOut, byte));
  }

  /** La macchina risponde all'apertura: è aperto, oppure dice perché no. */
  function apriCanale(s: number, k: string, h: string | undefined): void {
    const scarta = () => { rias.dimentica(s); manda({ f: "reset", s, motivo: "bad-frame" }); };
    // Un canale di un genere che non si conosce chiude QUELLO stream invece di
    // far cadere la sessione: è il punto di estensione del tubo.
    if (k !== GENERE_WS_APERTO) { scarta(); return; }
    const t = leggiTestaWsAperto(h);
    if (!t) { scarta(); return; }
    const f = fili.get(t.re);
    // Un canale che nomina un socket che qui non esiste: o non è mai esistito,
    // o era già morto. In tutti e due i casi non c'è niente a cui attaccarlo.
    if (!f || f.finito) { scarta(); return; }

    f.sOut = s;
    perCanale.set(s, f);
    const risolvi = f.apertura;
    f.apertura = null;
    if (t.s === WS_APERTO) {
      risolvi?.({ ok: true, sIn: f.sIn, ...(t.sp !== undefined ? { sp: t.sp } : {}) });
      return;
    }
    // Non è riuscita, e il perché è l'unica cosa che l'ospite può leggere: si
    // rigira così com'è invece di tradurlo in un guasto generico.
    risolvi?.({ ok: false, stato: t.s });
    spegni(f);
  }

  /** La macchina chiude un socket, con codice e motivo. */
  function chiusuraDallaMacchina(s: number, h: string | undefined, dati: string | Uint8Array): void {
    const t = leggiTestaWsChiuso(h);
    const c = leggiChiusuraWs(dati);
    if (!t || !c) { manda({ f: "reset", s, motivo: "bad-frame" }); return; }
    const f = fili.get(t.w);
    // Un socket già morto non è un errore: i due capi possono chiudere nello
    // stesso istante e nessuno dei due ha sbagliato.
    if (!f) return;
    spegni(f, { versoBrowser: c });
  }

  function consegna(re: number, e: Esito | null): void {
    const risolvi = attese.get(re);
    if (!risolvi) return;
    attese.delete(re);
    risolvi(e);
  }

  /** Le intestazioni della risposta, rimesse su una `Headers`.
   *
   *  Si `append` e non si `set`: `set-cookie` compare più volte, ed è
   *  esattamente quella che fa entrare un dispositivo appaiato — tenerne una
   *  sola vorrebbe dire perdere proprio quella. */
  function intestazioniDi(coppie: Intestazioni, prefisso: string): Headers {
    const h = new Headers();
    for (const [n, v] of coppie) {
      let valore = v;
      // Un rimando relativo esce dal ponte: il browser lo risolverebbe sulla
      // radice del relay, dove non c'è nessuna installazione. Si riporta sotto
      // il prefisso da cui è entrato — e SOLO se è un percorso, mai se è un
      // indirizzo assoluto, che è roba di chi lo ha scritto.
      if (n === "location" && v.startsWith("/") && !v.startsWith("//")) valore = `${prefisso}${v}`;
      else if (n === "set-cookie") valore = stradaCookie(v);
      try { h.append(n, valore); } catch { /* un valore che una Headers rifiuta non passa */ }
    }
    return h;
  }

  return {
    /**
     * Una richiesta del browser, tradotta e servita.
     *
     * `percorso` è ciò che la macchina rigiocherà — percorso e query, sempre da
     * `/` — e lo calcola chi instrada, non chi chiede. `prefisso` è la parte di
     * URL da cui si è entrati, e serve solo a rimettere in piedi i rimandi.
     */
    async servi(req: Request, percorso: string, prefisso: string): Promise<Response> {
      if (!METODI.has(req.method)) return dillo(405, "This method is not carried over the relay.");

      // Quale installazione è questa, letta dal prefisso da cui si è entrati
      // (`/i/<installazione>`): è lo stesso valore che il Worker ha usato per
      // scegliere questo Durable Object, quindi non c'è una seconda verità da
      // tenere d'accordo.
      const installazione = prefisso.startsWith("/i/") ? prefisso.slice(3) : "";

      // Già andato quando la richiesta arriva fin qui: non si compone niente.
      // Mandare una domanda e la sua rinuncia nello stesso respiro costa due
      // buste su un oggetto che si paga a messaggio, e brucia un numero di
      // stream che l'altro capo non riaccetterà mai più.
      if (req.signal?.aborted) return dillo(499, "The client went away before the request was sent.");

      // Il corpo si legge intero prima di partire, e non è una scelta di
      // comodità: la macchina serve una richiesta quando il suo stream è
      // COMPLETO, quindi mandarlo a pezzi mentre arriva non farebbe cominciare
      // niente prima. Il tetto qui non evita di caricarlo — quello lo decide il
      // limite del Worker sopra di noi — ma evita di spezzarlo in centinaia di
      // buste per poi vederselo rifiutare dall'altro capo.
      let corpo: Uint8Array | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        let byte: ArrayBuffer;
        try { byte = await req.arrayBuffer(); } catch { return dillo(400, "The request body could not be read."); }
        if (byte.byteLength > maxCorpo) return dillo(413, "The request body is too large for the relay.");
        if (byte.byteLength > 0) corpo = new Uint8Array(byte);
      }

      // Le intestazioni si girano com'erano: chi decide cosa questa richiesta
      // può vedere è la macchina, con le stesse regole della rete locale, e le
      // toglie lei quelle che non le spettano (`intestazioniRichiesta`).
      //
      // UNA eccezione, e sta qui perché è l'unica cosa che la macchina non può
      // decidere da sola: i cookie di un'ALTRA installazione. Di là non si
      // distinguono dai propri (stesso nome, stessa origine), e girarglieli
      // significherebbe mostrare a una macchina il gettone di sessione di
      // un'altra. Vedi `soloCookieNostri`.
      const intestazioni: Intestazioni = [];
      for (const [n, v] of req.headers) {
        if (n === "cookie") {
          const nostri = soloCookieNostri(v, installazione);
          if (nostri !== null) intestazioni.push([n, nostri]);
          continue;
        }
        intestazioni.push([n, v]);
      }

      // L'indirizzo VERO di chi ha bussato. Qui e' l'unico posto che lo sa: la
      // macchina vede solo il proprio salto locale, e le intestazioni di
      // inoltro le spoglia apposta perche' chi bussa potrebbe scriversele.
      // Senza questa riga il tetto per-indirizzo dell'appaiamento diventa un
      // solo secchio per tutta Internet, e il cartello di approvazione dice
      // «viene dalla tua macchina» a una richiesta arrivata da fuori.
      const vero = req.headers.get("cf-connecting-ip") ?? "";
      const testa = scriviTesta({
        m: req.method, p: percorso, h: intestazioni,
        ...(vero ? { ip: vero } : {}),
      });
      const s = prossimo();
      const risposta = new Promise<Esito | null>((res) => attese.set(s, res));

      for (const f of componiStream({ s, k: GENERE_RICHIESTA, h: testa, ...(corpo !== undefined ? { dati: corpo } : {}), max })) {
        manda(f);
      }

      let scaduta: ReturnType<typeof setTimeout> | undefined;
      const attesa = new Promise<Esito | null | "scaduta">((res) => {
        scaduta = setTimeout(() => res("scaduta"), scadenzaMs);
      });
      const via = seNeVa(req);
      const e = await Promise.race([risposta, attesa, via.andato]);
      if (scaduta !== undefined) clearTimeout(scaduta);
      via.stacca();

      // Le due rinunce fanno la STESSA cosa di là, e cambia solo chi ha smesso
      // di aspettare per primo: qui la scadenza, lì chi aveva chiesto. Ciò che
      // la macchina deve sapere è identico — questa corsia non serve più.
      if (e === "scaduta" || e === "andato") {
        // Si rinuncia anche di là: la macchina deve smettere di leggere un
        // corpo che non ha più dove andare.
        attese.delete(s);
        manda({ f: "reset", s, motivo: "aborted" });
        return e === "andato"
          ? dillo(499, "The client went away before the installation answered.")
          : dillo(504, "The installation did not answer in time.");
      }
      if (!e) return dillo(502, "The installation could not serve this request.");

      const senzaCorpo = SENZA_CORPO.has(e.stato) || req.method === "HEAD";
      // `BodyInit` esclude le viste su un `SharedArrayBuffer` (da TS 5.7 il
      // parametro di `Uint8Array` lo dice nel tipo), e i byte che escono dal
      // riassemblatore sono dichiarati sul buffer generico. Qui non ce ne sono:
      // nascono da `daBase64url` e da `TextEncoder`, cioè sempre su un
      // `ArrayBuffer` normale. Si dice, invece di ricopiarli — un corpo grande
      // ricopiato per una differenza che esiste solo nei tipi è memoria bruciata.
      const byte = e.corpo as Uint8Array<ArrayBuffer>;
      return new Response(senzaCorpo ? null : byte, {
        status: e.stato,
        headers: intestazioniDi(e.intestazioni, prefisso),
      });
    },

    /**
     * Un upgrade WebSocket del browser, chiesto alla macchina.
     *
     * Si ASPETTA l'esito prima di rispondere, e non è pignoleria: un `101`
     * dato subito e poi chiuso è, per chi guarda da fuori, un socket che si
     * apre e muore senza dire niente — mentre un percorso che di là non esiste
     * merita un guasto che si legge. E il sottoprotocollo scelto lo decide la
     * macchina: senza aspettarla non ci sarebbe niente da mettere nella
     * risposta di apertura, e un browser che ne aveva chiesto uno rifiuta la
     * connessione.
     *
     * L'oggetto non viene sfrattato mentre una `fetch` è in volo, quindi lo
     * stato di questo socket e chi lo ha chiesto stanno sempre nella stessa
     * istanza, per costruzione.
     */
    async apriWs(req: Request, percorso: string): Promise<EsitoWs> {
      // Il tetto è quello della macchina, dichiarato qui: di là si legge come
      // un `reset`, cioè come una morte senza motivo. E ha un numero SUO —
      // `503` qui direbbe «l'accesso da fuori non è configurato», che di
      // questa installazione non è vero: sono i posti a essere finiti.
      if (fili.size >= maxSocket) return { ok: false, stato: 429 };

      // Chi bussava se n'è già andato: non si apre niente. Un socket chiesto e
      // rinunciato nello stesso respiro è, di là, una stretta di mano vera che
      // parte e muore — cioè un processo acceso per nessuno.
      if (req.signal?.aborted) return { ok: false, stato: 499 };

      // Le intestazioni si girano com'erano: chi decide cosa questo socket può
      // vedere è la macchina, con le stesse regole della rete locale, e le
      // toglie lei quelle che non le spettano (`intestazioniUpgrade`).
      const intestazioni: Intestazioni = [];
      for (const [n, v] of req.headers) intestazioni.push([n, v]);
      const sp = protocolliChiesti(req.headers.get("sec-websocket-protocol"));

      const sIn = prossimo();
      const canale = creaCapoCanale({ s: sIn, invia: manda, max });
      const f: Filo = { sIn, sOut: null, su: null, canale, apertura: null, giu: [], finito: false };
      fili.set(sIn, f);
      const aperto = new Promise<EsitoWs>((res) => { f.apertura = res; });
      canale.apri(GENERE_WS, scriviTestaWs({
        p: percorso, h: intestazioni, ...(sp.length > 0 ? { sp } : {}),
        // Stessa ragione dell'HTTP: senza, un upgrade da fuori si presenta
        // come locale.
        ...(req.headers.get("cf-connecting-ip") ? { ip: req.headers.get("cf-connecting-ip")! } : {}),
      }));

      let scaduta: ReturnType<typeof setTimeout> | undefined;
      const attesa = new Promise<"scaduta">((res) => {
        scaduta = setTimeout(() => res("scaduta"), scadenzaMs);
      });
      const via = seNeVa(req);
      const e = await Promise.race([aperto, attesa, via.andato]);
      if (scaduta !== undefined) clearTimeout(scaduta);
      via.stacca();
      if (e !== "scaduta" && e !== "andato") return e;

      // Si rinuncia anche di là: la macchina deve smettere di tenere aperto un
      // socket vero che non ha più nessuno davanti. Vale identico per la
      // scadenza e per chi se n'è andato — di là non c'è nessuna differenza da
      // raccontare, e qui cambia solo lo stato che legge chi ha bussato.
      f.apertura = null;
      spegni(f);
      return { ok: false, stato: e === "andato" ? 499 : 504 };
    },

    /**
     * Il socket del browser è stato accettato: da qui in poi i due versi
     * scorrono. Quello che la macchina ha mandato nel frattempo si consegna
     * adesso, in ordine — l'ha già pagato in credito, e perderlo si vedrebbe
     * come una schermata che comincia a metà.
     */
    collegaWs(sIn: number, su: SocketPonte): void {
      const f = fili.get(sIn);
      if (!f || f.finito) { try { su.close(); } catch { /* già chiusa */ } return; }
      f.su = su;
      for (const q of f.giu.splice(0)) consegnaGiu(f, q.d, q.byte);
    },

    /**
     * Un messaggio del browser verso la macchina.
     *
     * `false` vuol dire «questo socket qui non esiste»: chi instrada lo chiude,
     * perché un filo che non arriva da nessuna parte è peggio di un filo
     * tagliato — somiglia a funzionare.
     */
    messaggioWs(sIn: number, d: string | Uint8Array): boolean {
      const f = fili.get(sIn);
      if (!f || f.finito) return false;
      // «troppo» vuol dire che la macchina non consuma e la coda ha sfondato il
      // tetto. Un guasto dichiarato è meglio di una memoria che cresce senza
      // che nessuno sappia perché.
      if (f.canale.manda(d) === "troppo") {
        spegni(f, {
          versoMacchina: { c: WS_PONTE_GIU, r: "backpressure" },
          versoBrowser: { c: WS_PONTE_GIU, r: "backpressure" },
        });
      }
      return true;
    },

    /** Il browser ha chiuso: il codice si porta di là così com'è, e un codice
     *  che il WebSocket non permette di dichiarare diventa una chiusura
     *  normale — è la macchina a rigirarlo al socket vero. */
    chiudiWs(sIn: number, codice?: number, motivo?: string): void {
      const f = fili.get(sIn);
      if (!f) return;
      const c = typeof codice === "number" && Number.isInteger(codice) && codice >= 1000 && codice <= 4999
        ? codice
        : WS_CHIUSURA_NORMALE;
      // Il browser è già andato: non gli si manda niente, nemmeno una chiusura.
      f.su = null;
      spegni(f, { versoMacchina: { c, r: (motivo ?? "").slice(0, 512) } });
    },

    /** Un `payload` in arrivo dalla macchina, per QUESTA sessione. */
    ricevi(payload: string): void {
      const f = leggiFramePayload(payload);
      // Un frame storto non è un'eccezione a metà di un `onmessage`: è uno
      // stream che muore, e gli altri continuano.
      if (!f) return;
      const e = rias.ricevi(f);

      if (e.esito === "aperto") {
        // Un canale è un socket, e uno stream normale una risposta: le due
        // forme non si scambiano di posto. Un `res` come canale non finirebbe
        // mai, e un `wsok` senza canale consegnerebbe un socket intero alla
        // sua chiusura.
        if (e.canale) { apriCanale(e.s, e.k, e.h); return; }
        if (e.k === GENERE_RISPOSTA) {
          const t = leggiTestaRisposta(e.h);
          if (t) daRisposta.set(e.s, t.re);
        }
        return;
      }

      if (e.esito === "messaggio") {
        const filo = perCanale.get(e.s);
        if (!filo || filo.finito) { manda({ f: "reset", s: e.s, motivo: "bad-frame" }); return; }
        consegnaGiu(filo, e.dati, e.byte);
        return;
      }

      if (e.esito === "credito") {
        // Il credito cammina al contrario dei dati: riguarda il canale che ha
        // aperto QUESTO capo, ed è per questo che si cerca fra i `sIn`.
        fili.get(e.s)?.canale.ricarica(e.c);
        return;
      }

      if (e.esito === "completo") {
        if (e.k === GENERE_WS_CHIUSO) { chiusuraDallaMacchina(e.s, e.h, e.dati); return; }
        if (e.k !== GENERE_RISPOSTA) { manda({ f: "reset", s: e.s, motivo: "bad-frame" }); return; }
        const t = leggiTestaRisposta(e.h);
        if (!t) { manda({ f: "reset", s: e.s, motivo: "bad-frame" }); return; }
        daRisposta.delete(e.s);
        consegna(t.re, {
          stato: t.s,
          intestazioni: t.h ?? [],
          corpo: e.e === "b" ? e.dati : new TextEncoder().encode(e.dati),
        });
        return;
      }

      if (e.esito === "chiuso" || e.esito === "errore") {
        // Un socket può morire dai due lati: la macchina chiude il PROPRIO
        // canale, oppure resetta quello dell'ospite quando la testa non le è
        // nemmeno piaciuta. Nessuno dei due porta un codice — quello viaggia
        // sullo stream di chiusura — quindi per il browser è una caduta del
        // filo, che è esattamente ciò che è.
        const filo = perCanale.get(e.s) ?? fili.get(e.s);
        if (filo) { spegni(filo); return; }
        // Due modi di morire, e vanno svegliati tutti e due: la macchina può
        // chiudere la corsia di RISPOSTA (e allora si risale al `re`) oppure
        // quella della RICHIESTA, quando la testa non le è nemmeno piaciuta —
        // e lì non c'è nessuna risposta da cui risalire.
        const re = daRisposta.get(e.s);
        if (re !== undefined) { daRisposta.delete(e.s); consegna(re, null); }
        else consegna(e.s, null);
      }
    },

    /**
     * Il filo con la macchina è caduto.
     *
     * Chi stava aspettando non aspetta più: senza questo, ogni richiesta in
     * volo resterebbe appesa fino alla scadenza, e la scheda del browser
     * girerebbe mezzo minuto per dire alla fine la cosa che si sapeva già.
     */
    abbandona(): void {
      for (const re of [...attese.keys()]) consegna(re, null);
      daRisposta.clear();
      // …e i socket non sono diversi: un filo che resta aperto verso una
      // macchina che non c'è più è la cosa che somiglia di più a funzionare
      // senza esserlo. Si dichiara PERCHÉ, così chi sta di là sa che deve
      // riaprire invece di restare a guardare qualcosa che non si aggiorna.
      for (const f of [...fili.values()]) {
        spegni(f, { versoBrowser: { c: WS_PONTE_GIU, r: "installation offline" } });
      }
    },

    inAttesa: () => attese.size,
    /** Quanti socket sono vivi su questa sessione. */
    wsVivi: () => fili.size,
  };
}
