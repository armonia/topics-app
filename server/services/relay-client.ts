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
import { leggiMessaggio, RELAY_PROTOCOL_VERSION, type MessaggioRelay } from "../../shared/relay-protocol";

export interface RichiestaOspite {
  /** Cosa vuole. Oggi una sola forma: «dammi la cosa di questo link». */
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
  /** Iniettabile per i test. */
  now?: () => number;
  apriSocket?: (url: string) => WebSocket;
  log?: (m: string) => void;
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

  async function gestisci(m: MessaggioRelay): Promise<void> {
    if (m.t !== "to-guest") return; // il relay ci gira le buste già etichettate
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
      try { ws?.close(); } catch { /* già chiusa */ }
      ws = null;
    },
    collegato: () => ws?.readyState === 1,
    /** Test-only: serve una richiesta senza passare dal filo. */
    __servi: servi,
  };
}
