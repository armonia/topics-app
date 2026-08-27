/**
 * Un relay FINTO, in memoria: due capi, nessuna rete.
 *
 * Serve a due cose, e la seconda è quella che conta.
 *
 * La prima: provare il protocollo senza dipendere da un servizio esterno. Un
 * test che ha bisogno di Cloudflare per girare è un test che nella pratica non
 * gira.
 *
 * La seconda: **tenere onesta la promessa che il trasporto è sostituibile.**
 * Finché esistono due implementazioni del relay — questa e quella vera — il
 * protocollo non può scivolare dentro l'implementazione senza che qualcosa si
 * rompa. Se un giorno il Worker cominciasse a guardare dentro le buste, o a
 * dipendere da un ordine che il protocollo non garantisce, questa smetterebbe
 * di funzionare e lo si saprebbe subito. È lo stesso motivo per cui un
 * linguaggio con due compilatori ha una specifica migliore.
 *
 * Non è un mock: implementa il contratto per intero, compreso il fatto di NON
 * poter leggere ciò che inoltra.
 */

/**
 * Il segreto d'aggancio nei test che non fanno una stretta di mano vera.
 *
 * Questi test iniettano `apriSocket`, quindi il filo non esce dal processo e
 * nessuno verifica niente: il valore serve solo a soddisfare la forma di
 * `RelayDeps`. Sta QUI e non ripetuto in cinque file perché un segreto finto
 * copiato cinque volte è un segreto finto che un giorno qualcuno cerca di
 * cambiare in un posto solo.
 *
 * Chi invece prova il controllo vero — che il nome sia il digest della
 * preimmagine — non usa questo: deriva il nome dal segreto con
 * `derivaRelayId`, perché una coppia inventata a mano non corrisponderebbe e il
 * test proverebbe solo il rifiuto.
 */
export const SEGRETO_FINTO = "segreto-finto-per-i-test-0123456789";
import {
  RELAY_PROTOCOL_VERSION, leggiMessaggio, haContenutoOpaco,
  componiStream, creaCapoCanale, creaContatoreStream, creaRiassemblatore, leggiFramePayload,
  ricaricaPer, scriviFrame,
  type EsitoInvio, type EsitoTubo, type LatoTubo, type MessaggioRelay, type MotivoStream,
  type Rifiutato, type RuoloSessione,
} from "./relay-protocol";
import {
  GENERE_RICHIESTA, GENERE_RISPOSTA, leggiTestaRisposta, scriviTesta,
  type Intestazioni,
} from "./relay-http";
import {
  GENERE_WS, GENERE_WS_APERTO, GENERE_WS_CHIUSO, WS_APERTO,
  WS_CHIUSURA_ANOMALA, WS_CHIUSURA_NORMALE,
  leggiChiusuraWs, leggiTestaWsAperto, leggiTestaWsChiuso, scriviChiusuraWs, scriviTestaWs,
} from "./relay-ws";

type Invia = (m: MessaggioRelay) => void;

interface Head {
  invia: Invia;
}

export interface FakeRelayOpts {
  /** I token validi per installazione. Il relay verifica CHE tu sia
   *  l'installazione che dici, non CHI sei come persona — quella domanda non è
   *  sua e non deve diventarlo. */
  tokenValidi?: Record<string, string>;
  /** I riferimenti di condivisione ancora buoni. Assente = tutti buoni. */
  shareRefValidi?: Set<string>;
}

/**
 * Un relay che funziona davvero, in memoria.
 *
 * Regola che si porta dietro dal contratto: quando la macchina non è collegata,
 * l'ospite riceve `host-offline` — un motivo suo, non un errore generico. È la
 * differenza fra dire «la sua macchina è spenta» e lasciare qualcuno davanti a
 * una pagina vuota che si legge come «non ti hanno condiviso niente».
 */
export function creaRelayFinto(opts: FakeRelayOpts = {}) {
  const macchine = new Map<string, Head>();
  const ospiti = new Map<string, { capo: Head; installationId: string; ruolo: RuoloSessione }>();
  /** Ciò che il relay ha VISTO passare: serve ai test per dimostrare che non
   *  contiene i contenuti. */
  const visto: Array<Record<string, unknown>> = [];
  let contatore = 0;

  const nega = (capo: Head, motivo: Rifiutato["motivo"]) => capo.invia({ t: "denied", motivo });

  function collegaMacchina(invia: Invia) {
    const capo: Head = { invia };
    let id: string | null = null;

    return {
      /** Un messaggio dalla macchina verso il relay. */
      ricevi(raw: unknown) {
        const m = leggiMessaggio(raw);
        if (!m) return nega(capo, "bad-version");
        visto.push({ t: m.t, ...(haContenutoOpaco(m) ? {} : {}) });

        if (m.t === "hello") {
          const atteso = opts.tokenValidi?.[m.installationId];
          if (atteso !== undefined && atteso !== m.token) return nega(capo, "bad-token");
          id = m.installationId;
          macchine.set(id, capo);
          capo.invia({ t: "ready", v: RELAY_PROTOCOL_VERSION });
          return;
        }

        if (m.t === "to-guest") {
          if (!id) return nega(capo, "bad-token");
          const dest = ospiti.get(m.to);
          // Una busta per un ospite che se n'è andato si lascia cadere in
          // silenzio: non è un errore della macchina, è il mondo che è cambiato.
          if (dest && dest.installationId === id) dest.capo.invia(m);
          return;
        }

        nega(capo, "bad-version");
      },
      scollega() {
        if (id) macchine.delete(id);
        for (const [sid, o] of ospiti) {
          if (o.installationId === id) {
            o.capo.invia({ t: "denied", motivo: "host-offline" });
            ospiti.delete(sid);
          }
        }
      },
    };
  }

  function collegaOspite(invia: Invia) {
    const capo: Head = { invia };
    let sessionId: string | null = null;

    return {
      ricevi(raw: unknown) {
        const m = leggiMessaggio(raw);
        if (!m) return nega(capo, "bad-version");
        visto.push({ t: m.t });

        if (m.t === "guest-open") {
          if (opts.shareRefValidi && !opts.shareRefValidi.has(m.shareRef)) {
            return nega(capo, "expired");
          }
          const host = macchine.get(m.installationId);
          if (!host) return nega(capo, "host-offline");
          sessionId = `s${++contatore}`;
          ospiti.set(sessionId, { capo, installationId: m.installationId, ruolo: "guest" });
          capo.invia({ t: "ready", v: RELAY_PROTOCOL_VERSION, sessionId });
          host.invia({ t: "guest-joined", sessionId, ruolo: "guest" });
          return;
        }

        if (m.t === "to-host") {
          if (!sessionId) return nega(capo, "bad-token");
          const o = ospiti.get(sessionId);
          const host = o && macchine.get(o.installationId);
          if (!host) return nega(capo, "host-offline");
          // Il relay aggiunge da chi viene: l'ospite non se lo può attribuire
          // da solo, o potrebbe spacciarsi per un altro.
          host.invia({ t: "to-guest", to: sessionId, payload: m.payload });
          return;
        }

        nega(capo, "bad-version");
      },
      scollega() {
        if (!sessionId) return;
        const o = ospiti.get(sessionId);
        if (o) {
          macchine.get(o.installationId)?.invia({ t: "guest-left", sessionId, ruolo: o.ruolo });
          ospiti.delete(sessionId);
        }
      },
    };
  }

  /**
   * Un DISPOSITIVO appaiato che si aggancia da un'altra rete.
   *
   * Sta accanto a `collegaOspite` e non dentro, perché nel relay vero le due
   * cose sono due PERCORSI diversi (`/d/:id` e `/s/:id`) e il ruolo nasce da
   * lì. Qui la stessa asimmetria si vede nella forma: l'installazione arriva
   * al collegamento e non con un messaggio dopo, esattamente come nell'URL —
   * un dispositivo non ha nessun riferimento di condivisione da mostrare, ha
   * l'installazione intera davanti, e chi decide cosa può vedere è
   * l'ascoltatore dedicato della macchina, non il relay.
   */
  function collegaDispositivo(installationId: string, invia: Invia) {
    const capo: Head = { invia };
    let sessionId: string | null = null;

    const host = macchine.get(installationId);
    if (!host) nega(capo, "host-offline");
    else {
      sessionId = `s${++contatore}`;
      ospiti.set(sessionId, { capo, installationId, ruolo: "device" });
      capo.invia({ t: "ready", v: RELAY_PROTOCOL_VERSION, sessionId });
      host.invia({ t: "guest-joined", sessionId, ruolo: "device" });
    }

    return {
      ricevi(raw: unknown) {
        const m = leggiMessaggio(raw);
        if (!m) return nega(capo, "bad-version");
        visto.push({ t: m.t });

        if (m.t === "to-host") {
          if (!sessionId) return nega(capo, "host-offline");
          const o = ospiti.get(sessionId);
          const h = o && macchine.get(o.installationId);
          if (!h) return nega(capo, "host-offline");
          // Il mittente lo attacca il RELAY, come per gli ospiti di link: un
          // capo che se lo scegliesse potrebbe spacciarsi per un altro.
          h.invia({ t: "to-guest", to: sessionId, payload: m.payload });
          return;
        }

        nega(capo, "bad-version");
      },
      scollega() {
        if (!sessionId) return;
        const o = ospiti.get(sessionId);
        if (o) {
          macchine.get(o.installationId)?.invia({ t: "guest-left", sessionId, ruolo: o.ruolo });
          ospiti.delete(sessionId);
        }
      },
      sessionId: () => sessionId,
    };
  }

  return {
    collegaMacchina,
    collegaOspite,
    collegaDispositivo,
    /** Tutto ciò che il relay ha visto. Nessun contenuto, per costruzione. */
    visto,
    macchineCollegate: () => macchine.size,
    ospitiCollegati: () => ospiti.size,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// IL TUBO, dal lato dei CAPI
// ───────────────────────────────────────────────────────────────────────────
/**
 * Un capo che parla il tubo — la busta interna — sopra un `payload` qualsiasi.
 *
 * Sta qui accanto al relay finto e non dentro il client vero per lo stesso
 * motivo per cui il relay finto esiste: **due implementazioni tengono onesto un
 * protocollo**. Finché questo capo e quello di produzione spezzano, numerano e
 * rimettono insieme gli stream nello stesso modo, il formato ha una definizione
 * fuori da chi lo usa. Il giorno in cui il client vero dipendesse da un ordine
 * o da un campo che il protocollo non promette, questo smetterebbe di capirlo.
 *
 * Non sa niente di come il `payload` arriva dall'altra parte, e non deve: il
 * tubo è indipendente dal trasporto. Chi lo usa lo attacca a un relay finto, a
 * un WebSocket vero o a due funzioni in memoria — e in tutti e tre i casi il
 * comportamento atteso è identico.
 */
export interface CapoTuboOpts {
  /** Da che capo si sta: decide i numeri che si aprono (pari la macchina,
   *  dispari l'ospite) e la parità che ci si aspetta di ricevere. */
  lato: LatoTubo;
  /** Dove finisce ogni frame già serializzato. È il solo contatto col
   *  trasporto. */
  invia(payload: string): void;
  /** Quanto grande può essere un pezzo. Abbassabile nei test, dove uno stream
   *  spezzato in venti frame si scrive in una riga invece che in mezzo MiB.
   *  Sotto la misura di un singolo carattere il taglio SFORA invece di spaccarlo
   *  (vedi `dividiTesto`): un pezzo un po' più largo si accetta, un carattere a
   *  metà non torna più indietro. */
  max?: number;
  maxStream?: number;
  maxByteStream?: number;
}

export function creaCapoTubo(opts: CapoTuboOpts) {
  const prossimo = creaContatoreStream(opts.lato);
  const rias = creaRiassemblatore({
    latoRemoto: opts.lato === "host" ? "guest" : "host",
    ...(opts.maxStream !== undefined ? { maxStream: opts.maxStream } : {}),
    ...(opts.maxByteStream !== undefined ? { maxByteStream: opts.maxByteStream } : {}),
  });

  return {
    /**
     * Apre uno stream e ci manda tutto quello che c'è, spezzato. Torna il
     * numero: è la sola cosa che serve per annullarlo o per riconoscere la
     * risposta.
     */
    manda(k: string, dati?: string | Uint8Array, h?: string): number {
      const s = prossimo();
      for (const f of componiStream({
        s, k,
        ...(h !== undefined ? { h } : {}),
        ...(dati !== undefined ? { dati } : {}),
        ...(opts.max !== undefined ? { max: opts.max } : {}),
      })) opts.invia(scriviFrame(f));
      return s;
    },

    /** Rinuncia. Vale anche su uno stream che l'altro capo ha già chiuso: due
     *  capi possono mollare nello stesso istante e nessuno dei due ha
     *  sbagliato. */
    annulla(s: number, motivo: MotivoStream = "aborted"): void {
      opts.invia(scriviFrame({ f: "reset", s, motivo }));
    },

    /**
     * Un `payload` in arrivo. Un JSON storto non diventa un'eccezione a metà di
     * un `onmessage`: diventa un errore su UNO stream, e gli altri continuano.
     */
    ricevi(payload: string): EsitoTubo {
      const f = leggiFramePayload(payload);
      if (!f) return { esito: "errore", s: -1, motivo: "bad-frame" };
      return rias.ricevi(f);
    },

    apertiOra: rias.apertiOra,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// L'OSPITE che chiede HTTP dentro il tubo
// ───────────────────────────────────────────────────────────────────────────
/**
 * Il capo OSPITE dello scambio richiesta/risposta.
 *
 * Esiste qui per la stessa ragione del relay finto: **due implementazioni
 * tengono onesto un formato**. Il proxy della macchina
 * (`server/services/relay-client.ts`) è l'altra, e nessuna delle due può
 * scivolare — la testa di risposta la scrive uno e la legge l'altro, e se uno
 * dei due cominciasse a dipendere da un campo che il formato non promette,
 * l'altro smetterebbe di capirlo.
 *
 * Non sa niente di come il `payload` arriva: si attacca a un relay finto, a un
 * WebSocket vero o a due funzioni in memoria, e in tutti e tre i casi si
 * comporta uguale.
 */
export interface RispostaTubo {
  stato: number;
  intestazioni: Intestazioni;
  corpo: Uint8Array;
  testo(): string;
}

export interface GuestHttpOpts {
  invia(payload: string): void;
  max?: number;
}

export function creaOspiteHttp(opts: GuestHttpOpts) {
  const tubo = creaCapoTubo({
    lato: "guest",
    invia: opts.invia,
    ...(opts.max !== undefined ? { max: opts.max } : {}),
  });
  /** Chi aspetta una risposta, per stream della RICHIESTA. */
  const attese = new Map<number, (r: RispostaTubo | null) => void>();
  /**
   * Le risposte arrivate PRIMA che qualcuno le aspettasse.
   *
   * Non è un caso di scuola: il trasporto può essere sincrono — due funzioni in
   * memoria, o un capo che rifiuta la richiesta senza toccare la rete — e
   * allora la risposta rientra da questa stessa pila di chiamate, mentre
   * `chiedi` non ha ancora avuto modo di registrarsi. Senza questa mappa quel
   * caso è un'attesa che non finisce, e si vede solo come un test che scade.
   */
  const pronte = new Map<number, RispostaTubo | null>();
  /** Da quale stream di risposta si torna a quale richiesta. Serve perché una
   *  corsia può MORIRE (`reset`), e allora chi aspetta va svegliato lo stesso:
   *  un `null` è una risposta, un'attesa per sempre no. */
  const fromReplyAtRequest = new Map<number, number>();

  const consegna = (re: number, r: RispostaTubo | null) => {
    const risolvi = attese.get(re);
    if (!risolvi) { pronte.set(re, r); return; }
    attese.delete(re);
    risolvi(r);
  };

  return {
    /** Manda una richiesta e aspetta la risposta. `null` = la corsia è morta. */
    chiedi(
      m: string, p: string,
      extra: { h?: Intestazioni; corpo?: string | Uint8Array } = {},
    ): { s: number; risposta: Promise<RispostaTubo | null> } {
      const testa = scriviTesta({ m, p, ...(extra.h !== undefined ? { h: extra.h } : {}) });
      const s = tubo.manda(GENERE_RICHIESTA, extra.corpo, testa);
      if (pronte.has(s)) {
        const gia = pronte.get(s) ?? null;
        pronte.delete(s);
        return { s, risposta: Promise.resolve(gia) };
      }
      const risposta = new Promise<RispostaTubo | null>((res) => attese.set(s, res));
      return { s, risposta };
    },

    /**
     * Apre uno stream di un genere qualsiasi.
     *
     * Serve a provare il punto di estensione del tubo: un capo che riceve un
     * genere che non conosce deve chiudere QUELLO stream e restare in piedi. Va
     * fatto dal contatore di questo capo — un numero scelto a mano brucerebbe
     * quelli più bassi, e le richieste dopo verrebbero rifiutate per un motivo
     * che non c'entra niente.
     */
    apriGenere(k: string, dati?: string | Uint8Array, h?: string): number {
      return tubo.manda(k, dati, h);
    },

    /** Rinuncia. La macchina deve smettere di leggere il corpo di sopra. */
    annulla(s: number, motivo: MotivoStream = "aborted") {
      tubo.annulla(s, motivo);
      consegna(s, null);
    },

    /** Un `payload` in arrivo dalla macchina. */
    ricevi(payload: string): EsitoTubo {
      const e = tubo.ricevi(payload);
      if (e.esito === "aperto" && e.k === GENERE_RISPOSTA) {
        const t = leggiTestaRisposta(e.h);
        if (t) fromReplyAtRequest.set(e.s, t.re);
      }
      if (e.esito === "completo") {
        if (e.k !== GENERE_RISPOSTA) return e;
        const t = leggiTestaRisposta(e.h);
        if (!t) return e;
        fromReplyAtRequest.delete(e.s);
        const corpo = e.e === "b" ? e.dati : new TextEncoder().encode(e.dati);
        consegna(t.re, {
          stato: t.s, intestazioni: t.h ?? [], corpo,
          testo: () => new TextDecoder().decode(corpo),
        });
      }
      if (e.esito === "chiuso" || e.esito === "errore") {
        // Due modi di morire, e vanno svegliati tutti e due: la macchina può
        // chiudere la corsia di RISPOSTA (e allora si risale al `re`) oppure
        // la corsia della RICHIESTA, quando la testa non le è nemmeno
        // piaciuta — e lì non c'è nessuna risposta da cui risalire.
        const re = fromReplyAtRequest.get(e.s);
        if (re !== undefined) { fromReplyAtRequest.delete(e.s); consegna(re, null); }
        else consegna(e.s, null);
      }
      return e;
    },

    inAttesa: () => attese.size,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// L'OSPITE che apre WEBSOCKET dentro il tubo
// ───────────────────────────────────────────────────────────────────────────
/**
 * Il capo OSPITE di un socket dentro il tubo.
 *
 * Esiste qui per la stessa ragione di `creaOspiteHttp`: **due implementazioni
 * tengono onesto un formato**. Il proxy della macchina
 * (`server/services/relay-client.ts`) è l'altra, e nessuna delle due può
 * scivolare — la testa di apertura la scrive uno e la legge l'altro, il credito
 * lo conta uno e lo restituisce l'altro. Il giorno in cui uno dei due
 * cominciasse a dipendere da un campo che il formato non promette, questo
 * smetterebbe di capirlo.
 *
 * È anche la forma che serve a un browser: un oggetto con `manda`, `chiudi` e
 * tre richiami, cioè esattamente ciò su cui si appoggia un `WebSocket` finto —
 * quattro socket veri dell'applicazione, ognuno con vita sua, sopra un tubo
 * solo.
 */
export interface SocketOspite {
  /** Il numero del canale dell'ospite: è il nome del socket per tutti e due i
   *  capi. */
  s: number;
  manda(d: string | Uint8Array): EsitoInvio;
  /** Chiude dichiarando un codice. Il codice arriva davvero al socket vero,
   *  quando è un codice che si può mandare. */
  chiudi(c?: number, r?: string): void;
  stato(): "apertura" | "aperto" | "chiuso";
  /** Quanta corsa resta a QUESTO capo. Serve ai test per vedere la finestra
   *  stringersi, che è la sola prova che il «fermati» esiste. */
  credito(): number;
}

export interface GuestWsOpts {
  invia(payload: string): void;
  max?: number;
  credito?: number;
  arretratoMax?: number;
}

export interface AperturaWs {
  h?: Intestazioni;
  sp?: string[];
  /** Il socket è collegato. `sp` è il sottoprotocollo scelto, se c'è. */
  suAperto?(sp: string | undefined): void;
  suMessaggio?(d: string | Uint8Array): void;
  /** Fine. `stato` è lo stato dell'upgrade quando non è nemmeno partito
   *  (`503`, `400`, `502`), e non c'è quando il socket era aperto: le due cose
   *  si leggono diverse perché sono diverse. */
  suChiuso?(c: number, r: string, stato?: number): void;
}

interface StateSocketGuest {
  s: number;
  sOut: number | null;
  stato: "apertura" | "aperto" | "chiuso";
  canale: ReturnType<typeof creaCapoCanale>;
  cb: AperturaWs;
  /** Lo stato dell'upgrade quando è stato rifiutato: si consegna alla
   *  chiusura, che è l'unico momento in cui chi ascolta se ne può fare
   *  qualcosa. */
  rifiuto: number | null;
}

export function creaOspiteWs(opts: GuestWsOpts) {
  const prossimo = creaContatoreStream("guest");
  const rias = creaRiassemblatore({ latoRemoto: "host" });
  /** I socket per canale dell'OSPITE (il loro nome) e per canale della
   *  MACCHINA (da dove arrivano messaggi e credito). */
  const perNome = new Map<number, StateSocketGuest>();
  const perCanale = new Map<number, StateSocketGuest>();

  const manda = (f: Parameters<typeof scriviFrame>[0]) => opts.invia(scriviFrame(f));

  /**
   * Stacca il socket da tutto ciò che lo tiene, e dice se c'era ancora.
   *
   * Va fatto PRIMA di mettere qualunque cosa sul filo: il trasporto può essere
   * sincrono — due funzioni in memoria — e allora la risposta della macchina
   * rientra qui dentro, a metà della chiusura che si sta dichiarando. Se il
   * socket fosse ancora nelle mappe, quel rientro annuncerebbe una SECONDA
   * chiusura — la caduta del filo, `1006`, senza codice — che arriva a chi
   * ascolta prima di quella vera e la copre.
   */
  function stacca(sk: StateSocketGuest): boolean {
    if (sk.stato === "chiuso") return false;
    sk.stato = "chiuso";
    perNome.delete(sk.s);
    if (sk.sOut !== null) {
      perCanale.delete(sk.sOut);
      // Il canale della MACCHINA va dimenticato anche qui, e non solo quando
      // arriva il suo `reset`: chiudendo per primi, quel reset può non essere
      // ancora sul filo. Lasciarlo nel riassemblatore vorrebbe dire consumare
      // un canale a ogni socket chiuso, e dopo `maxStream` giri nessun socket
      // nuovo si aprirebbe più — restando in «apertura» per sempre, perché il
      // rifiuto arriverebbe su uno stream che nessuno sta più aspettando.
      rias.dimentica(sk.sOut);
    }
    return true;
  }

  /** Fine dichiarata: si chiude la propria corsia e lo si dice a chi ascolta. */
  function annuncia(sk: StateSocketGuest, c: number, r: string, avvisa: boolean) {
    if (avvisa) sk.canale.chiudi("aborted");
    sk.cb.suChiuso?.(c, r, sk.rifiuto ?? undefined);
  }

  function spegni(sk: StateSocketGuest, c: number, r: string, avvisa: boolean) {
    if (!stacca(sk)) return;
    annuncia(sk, c, r, avvisa);
  }

  return {
    /** Apre un socket. Torna subito: il collegamento vero arriva col richiamo,
     *  esattamente come un `WebSocket` del browser. */
    apri(p: string, o: AperturaWs = {}): SocketOspite {
      const s = prossimo();
      const canale = creaCapoCanale({
        s, invia: manda,
        ...(opts.max !== undefined ? { max: opts.max } : {}),
        ...(opts.credito !== undefined ? { credito: opts.credito } : {}),
        ...(opts.arretratoMax !== undefined ? { arretratoMax: opts.arretratoMax } : {}),
      });
      const sk: StateSocketGuest = { s, sOut: null, stato: "apertura", canale, cb: o, rifiuto: null };
      perNome.set(s, sk);
      canale.apri(GENERE_WS, scriviTestaWs({
        p, ...(o.h !== undefined ? { h: o.h } : {}), ...(o.sp !== undefined ? { sp: o.sp } : {}),
      }));
      return {
        s,
        manda: (d) => (sk.stato === "chiuso" ? "troppo" : canale.manda(d)),
        chiudi(c = WS_CHIUSURA_NORMALE, r = "") {
          // Si esce dalle mappe prima di parlare: la macchina risponde a questa
          // chiusura dentro la stessa pila di chiamate.
          if (!stacca(sk)) return;
          // La chiusura viaggia su uno stream suo perché porta un codice: il
          // `reset` del tubo ha solo il vocabolario del tubo.
          for (const fr of componiStream({
            s: prossimo(), k: GENERE_WS_CHIUSO,
            h: scriviTestaWs({ w: s }), dati: scriviChiusuraWs({ c, r }),
            ...(opts.max !== undefined ? { max: opts.max } : {}),
          })) manda(fr);
          annuncia(sk, c, r, true);
        },
        stato: () => sk.stato,
        credito: () => canale.creditoOra(),
      };
    },

    /** Un `payload` in arrivo dalla macchina. */
    ricevi(payload: string): EsitoTubo {
      const fr = leggiFramePayload(payload);
      if (!fr) return { esito: "errore", s: -1, motivo: "bad-frame" };
      const e = rias.ricevi(fr);

      if (e.esito === "aperto" && e.canale && e.k === GENERE_WS_APERTO) {
        const t = leggiTestaWsAperto(e.h);
        const sk = t ? perNome.get(t.re) : undefined;
        if (!t || !sk) { manda({ f: "reset", s: e.s, motivo: "bad-frame" }); return e; }
        sk.sOut = e.s;
        perCanale.set(e.s, sk);
        if (t.s === WS_APERTO) { sk.stato = "aperto"; sk.cb.suAperto?.(t.sp); }
        // Un upgrade rifiutato non è un socket che si chiude: si ricorda lo
        // stato e lo si consegna quando la corsia muore, un istante dopo.
        else sk.rifiuto = t.s;
        return e;
      }

      if (e.esito === "messaggio") {
        const sk = perCanale.get(e.s);
        if (!sk) { manda({ f: "reset", s: e.s, motivo: "bad-frame" }); return e; }
        sk.cb.suMessaggio?.(e.dati);
        // Il credito torna DOPO la consegna, e con la misura che ha contato
        // chi riceve: due conti dello stesso numero prima o poi divergono.
        manda(ricaricaPer(e.s, e.byte));
        return e;
      }

      if (e.esito === "credito") {
        perNome.get(e.s)?.canale.ricarica(e.c);
        return e;
      }

      if (e.esito === "completo" && e.k === GENERE_WS_CHIUSO) {
        const t = leggiTestaWsChiuso(e.h);
        const c = leggiChiusuraWs(e.dati);
        if (!t || !c) { manda({ f: "reset", s: e.s, motivo: "bad-frame" }); return e; }
        const sk = perNome.get(t.w);
        // Un socket già morto non è un errore: i due capi possono chiudere
        // nello stesso istante e nessuno dei due ha sbagliato.
        if (sk) spegni(sk, c.c, c.r, true);
        return e;
      }

      if (e.esito === "chiuso" || e.esito === "errore") {
        const sk = perCanale.get(e.s);
        // La corsia è morta senza che nessuno abbia dichiarato una chiusura:
        // per il socket è una caduta, ed è esattamente ciò che vuol dire 1006.
        if (sk) spegni(sk, WS_CHIUSURA_ANOMALA, "", false);
        return e;
      }

      return e;
    },

    socketVivi: () => perNome.size,
  };
}
