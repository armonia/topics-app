/**
 * IL BOOT RIPRENDE I TURNI CHE HA UCCISO LUI — non chiede all'utente di farlo.
 *
 * ── Perché esiste ───────────────────────────────────────────────────────────
 * «Al più ci dovrebbe essere Riprendi, ma dovrebbe riprendere da solo» (20/08).
 *
 * Un turno di `claude-code` sopravvive già: gira in un processo figlio che il
 * SIGTERM non tocca, e `reattachSurvivingChatTurns` lo riadotta al boot. Un
 * turno del runtime nativo `topics` no: vive DENTRO il server, e quando il
 * processo muore non resta niente da riadottare. Stessa app, stesso gesto
 * dell'utente, due destini opposti — e quello brutto non lo diceva nemmeno.
 *
 * ── Cosa fa ─────────────────────────────────────────────────────────────────
 * Trova le chat il cui ULTIMO turno è morto interrotto senza che nessuno lo
 * riprendesse, e rimanda l'ultimo messaggio dell'utente per conto suo — che è
 * esattamente ciò che farebbe il bottone «Riprova», ma senza aspettare che
 * qualcuno se ne accorga.
 *
 * ── I freni, che sono la parte importante ───────────────────────────────────
 * Una ripresa automatica sbagliata costa un turno vero, a pagamento, e in un
 * ciclo li costa tutti. Quindi:
 *
 *   · only a turn carrying the verdict of an interruption of OURS (the
 *     `error` block written by `avvisoPerTurno`/`bonificaTurniMuti`) is
 *     resumed. For an answer row a Stop is kept out by construction, since
 *     `cancelledNotice` writes no block for it. A person's message nobody
 *     answered carries no block at all, so there the Stop is read from the
 *     turn-end registry (`readTurnEnd`) and, since the registry dies with
 *     every reload, from `activity_log`: a Stop recorded at or after the
 *     message means they stopped it (topic c5d57a41, 24/09);
 *   · never while a provider still holds a send for the chat
 *     (`sessionHasPendingSend`): a send queued behind a stuck turn is live
 *     even with no stream and no process (topic 3019832f, 24/09);
 *   · at most MAX_RESUME_ATTEMPTS times per MESSAGE, counted along the chain
 *     of resends (`parent_id`) and not on the single row; the trace lives in
 *     the DB (`kind: 'ripreso'`, with the attempt number), not in memory,
 *     or two restarts in a row would resume the same turn twice. Once the
 *     cap is hit it is WRITTEN in the chat, with the retry button;
 *   · solo l'ULTIMO turno della chat: più indietro non è «interrotto», è
 *     storia, e l'utente ci ha già parlato sopra;
 *   · solo se l'ultimo messaggio è dell'assistente. Se dopo c'è già scritto
 *     l'utente, ha ripreso lui e a modo suo;
 *   · una finestra stretta (30 minuti): riprendere un turno di ieri vorrebbe
 *     dire far comparire una risposta a una domanda che chi legge non ha più
 *     in mente.
 */
import type { ContentBlock } from "../types";
import { cancelled, type TurnEndInfo } from "../providers/stop-reason";
import { readTurnEnd, type RecordedTurnEnd } from "../providers/turn-end-registry";
import {
  cancelledNotice, eCartelloDiInterruzione, isRestartNotice, isResumableCause,
  STOP_PRESSED_LOG_TITLE, USER_ABORT_LOG_TITLE,
} from "./cancelled-notice";

/** Quanto indietro si va a riprendere. Oltre, è storia. */
// 24 hours, not 30 minutes (2026-09-04, asked out loud: every interrupted
// topic must resume). A turn cut last night is still the last thing that
// happened in that chat, and whoever opens it wants the answer, not a banner.
export const FINESTRA_RIPRESA_MS = 24 * 60 * 60 * 1000;

/**
 * How many resends the same MESSAGE gets, across different boots, before the
 * boot stops and says so in the chat.
 *
 * Counted on the CHAIN, not on the row. It used to be a per-row count of
 * `ripreso` blocks, and the row is the wrong unit: a resumed turn that gets
 * cut by the NEXT restart is a new row (the resend's answer), and the notice
 * the boot writes to explain it is a newer row still. Every link started from
 * zero, and the cap was never reached. Read on the live DB, topic:6b9605e5,
 * 2026-09-02 08:46 to 09:27: the same message resent FIVE times, each answer
 * redoing every tool round from scratch, five banners in the chat, and every
 * resumed turn holding the next restart. A watcher restarting the server every
 * thirty seconds turns that into a loop that buys the same turn until the
 * thirty-minute window closes.
 *
 * Two: the resume itself, plus one automatic retry for the resend that got cut
 * (the topic:0299ac2d case, which a yes/no switch used to lose). A third cut
 * on the same message says the problem is not the moment, and from there the
 * user gets the ⚠️ notice with "Riprova" and decides.
 */
// Four, not two: three planned restarts in forty minutes hit the old cap and
// left the retry banner on chats nobody had touched. The cap still exists for
// the message that crashes its turn every time.
export const MAX_RESUME_ATTEMPTS = 4;

/**
 * THE QUESTION NOBODY ANSWERED. A chat whose LAST row is the person's message,
 * with no answer row after it, used to be read as "they resumed by hand" and
 * skipped. But that is also what a turn looks like when the server died BEFORE
 * the answer row was born, or when the boot swept an empty answer away: the
 * person wrote, nothing came, and nothing ever would. Measured 2026-09-04 on
 * topic:6b9605e5, a message sent at 09:58 under a restart and unanswered for
 * five hours while every sweep read it as "already resumed". A live turn writes
 * its answer row within seconds, so a person's row older than this grace, with
 * no stream on the chat, is an interruption of ours that never got its notice.
 */
export const USER_TAIL_GRACE_MS = 2 * 60_000;
/** The notice written on such a chat BEFORE it is resumed (RESUME-02: first the
 *  explanation in the thread, then the resend). Its opening words are one of
 *  `CARTELLI_RIPRENDIBILI`, so the resume that follows recognises it. */
export const UNANSWERED_NOTICE =
  "⚠️ Turno interrotto: il server si è riavviato prima che la risposta partisse: il messaggio è rimasto senza risposta.";

/**
 * The same notice when no restart happened: UNANSWERED_NOTICE said "the server
 * restarted" on every chat, and on topic 3019832f (24/09) nothing had
 * restarted. Its opening is in `CARTELLI_RIPRENDIBILI` too, for the same reason.
 */
export const UNANSWERED_NO_RESTART_NOTICE =
  "⚠️ Turno interrotto: la risposta non è mai partita e il messaggio è rimasto senza risposta. Lo rimando.";

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
    if (why) return `${why} Il messaggio è rimasto senza risposta: lo rimando.`;
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
 */
export const RESUME_CAP_MARKER =
  `⚠️ Ripresa automatica sospesa: il server si e' riavviato ${MAX_RESUME_ATTEMPTS} volte di fila sotto questo turno e ogni volta l'aveva ripreso da capo. Il messaggio che hai inviato e' ancora qui: premi Riprova quando vuoi rimandarlo.`;

/**
 * The cap notice, worded by what really cut the chain. RESUME_CAP_MARKER
 * blamed a restart every time: topic 3019832f got six of them on 24/09 with no
 * restart between 10:42 and 14:48. Cause first, as in `blamesRestart`: a stall
 * keeps its sentence even when a boot happened later. Same opening as the
 * marker, which must stay outside `CARTELLI_RIPRENDIBILI` for the reason
 * given above.
 */
export function resumeCapNotice(opts: { restarted: boolean; cause?: unknown }): string {
  const tail = "Il messaggio che hai inviato e' ancora qui: premi Riprova quando vuoi rimandarlo.";
  if (isStall(opts.cause)) {
    return `⚠️ Ripresa automatica sospesa: l'agente ha smesso di rispondere ${MAX_RESUME_ATTEMPTS} volte di fila su questo turno e ogni volta l'avevo ripreso da capo. ${tail}`;
  }
  if (blamesRestart(opts.cause, opts.restarted)) return RESUME_CAP_MARKER;
  return `⚠️ Ripresa automatica sospesa: questo turno si e' interrotto ${MAX_RESUME_ATTEMPTS} volte di fila e ogni volta l'avevo ripreso da capo. ${tail}`;
}

export interface RigaDaValutare {
  sessionKey: string;
  /** L'ultimo messaggio della chat: ruolo, blocchi, quando. */
  ruolo: string;
  blocks: ContentBlock[] | null;
  timestampMs: number;
  /**
   * Resends already spent on this chain, this row included: the highest
   * `attempt` any `ripreso` block along `parent_id` carries. The caller walks
   * the chain (`attemptsInChain`); the rule stays pure.
   */
  attempts: number;
  /** A turn is live on this chat right now (`ctx.isStreaming`). */
  streaming?: boolean;
  /** A provider still holds a send for this chat, in flight or queued
   *  (`sessionHasPendingSend`), which a live stream alone does not show. */
  providerBusy?: boolean;
  /** The last turn end recorded for this session and when (`readTurnEnd`);
   *  empty after a restart. */
  lastTurnEnd?: RecordedTurnEnd | null;
  /** The chat belongs to a board card: the dispatcher resumes those itself. */
  boundToCard?: boolean;
}

/** The person pressed Stop on this message's turn, or on a later one. A Stop
 *  recorded before the message belongs to the turn before it. */
function stoppedByPerson(r: RigaDaValutare): boolean {
  const e = r.lastTurnEnd;
  return !!e && e.info.end === "cancelled" && e.info.cause === "user" && e.atMs >= r.timestampMs;
}

/** The rule's answer: resend, stop AND say so, leave the row alone - or, for a
 *  person's message nobody answered, write the notice first and then resend. */
export type ResumeVerdict = "resend" | "capped" | "no" | "unanswered";

/**
 * Questa chat va ripresa adesso?
 *
 * Pura: chi chiama decide COME riprendere. Qui si decide SE, e ogni «no» ha
 * un test suo — perché sono i «no» che tengono questa macchina innocua.
 *
 * `capped` is a "no" with a duty attached: the row DESERVED the resend and the
 * chain has already had its share, so the chat has to be told, once.
 */
export function resumeVerdict(r: RigaDaValutare, oraMs: number): ResumeVerdict {
  if (r.ruolo === "user") {
    // The last word is the person's. Either they resumed by hand and a turn
    // is running, or the row is fresh and its answer is on the way - or nobody
    // ever answered (see USER_TAIL_GRACE_MS). A card's chat is the
    // dispatcher's, which re-sends its own kickoff. Window and cap apply as
    // for any other interruption of ours.
    // A send still queued on the provider is the answer on its way, and a
    // message the person stopped stays unanswered because they chose so.
    if (r.streaming || r.providerBusy || r.boundToCard) return "no";
    if (stoppedByPerson(r)) return "no";
    if (oraMs - r.timestampMs < USER_TAIL_GRACE_MS) return "no";
    if (oraMs - r.timestampMs > FINESTRA_RIPRESA_MS) return "no";
    if (r.attempts >= MAX_RESUME_ATTEMPTS) return "capped";
    return "unanswered";
  }
  if (r.ruolo !== "assistant") return "no";
  // A turn is live on this chat: whatever the last row says, it is being
  // answered right now. Without this the capped branch below fired on EVERY
  // sweep while the resumed turn was still working: topic 3019832f on 24/09
  // got «Ripresa automatica sospesa» six times in 30 minutes, one each 5 min,
  // under an agent that was answering. A send still waiting in the provider's
  // queue is the same case with no stream to show it (3019832f again: four
  // resends behind the send the watchdog had orphaned).
  if (r.streaming || r.providerBusy) return "no";
  if (!Array.isArray(r.blocks) || r.blocks.length === 0) return "no";
  // Fuori finestra: una risposta che arriva domani a una domanda di ieri è
  // rumore, non un recupero.
  if (oraMs - r.timestampMs > FINESTRA_RIPRESA_MS) return "no";
  // E soprattutto: c'è il verdetto di un'interruzione NOSTRA? Un turno chiuso
  // dall'utente non ce l'ha (`cancelledNotice` tace su `user`), quindi questo
  // controllo è anche il modo in cui il suo Ferma viene rispettato.
  // NON basta «c'è un blocco error»: in quel blocco ci finisce OGNI verdetto di
  // guasto. Misurato sul db vivo, sugli ultimi messaggi di ogni sessione con un
  // blocco `error`: 25 «ai-bridge: ack timeout», 4 «Process exited with code»,
  // 1 «API 400» — nessuno e' un'interruzione nostra. Sono guasti
  // deterministici: rimandare il messaggio ricompra lo stesso fallimento, e su
  // un turno lungo riapre tutti i giri di tool gia' fatti.
  //
  // Il testo del cartello lo riconosce chi lo scrive (`cancelled-notice.ts`),
  // dove le frasi vivono: cosi' chi ne cambia una vede subito chi la legge.
  // The cap notice below is written with the same ⚠️ shape and is NOT in that
  // list: that is what keeps it from being resumed in turn.
  // Text OR cause. The text is what reaches rows written before the block
  // carried a `cause` (2026-09-03) and the notices whose wording is stable; the
  // cause is what reaches every cut of ours whatever sentence it wore. The
  // sweeper's cut (`INTERRUPTED_MARKER` in lib/stale-stream-sweep.ts) was
  // recognised by neither until 05/09/2026: no chat it closed was ever resumed.
  const interrupted = r.blocks.some((b) => b?.kind === "error" && (
    eCartelloDiInterruzione(typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")
    || isResumableCause((b as { cause?: unknown }).cause)
  ));
  if (!interrupted) return "no";
  // Resumed TOO MANY times, on the CHAIN. The trace is written BEFORE the
  // resend, on purpose: written after, a resend that dies halfway would be
  // retried at every boot forever. And it is a counter, not a switch: a resend
  // that got CUT by the next restart must get one more try (topic:0299ac2d,
  // 2026-08-29, where the switch left two chats stuck under a notice promising
  // they would resume on their own). Past the cap the row is still an
  // interruption of ours, so the answer is not silence: it is `capped`.
  if (r.attempts >= MAX_RESUME_ATTEMPTS) return "capped";
  return "resend";
}

/**
 * THE READER OF THE FIELD THIS FILE WRITES.
 *
 * The resend goes out as `{ ripresa: <attempt> }` on the chat route's body,
 * and two things downstream have to know: the `ripreso` block on the row, and
 * the `resumedBy: "server"` marker on `stream:start`, which is what lets the
 * chat say "resuming" instead of leaving the reader under a banner whose only
 * advice is to press Retry.
 *
 * `true` still means one, because the field was a boolean before it was a
 * counter and an old caller must not silently mean zero.
 */
export function resumeAttemptOf(body: { ripresa?: unknown } | null | undefined): number {
  const value = body?.ripresa;
  if (typeof value === "number" && value > 0) return value;
  return value === true ? 1 : 0;
}

/** The yes/no of `resumeVerdict`, for the callers that only resend. */
export function chatDaRiprendere(r: RigaDaValutare, oraMs: number): boolean {
  return resumeVerdict(r, oraMs) === "resend";
}

/** The resend number a `ripreso` block stands for. Rows written before the
 *  field existed carry one resend each, which is what they meant. */
function attemptOf(b: ContentBlock): number {
  if (b?.kind !== "ripreso") return 0;
  const a = (b as { attempt?: unknown }).attempt;
  return typeof a === "number" && a > 0 ? a : 1;
}

/** The highest resend number among a row's blocks; 0 when it has none. */
export function attemptsOnRow(blocks: ContentBlock[] | null | undefined): number {
  if (!Array.isArray(blocks)) return 0;
  return blocks.reduce((n, b) => Math.max(n, attemptOf(b)), 0);
}

/**
 * Il GIRO della ripresa. La REGOLA — chi merita di essere ripreso — sta sopra,
 * in `chatDaRiprendere`, e si prova senza toccare un database.
 *
 * Vive qui e non in `server.ts` perché tocca il DB di produzione e manda turni
 * veri: dentro un file da cinquemila righe nessun test ci arriva, e una
 * macchina che spende soldi da sola non può essere l'unica cosa non provata.
 */
import type { Database } from "bun:sqlite";
import { decodeCol, encodeCol } from "../../shared/message-blob";
import { insertRestartNotification, type PartialSweepDb } from "./boot-partial-sweep";

/** Quel poco del contesto del server che serve al giro. */
export interface CtxRipresa {
  db: Database;
  getTopicBySessionKey(sessionKey: string): { id?: string; archived?: boolean | number } | undefined | null;
  /** Truthy when a turn is live on that chat (`ctx.isStreaming` in production). */
  isStreaming?(sessionKey: string): unknown;
  /** Whether a provider still holds a send for that chat, in flight or queued
   *  (`sessionHasPendingSend` in production). Absent means nobody can tell.
   *  It must answer from memory, with no I/O: see the loop that awaits it. */
  providerBusy?(sessionKey: string): boolean | Promise<boolean>;
  /** The last recorded turn end and when; defaults to the process registry.
   *  A person's Stop is also read from `activity_log`, which survives a restart. */
  lastTurnEnd?(sessionKey: string): RecordedTurnEnd | undefined;
  /** When this server process started: a person's message older than this
   *  lived through a restart. Defaults to the process start. */
  bootedAtMs?: number;
}

/** The last `error` block of a row: the cut, with its cause and its text. */
function lastErrorBlock(blocks: ContentBlock[] | null): { cause?: unknown; text?: string } | undefined {
  if (!Array.isArray(blocks)) return undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i] as { kind?: unknown; cause?: unknown; text?: unknown } | undefined;
    if (b?.kind === "error") return { cause: b.cause, text: typeof b.text === "string" ? b.text : undefined };
  }
  return undefined;
}

/**
 * The newest DURABLE trace of a person's Stop on this session at or after
 * `sinceIso`, as a turn end. The registry is memory and the server reloads on
 * every save: on the first boot after a Stop it is empty, and the stopped
 * message would be resent as "unanswered" (topic c5d57a41, 24/09). A database
 * without `activity_log` is no evidence, not an error.
 */
function durableStopSince(db: Pick<Database, "query">, sessionKey: string, sinceIso: string): RecordedTurnEnd | undefined {
  try {
    const row = db.query(
      `SELECT timestamp FROM activity_log
        WHERE session_key = ? AND category = 'stream' AND title IN (?, ?) AND timestamp >= ?
        ORDER BY timestamp DESC LIMIT 1`,
    ).get(sessionKey, USER_ABORT_LOG_TITLE, STOP_PRESSED_LOG_TITLE, sinceIso) as { timestamp: string } | undefined | null;
    const atMs = row ? Date.parse(row.timestamp) : NaN;
    return Number.isFinite(atMs) ? { info: cancelled("user", "activity_log"), atMs } : undefined;
  } catch {
    return undefined;
  }
}

/** Of two recorded ends, the latest. */
function latestEnd(a: RecordedTurnEnd | undefined, b: RecordedTurnEnd | undefined): RecordedTurnEnd | undefined {
  if (!a || !b) return a ?? b;
  return b.atMs > a.atMs ? b : a;
}

/** Stops already reported in the log, per session, by the time of the Stop:
 *  without it a stopped chat would repeat the same line every sweep for a day. */
const stopsLogged = new Map<string, number>();

/** Whether a board card is working on this topic: those chats are the
 *  dispatcher's to resume (it re-sends its own kickoff), never this sweep's. */
function cardBound(db: Pick<Database, "query">, topicId: string): boolean {
  try {
    return db.query(
      `SELECT 1 FROM tasks WHERE assigned_topic_id = ? AND archived = 0 AND status IN ('todo','in_progress','review') LIMIT 1`,
    ).get(topicId) != null;
  } catch { return false; }
}

/** A chain longer than this is not a chain: `parent_id` is cyclic or corrupt. */
const CHAIN_WALK_LIMIT = 64;

/**
 * How many resends the chain ending at `ultimoId` has already spent.
 *
 * Walks `parent_id` upwards and takes the highest `attempt` any `ripreso`
 * block carries. The chain is every row born of the same resent message: the
 * cut answers (each opens with the banner `chat.ts` pushes), the boot notices
 * that explain them (each gains the trace written before the resend), and the
 * resent user rows in between. It ends at the first assistant row that carries
 * no `ripreso` block at all, which is the turn before all this began, except
 * for the row being judged itself: a fresh boot notice has no trace yet, and
 * the answer it explains is one hop up.
 */
export function attemptsInChain(db: Pick<Database, "query">, sessionKey: string, ultimoId: string): number {
  let max = 0;
  let id: string | null = ultimoId;
  for (let hop = 0; id && hop < CHAIN_WALK_LIMIT; hop++) {
    const row = db.query(
      `SELECT role, blocks, parent_id FROM messages WHERE id = ? AND session_key = ?`,
    ).get(id, sessionKey) as { role: string; blocks: unknown; parent_id: string | null } | undefined | null;
    if (!row) break;
    if (row.role === "assistant") {
      let blocks: ContentBlock[] | null = null;
      try { blocks = JSON.parse(decodeCol(row.blocks) ?? "null") as ContentBlock[] | null; } catch { blocks = null; }
      const n = attemptsOnRow(blocks);
      if (n === 0 && hop > 0) break;
      max = Math.max(max, n);
    }
    id = row.parent_id;
  }
  return max;
}

/** La route della chat, iniettata: è la STESSA porta di un messaggio umano. */
export type RouterChat = (
  req: Request, url: URL, path: string, method: string,
) => Promise<Response | undefined | null> | Response | undefined | null;

/**
 * HOW LONG THE ROUTE MAY TAKE TO HAND BACK A RESPONSE, and why there is a
 * ceiling at all.
 *
 * Measured on 2026-08-29, topic:0299ac2d: the log printed "1 turno/i
 * interrotto/i da riprendere" and then nothing. Not the success line, not the  allow-italian: quoted log line
 * refusal line, not even `[HTTP] POST /api/chat received`, which is the first
 * statement of the chat handler, before any await. So `await router(...)` had
 * not returned, and it never would: an await with no ceiling is not "slow",
 * it is a stop, and it takes the last link of the boot chain down with it.
 *
 * A ceiling does not repair whatever hangs down there. It does two things the
 * hang denied us: the resume loop keeps going for the OTHER sessions, and the
 * log gains the line that says where it stopped. A resume that fails loudly
 * costs one turn; a resume that hangs mutely costs every later one.
 *
 * The route only has to produce the response HEADERS inside this window: the
 * turn itself streams afterwards, and has its own, far wider ceiling below.
 */
export const RESPONSE_CEILING_MS = 60_000;

/**
 * And the stream has one too. Draining it is how we learn the turn ended, so
 * this window has to hold a whole real turn (tool rounds included), which is
 * why it is minutes and not seconds. Past it we stop WATCHING the resend, we
 * do not stop it: the turn keeps running inside the server and its rows keep
 * being written. We only give up on being able to say how it went.
 */
export const STREAM_CEILING_MS = 15 * 60 * 1000;

/** The two ceilings, injectable so a test does not have to wait a minute. */
export interface ResumeCeilings {
  responseMs?: number;
  streamMs?: number;
}

/** What a ceiling returns when it fires. Not a value the work could produce. */
const EXPIRED = Symbol("expired");

/**
 * Await `work`, but never longer than `ms`.
 *
 * The loser of the race is left running on purpose: aborting a resend that is
 * merely slow would throw away a turn the user is waiting for. What we abandon
 * is the WAIT, not the work. `Promise.race` already attaches a handler to the
 * loser, so a late rejection cannot surface as an unhandled one.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof EXPIRED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alarm = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), ms);
  });
  try {
    return await Promise.race([work, alarm]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * I TURNI CHE ABBIAMO UCCISO NOI, RIPRESI DA NOI.
 *
 * Un turno di `claude-code` sopravvive al riavvio (gira in un figlio, il broker
 * lo tiene, `reattachSurvivingChatTurns` lo riadotta). Un turno del runtime
 * nativo no: vive dentro questo processo, e quando muore la chat resta ferma a
 * metà frase — e il bottone «Riprova» non copre il caso, perché il client lo
 * mostra solo su un turno SENZA lavoro, mentre quello morto a metà lavoro è la
 * forma normale del guasto.
 *
 * So the server resumes it. Who deserves the resume is `resumeVerdict`'s call,
 * tested on its own: only the last turn, only an interruption of OURS, never a
 * message the person stopped (read from the turn-end registry and from
 * `activity_log`, because an unanswered message has no block to say so),
 * never while a provider still holds a send for the chat, at most
 * MAX_RESUME_ATTEMPTS times per message, inside FINESTRA_RIPRESA_MS, and only
 * if the person has not resumed it.
 *
 * Il rimando passa dalla STESSA route della chat: qui non si fabbrica un turno,
 * si rimanda il messaggio che era rimasto senza risposta.
 */
export async function riprendiTurniInterrotti(
  ctx: CtxRipresa, router: RouterChat, ceilings: ResumeCeilings = {},
): Promise<void> {
  const responseCeilingMs = ceilings.responseMs ?? RESPONSE_CEILING_MS;
  const streamCeilingMs = ceilings.streamMs ?? STREAM_CEILING_MS;
  const candidati: Array<{ sessionKey: string; messaggio: string; idTurno: string; blocks: ContentBlock[]; attempt: number }> = [];
  try {
    // L'ULTIMO messaggio di ogni chat, che è l'unico che possa essere
    // «interrotto»: più indietro è storia, e l'utente ci ha già parlato sopra.
    const righe = ctx.db.query(
      `SELECT m.session_key AS sk, m.id AS id, m.role AS ruolo, m.blocks AS blocks, m.timestamp AS ts
         FROM messages m
         JOIN (SELECT session_key, MAX(rowid) AS r FROM messages GROUP BY session_key) u
           ON u.r = m.rowid
        WHERE m.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours')`,
    ).all() as Array<{ sk: string; id: string; ruolo: string; blocks: unknown; ts: string }>;
    const ora = Date.now();
    const bootedAtMs = ctx.bootedAtMs ?? ora - process.uptime() * 1000;
    for (const r of righe) {
      let blocks: ContentBlock[] | null = null;
      try { blocks = JSON.parse(decodeCol(r.blocks) ?? "null") as ContentBlock[] | null; } catch { continue; }
      const attempts = attemptsInChain(ctx.db, r.sk, r.id);
      const topic = ctx.getTopicBySessionKey(r.sk);
      if (!topic || topic.archived) continue;
      const row: RigaDaValutare = {
        sessionKey: r.sk, ruolo: r.ruolo, blocks, timestampMs: Date.parse(r.ts), attempts,
        streaming: Boolean(ctx.isStreaming?.(r.sk)),
        // Settles in microtasks (a queue tail, no I/O), so reading the rows
        // and writing the traces still happen inside one macrotask, and a
        // second sweep started by a timer cannot pick the same row.
        providerBusy: Boolean(await ctx.providerBusy?.(r.sk)),
        // Newest wins between the registry and, for a person's message, the
        // durable Stop: after a restart only the second is left.
        lastTurnEnd: latestEnd(
          ctx.lastTurnEnd ? ctx.lastTurnEnd(r.sk) : readTurnEnd(r.sk),
          r.ruolo === "user" ? durableStopSince(ctx.db, r.sk, r.ts) : undefined,
        ) ?? null,
        boundToCard: topic.id ? cardBound(ctx.db, topic.id) : false,
      };
      let verdict: ResumeVerdict = resumeVerdict(row, ora);
      if (verdict === "no") {
        // Said only when that reason alone changed the verdict: a live stream
        // or a card already says "no" without anybody's help.
        if (row.providerBusy && resumeVerdict({ ...row, providerBusy: false }, ora) !== "no") {
          console.log(`[ripresa] ${r.sk}: un invio per questa chat è ancora in coda sul provider, non lo rimando`);
        } else if (row.lastTurnEnd && stoppedByPerson(row) && stopsLogged.get(r.sk) !== row.lastTurnEnd.atMs
          && resumeVerdict({ ...row, lastTurnEnd: null }, ora) !== "no") {
          stopsLogged.set(r.sk, row.lastTurnEnd.atMs);
          console.log(`[ripresa] ${r.sk}: il turno l'ha fermato l'utente, il messaggio resta senza risposta e non lo rimando`);
        }
        continue;
      }
      // A person's message that predates this process lived through a restart:
      // the fallback evidence for their notices when no cause is known. Never
      // used for an answer row, whose cut says what cut it.
      const messagePredatesBoot = row.timestampMs < bootedAtMs;
      // The recorded end speaks for this message only if it came after it.
      const ownEnd = row.lastTurnEnd && row.lastTurnEnd.atMs >= row.timestampMs ? row.lastTurnEnd.info : null;
      let resendRowId = r.id;
      let rowBlocks: ContentBlock[] = blocks ?? [];
      if (verdict === "unanswered") {
        // RESUME-02: the explanation goes in the thread FIRST. The notice has
        // the boot's own shape, parented to the person's row, and it becomes
        // the row the resend is traced on: the next sweep counts this chain
        // like any other, and a second boot does not resend it again.
        try {
          insertRestartNotification(ctx.db as unknown as PartialSweepDb, r.sk, { text: unansweredNotice({ restarted: messagePredatesBoot, lastEnd: ownEnd }) });
        } catch (err) {
          console.warn(`[ripresa] ${r.sk}: messaggio senza risposta, ma non riesco a scrivere il cartello, lo salto:`, err);
          continue;
        }
        const notice = ctx.db.query(
          `SELECT id, blocks FROM messages WHERE session_key = ? ORDER BY sort_order DESC, rowid DESC LIMIT 1`,
        ).get(r.sk) as { id: string; blocks: unknown } | undefined;
        if (!notice || notice.id === r.id) continue;
        try { rowBlocks = JSON.parse(decodeCol(notice.blocks) ?? "[]") as ContentBlock[]; } catch { rowBlocks = []; }
        resendRowId = notice.id;
        console.log(`[ripresa] ${r.sk}: messaggio dell'utente senza risposta da ${Math.round((ora - Date.parse(r.ts)) / 60_000)} min, cartello scritto, lo rimando`);
        verdict = "resend";
      }
      // THE CAP IS SAID, NOT SUFFERED. The row is an interruption of ours and
      // the chain has had its resends: stopping here in silence would leave
      // the chat under a notice promising it resumes on its own, which is the
      // one lie this file exists to remove. The notice goes in the thread with
      // the same shape as the boot's own (⚠️, error block only), so the client
      // shows the amber banner and "Riprova"; and being the last row, and not  allow-italian: button label
      // an interruption text, it is what stops the next boot from resuming
      // this chain again. Written once: the boot after finds it and says "no".
      if (verdict === "capped") {
        try {
          const cut = lastErrorBlock(blocks);
          const text = r.ruolo === "user"
            ? resumeCapNotice({ restarted: messagePredatesBoot, cause: ownEnd?.cause })
            // An answer row carries its cut: the block's cause, or a restart
            // notice's text (the boot sweep writes a hard kill's with no cause).
            : resumeCapNotice({ restarted: isRestartNotice(cut?.text), cause: cut?.cause });
          insertRestartNotification(ctx.db as unknown as PartialSweepDb, r.sk, { text });
          console.warn(`[ripresa] ${r.sk}: ripreso gia' ${attempts} volte di fila su questo messaggio, mi fermo e lo scrivo in chat`);
        } catch (err) {
          console.warn(`[ripresa] ${r.sk}: tetto raggiunto ma non riesco a scriverlo in chat:`, err);
        }
        continue;
      }
      // Il messaggio da rimandare è l'ultimo dell'utente: è ciò che farebbe il
      // bottone «Riprova» (`handleRetry`, ChatPane), e la stessa cosa fatta
      // senza aspettare che qualcuno se ne accorga.
      const dom = ctx.db.query(
        `SELECT content FROM messages WHERE session_key = ? AND role = 'user'
          ORDER BY rowid DESC LIMIT 1`,
      ).get(r.sk) as { content: unknown } | undefined;
      const messaggio = (decodeCol(dom?.content) ?? "").trim();
      if (!messaggio) continue;
      candidati.push({ sessionKey: r.sk, messaggio, idTurno: resendRowId, blocks: rowBlocks, attempt: attempts + 1 });
    }
  } catch (err) {
    console.warn("[ripresa] non riesco a cercare i turni interrotti:", err);
    return;
  }
  if (candidati.length === 0) return;
  console.log(`[ripresa] ${candidati.length} turno/i interrotto/i da riprendere`);
  // ONE RESEND DOES NOT WAIT FOR THE ONE BEFORE IT.
  //
  // This was a `for` that awaited the answer (up to a minute) and then DRAINED
  // the stream, which is a whole turn: fifteen minutes of ceiling. Candidate
  // N+1 did not start until turn N had finished, while the notice on every one
  // of those chats reads "Riprendo da solo: non serve che tu faccia niente" allow-italian: quoted notice text
  // (lib/cancelled-notice.ts). True for the first, a lie for the rest, and the
  // same SIGTERM kills them all together. Each resend is independent (its own
  // session, its own row, its own trace), so they go at once and the boot chain
  // is as long as the slowest one instead of their sum.
  await Promise.all(candidati.map((c) => resumeOne(c)));

  async function resumeOne(c: (typeof candidati)[number]): Promise<void> {
    // LA TRACCIA PRIMA DEL LAVORO. Se il rimando fallisce a metà — o il server
    // muore di nuovo mentre lo fa — la traccia c'è comunque, e il boot dopo non
    // lo riprende una seconda volta. Al contrario si costruirebbe un ciclo che
    // brucia token da solo, che è l'unico modo in cui questa funzione può fare
    // più danno del guasto che cura.
    //
    // The trace carries the resend NUMBER, and so does the banner the route
    // pushes on the answer: it is how the boot after this one, finding that
    // answer cut in turn, knows the chain is on its second try and not its
    // first.
    try {
      const conTraccia: ContentBlock[] = [...c.blocks, { kind: "ripreso", attempt: c.attempt }];
      ctx.db.prepare(`UPDATE messages SET blocks = ? WHERE id = ?`)
        .run(encodeCol(JSON.stringify(conTraccia)) ?? null, c.idTurno);
    } catch (err) {
      console.warn(`[ripresa] ${c.sessionKey}: non riesco a segnare il turno, lo salto:`, err);
      return;
    }
    // The instant before the resend, so afterwards we can tell whether
    // anything was born of it.
    const beforeResend = new Date().toISOString();
    // ONE LINE BEFORE THE CALL, and it is not decoration. On 2026-08-29 the log
    // went from "N turni da riprendere" straight to silence, and that silence  allow-italian: quoted log line
    // could mean two different things: the loop never reached the route, or the
    // route never came back. Reading the log could not tell them apart, so the
    // hunt had to start from the source. With this line the next occurrence
    // says which of the two it is, before anyone opens an editor.
    console.log(`[ripresa] ${c.sessionKey}: rimando il messaggio alla route della chat (attempt ${c.attempt} di ${MAX_RESUME_ATTEMPTS})`);
    try {
      const url = new URL("http://localhost/api/chat");
      const body = JSON.stringify({
        sessionKey: c.sessionKey,
        messages: [{ role: "user", content: c.messaggio }],
        ripresa: c.attempt,
      });
      const answered = await withDeadline(
        Promise.resolve(router(
          new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
          url, "/api/chat", "POST",
        )),
        responseCeilingMs,
      );
      // THE ROUTE NEVER ANSWERED. This is the measured failure, and the only
      // thing that makes it survivable is that we say so and move on: the next
      // candidate still gets its resend, and the boot chain still finishes.
      if (answered === EXPIRED) {
        console.warn(
          `[ripresa] ${c.sessionKey}: la route non ha risposto entro ${responseCeilingMs} ms, smetto di aspettarla: il turno NON è ripreso`,
        );
        return;
      }
      const resp = answered;
      // THE STATUS GETS READ, or "resumed" is a word and not a fact.
      //
      // Before, the body was drained and success declared whatever came back: a
      // 400 and a working turn left the identical log line. On 2026-08-29, on
      // topic:0299ac2d, the resume wrote its trace, said "turno ripreso" and
      // NOTHING appeared in the chat - zero rows after that boot, while four
      // other sessions were writing normally. The cause cannot be reconstructed
      // afterwards, because the one piece of evidence that would settle it -
      // what the route answered - was read by nobody.
      if (!resp || !resp.ok) {
        console.warn(
          `[ripresa] ${c.sessionKey}: la route ha rifiutato il rimando (HTTP ${resp?.status ?? "nessuna risposta"}), il turno NON è ripreso`,
        );
        return;
      }
      // Lo stream si consuma fino in fondo: la route finalizza la riga quando
      // il turno finisce, non quando parte.
      if (resp.body) {
        const reader = resp.body.getReader();
        const drained = await withDeadline((async () => {
          while (true) { const { done } = await reader.read(); if (done) break; }
        })(), streamCeilingMs);
        // A stream that never ends is the same stop as above, one step later.
        // The reader is deliberately NOT cancelled: cancelling the body is how
        // the route learns the caller left, and the turn we are trying to save
        // would die of it. We stop looking; the drain finishes on its own.
        if (drained === EXPIRED) {
          console.warn(
            `[ripresa] ${c.sessionKey}: lo stream non è finito entro ${streamCeilingMs} ms, smetto di guardarlo: il turno può essere vivo, ma non lo dichiaro ripreso`,
          );
          return;
        }
      }
      // AND A 200 IS NOT ENOUGH EITHER. The route can answer and then end the
      // turn without depositing a row, which is exactly the measured case. So
      // the session is asked whether it gained a message, and the answer is
      // said out loud when it did not.
      const gained = ctx.db.prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE session_key = ? AND timestamp > ?`,
      ).get(c.sessionKey, beforeResend) as { n: number } | undefined;
      if (!gained?.n) {
        console.warn(
          `[ripresa] ${c.sessionKey}: la route ha risposto ${resp.status} ma la sessione non ha guadagnato nessun messaggio: il turno NON è ripreso`,
        );
        return;
      }
      console.log(`[ripresa] ${c.sessionKey}: turno ripreso`);
    } catch (err) {
      console.warn(`[ripresa] ${c.sessionKey}: la ripresa non è riuscita:`, err);
    }
  }
}
