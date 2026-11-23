/**
 * Headless turns: how a dispatched card's chat turn is run, watched for a stall, reattached after a restart and woken.
 */
import { isSwapFreezeHold } from "../lib/swap-freeze-hold";
import type { WakeEvent } from "../../shared/types";
import { foregroundToolHold } from "../lib/stale-stream-sweep";
import { flushTurnBody } from "../lib/turn-body-flush";
import { getProvider, tryGetProvider } from "../providers";
import { stallBackgroundHold } from "../providers/background-probes";
import { pickTurnOwner, type TurnOwnerClaim } from "../lib/boot-native-turns";
import { cancelled, type TurnEndInfo } from "../providers/stop-reason";
import { takeTurnEnd, peekTurnEnd } from "../providers/turn-end-registry";
import { raceReadAgainstTurnEnd } from "../providers/race-read-turn-end";
import { awaitsForegroundChild } from "../lib/subagent-runtime";
import { isSseCommentOnly } from "../lib/sse-ping";
import { isHumanHold } from "../lib/human-hold";
import { armStallDetector } from "../lib/stall-detector";
import { judgeStall } from "../lib/stall-judge";
import { internalAbortRequest, type StopCause } from "../lib/abort-cause";
import type { AfterDispatchPrep } from "./scope";

export function bootHeadlessTurns(scope: AfterDispatchPrep) {
  const { activeStreams, ctx, getMessageById, isChecksHold, topicsRouter } = scope;
  /** Stops a turn from inside the server. The cause is required and is never
   *  `user` unless a person pressed something: see lib/abort-cause.ts (card C9). */
  async function abortHeadlessTurn(sessionKey: string, cause: StopCause): Promise<void> {
    const req = internalAbortRequest(sessionKey, cause);
    try {
      await topicsRouter(req, new URL(req.url), "/api/chat/abort", "POST");
    } catch { /* best-effort */ }
  }


  /**
   * Una risposta di ERRORE della route ha comunque un corpo — JSON, non SSE. Il
   * controllo `!resp.body` non la vede, quindi il drain qui sotto la mangiava
   * tutta senza incontrare `[DONE]`, e il `takeTurnEnd(…) ?? { end: "end_turn" }`
   * finale la dichiarava una fine normale: un turno mai partito, riportato al
   * dispatcher come consegnato.
   *
   * Non è teorico. `runHeadlessReattach` manda `messages: []` e la route lo
   * respingeva con 400 «messages array required» (verificato: `curl` su
   * :3333 → HTTP 400): l'adozione dei turni sopravvissuti a un riavvio non è mai
   * partita, e a nessuno risultava perché tornava `end_turn`. Da oggi c'è anche
   * il 409 «turno già in volo», che qui vuol dire la stessa cosa: non abbiamo
   * guidato niente.
   */
  function rejectedTurn(resp: Response, what: string): TurnEndInfo | null {
    if (resp.ok) return null;
    // Il 409 NON è un guasto: la sessione sta già rispondendo, e i tre consumatori
    // dello stesso status devono dire la stessa cosa (il client riaccoda, l'MCP
    // risponde «riprova quando ha finito»). Appiattirlo su `provider-error`
    // bruciava un tentativo al dispatcher e finiva in park FAILED — un task
    // dichiarato fallito solo perché è arrivato mentre l'agente parlava.
    if (resp.status === 409) {
      return {
        end: "cancelled",
        cause: "turn-in-flight",
        detail: `POST ${what} → HTTP 409 (stream già in volo)`,
      };
    }
    // Il corpo si consuma senza rimorsi: da qui si torna indietro comunque.
    return {
      end: "error",
      cause: "provider-error",
      detail: `POST ${what} → HTTP ${resp.status}`,
    };
  }


  // Fallback when a caller doesn't pass `idleMs` (e.g. the boot sweep's
  // mid-turn reattach, which isn't a board task and has no `dispatchIdleMin`
  // setting to read) — matches `BoardSettings.dispatchIdleMin`'s own default.
  const DEFAULT_STALL_IDLE_MS = 5 * 60_000;

  /** After the route has deposited the end, how long a silent SSE body is still trusted to close on its own. */
  const HEADLESS_END_GRACE_MS = 20_000;


  /**
   * The transcript TAIL the stall judge reads: the last few local messages,
   * newest last, capped so the judge call stays cheap. `null` when there is
   * nothing to read — the caller treats that as "alive" (never recycle blind).
   */
  function stallTranscriptTail(sessionKey: string): string | null {
    try {
      const msgs = ctx.loadLocalMessages(sessionKey, { withBlocks: false });
      if (msgs.length === 0) return null;
      const tail = msgs.slice(-6).map((m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
        return `${m.role}: ${text.length > 1500 ? text.slice(-1500) : text}`;
      });
      return tail.join("\n---\n").slice(-6000) || null;
    } catch { return null; }
  }


  /** One cheap haiku call, in the shape `judgeStall` expects. */
  async function stallJudgeComplete(prompt: string): Promise<string> {
    const provider = getProvider("claude-code");
    const res = await provider.complete([{ role: "user", content: prompt }], { model: "claude-haiku-4-5", purpose: "stall-judge" });
    return res.content ?? "";
  }


  /**
   * ONE WATCHER FOR BOTH HEADLESS ENTRIES (fresh turn and reattach): the stall
   * judge, the drain, the end-deposit race. It used to live twice, and the two
   * copies drifted by a word each; `tag` is the only thing that differed.
   *
   * The turn self-drives server-side (consumeGateway) whether or not we read the
   * SSE mirror; we drain it only to learn when the turn ENDS (the reconciliation
   * signal). No wall-clock kill: a PASSIVE stall detector watches for silence
   * past `idleMs` and asks a cheap judge before ever touching the turn.
   *
   * EVERY CHUNK THAT ARRIVES IS A SIGN OF LIFE, and the cap has to know it. This
   * drain existed only to learn WHEN the turn ends; it also says THAT it is still
   * going, and nobody was looking. Without it the cap was a wall clock and it cut
   * healthy turns: 60 times, the last on 2026-08-21 at 00:37.
   *
   * THE END IS THE DEPOSIT, NOT THE CLOSE OF THE BODY. On 2026-09-04 (c8039b35)
   * the route finalized the turn - row written, end deposited, `[Media]` line
   * out - and this reader kept waiting on a body that never closed: the run
   * stayed "in flight", the card's continuation parked behind it, and
   * `restart-when-idle` waited an hour for a turn that did not exist. Once the
   * end is deposited and the body has been silent for the grace, the turn is
   * over for us too.
   */
  async function watchHeadlessBody(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    sessionKey: string,
    opts: { timeoutMs: number; idleMs?: number },
    tag: "" | " (reattach)",
  ): Promise<TurnEndInfo> {
    let stalled = false;
    let lastRearm: string | null = null;
    const t0 = Date.now();
    const detector = armStallDetector({
      idleMs: opts.idleMs ?? DEFAULT_STALL_IDLE_MS,
      isWaitingForHuman: () => isHumanHold(sessionKey),
      isWaitingForChecks: () => isChecksHold(sessionKey),
      // A command of this session is STOPped by us: that silence is ours.
      isFrozen: () => isSwapFreezeHold(sessionKey),
      // Its CLI still reports on an agent, a Bash or a Monitor: that wait is the
      // model's own. The same bound as every other clock that kills the child:
      // the judge's recycle is a SIGINT, and it takes the work with it.
      isWaitingForBackground: stallBackgroundHold(sessionKey),
      // A foreground spawn_agent waiting for its child: our own wait as well.
      isWaitingForSubagent: () => awaitsForegroundChild(sessionKey),
      // A foreground command (cargo test, a mutation run) is still executing: the
      // transcript tail is silent for all of it and the judge would misread it.
      isToolRunning: () => {
        const stream = activeStreams.get(sessionKey);
        // The row is written on a throttle: flush so the running tool's line is on it.
        if (stream) flushTurnBody(sessionKey);
        return !!stream && foregroundToolHold(getMessageById(stream.messageId), Date.now());
      },
      getTail: () => stallTranscriptTail(sessionKey),
      judge: (tail) => judgeStall({ complete: stallJudgeComplete }, tail),
      // Once per change of reason: a hold lasting an hour rearmed every five
      // minutes and wrote the same line twelve times.
      onRearm: (reason) => {
        if (reason === lastRearm) return;
        lastRearm = reason;
        console.log(
          reason === "human"
            ? `[turn] stall watch rearmed on ${sessionKey}: a person is in the loop (question or permission), their time doesn't count`
            : reason === "freeze"
              ? `[turn] stall watch rearmed on ${sessionKey}: one of its commands is frozen by the swap brake, that wait is ours`
            : reason === "background"
              ? `[turn] stall watch rearmed on ${sessionKey}: its background work is still running, the judge is not asked`
            : reason === "subagent"
              ? `[turn] stall watch rearmed on ${sessionKey}: it waits in the foreground for a sub-agent, that wait is ours`
            : reason === "tool"
              ? `[turn] stall watch rearmed on ${sessionKey}: a tool call is still running, the judge is not asked`
            : reason === "checks"
              ? `[turn] stall watch rearmed on ${sessionKey}: our pre-review checks are running for its card, that wait is ours`
              : `[turn] stall watch rearmed on ${sessionKey}: judge says alive, still watching`,
        );
      },
      onStuck: () => {
        stalled = true;
        console.warn(`[turn] stall detector recycling ${sessionKey}${tag}: judge found it stuck`);
        abortHeadlessTurn(sessionKey, "stall").catch(() => {});
        reader.cancel().catch(() => {});
      },
    });
    try {
      while (true) {
        const { done, value } = await raceReadAgainstTurnEnd(
          () => reader.read(),
          () => peekTurnEnd(sessionKey),
          HEADLESS_END_GRACE_MS,
        );
        if (done) {
          if (peekTurnEnd(sessionKey)) reader.cancel().catch(() => {});
          break;
        }
        // A ping is no sign of life. It means the route has not finalized, so it rightly holds
        // off the end grace: an end deposited meanwhile is a superseded turn's, or not final yet.
        if (isSseCommentOnly(value)) continue;
        detector.noteActivity();
        // A new stretch of silence logs its first rearm again.
        lastRearm = null;
      }
    }
    finally {
      detector.clear();
      try { reader.releaseLock(); } catch { /* already released */ }
      // `dispatchTimeoutMin` DECLASSED TO REPORTING ONLY: no cut, just a log.
      if (opts.timeoutMs && Date.now() - t0 > opts.timeoutMs) {
        console.warn(`[turn] ${sessionKey}${tag}: over dispatchTimeoutMin (${Math.round(opts.timeoutMs / 60_000)}min) - reporting only, no cut (${Math.round((Date.now() - t0) / 60_000)}min elapsed)`);
      }
    }
    // The stall verdict is OURS: it outranks whatever end the route deposited in
    // the meantime (the abort we sent lands after it).
    if (stalled) {
      takeTurnEnd(sessionKey);
      return cancelled("stall", `idle stall detector${tag}: judge found the session stuck (idle ${opts.idleMs ?? DEFAULT_STALL_IDLE_MS}ms)`);
    }
    // The route deposited the WHY while finalizing; the drain ends on `[DONE]`,
    // which finalization writes afterwards. If it is missing, the turn is over anyway.
    return takeTurnEnd(sessionKey) ?? { end: "end_turn" };
  }


  async function runHeadlessTurn(
    sessionKey: string,
    content: string,
    opts: { timeoutMs: number; idleMs?: number; contextMode?: "full" | "lean"; dispatchedFor?: string[] },
  ): Promise<TurnEndInfo> {
    const url = new URL("http://localhost/api/chat");
    // Butta via un eventuale residuo: una fine depositata e mai ritirata è di un
    // turno vecchio, e attribuirla a questo sarebbe la bugia che 0.4 elimina.
    takeTurnEnd(sessionKey);
    // contextMode "lean" (resume/continuation): the chat route skips re-injecting
    // the heavy context envelope (CLAUDE.md/README/memory/…) since the persistent
    // CLI session already has it — see assembleTopicContext(leanContext).
    // `dispatched`: è un turno d'AGENTE guidato dalla board, non una chat umana.
    // La route lo rimanda sul `stream:end` di completamento così la push di fine
    // risposta lo esclude (decine di turni d'agente = spam).
    // `dispatchedFor`: the ids of the card comments this envelope delivers, so
    // the row carries them and nobody has to read them back out of the text.
    const body = JSON.stringify({
      sessionKey, messages: [{ role: "user", content }],
      contextMode: opts.contextMode ?? "full", dispatched: true,
      ...(opts.dispatchedFor?.length ? { dispatchedFor: opts.dispatchedFor } : {}),
    });
    const resp = await topicsRouter(
      new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
      url, "/api/chat", "POST",
    );
    // Nessuno stream = la route non ha nemmeno iniziato il turno: è un guasto,
    // non una fine normale (dirla `end_turn` sarebbe la solita bugia).
    if (!resp || !resp.body) return { end: "error", cause: "provider-error", detail: "no stream from /api/chat" };
    const rejected = rejectedTurn(resp, "/api/chat");
    if (rejected) return rejected;
    return watchHeadlessBody(resp.body.getReader(), sessionKey, opts, "");
  }


  /**
   * Which provider still runs a turn for this session in the AI broker, if any.
   *
   * Two can: `claude-code` (the CLI, under the session key) and the native
   * runtime (its turn process, under `native:<session key>`). The native one
   * also claims a dead store whose row is still open, so when both claim, the
   * one whose process is alive wins (`pickTurnOwner`).
   */
  async function liveTurnOwner(sessionKey: string): Promise<"topics" | "claude-code" | null> {
    const claims: TurnOwnerClaim[] = [];
    for (const name of ["topics", "claude-code"] as const) {
      const p = tryGetProvider(name) as unknown as { hasLiveSession?: (sk: string) => Promise<boolean>; liveDetachedSessions?: () => Promise<Set<string>> } | undefined;
      try {
        if (typeof p?.hasLiveSession !== "function" || !(await p.hasLiveSession(sessionKey))) continue;
        // claude-code claims only a live child; the native runtime says which of its claims are alive.
        const alive = typeof p.liveDetachedSessions === "function" ? (await p.liveDetachedSessions()).has(sessionKey) : true;
        claims.push({ name, claims: true, alive });
      } catch { /* this provider cannot tell: ask the next */ }
    }
    return pickTurnOwner(claims);
  }


  // Reattach variant: POST /api/chat with mode:"reattach" and NO user message —
  // the route calls provider.reattach (adopt the surviving broker turn) instead of
  // sendChat. Same SSE drain to learn when the turn ends. Used by the dispatcher's
  // reconcile REATTACH branch after a server restart, and by the boot's adoption of
  // every surviving chat turn (`boot/reattach.ts`).
  //
  // `dispatched` only for the dispatcher's own card turns. It used to be sent on
  // every reattach, and the attention state reads it as «a card is the subject»
  // (rule 2 of `attention/compose.ts`, idle before any wait or open turn): after
  // every reload of the server, every 2-10 minutes here, each adopted chat turn
  // went idle, a question it then asked never lit amber, and its end never lit
  // «finished» (23/11: 10 of the 11 chats with a turn open had no attention row).
  // A card's topic stays the card's anyway: the route also asks `runningTaskOwnsTopic`.
  async function runHeadlessReattach(sessionKey: string, opts: { timeoutMs: number; idleMs?: number }, provider: string = "claude-code", { dispatched = false }: { dispatched?: boolean } = {}): Promise<TurnEndInfo> {
    const url = new URL("http://localhost/api/chat");
    // Il provider si DICHIARA, non si lascia indovinare alla rotta.
    //
    // `resolveProvider` risponde «con chi vorrebbe parlare questa topic», e senza
    // un `provider` nel corpo cade sul default della macchina. Ma un riattacco
    // non sceglie: adotta un turno che sta già girando, e qui il proprietario è
    // `claude-code` per COSTRUZIONE — entrambi i chiamanti lo sanno già.
    // `hasLiveSession` (poco sopra) interroga esplicitamente `claude-code`, e il
    // setaccio di boot `reattachSurvivingChatTurns` enumera lo store del broker
    // ai-bridge, che è del provider claude-code e di nessun altro.
    //
    // Senza questa riga, su una macchina il cui default è il runtime nativo
    // (`topics`, che non ha `reattach`), ogni riadozione finiva su `sendChat` con
    // un messaggio VUOTO: un turno fabbricato che rispondeva «Ciao! Come posso
    // aiutarti?» e si sedeva in chat al posto della risposta vera. Nove volte in
    // quindici minuti su topic:9fe7a291 il 2026-08-18, una per riavvio del
    // server. La rotta adesso rifiuta quel caso (501 `reattach_unsupported`),
    // ma la cura sta qui: chi conosce il proprietario lo scrive.
    const body = JSON.stringify({ sessionKey, messages: [], mode: "reattach", ...(dispatched ? { dispatched: true } : {}), provider });
    // Stesso patto di runHeadlessTurn: residuo via prima di iniziare.
    takeTurnEnd(sessionKey);
    const resp = await topicsRouter(
      new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
      url, "/api/chat", "POST",
    );
    // Nessuno stream = il turno adottato non c'era più: non è una fine normale.
    if (!resp || !resp.body) return { end: "error", cause: "provider-error", detail: "no stream from /api/chat (reattach)" };
    const rejected = rejectedTurn(resp, "/api/chat (reattach)");
    if (rejected) return rejected;
    return watchHeadlessBody(resp.body.getReader(), sessionKey, opts, " (reattach)");
  }


  /**
   * Il gemello di `runHeadlessReattach` per il turno che la CLI apre DA SOLA
   * (`Monitor` che consegna). Stessa route, stesso drenaggio SSE, stessa lettura
   * della fine: cambia solo il `mode`, perché cambia solo COME ci si attacca —
   * il provider ha già gli eventi in mano, non c'è nessuno store da rileggere.
   *
   * Nessun tetto a orologio come negli altri due: quel tetto è la promessa fatta
   * al DISPATCHER, che aspetta un verdetto per una card. Qui non aspetta nessuno —
   * è una risposta che arriva in chat mentre l'utente fa altro — e imporre una
   * scadenza vorrebbe dire troncare la risposta di un Monitor che si è messo a
   * lavorare sul serio. Il turno finisce quando finisce; le reti che lo chiudono
   * comunque (watchdog d'inattività del provider, sweeper StaleStream) sono le
   * stesse di ogni altro turno di chat.
   */
  async function runHeadlessWoken(sessionKey: string, source: WakeEvent[] = []): Promise<TurnEndInfo> {
    const url = new URL("http://localhost/api/chat");
    // Il provider si DICHIARA, per la stessa ragione del riattacco: senza, si
    // cade sul default della macchina e la sveglia di claude-code finirebbe a
    // bussare a un provider che non possiede quel figlio.
    // `wokenSource`: what woke the CLI, a Monitor's event or a task's report
    // (`claude/wake-source.ts`). It travels to the chat row, which without it
    // shows an answer with no provenance.
    const body = JSON.stringify({ sessionKey, messages: [], mode: "woken", provider: "claude-code", ...(source.length > 0 ? { wokenSource: source } : {}) });
    // Stesso patto degli altri due: residuo via prima di iniziare.
    takeTurnEnd(sessionKey);
    const resp = await topicsRouter(
      new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }),
      url, "/api/chat", "POST",
    );
    if (!resp || !resp.body) return { end: "error", cause: "provider-error", detail: "no stream from /api/chat (woken)" };
    const rejected = rejectedTurn(resp, "/api/chat (woken)");
    if (rejected) return rejected;
    const reader = resp.body.getReader();
    try { while (true) { const { done } = await reader.read(); if (done) break; } }
    finally { try { reader.releaseLock(); } catch { /* already released */ } }
    return takeTurnEnd(sessionKey) ?? { end: "end_turn" };
  }

  return { abortHeadlessTurn, liveTurnOwner, runHeadlessReattach, runHeadlessTurn, runHeadlessWoken };
}
