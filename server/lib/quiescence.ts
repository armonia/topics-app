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
 * `isAdoptable` risponde per sessione. `undefined` = non lo sappiamo, e il
 * dubbio conta come NON riadottabile: sbagliare per prudenza costa un riavvio
 * più lento, sbagliare al contrario costa il lavoro di qualcuno.
 */
export function unadoptableStreams(
  streamKeys: readonly string[],
  isAdoptable: (sessionKey: string) => boolean | undefined,
): string[] {
  return streamKeys.filter((k) => isAdoptable(k) !== true);
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
