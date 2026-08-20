/**
 * CHE COSA TRATTIENE UN RIAVVIO PIANIFICATO.
 *
 * `/__daemon/restart-when-idle` promette «aspetto che i turni finiscano». Per
 * mesi ne ha mantenuta una versione più stretta di quella scritta: il cancello
 * guardava UN contatore solo, `taskDispatcher.busyCount()`, che è `inFlight.size`
 * — una mappa chiavata sul taskId, scritta solo da `beginRun` sul cammino di
 * dispatch di una CARD della board. Una chat umana non è una card: non può
 * entrarci per costruzione.
 *
 * Il 2026-08-18 il server prod si è riavviato circa 1,4 volte al minuto sopra un
 * turno di chat vivo da quattordici minuti, e nel log di quella finestra non
 * compare **nemmeno una riga** `[quiescence]`: il predicato non era mai entrato
 * nel `while`. Il turno è sopravvissuto lo stesso (il figlio sta nel broker, il
 * SIGTERM fa detach), ma ogni giro ripassava dalla riadozione — ed è lì che il
 * difetto vero, un riattacco che ripiegava su un invio vuoto, ha depositato nove
 * risposte fantasma al posto di quella giusta.
 *
 * Le tre fonti hanno costi diversi, ed è per questo che la funzione le riceve
 * già raccolte invece di andarsele a prendere: il chiamante decide la cadenza
 * (le card e gli stream sono in RAM e si guardano a ogni giro, il broker si paga
 * e si guarda di rado), qui resta solo la decisione — pura, e quindi provabile.
 *
 * L'ORDINE NON È ESTETICO. La stringa finisce in un log che qualcuno leggerà
 * mentre si chiede perché il suo salvataggio non è ancora andato in produzione:
 * si nomina la fonte più economica e più certa per prima, così la risposta più
 * frequente è anche quella che costa meno a calcolare.
 */

/** Le tre fonti che sanno se qualcosa sta ancora lavorando. */
export interface QuiescenceSources {
  /** Turni di card della board in volo (`taskDispatcher.busyCount()`). */
  cards: number;
  /** Chat che stanno streammando in QUESTO processo (`activeStreams`). */
  streamKeys: readonly string[];
  /**
   * Sessioni di chat il cui turno è aperto secondo il BROKER.
   *
   * È l'unica fonte che vede un turno ADOTTATO dopo un riavvio: la gamba di
   * riadozione dura un attimo, e quando si chiude `endStream` toglie la voce da
   * `activeStreams`. Da lì in poi, in-processo, il figlio CLI che sta ancora
   * lavorando non ha più nessuna rappresentazione — `cards` e `streamKeys`
   * dicono «fermo», e lo dicono con verità.
   */
  brokerOpenKeys: readonly string[];
}

/**
 * Questo provider regge un riavvio del server?
 *
 * La domanda vera è «dove vive il turno»: in un processo FIGLIO, che il SIGTERM
 * non tocca e che il broker ritrova, oppure DENTRO il processo del server. Chi
 * sa riadottare (`reattach`) è per costruzione del primo tipo — è quel metodo a
 * riprendere il turno dopo il riavvio — e chi non ce l'ha è del secondo.
 *
 * Si chiede al provider e non al nome del provider: un elenco di nomi sarebbe
 * una tabella da aggiornare a ogni runtime nuovo, e il runtime nuovo che
 * qualcuno dimentica di aggiungere erediterebbe in silenzio l'attesa corta —
 * cioè il difetto del 20/08, di nuovo, con un altro nome.
 */
export function providerSurvivesRestart(provider: { reattach?: unknown } | null | undefined): boolean {
  return typeof provider?.reattach === "function";
}

/**
 * Fra le chat che stanno streammando, quali NON sopravvivono al riavvio.
 *
 * L'attesa breve riservata alle chat (`QUIESCENCE_CHAT_CAP_MS`, un minuto)
 * poggia su una promessa precisa, scritta nel commento di
 * `waitForDispatcherQuiescent`: «la reload-resilience la riadotta, chi guarda
 * vede una pausa». Per una chat su `claude-code` è vera — il turno gira in un
 * processo figlio che il SIGTERM non tocca, il broker lo tiene, e al riavvio
 * viene riadottato.
 *
 * Per il runtime nativo `topics` è FALSA, e lo è per costruzione: quel turno
 * gira dentro il processo del server, non ha un figlio nel broker, e non esiste
 * nessun `reattach` che possa riprenderlo. Il 20/08 su topic:9f9e9629 il
 * cancello ha aspettato il suo minuto, ha detto «procedo, tanto lo riprendono»
 * e ha ucciso un turno che nessuno avrebbe ripreso: la chat si è fermata a metà
 * frase e lì è rimasta.
 *
 * Quindi la domanda giusta non è «è una chat o una card»: è «questo turno
 * sopravvive al riavvio». Chi non sopravvive merita l'attesa lunga, come una
 * card — perché come per una card, quello che si taglia è perso.
 *
 * La risposta si legge da `ActiveStream.survivesRestart`, deciso quando lo
 * stream nasce: non si interroga il registro dei provider due volte al secondo
 * per una cosa che non cambia mentre il turno gira.
 */
export function unadoptableStreams(
  streams: Iterable<{ sessionKey: string; survivesRestart: boolean }>,
): string[] {
  const out: string[] = [];
  for (const s of streams) if (!s.survivesRestart) out.push(s.sessionKey);
  return out;
}

/**
 * L'attesa è finita?
 *
 * PERCHÉ È UNA FUNZIONE. La regola viveva dentro il `for(;;)` di
 * `waitForDispatcherQuiescent`, in `server.ts`, dove nessun test poteva
 * arrivarci senza avviare un server intero — e infatti conteneva un difetto
 * che è sopravvissuto a mesi di riavvii: la scadenza si RINNOVAVA a ogni giro
 * in cui c'era del lavoro in volo (`deadline = max(deadline, now + capMs)`),
 * quindi con una card sempre presente non scadeva MAI. Non era un tetto, era
 * una promessa infinita, e a decidere finiva l'unico orologio che scadeva
 * davvero: il SIGTERM di `start-prod.sh`.
 *
 * Costo misurato sul task 235afe11 (20/08): ucciso TRE volte, a 27 minuti
 * esatti l'una dall'altra, ogni volta con un turno d'agente vivo — worktree
 * buttato e task rimesso in coda. Il log del cancello non riporta una sola
 * scadenza in tutta la sua storia: non poteva averne.
 *
 * `now` è un parametro perché un tetto si prova facendolo scadere, non
 * aspettando venticinque minuti.
 */
export function quiescenceVerdict(args: {
  /** Che cosa trattiene, o `null` se niente. */
  busy: string | null;
  /** Chi non torna dopo un riavvio: card in volo + chat non riadottabili. */
  unrecoverable: number;
  now: number;
  /** Quando è cominciata l'attesa. I tetti si contano da QUI. */
  startedAt: number;
  /** Tetto per ciò che non sopravvive al riavvio. */
  capMs: number;
  /** Tetto per una chat che verrà riadottata: la sua pausa è visibile, non persa. */
  chatCapMs: number;
}): "procedi" | "aspetta" | "scaduto" {
  if (!args.busy) return "procedi";
  const tetto = args.unrecoverable > 0 ? args.capMs : args.chatCapMs;
  return args.now - args.startedAt >= tetto ? "scaduto" : "aspetta";
}

/**
 * Una frase che dice che cosa trattiene il riavvio, o `null` se niente.
 *
 * `null` è l'unica risposta che autorizza il riavvio: chi chiama non deve
 * interpretare una stringa vuota o un conteggio, deve solo guardare se c'è
 * qualcosa.
 */
export function describeInFlight(sources: QuiescenceSources): string | null {
  const { cards, streamKeys, brokerOpenKeys } = sources;
  if (cards > 0) return `${cards} turno/i di card della board`;
  if (streamKeys.length > 0) {
    return `${streamKeys.length} chat in streaming (${streamKeys.join(", ")})`;
  }
  if (brokerOpenKeys.length > 0) {
    return `${brokerOpenKeys.length} turno/i di chat aperti nel broker (${brokerOpenKeys.join(", ")})`;
  }
  return null;
}
