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
 * A FOURTH SOURCE, 2026-08-28: a chat parked on a question. The three above
 * all answer "who is WORKING", and a chat waiting for a human is not working,
 * so it held nothing and the restart cut it. It is the case that deserves the
 * deferral most, not least - see `askOpenKeys` below.
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
  /**
   * Chat sitting on an OPEN QUESTION: the panel is on screen and nobody has
   * answered it yet.
   *
   * The odd one out, because such a chat is not working: it is waiting for a
   * person. That is exactly why it belongs here. A working turn that gets cut
   * can be run again; a question that gets cut takes away the context that
   * made it make sense, and whoever was about to answer is never told it was
   * taken out of their hands. Measured on 2026-08-28 at 19:05, topic:4c935add:
   * an open panel with two questions died with the turn, the chat kept "turn
   * interrupted by a server restart", and the log of that same window shows
   * deferrals for the board cards and none for the chat.
   *
   * Optional because a caller that has no cheap way to know (the idle gc, for
   * one, which must NOT be held back by a chat waiting on a human) simply does
   * not pass it.
   */
  askOpenKeys?: readonly string[];
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
 *
 * THE CAP IS NOT A DEATH SENTENCE (2026-08-28). On expiry the restart went
 * ahead anyway, and the cost reads in two consecutive production log lines:
 *
 *     [StreamWS] Soft timeout: no data for 60s on topic:0299ac2d (grace 60s)
 *     [quiescence] 1 chat in streaming (topic:0299ac2d) - still in flight at
 *                  the deadline after 1500s, proceeding anyway
 *
 * and then, in the chat itself, "turn interrupted by a server restart".
 * Waiting twenty-five minutes and cutting anyway protects nobody: it postpones
 * the damage, and lands it on a turn that is often not even the one being
 * waited for, because in twenty-five minutes the set of working turns has
 * turned over completely.
 *
 * So what does NOT come back is not cut: it is DEFERRED. The window arrives,
 * and meanwhile the deferral shows up in the log instead of passing in
 * silence. There is no second cap beyond the deferral: that would be the same
 * cut with a bigger number on it.
 *
 * What DOES come back (a chat on a runtime that can re-adopt) is still cut at
 * its short deadline: that turn restarts by itself and the reader sees a
 * pause, while waiting for it like a card would kill hot reload for anyone
 * with a conversation open.
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
  /**
   * Chat parked on a question nobody has answered yet. No cap applies to them:
   * see the note above.
   */
  parkedAsks?: number;
}): "procedi" | "aspetta" | "scaduto" | "rinvia" {
  if (!args.busy) return "procedi";
  // A QUESTION IS DEFERRED AT ONCE, WITHOUT SERVING THE CAP FIRST.
  //
  // The cap answers "how long can this finish by itself?", and an open question
  // never can: what ends it is a person, and a person does not arrive faster
  // because a clock is running. Making it wait its twenty-five minutes would
  // only mean that for those minutes the deferral is not DECLARED, and the
  // heartbeat that keeps `start-prod.sh` from firing its own SIGTERM is not
  // written: the question would be cut by the very script this gate exists to
  // get ahead of. The loop re-reads the sources twice a second, so the instant
  // the answer lands this stops holding anything.
  if ((args.parkedAsks ?? 0) > 0) return "rinvia";
  const unrecoverable = args.unrecoverable > 0;
  const tetto = unrecoverable ? args.capMs : args.chatCapMs;
  if (args.now - args.startedAt < tetto) return "aspetta";
  return unrecoverable ? "rinvia" : "scaduto";
}

/**
 * WHAT THE CAP IS FOR, now that it does not cut.
 *
 * `quiescenceVerdict` never returns "scaduto" for work that will not come back:
 * a clock must not kill it, and that invariant was paid for on 2026-08-28 with
 * a chat left holding "turn interrupted by a server restart". The consequence
 * is that the wait has no end of its own, and that is CORRECT — but it left the
 * long cap doing nothing at all except changing a log line.
 *
 * Measured on 2026-08-30: a restart was deferred for 4599 seconds, 102 log
 * lines, because one chat held a `bash` tool that had started a server in the
 * FOREGROUND and would never return. Nothing was broken; nothing could ever
 * finish either. The one person who could end it in five seconds had no way to
 * know, because the only trace was a line in a file nobody tails.
 *
 * So past the cap the gate stops being silent and ASKS. It still does not cut:
 * it says who is holding the restart and lets the person decide. Once per wait,
 * because a decision repeated every minute is noise, not information.
 *
 * A time cap on the tool itself was measured and rejected: over 10.887 real
 * tool calls (14 days) the median is 1,6 s and p99.9 is 10,8 minutes, but the
 * longest — 80 minutes — is a genuine `bun run typecheck`, with `test:unit` at
 * 26 and a client build at 20. Half way through, an 80-minute typecheck and a
 * foreground server are indistinguishable, so any cap that catches the second
 * kills the first. Asking a person costs nothing and cannot be wrong.
 */
export interface ReloadHeldNotice {
  title: string;
  body: string;
  dedupeKey: string;
}

export function reloadHeldNotice(args: {
  /** How long this wait has been going. */
  waitedMs: number;
  /** The long cap: past it the wait has no end of its own. */
  capMs: number;
  /** What is holding, already worded by `describeInFlight`. */
  busy: string;
  /** Readable name of the holding chat, when it is known. */
  holderName?: string | null;
  /** Identifies THIS wait, so the next one may speak again. */
  waitId: string;
}): ReloadHeldNotice | null {
  if (args.waitedMs < args.capMs) return null;
  const min = Math.round(args.waitedMs / 60_000);
  const chi = args.holderName?.trim() ? `«${args.holderName.trim()}»` : args.busy;
  return {
    title: "Un riavvio del server sta aspettando",
    body:
      `${chi} ha un turno in corso da ${min} minuti, e il riavvio non taglia un turno che non tornerebbe. `
      + "Se e' piantato, fermalo dalla chat: il riavvio parte da solo subito dopo.",
    dedupeKey: `reload-held:${args.waitId}`,
  };
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
  // Last because it is the dearest to compute (it reads rows), not because it
  // matters least: this is the one source whose loss is unrecoverable by
  // definition.
  const askOpenKeys = sources.askOpenKeys ?? [];
  if (askOpenKeys.length > 0) {
    return `${askOpenKeys.length} chat ferma/e su una domanda (${askOpenKeys.join(", ")})`;
  }
  return null;
}
