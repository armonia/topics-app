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
  creaContatoreStream, creaRiassemblatore, dividiBinario,
  RELAY_PROTOCOL_VERSION, TUBO_BYTE_PER_FRAME,
  type FrameTubo, type MessaggioRelay, type MotivoStream,
} from "../../shared/relay-protocol";
import {
  GENERE_RICHIESTA, GENERE_RISPOSTA, intestazioniRichiesta, intestazioniRisposta,
  leggiTestaRichiesta, risolviUrlLocale, scriviTesta, type Intestazioni,
} from "../../shared/relay-http";

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

export interface ProxyTuboDeps {
  /** `null` = non configurata: si rifiuta in modo dichiarato. */
  portaTunnel: number | null;
  /** Dove finisce un frame già serializzato, per la sessione `sid`. */
  invia(sid: string, payload: string): void;
  fetchLocale?: typeof fetch;
  max?: number;
  maxStream?: number;
  maxByteStream?: number;
  maxInVolo?: number;
  log?: (m: string) => void;
}

interface SessioneOspite {
  rias: ReturnType<typeof creaRiassemblatore>;
  prossimo: () => number;
  /** Le richieste in volo, per stream della RICHIESTA: è quello che l'ospite
   *  nomina quando rinuncia. */
  inVolo: Map<number, AbortController>;
}

export function creaProxyTubo(deps: ProxyTuboDeps) {
  const max = deps.max ?? TUBO_BYTE_PER_FRAME;
  const maxInVolo = deps.maxInVolo ?? MAX_IN_VOLO;
  const log = deps.log ?? (() => {});
  const f = deps.fetchLocale ?? fetch;
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
          // Un genere che non si conosce chiude QUELLO stream invece di far
          // cadere la sessione: è il punto di estensione del tubo.
          if (e.k !== GENERE_RICHIESTA) { manda(sid, { f: "reset", s: e.s, motivo: "bad-frame" }); return; }
          void serviRichiesta(sid, sess, e.s, e.h, e.dati);
          return;
        case "aperto":
          if (e.k !== GENERE_RICHIESTA) {
            sess.rias.dimentica(e.s);
            manda(sid, { f: "reset", s: e.s, motivo: "bad-frame" });
          }
          return;
        case "errore":
          fermaVolo(sess, e.s);
          manda(sid, { f: "reset", s: e.s, motivo: e.motivo });
          return;
        case "chiuso":
          fermaVolo(sess, e.s);
          return;
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
    ...(deps.maxFrame !== undefined ? { max: deps.maxFrame } : {}),
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
  };
}
