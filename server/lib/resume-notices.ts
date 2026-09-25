/**
 * THE WORDS THE RESUME SWEEP WRITES IN A CHAT (`ripresa-boot.ts`).
 *
 * Two notices: the one written on a person's message nobody answered, before
 * it is resent, and the one that says the chain has spent its attempts. Each
 * claims only what the sweep knows, and the first must open with a recognised
 * interruption while the second must not (see each one below).
 */
import type { TurnEndInfo } from "../providers/stop-reason";
import { cancelledNotice } from "./cancelled-notice";

/** The notice written on a chat whose last word is a person's message nobody
 *  answered, BEFORE it is resumed (RESUME-02: first the
 *  explanation in the thread, then the resend). Its opening words are one of
 *  `CARTELLI_RIPRENDIBILI`, so the resume that follows recognises it. */
export const UNANSWERED_NOTICE =
  "⚠️ Turno interrotto: il server si è riavviato prima che la risposta partisse e il messaggio è rimasto senza risposta. Lo rimando.";

/**
 * The same notice when no restart can be blamed: UNANSWERED_NOTICE said "the
 * server restarted" on every chat, and on topic 3019832f (24/09) nothing had
 * restarted. It says only what is known, that no answer arrived. Its opening
 * is in `CARTELLI_RIPRENDIBILI` too, for the same reason.
 */
const UNANSWERED_NO_RESTART_NOTICE =
  "⚠️ Turno interrotto: la risposta non è mai arrivata e il messaggio è rimasto senza risposta. Lo rimando.";

/** A cut by the stream watchdog or the silence cap: the agent stopped answering. */
function isStall(cause: unknown): boolean {
  return cause === "watchdog" || cause === "wall-clock";
}

/**
 * May a notice blame a restart? CAUSE FIRST: when the cut names its cause,
 * only `server-shutdown` is a restart. `restarted` is the caller's evidence
 * for when no cause is known, and never a timestamp of a cut row: a watchdog
 * cut followed by a reload on save predates the boot too, and the boot sweep's
 * own notice of a hard kill is written after it.
 */
function blamesRestart(cause: unknown, restarted: boolean): boolean {
  return typeof cause === "string" ? cause === "server-shutdown" : restarted;
}

/**
 * The notice for a person's message left unanswered.
 *
 * The turn's own end speaks first (`lastEnd`, only when it belongs to this
 * message): a stall gets its sentence even across a restart. `restarted` (the
 * message predates this boot) is used only when no cause is known; the rest
 * gets a sentence that claims no cause it cannot prove. Every variant opens
 * with a recognised interruption, because the notice becomes the row the
 * resend is traced on and the next sweep reads it.
 */
export function unansweredNotice(opts: { restarted: boolean; lastEnd?: TurnEndInfo | null }): string {
  const end = opts.lastEnd;
  if (end?.end === "cancelled" && isStall(end.cause)) {
    const why = cancelledNotice(end);
    if (why) return `${why} Il messaggio è rimasto senza risposta. Lo rimando.`;
  }
  return blamesRestart(end?.cause, opts.restarted) ? UNANSWERED_NOTICE : UNANSWERED_NO_RESTART_NOTICE;
}

/**
 * The notice written in the chat when the chain has spent its attempts. Same
 * shape as RESTART_INTERRUPTED_MARKER (⚠️ prefix, error block only), so the
 * client renders the amber banner and the "Riprova" button without a change.  allow-italian: button label
 *
 * It must NOT start with one of the openings `eCartelloDiInterruzione`
 * recognises, or the next boot would read it as one more interruption of ours
 * and resume the chain it just closed.
 *
 * It claims only what the sweep knows: how many times it RESENT the message
 * (the count it keeps), and what cut the LAST link (the only one it reads).
 * The old wording extended the last cut to the whole chain, «il server si e'  allow-italian: quotes the old notice
 * riavviato 4 volte» after a single boot.
 */
export function capNotice(attempts: number, lastCut: string): string {
  return `⚠️ Ripresa automatica sospesa: ho ripreso questo turno da capo ${attempts} volte e ${lastCut}. Il messaggio che hai inviato è ancora qui: premi Riprova quando vuoi rimandarlo.`;
}

/**
 * What cut the chain's last link, in the cap notice's words. Cause first, as in
 * `blamesRestart`: a stall keeps its sentence even when a boot happened later.
 */
export function capLastCut(opts: { restarted: boolean; cause?: unknown }): string {
  if (isStall(opts.cause)) return "l'ultima volta l'agente ha smesso di rispondere";
  if (blamesRestart(opts.cause, opts.restarted)) return "l'ultima volta l'ha interrotto un riavvio del server";
  return "l'ultima volta si è interrotto di nuovo";
}
