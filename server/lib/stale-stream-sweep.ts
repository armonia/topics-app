// stale-stream-sweep.ts — un giro dello spazzino degli stream muti.
//
// PERCHÉ È UN MODULO. `stale-stream-verdict.ts` era già uscito da `server.ts`
// per essere provabile, ma il CABLAGGIO no: il verdetto puro restava verde
// anche con lo spazzino di `server.ts` riportato indietro per intero, perché
// nessun test poteva far girare il giro. Il caso interessante — un figlio VIVO
// al secondo tick muto, cioè il turno che NON va finalizzato — sta tutto nel
// cablaggio: chi chiama la sonda, chi tocca il messaggio parziale, chi decide
// di non toccarlo. Qui è una funzione con le dipendenze iniettate, quindi due
// tick si eseguono in un millisecondo invece che in sette minuti veri.
//
// La funzione è un TICK, non un timer: chi la usa in produzione la mette in un
// `setInterval`, il test la chiama due volte. `now` è iniettato per la stessa
// ragione.

import { staleStreamVerdict } from "./stale-stream-verdict";
import { pendingAskVerdict } from "./ask-user-bridge";

/** Il minimo di `ActiveStream` che questo giro legge. */
export interface SweepableStream {
  sessionKey: string;
  lastActivity: string;
  content: string;
  messageId: string;
  abortController?: { abort: () => void };
}

/** Un tool rimasto 'running' che `endStream` ha appena interrotto. */
export interface InterruptedTool {
  id: string;
  error?: string;
  endedAt?: number;
}

/**
 * DA QUANDO tace davvero, contro l'orologio che lo spazzino gli sposta.
 *
 * Ogni proroga chiama `updateStreamActivity`, quindi al giro dopo `lastActivity`
 * dice «un attimo fa» e il messaggio «silent for N min» non è mai cresciuto:
 * un turno zitto da mezz'ora si annunciava come zitto da tre minuti, sempre.
 * `since` è l'ultima attività VERA; `bumpedTo` è dove lo spazzino ha spostato
 * l'orologio l'ultima volta, ed è l'unico modo di distinguere «ho parlato io»
 * da «ha parlato il turno»: se `lastActivity` è più avanti di `bumpedTo`, a
 * parlare è stato il turno e il conteggio riparte.
 */
export interface SilenceMark {
  since: number;
  bumpedTo: number;
}

export interface StaleStreamSweepDeps {
  now: () => number;
  timeoutMs: number;
  askTtlMs: number;
  /** I turni in trasmissione ADESSO. Il giro può cancellarne le voci. */
  activeStreams: Map<string, SweepableStream>;
  /** Chi ha già speso il suo unico resync. */
  rescued: Set<string>;
  /** Da quando ciascuno tace davvero (vedi `SilenceMark`). */
  silence: Map<string, SilenceMark>;
  getMessageById: (id: string) => { content?: unknown; partial?: boolean; tool_calls?: unknown } | null | undefined;
  /** L'età di un pannello aperto sull'umano (domanda o permesso), o `null`. */
  humanHoldAgeMs: (sessionKey: string) => number | null;
  /** `undefined` = il provider non sa rispondere, che qui vale «morto». */
  childAlive: (sessionKey: string) => boolean | undefined;
  resyncStream: (sessionKey: string) => void;
  cancelAsk: (sessionKey: string, reason: string) => void;
  updateStreamActivity: (sessionKey: string) => void;
  getTopicId: (sessionKey: string) => string | undefined;
  endStream: (sessionKey: string) => InterruptedTool[];
  broadcast: (msg: Record<string, unknown>) => void;
  /** `marker` non nullo = il turno non aveva prosa e va spiegato all'utente. */
  finalizeMessage: (args: { messageId: string; marker: string | null }) => void;
  recordTurnEnd: (sessionKey: string) => void;
  warn: (msg: string) => void;
  info: (msg: string) => void;
}

/** Il testo che sostituisce una bolla vuota: senza, il client la nasconde. */
export const INTERRUPTED_MARKER =
  "⚠️ Risposta interrotta: nessuna attività per 3 minuti (il processo potrebbe essersi bloccato o disconnesso). Riprova.";

/** Cosa il giro ha fatto a ciascuna sessione: il valore di ritorno esiste per i test. */
export type SweepOutcome = "dropped" | "held" | "rescued" | "extended" | "finalized";

/**
 * Un giro completo. Restituisce l'esito per sessione, in ordine di visita.
 */
/**
 * Is a tool of this turn EXECUTING right now?
 *
 * It separates "silent because it is working" from "silent, full stop", which is
 * the difference between extending and closing. Read off the row the sweeper is
 * already holding, so it costs no new dependency.
 *
 * When in doubt it answers `true`, deliberately: a format that will not parse
 * must not turn into a death sentence. Erring this way costs a few more minutes
 * of waiting; erring the other way closes a healthy turn, which is the mistake
 * this file exists in order not to repeat.
 */
function hasRunningTool(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === "") return false;
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(list)) return true;
    return list.some((t) => {
      const st = (t as { status?: unknown } | null)?.status;
      return st === "running" || st === "pending";
    });
  } catch {
    return true;
  }
}

export function sweepStaleStreams(deps: StaleStreamSweepDeps): Map<string, SweepOutcome> {
  const now = deps.now();
  const outcomes = new Map<string, SweepOutcome>();
  for (const key of deps.rescued) if (!deps.activeStreams.has(key)) deps.rescued.delete(key);
  for (const key of deps.silence.keys()) if (!deps.activeStreams.has(key)) deps.silence.delete(key);

  for (const [sessionKey, stream] of deps.activeStreams.entries()) {
    if (!deps.activeStreams.has(sessionKey)) continue;
    // Fast path — DB says the partial assistant message is already finalized
    // but the in-memory entry lingered (lost cleanup in some endStream path).
    // Drop it silently: nobody is mid-stream to notify, and leaving it would
    // cause ghost `stream:catchup` events on future WS reconnects.
    const partial = deps.getMessageById(stream.messageId);
    if (!partial || partial.partial !== true) {
      deps.activeStreams.delete(sessionKey);
      deps.silence.delete(sessionKey);
      outcomes.set(sessionKey, "dropped");
      continue;
    }
    // Un turno fermo su una domanda all'umano è silenzioso PER DESIGN: il
    // figlio è bloccato sulla risposta JSON-RPC del bridge e non produce un
    // byte finché nessuno clicca. Questo sweeper contava quel silenzio come
    // morte e a 3 minuti chiudeva il turno con "nessuna attività per 3 minuti"
    // — lasciando però il pannello cliccabile, perché `endStream` finalizza i
    // tool 'running' e non i `waiting_for_input`. Risultato osservato su
    // topic:ed2070df: una domanda a schermo da 22 minuti accanto a un bottone
    // Retry, cioè un pannello vivo su un turno che non esisteva più.
    //
    // Il watchdog del provider (claude-code.ts, 30 min) ha già esattamente
    // questa esenzione; qui mancava. L'esenzione è a tempo — l'età della
    // domanda, non un "per sempre" — e vale solo finché il provider giura che
    // il figlio è VIVO: se muore mentre il pannello è su, nessuna gamba di
    // poll arriva più e niente, dentro il bridge, se ne accorgerebbe.
    // `humanHoldAgeMs`, non `pendingAskAgeMs`: i silenzi legittimi sono DUE —
    // una domanda a schermo e una richiesta di PERMESSO a schermo — e questo
    // spazzino conosceva solo il primo. È il difetto che ha ucciso il turno
    // dell'8 agosto sotto un pannello di permesso aperto, ed è nominato per
    // nome nella docstring di `human-hold.ts`, che elenca proprio «lo spazzino
    // degli stream fermi» fra i sei posti che devono interrogare UNA cosa sola.
    // Il tetto resta a tempo e resta condizionato al «figlio VIVO»: un pannello
    // su una sessione morta non deve disarmare niente.
    const askAge = deps.humanHoldAgeMs(sessionKey);
    if (askAge !== null) {
      const verdict = pendingAskVerdict({
        askAgeMs: askAge,
        askTtlMs: deps.askTtlMs,
        childAlive: deps.childAlive(sessionKey),
      });
      if (verdict === "defer") {
        // L'origine del silenzio si legge PRIMA della proroga: dopo,
        // `lastActivity` è già `now` e il conteggio ripartirebbe da zero.
        const prev = deps.silence.get(sessionKey);
        const since = prev?.since ?? new Date(stream.lastActivity).getTime();
        deps.updateStreamActivity(sessionKey);
        deps.silence.set(sessionKey, { since, bumpedTo: now });
        outcomes.set(sessionKey, "held");
        continue;
      }
      // La domanda non è più onorabile (figlio morto sotto il pannello, o TTL
      // scaduto): chiudila, così chi è bloccato fallisce pulito, e lascia che il
      // turno passi al giudizio qui sotto come ogni altro stream muto.
      // NB: «passa al giudizio», non «viene finalizzato». Dei due motivi per
      // cui si arriva qui uno lascia il figlio VIVO (TTL scaduto su una domanda
      // che nessuno ha cliccato), e da quando la sonda di vitalità sta fuori dal
      // ramo di soccorso quel caso si estende invece di chiudere: annullare
      // l'ask sblocca il figlio con un errore, e lui riprende a parlare.
      deps.warn(`[StaleStream] ${sessionKey} aveva una domanda a schermo non più onorabile — chiudo l'ask e finalizzo`);
      deps.cancelAsk(sessionKey, "il processo del turno è morto mentre la domanda era a schermo");
    }

    const lastActivity = new Date(stream.lastActivity).getTime();
    const mark = deps.silence.get(sessionKey);
    // Il turno ha ripreso a parlare: l'orologio è più avanti di dove l'avevamo
    // spostato noi. Il conteggio del silenzio riparte da zero.
    if (mark && lastActivity > mark.bumpedTo) deps.silence.delete(sessionKey);
    const silenceSince = deps.silence.get(sessionKey)?.since ?? lastActivity;

    // THE LIVENESS PROBE LIVES OUTSIDE THE RESCUE BRANCH. It used to sit
    // inside it, so on the second silent tick nobody asked whether the child
    // was still alive and the turn was finalized anyway. A 12-minute build or
    // a CLI auto-compact (which emits nothing at all while it compacts the
    // context) ended as "nessuna attività per 3 minuti": the answer lost and,
    // on a dispatched task, an attempt burnt.
    // The resync stays the one-shot recovery ATTEMPT; the finalize DECISION
    // depends only on `childAlive === false`, exactly as handleGraceExpiry
    // and handleHardTimeout already do in routes/chat.ts.
    const verdict = staleStreamVerdict({
      silentMs: now - lastActivity,
      // The TRUE silence: `now - lastActivity` drops back under the threshold on
      // every extension, so the frozen cap must be compared against this one or
      // it never fires at all.
      trueSilenceMs: now - silenceSince,
      timeoutMs: deps.timeoutMs,
      childAlive: deps.childAlive(sessionKey),
      toolRunning: hasRunningTool(partial.tool_calls),
      alreadyResynced: deps.rescued.has(sessionKey),
    });
    if (verdict === "ok") continue;
    if (verdict === "rescue") {
      deps.rescued.add(sessionKey);
      deps.warn(`[StaleStream] ${sessionKey} silent for 3 min but its child is ALIVE — re-attaching the stream and waiting`);
      deps.resyncStream(sessionKey);
      // Push lastActivity forward so the rescue gets a full round to land;
      // real output re-bumps it and the stream leaves this path entirely.
      deps.updateStreamActivity(sessionKey);
      deps.silence.set(sessionKey, { since: silenceSince, bumpedTo: now });
      outcomes.set(sessionKey, "rescued");
      continue;
    }
    if (verdict === "extend") {
      // The rescue is already spent and the child is still alive: extend,
      // never finalize. Re-issuing a resync every 30s against a healthy but
      // quiet child is pure noise, so this leg only bumps the clock.
      // Il numero è il silenzio VERO, non la distanza dall'ultima proroga.
      deps.warn(`[StaleStream] ${sessionKey} silent for ${Math.round((now - silenceSince) / 60_000)} min but its child is ALIVE: extending (a live turn is never killed by a clock)`);
      deps.updateStreamActivity(sessionKey);
      deps.silence.set(sessionKey, { since: silenceSince, bumpedTo: now });
      outcomes.set(sessionKey, "extended");
      continue;
    }
    if (verdict === "frozen") {
      // ALIVE BUT STOPPED. The process is there, no tool is running, and not a
      // byte has arrived in ten minutes: this is not a turn working in silence,
      // it is a stuck turn. Extending it again means leaving it hanging forever
      // — measured on 2026-08-28 on topic:0299ac2d, fifteen minutes with zero
      // characters produced, until it was stopped by hand.
      deps.warn(
        `[StaleStream] ${sessionKey} vivo ma fermo da ${Math.round((now - silenceSince) / 60_000)} min `
        + `senza tool in corso: e' piantato, lo chiudo`,
      );
    }
    deps.info(`[StaleStream] Auto-clearing stale stream for ${sessionKey}`);
    deps.rescued.delete(sessionKey);
    deps.silence.delete(sessionKey);
    const topicId = deps.getTopicId(sessionKey);
    // Finalize any tool call left 'running'. Previously the sweeper did a bare
    // `activeStreams.delete`, bypassing endStream — so a hung tool kept its
    // spinner ticking forever (observed: a tool "running" for 2h+ at session
    // end). endStream marks them interrupted + stamps endedAt (and deletes the
    // in-memory entry); we broadcast so LIVE clients stop the spinner without a
    // reload.
    const interrupted = deps.endStream(sessionKey);
    for (const tc of interrupted) {
      deps.broadcast({ type: "stream:tool_result", sessionKey, topicId, toolCallId: tc.id, status: "error", result: "", error: tc.error, endedAt: tc.endedAt });
    }
    // Non-destructive content finalize. A genuinely stale partial means the turn
    // died without a clean `result` (detached/orphaned/wedged process). Do NOT
    // just flip `partial = 0` — a turn that streamed only tool calls (no final
    // prose) would be left as a blank bubble that the client then hides, which
    // is the "message streams then disappears" bug. If no prose was streamed,
    // drop in an explicit interrupted marker so the user sees WHAT happened;
    // any tool blocks are untouched and still render below it.
    const hadProse = typeof partial.content === "string" && partial.content.trim().length > 0;
    deps.finalizeMessage({ messageId: stream.messageId, marker: hadProse ? null : INTERRUPTED_MARKER });
    // Il turno è morto senza un `result` pulito: chi lo sta guidando (il
    // dispatcher) deve leggere "fermato dal watchdog", non la fine di default.
    deps.recordTurnEnd(sessionKey);
    deps.broadcast({ type: "stream:end", sessionKey, topicId, reason: "stale_timeout", stopReason: "cancelled", stopCause: "watchdog" });
    // Sveglia il client HTTP. Il broadcast sopra parla ai soli spettatori WS:
    // chi ha MANDATO il messaggio sta leggendo la risposta SSE, e quel canale
    // scarta per contratto gli eventi WS della propria sessione. Senza questo
    // abort la sua richiesta resta aperta su un turno che qui abbiamo appena
    // dichiarato morto — la chat continua a mostrare i puntini finché non
    // ricarica la pagina. La route ci ha lasciato l'AbortController apposta.
    try { stream.abortController?.abort(); } catch (err) { deps.warn(`[StaleStream] abort SSE fallito per ${sessionKey}: ${String(err)}`); }
    outcomes.set(sessionKey, "finalized");
  }
  return outcomes;
}
