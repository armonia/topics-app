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
 *   · si riprende SOLO chi porta il verdetto di un'interruzione NOSTRA (il
 *     blocco `error` scritto da `avvisoPerTurno`/`bonificaTurniMuti`): un
 *     turno fermato dall'utente non ha quel blocco, per costruzione;
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
import { eCartelloDiInterruzione } from "./cancelled-notice";

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
}

/** The rule's answer: resend, stop AND say so, or leave the row alone. */
export type ResumeVerdict = "resend" | "capped" | "no";

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
  // L'ultima parola è dell'utente: ha già ripreso lui, a modo suo.
  if (r.ruolo !== "assistant") return "no";
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
  const interrupted = r.blocks.some((b) => b?.kind === "error" && eCartelloDiInterruzione(
    typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "",
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
  getTopicBySessionKey(sessionKey: string): { archived?: boolean | number } | undefined | null;
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
 * Quindi lo riprende il server. Chi merita la ripresa lo decide
 * `lib/ripresa-boot.ts`, provato a parte, con i suoi cinque freni: solo
 * l'ultimo turno, solo se porta il verdetto di un'interruzione NOSTRA (un turno
 * fermato dall'utente non ce l'ha, per costruzione), al più MAX_RESUME_ATTEMPTS volte per messaggio, dentro
 * mezz'ora, e solo se l'utente non ha già ripreso lui.
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
    for (const r of righe) {
      let blocks: ContentBlock[] | null = null;
      try { blocks = JSON.parse(decodeCol(r.blocks) ?? "null") as ContentBlock[] | null; } catch { continue; }
      const attempts = attemptsInChain(ctx.db, r.sk, r.id);
      const verdict = resumeVerdict(
        { sessionKey: r.sk, ruolo: r.ruolo, blocks, timestampMs: Date.parse(r.ts), attempts }, ora,
      );
      if (verdict === "no") continue;
      const topic = ctx.getTopicBySessionKey(r.sk);
      if (!topic || topic.archived) continue;
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
          insertRestartNotification(ctx.db as unknown as PartialSweepDb, r.sk, { text: RESUME_CAP_MARKER });
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
      candidati.push({ sessionKey: r.sk, messaggio, idTurno: r.id, blocks: blocks!, attempt: attempts + 1 });
    }
  } catch (err) {
    console.warn("[ripresa] non riesco a cercare i turni interrotti:", err);
    return;
  }
  if (candidati.length === 0) return;
  console.log(`[ripresa] ${candidati.length} turno/i interrotto/i da riprendere`);
  for (const c of candidati) {
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
      continue;
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
        continue;
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
        continue;
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
          continue;
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
        continue;
      }
      console.log(`[ripresa] ${c.sessionKey}: turno ripreso`);
    } catch (err) {
      console.warn(`[ripresa] ${c.sessionKey}: la ripresa non è riuscita:`, err);
    }
  }
}
