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
 *   · UNA volta sola per turno, e la traccia sta nel DB (`kind: 'ripreso'`),
 *     non in memoria — altrimenti due riavvii di fila riprenderebbero due
 *     volte lo stesso turno;
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
export const FINESTRA_RIPRESA_MS = 30 * 60 * 1000;

export interface RigaDaValutare {
  sessionKey: string;
  /** L'ultimo messaggio della chat: ruolo, blocchi, quando. */
  ruolo: string;
  blocks: ContentBlock[] | null;
  timestampMs: number;
}

/**
 * Questa chat va ripresa adesso?
 *
 * Pura: chi chiama decide COME riprendere. Qui si decide SE, e ogni «no» ha
 * un test suo — perché sono i «no» che tengono questa macchina innocua.
 */
export function chatDaRiprendere(r: RigaDaValutare, oraMs: number): boolean {
  // L'ultima parola è dell'utente: ha già ripreso lui, a modo suo.
  if (r.ruolo !== "assistant") return false;
  if (!Array.isArray(r.blocks) || r.blocks.length === 0) return false;
  // Fuori finestra: una risposta che arriva domani a una domanda di ieri è
  // rumore, non un recupero.
  if (oraMs - r.timestampMs > FINESTRA_RIPRESA_MS) return false;
  // Già ripreso: mai due volte, e la traccia è nel turno stesso.
  if (r.blocks.some((b) => b?.kind === "ripreso")) return false;
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
  return r.blocks.some((b) => b?.kind === "error" && eCartelloDiInterruzione(
    typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "",
  ));
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

/** Quel poco del contesto del server che serve al giro. */
export interface CtxRipresa {
  db: Database;
  getTopicBySessionKey(sessionKey: string): { archived?: boolean | number } | undefined | null;
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
 * fermato dall'utente non ce l'ha, per costruzione), una volta sola, dentro
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
  const candidati: Array<{ sessionKey: string; messaggio: string; idTurno: string; blocks: ContentBlock[] }> = [];
  try {
    // L'ULTIMO messaggio di ogni chat, che è l'unico che possa essere
    // «interrotto»: più indietro è storia, e l'utente ci ha già parlato sopra.
    const righe = ctx.db.query(
      `SELECT m.session_key AS sk, m.id AS id, m.role AS ruolo, m.blocks AS blocks, m.timestamp AS ts
         FROM messages m
         JOIN (SELECT session_key, MAX(rowid) AS r FROM messages GROUP BY session_key) u
           ON u.r = m.rowid
        WHERE m.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')`,
    ).all() as Array<{ sk: string; id: string; ruolo: string; blocks: unknown; ts: string }>;
    const ora = Date.now();
    for (const r of righe) {
      let blocks: ContentBlock[] | null = null;
      try { blocks = JSON.parse(decodeCol(r.blocks) ?? "null") as ContentBlock[] | null; } catch { continue; }
      if (!chatDaRiprendere({ sessionKey: r.sk, ruolo: r.ruolo, blocks, timestampMs: Date.parse(r.ts) }, ora)) continue;
      const topic = ctx.getTopicBySessionKey(r.sk);
      if (!topic || topic.archived) continue;
      // Il messaggio da rimandare è l'ultimo dell'utente: è ciò che farebbe il
      // bottone «Riprova» (`handleRetry`, ChatPane), e la stessa cosa fatta
      // senza aspettare che qualcuno se ne accorga.
      const dom = ctx.db.query(
        `SELECT content FROM messages WHERE session_key = ? AND role = 'user'
          ORDER BY rowid DESC LIMIT 1`,
      ).get(r.sk) as { content: unknown } | undefined;
      const messaggio = (decodeCol(dom?.content) ?? "").trim();
      if (!messaggio) continue;
      candidati.push({ sessionKey: r.sk, messaggio, idTurno: r.id, blocks: blocks! });
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
    try {
      const conTraccia: ContentBlock[] = [...c.blocks, { kind: "ripreso" }];
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
    console.log(`[ripresa] ${c.sessionKey}: rimando il messaggio alla route della chat`);
    try {
      const url = new URL("http://localhost/api/chat");
      const body = JSON.stringify({
        sessionKey: c.sessionKey,
        messages: [{ role: "user", content: c.messaggio }],
        ripresa: true,
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
