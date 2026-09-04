/**
 * CHI RIPRENDE DA SOLO — e chi invece va lasciato dov'è.
 *
 * ── La domanda ──────────────────────────────────────────────────────────────
 * «Al più ci dovrebbe essere Riprendi, ma dovrebbe riprendere da solo.»
 * (20/08, dopo aver visto una chat ferma a metà frase con un cartello che
 * prometteva un bottone «Riprova» che non c'era.)
 *
 * Ha ragione due volte. Un turno di `claude-code` muore in un processo FIGLIO
 * che il SIGTERM non tocca: al riavvio `reattachSurvivingChatTurns` lo ritrova
 * e lo riadotta, e chi guardava vede una pausa. Un turno del runtime nativo
 * `topics` vive DENTRO il server: quando il processo muore non resta niente da
 * riadottare, e la chat resta ferma per sempre. Due destini opposti per lo
 * stesso gesto — salvare un file — e nessuno dei due scelto dall'utente.
 *
 * ── Perché non basta il bottone ─────────────────────────────────────────────
 * «Riprova» (`turnIsOnlyError`) compare solo se il turno NON ha prodotto
 * niente, ed è giusto: rimandare un messaggio a cui l'agente ha già risposto a
 * metà creerebbe un SECONDO turno, a pagamento, sopra uno che è già lì. Ma è
 * proprio il turno morto a metà lavoro il caso frequente, quindi la stragrande
 * maggioranza dei turni tagliati non aveva né la ripresa né il bottone: solo un
 * cartello che ne prometteva uno inesistente.
 *
 * ── La regola ───────────────────────────────────────────────────────────────
 * Un turno merita la ripresa automatica quando tutte queste sono vere:
 *
 *   1. è morto per una causa NOSTRA (spegnimento, watchdog) — se l'utente ha
 *      premuto Ferma, riprendere sarebbe disobbedire;
 *   2. la sua chat esiste e non è archiviata — non si scrive in un posto che
 *      l'utente non ha;
 *   3. nessuno l'ha già ripreso, e nessuno sta parlando lì adesso;
 *   4. non è già stato ripreso una volta per lo stesso turno: un guasto che si
 *      ripete non deve diventare un ciclo che brucia token da solo.
 *
 * Il punto 4 è il freno che rende questa cosa sicura, ed è per questo che la
 * decisione vive qui e non dentro il boot: un ciclo di ripresa automatica che
 * nessun test può raggiungere è esattamente il genere di macchina che, il
 * giorno che sbaglia, sbaglia per sempre.
 */
import type { TurnEndInfo } from "../providers/stop-reason";

/**
 * Le cause per cui riprendere è giusto: sono i modi in cui il turno è morto
 * per una decisione della MACCHINA, non della persona.
 *
 * `user` non c'è, e non per dimenticanza: chi ha premuto Ferma ha detto una
 * cosa sola e chiarissima. `session-reset` nemmeno — lì il provider rimanda
 * già il turno da sé, e riprenderlo qui ne farebbe due.
 */
const CAUSE_DA_RIPRENDERE = new Set(["server-shutdown", "watchdog", "wall-clock"]);

export interface StatoRipresa {
  /** La causa con cui il turno è finito, se la conosciamo. */
  fine?: TurnEndInfo;
  /** La chat esiste ed è viva (non archiviata)? */
  chatViva: boolean;
  /** Qualcuno sta già parlando in questa sessione? */
  turnoInCorso: boolean;
  /** Questo stesso turno è già stato ripreso una volta? */
  giaRipreso: boolean;
}

/**
 * Va ripreso da solo?
 *
 * Volutamente senza effetti: chi chiama decide COME riprendere (la route del
 * riattacco, un rimando del messaggio), questa dice solo SE.
 */
export function meritaRipresaAutomatica(s: StatoRipresa): boolean {
  if (!s.chatViva) return false;
  if (s.turnoInCorso) return false;
  if (s.giaRipreso) return false;
  const fine = s.fine;
  // An `error` end is a real failure, except one: the API's limit saturated
  // through every retry. That one is the machine's (ours and the fleet's),
  // and the same message goes through once the limit frees.
  if (fine?.end === "error" && fine.cause === "rate-limit") return true;
  if (!fine || fine.end !== "cancelled") return false;
  // Un `cancelled` SENZA causa non si riprende: la stessa regola di
  // `cancelled-notice`, e per la stessa ragione — non si indovina chi ha
  // annullato. Nel dubbio si lascia il cartello, che è reversibile; una
  // ripresa sbagliata costa un turno vero.
  return typeof fine.cause === "string" && CAUSE_DA_RIPRENDERE.has(fine.cause);
}
