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
import {
  RELAY_PROTOCOL_VERSION, leggiMessaggio, haContenutoOpaco,
  componiStream, creaContatoreStream, creaRiassemblatore, leggiFramePayload, scriviFrame,
  type EsitoTubo, type LatoTubo, type MessaggioRelay, type MotivoStream, type Rifiutato,
  type RuoloSessione,
} from "./relay-protocol";
import {
  GENERE_RICHIESTA, GENERE_RISPOSTA, leggiTestaRisposta, scriviTesta,
  type Intestazioni,
} from "./relay-http";

type Invia = (m: MessaggioRelay) => void;

interface Capo {
  invia: Invia;
}

export interface RelayFintoOpts {
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
export function creaRelayFinto(opts: RelayFintoOpts = {}) {
  const macchine = new Map<string, Capo>();
  const ospiti = new Map<string, { capo: Capo; installationId: string; ruolo: RuoloSessione }>();
  /** Ciò che il relay ha VISTO passare: serve ai test per dimostrare che non
   *  contiene i contenuti. */
  const visto: Array<Record<string, unknown>> = [];
  let contatore = 0;

  const nega = (capo: Capo, motivo: Rifiutato["motivo"]) => capo.invia({ t: "denied", motivo });

  function collegaMacchina(invia: Invia) {
    const capo: Capo = { invia };
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
    const capo: Capo = { invia };
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
    const capo: Capo = { invia };
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

export interface OspiteHttpOpts {
  invia(payload: string): void;
  max?: number;
}

export function creaOspiteHttp(opts: OspiteHttpOpts) {
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
  const daRispostaAllaRichiesta = new Map<number, number>();

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
        if (t) daRispostaAllaRichiesta.set(e.s, t.re);
      }
      if (e.esito === "completo") {
        if (e.k !== GENERE_RISPOSTA) return e;
        const t = leggiTestaRisposta(e.h);
        if (!t) return e;
        daRispostaAllaRichiesta.delete(e.s);
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
        const re = daRispostaAllaRichiesta.get(e.s);
        if (re !== undefined) { daRispostaAllaRichiesta.delete(e.s); consegna(re, null); }
        else consegna(e.s, null);
      }
      return e;
    },

    inAttesa: () => attese.size,
  };
}
