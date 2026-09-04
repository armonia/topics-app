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
import type { TurnEndCause } from "../../shared/types";
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
  /** The HYDRATED row, not the raw one: in production this is
   *  `ctx.getMessageById` (server/utils.ts:2163), which goes through
   *  `rowToMessage` and therefore hands over `toolCalls` in camelCase — never
   *  `tool_calls`. The type spells it out because the wrong key here is not a
   *  compile error: it is `undefined` at runtime, and an `undefined` makes a
   *  working turn look idle. */
  getMessageById: (id: string) => { content?: unknown; partial?: boolean; toolCalls?: unknown; blocks?: unknown } | null | undefined;
  /** L'età di un pannello aperto sull'umano (domanda o permesso), o `null`. */
  humanHoldAgeMs: (sessionKey: string) => number | null;
  /** `undefined` = il provider non sa rispondere, che qui vale «morto». */
  childAlive: (sessionKey: string) => boolean | undefined;
  resyncStream: (sessionKey: string) => void;
  cancelAsk: (sessionKey: string, reason: string) => void;
  updateStreamActivity: (sessionKey: string) => void;
  getTopicId: (sessionKey: string) => string | undefined;
  /**
   * Stop the provider's turn, through the same door `handleGraceExpiry` and
   * `handleHardTimeout` use (`provider.abort(sk, undefined, "watchdog")`).
   * Finalizing the ROW without aborting the LOOP is how a native turn kept
   * running as a zombie after the user was told it was over: still spending
   * tokens, still running tools, writing its blocks onto the next turn's row.
   */
  abortProvider: (sessionKey: string) => void;
  endStream: (sessionKey: string) => InterruptedTool[];
  broadcast: (msg: Record<string, unknown>) => void;
  /**
   * `marker` non nullo = il turno non aveva prosa e va spiegato all'utente.
   *
   * `interruption` is the SAME explanation in machine-readable form, and it
   * travels even when `marker` is null: a turn cut halfway through a long
   * answer keeps its prose (so no marker), and used to say nothing at all about
   * why it stopped. That silence is the 2026-09-03 report. See
   * `lib/interrupted-turn-block.ts` for who may write it and who may not.
   *
   * NOT to be confused with `staleStreamVerdict` above, which decides whether
   * to finalize AT ALL: this one is the sentence shown once that is decided.
   */
  finalizeMessage: (args: {
    messageId: string;
    marker: string | null;
    interruption: { text: string; cause: TurnEndCause; at: string };
  }) => void;
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
      const entry = t as { status?: unknown; toolCall?: { status?: unknown } } | null;
      // Two shapes, one rule: a `tool_calls` entry carries the status at the
      // top, a timeline block nests it (`{kind:'tool', toolCall}`).
      const st = entry?.status ?? entry?.toolCall?.status;
      return st === "running" || st === "pending";
    });
  } catch {
    return true;
  }
}

/**
 * When did the oldest tool still marked `running` start?
 *
 * `null` = nobody knows (no stamp, or a shape that would not parse), and the
 * caller must read that as "not stuck": the same doubt-never-kills rule as
 * `hasRunningTool` right above.
 */
function runningToolStartedAt(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(list)) return null;
    let oldest: number | null = null;
    for (const t of list) {
      const entry = t as { status?: unknown; startedAt?: unknown; toolCall?: { status?: unknown; startedAt?: unknown } } | null;
      const st = entry?.status ?? entry?.toolCall?.status;
      if (st !== "running" && st !== "pending") continue;
      const at = entry?.startedAt ?? entry?.toolCall?.startedAt;
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      if (oldest === null || at < oldest) oldest = at;
    }
    return oldest;
  } catch {
    return null;
  }
}

/**
 * Push the stream's clock forward and record WHERE it actually landed.
 *
 * Reading the stamp back is the only way to tell "the turn started talking
 * again" from "I moved it myself". `now` is captured ONCE at the top of the
 * tick, while `updateStreamActivity` stamps `new Date()` when it is called —
 * a few milliseconds later. Recording `now` as `bumpedTo` therefore made
 * `lastActivity > bumpedTo` true on EVERY following tick: the silence mark was
 * dropped as if the turn had resumed, and `trueSilenceMs` fell back to the
 * distance between two ticks every time.
 *
 * What that cost: the `frozen` cap (ten minutes) was unreachable for EVERY
 * stream, with or without a running tool — so the 2026-08-28 cure could never
 * fire at all. Its signature in the log is the "silent for N min" number nailed
 * to the same value for dozens of consecutive lines instead of growing.
 */
function bumpAndMark(
  deps: StaleStreamSweepDeps,
  sessionKey: string,
  stream: SweepableStream,
  since: number,
  fallback: number,
): void {
  deps.updateStreamActivity(sessionKey);
  const stamped = new Date(stream.lastActivity).getTime();
  deps.silence.set(sessionKey, { since, bumpedTo: Number.isFinite(stamped) ? stamped : fallback });
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
    const toolStartedAt = runningToolStartedAt(partial.toolCalls) ?? runningToolStartedAt(partial.blocks);
    const verdict = staleStreamVerdict({
      silentMs: now - lastActivity,
      // The TRUE silence: `now - lastActivity` drops back under the threshold on
      // every extension, so the frozen cap must be compared against this one or
      // it never fires at all.
      trueSilenceMs: now - silenceSince,
      timeoutMs: deps.timeoutMs,
      childAlive: deps.childAlive(sessionKey),
      // BOTH columns. `tool_calls` is the list, `blocks` the timeline the
      // client renders when present: tool state lives in each of them, and
      // reading only one leaves half the product uncovered. Same reason
      // `finalizeOrphanedRunningTools` finalizes the two together.
      toolRunning: hasRunningTool(partial.toolCalls) || hasRunningTool(partial.blocks),
      // The age of the oldest tool still 'running', read off its own
      // `startedAt`: the one clock the extensions do not reset.
      toolRunningMs: toolStartedAt === null ? undefined : now - toolStartedAt,
      alreadyResynced: deps.rescued.has(sessionKey),
    });
    if (verdict === "ok") continue;
    if (verdict === "rescue") {
      deps.rescued.add(sessionKey);
      deps.warn(`[StaleStream] ${sessionKey} silent for 3 min but its child is ALIVE — re-attaching the stream and waiting`);
      deps.resyncStream(sessionKey);
      // Push lastActivity forward so the rescue gets a full round to land;
      // real output re-bumps it and the stream leaves this path entirely.
      bumpAndMark(deps, sessionKey, stream, silenceSince, now);
      outcomes.set(sessionKey, "rescued");
      continue;
    }
    if (verdict === "extend") {
      // The rescue is already spent and the child is still alive: extend,
      // never finalize. Re-issuing a resync every 30s against a healthy but
      // quiet child is pure noise, so this leg only bumps the clock.
      // Il numero è il silenzio VERO, non la distanza dall'ultima proroga.
      deps.warn(`[StaleStream] ${sessionKey} silent for ${Math.round((now - silenceSince) / 60_000)} min but its child is ALIVE: extending (a live turn is never killed by a clock)`);
      bumpAndMark(deps, sessionKey, stream, silenceSince, now);
      outcomes.set(sessionKey, "extended");
      continue;
    }
    if (verdict === "hung") {
      // A TOOL THAT WILL NEVER COME BACK. On 2026-09-02 `topic:6b9605e5` and
      // `topic:ada7e7db` sat on `bash:running` for hours: the command had
      // exited, but a backgrounded subshell held its pipes open and
      // `runCommand` was waiting for `close`. From in here that turn was
      // indistinguishable from a long build, and every tick bought it another
      // extension. The root is closed in the tool; this is the second wall, and
      // it closes SAYING what happened.
      deps.warn(
        `[StaleStream] ${sessionKey} ha un tool 'running' da ${Math.round((now - (toolStartedAt ?? now)) / 60_000)} min: `
        + `non è lavoro, è una promessa che non torna — lo chiudo`, // allow-italian: user-facing log line, like the others here
      );
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
    // THE LOOP FIRST, THEN THE ROW. A native turn runs INSIDE this process:
    // nothing below reaches it. `endStream`, the marker, `recordTurnEnd` and
    // the SSE abort all describe the turn as over while the agent loop keeps
    // going, and a loop nobody watches is the worst kind of alive (measured on
    // 2026-08-27 and 2026-08-29: tool blocks of a "closed" turn landing on the
    // next turn's row). Before the SSE controller, for the same reason
    // `/api/chat/abort` gives: once the route's state machine is latched the
    // provider's own `onAborted` finds a `finalizeStream` already shut.
    try { deps.abortProvider(sessionKey); } catch (err) { deps.warn(`[StaleStream] provider abort failed for ${sessionKey}: ${String(err)}`); }
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
    // The verdict goes on the row EITHER WAY. The marker only covers the empty
    // bubble; the frequent shape is a turn cut mid-answer, which keeps its
    // prose and, before this, kept no trace of why it ended - the reason lived
    // in the server log, where nobody waiting for an answer ever looks.
    deps.finalizeMessage({
      messageId: stream.messageId,
      marker: hadProse ? null : INTERRUPTED_MARKER,
      interruption: { text: INTERRUPTED_MARKER, cause: "watchdog", at: new Date().toISOString() },
    });
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
