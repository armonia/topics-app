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
  componiStream, creaContatoreStream, creaRiassemblatore, leggiFramePayload, scriviFrame,
  TUBO_BYTE_PER_FRAME,
  type FrameTubo,
} from "../../shared/relay-protocol";
import {
  GENERE_RICHIESTA, GENERE_RISPOSTA, leggiTestaRisposta, scriviTesta,
  type Intestazioni,
} from "../../shared/relay-http";

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
 */
function stradaCookie(v: string, prefisso: string): string {
  const pezzi = v.split(";");
  // Si parte da 1: il primo pezzo è `nome=valore`, e un cookie che si chiama
  // `path` non è l'attributo `Path`.
  for (let i = 1; i < pezzi.length; i++) {
    const pezzo = pezzi[i]!;
    const eq = pezzo.indexOf("=");
    if ((eq === -1 ? pezzo : pezzo.slice(0, eq)).trim().toLowerCase() !== "path") continue;
    const strada = eq === -1 ? "" : pezzo.slice(eq + 1).trim();
    // Una strada che non comincia da `/` non vale come strada: il browser la
    // butta e ricade sulla cartella della richiesta. La si normalizza in
    // radice, così il prefisso resta l'unico confine.
    pezzi[i] = ` Path=${prefisso}${strada.startsWith("/") ? strada : "/"}`;
    return pezzi.join(";");
  }
  return `${v}; Path=${prefisso}/`;
}

export function creaPonte(opts: PonteOpts) {
  // Si può abbassare e non alzare: un frame più grosso di così avvicinerebbe il
  // tetto per messaggio del Durable Object senza nessun vantaggio, e chi lo
  // alzasse non vedrebbe niente finché non si rompe.
  const max = Math.min(opts.max ?? TUBO_BYTE_PER_FRAME, TUBO_BYTE_PER_FRAME);
  const maxCorpo = opts.maxCorpo ?? MAX_CORPO;
  const maxRisposta = opts.maxRisposta ?? MAX_CORPO;
  const scadenzaMs = opts.scadenzaMs ?? SCADENZA_MS;

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
      else if (n === "set-cookie") valore = stradaCookie(v, prefisso);
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
      const intestazioni: Intestazioni = [];
      for (const [n, v] of req.headers) intestazioni.push([n, v]);

      const testa = scriviTesta({ m: req.method, p: percorso, h: intestazioni });
      const s = prossimo();
      const risposta = new Promise<Esito | null>((res) => attese.set(s, res));

      for (const f of componiStream({ s, k: GENERE_RICHIESTA, h: testa, ...(corpo !== undefined ? { dati: corpo } : {}), max })) {
        manda(f);
      }

      let scaduta: ReturnType<typeof setTimeout> | undefined;
      const attesa = new Promise<Esito | null | "scaduta">((res) => {
        scaduta = setTimeout(() => res("scaduta"), scadenzaMs);
      });
      const e = await Promise.race([risposta, attesa]);
      if (scaduta !== undefined) clearTimeout(scaduta);

      if (e === "scaduta") {
        // Si rinuncia anche di là: la macchina deve smettere di leggere un
        // corpo che non ha più dove andare.
        attese.delete(s);
        manda({ f: "reset", s, motivo: "aborted" });
        return dillo(504, "The installation did not answer in time.");
      }
      if (!e) return dillo(502, "The installation could not serve this request.");

      const senzaCorpo = SENZA_CORPO.has(e.stato) || req.method === "HEAD";
      return new Response(senzaCorpo ? null : e.corpo, {
        status: e.stato,
        headers: intestazioniDi(e.intestazioni, prefisso),
      });
    },

    /** Un `payload` in arrivo dalla macchina, per QUESTA sessione. */
    ricevi(payload: string): void {
      const f = leggiFramePayload(payload);
      // Un frame storto non è un'eccezione a metà di un `onmessage`: è uno
      // stream che muore, e gli altri continuano.
      if (!f) return;
      const e = rias.ricevi(f);

      if (e.esito === "aperto" && e.k === GENERE_RISPOSTA) {
        const t = leggiTestaRisposta(e.h);
        if (t) daRisposta.set(e.s, t.re);
        return;
      }

      if (e.esito === "completo") {
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
    },

    inAttesa: () => attese.size,
  };
}
