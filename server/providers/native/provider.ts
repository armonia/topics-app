/**
 * The native provider: Topics talking to the model with nothing in between.
 *
 * WHAT CHANGES AGAINST THE OTHERS. `claude-code`, `codex` and the ACP agents are
 * all the same shape — an external process to spawn, a protocol to speak to it,
 * a state to keep aligned. `claude-code.ts` is 3640 lines almost entirely about
 * that trade: process pools, reattaches, broker, heartbeat, store scanning. None
 * of that exists here, because there is no process: a session is an array of
 * messages, and the turn is an HTTP call we drive ourselves.
 *
 * IT DECLARES `history`, and that is the difference that counts in the registry.
 * The CLI providers keep the conversation on their own and ignore
 * `options.history`; this one is STATELESS to the outside just like `claude` and
 * `openai` — every turn resends the history. It keeps it in memory per session,
 * so chats continue without re-reading the DB every round, but if that memory is
 * lost (a restart) the history still arrives from the caller.
 *
 * WHAT IT DOES NOT DO, said here instead of left to be discovered. It does not
 * survive a server restart: an in-flight turn dies with the process hosting it,
 * while `claude-code` in broker mode finds it again. That is the price of being
 * in-process, and it is paid knowingly — reattaching is worth it only when a
 * turn costs a whole process, and here it costs an array.
 */

import { runAgentTurn, toProviderUsage, type AgentMessage } from "./agent-loop";
import { recordTurnUsage } from "../native-usage-registry";
import { CODING_TOOLS, WORKSPACE_FREE_TOOLS } from "./tools";
import { pruneDanglingToolUses } from "./history-repair";
import { rehydrateHistory } from "./history-rehydrate";
import { DEFAULT_CHARS_PER_TOKEN } from "./compaction";
import type { Calibration } from "./context-window";
import { levelFor } from "./permissions";
import { topicsToolSpecs, type TopicsToolContext } from "./topics-tools";
import { ensureMcpFleet, mcpToolSpecs, closeMcpFleet } from "./mcp-fleet";
import { hasCredentials, getAccessToken, readCredentials } from "./auth";
import { getTopicWorkspaceForSession, topicsAppBaseUrl } from "../claude-code";
import type {
  AbortReason,
  AIProvider,
  ChatMessage,
  CompletionResult,
  ProviderCapability,
  ProviderContextStrategy,
  ProviderDiagnostic,
  StreamHandler,
} from "../types";
import { recordTurnEnd } from "../turn-end-registry";
import { resolveClaudeEffort } from "../../lib/topics-agent-prompt";
import { resolveClaudeModel, resolveClaudeMaxTokens } from "../../services/app-settings";
import {
  isEligibleGlobalOrchestratorSession,
  isGlobalOrchestratorSession,
} from "../../services/global-orchestrator-session";
import { clampMaxTokens } from "../../lib/native-parity";
import { cancelled, stopCauseFromSignal, type StopCause, type TurnEndInfo } from "../stop-reason";

/**
 * The model we start from when nobody asks for one.
 *
 * Same tier as before (sonnet, not opus: this is the default, not the choice),
 * but of the current generation. It was stuck at `claude-sonnet-4-6`, and since
 * the guard in `routes/chat.ts` dropped every override to the 5 family, this
 * value was not the default: it was EVERYONE's model.
 */
export const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * DA QUANTO FERMA UNA SESSIONE PUÒ ESSERE SFRATTATA DALLA MEMORIA.
 *
 * `sessions` non veniva svuotata mai: solo `resetSession` e `stop()` toglievano
 * qualcosa, quindi OGNI topic che aveva avuto un turno teneva la sua
 * conversazione intera nel processo finché il server non ripartiva. Con 127
 * topic nati in un giorno sul runtime nativo è crescita senza fondo.
 *
 * LA PROVA È IL CODICE, NON UNA LETTURA DI RSS — e vale la pena dirlo perché la
 * prima stesura di questo commento affermava il contrario. Su una finestra di 40
 * secondi il server sembrava tenere 2.220 MB senza scendere quando un agente
 * finiva; su una finestra di dieci minuti lo stesso processo oscilla fra 284 MB
 * e 2 GB seguendo il carico, e quel 2.220 era un picco, non un trattenimento.
 * Due campioni non sono una tendenza. Ciò che regge è la lettura del codice:
 * non esisteva NESSUNA strada che togliesse una sessione ferma, quindi la
 * crescita è senza fondo per costruzione, che il picco di ieri fosse quello o un
 * altro.
 *
 * Sfrattare è sicuro PER COSTRUZIONE, e non è un compromesso:
 *
 *  · `sessionFor` ricostruisce la storia dal DB (`rehydrateHistory`) quando la
 *    sessione non c'è. È la stessa strada che si percorre a ogni riavvio del
 *    server, cioè decine di volte al giorno su questa macchina.
 *  · il modello arriva con OGNI turno (`routes/chat.ts` mette `sendOptions.model`
 *    dall'override della topic), quindi non si perde.
 *  · la radice si ri-deriva da `getTopicWorkspaceForSession`.
 *  · `ownsSession` dirà «non è mia», e `resolveTurnAlive` risponde `null` invece
 *    di `false`: «non lo so» al posto di «è morto», che è la risposta più
 *    prudente delle due (vedi il commento di `resolveTurnAlive`).
 *
 * Una sessione con un TURNO VIVO non si sfratta mai: la guardia è l'`abort`,
 * che esiste per la durata del turno e sparisce alla fine.
 */
const SESSION_TTL_MS = Math.max(1, Number(process.env.TOPICS_NATIVE_SESSION_TTL_MIN) || 15) * 60_000;
/** Ogni quanto si passa a guardare. Non serve precisione: serve che accada. */
const SESSION_SWEEP_MS = 60_000;

/**
 * Questa sessione si può togliere dalla memoria?
 *
 * Pura e esportata apposta: la regola dello sfratto è la cosa che deve essere
 * MISURATA, non il timer che la chiama. Due condizioni, ed entrambe contano —
 * un turno vivo non si tocca mai, e «ferma» vuol dire ferma da più del tetto.
 */
export function sessionIsEvictable(
  s: { abort?: unknown; lastUsedAt: number },
  now: number,
  ttlMs: number = SESSION_TTL_MS,
): boolean {
  if (s.abort) return false;
  return now - s.lastUsedAt > ttlMs;
}



/**
 * Cosa si dice all'agente quando la topic non ha un progetto.
 *
 * Serve perché senza tool il modello non sa PERCHÉ non li ha: proverebbe a
 * descrivere comandi da eseguire a mano, o peggio affermerebbe di aver fatto
 * cose. Dirglielo lo rende utile lo stesso — risponde, spiega, ma non finge.
 */
const NO_WORKSPACE_NOTE =
  "Questa conversazione non ha un progetto collegato, quindi non hai strumenti per leggere o " +
  "modificare file. Puoi comunque leggere una pagina web e tenere la lista di cose da fare. " +
  "Per il resto rispondi a voce; se serve lavorare su un progetto, di' all'utente di " +
  "collegarne uno alla conversazione.";

/**
 * I modelli che questo runtime sa usare.
 *
 * Lista dichiarata e non scoperta: l'API non espone un catalogo sull'endpoint
 * OAuth, e inventarne uno interrogando `/v1/models` con credenziali da
 * abbonamento darebbe una lista che non corrisponde a ciò che l'abbonamento
 * copre. Meglio pochi nomi veri che un elenco lungo e sbagliato.
 *
 * ── Perché la famiglia 5 è arrivata in ritardo, e cosa è costata ──────────
 * Questa lista non è cosmetica: `routes/chat.ts` la usa come GUARDIA. Un
 * modello richiesto che non compare qui viene scartato con
 * `Dropping stale model override`, e la sessione cade su {@link DEFAULT_MODEL}.
 *
 * Finché la lista si è fermata alla generazione 4-6, ogni card della board che
 * chiedeva `claude-opus-5[1m]` — cioè tutte — è girata in silenzio su
 * `claude-sonnet-4-6`. Il picker diceva Opus 5, la barra sotto al composer
 * diceva Opus 5, e il turno era Sonnet. Il 18/08 quella riga di scarto compare
 * a raffica nel log, e `agent-loop.ts` sapeva già eseguire il suffisso `[1m]`
 * (vedi `long-window.ts`, atterrato il 17/08): mancava solo il permesso.
 *
 * Gli id qui sotto sono PROVATI, non dedotti: una richiesta da 1 token per id
 * sull'endpoint OAuth con gli stessi header del loop, tutti 200 (19/08/2026).
 * Se un domani se ne aggiunge uno, si prova allo stesso modo prima di scriverlo.
 */
const MODELS = [
  "claude-opus-5[1m]",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

interface NativeSession {
  history: AgentMessage[];
  /** `null` = questa topic non ha un progetto: niente tool di file. */
  workspace: string | null;
  /**
   * Il turno in volo. La RAGIONE di un eventuale annullamento non sta qui
   * accanto: viaggia dentro il segnale (`abort(reason)` → `signal.reason`),
   * che è il posto che la piattaforma prevede. Un campo parallelo sarebbe una
   * seconda verità da tenere allineata a mano, cioè un posto in cui le due
   * possono divergere — ed è da una divergenza così che nasce tutto questo.
   */
  abort?: AbortController;
  /**
   * The promise of the turn that owns `abort`, so a second `sendChat` on this
   * session can WAIT for it instead of racing it. `abort` and `turn` are set
   * together and cleared together, by the turn that set them and only by it:
   * see `driveTurn`'s `finally`.
   */
  turn?: Promise<{ runId?: string }>;
  model?: string;
  /** Quando questa sessione è stata toccata l'ultima volta. Serve allo sfratto. */
  lastUsedAt: number;
  /** Measured chars-per-token. On the SESSION and not on the turn: the turn
   * that dies of a full context dies on its FIRST round, measuring nothing. */
  calibration: Calibration;
}

export interface NativeProviderConfig {
  type: "native";
  /** Radice usata quando una sessione non ha un progetto suo. */
  defaultWorkspace?: string;
  model?: string;
}

export class NativeProvider implements AIProvider {
  readonly name = "topics";
  readonly capabilities = new Set<ProviderCapability>([
    "streaming",
    "tools",
    "thinking",
    "sessions",
    "abort",
    // Announcing a tool and running it are two distinct moments here, and the
    // loop says so (`onToolExecStart`): the call is executed only after the
    // round has closed, so between the two there is a window in which nothing
    // is running. See `toolsSuspendSoftTimer`.
    "tool-phases",
    // Stateless verso l'esterno: vedi l'intestazione.
    "history",
  ]);
  /**
   * La storia la teniamo NOI, quindi i blocchi di sistema vanno inlinati nel
   * turno come per le CLI: `inline-system` è la strategia giusta.
   */
  readonly contextStrategy: ProviderContextStrategy = "inline-system";

  private readonly config: NativeProviderConfig;
  private sessions = new Map<string, NativeSession>();
  private stopped = false;

  constructor(config: NativeProviderConfig) {
    this.config = config;
  }

  /**
   * «Possiamo servire una chat?» — cioè: c'è una credenziale su questa
   * macchina. Non si verifica che sia VALIDA: richiederebbe una chiamata di
   * rete a ogni domanda (il registro la fa spesso), e un token scaduto si
   * rinnova da solo al primo turno. Un file assente invece è definitivo.
   */
  get connected(): boolean {
    return !this.stopped && hasCredentials();
  }

  /** Il passaggio periodico dello sfratto. `unref` così non tiene su il processo. */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.stopped = false;
    // THE FLEET WARMS UP AT BOOT, not on the first message. Mounting is awaited
    // before a turn builds its tool list, and a server that takes ten seconds to
    // answer the handshake would spend those ten seconds inside somebody's first
    // question. Started here it is almost always ready by then, and nothing waits
    // on it: a mount that fails leaves an empty fleet, not a broken start.
    void ensureMcpFleet();
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try { this.sweepIdleSessions(); } catch { /* meglio non sfrattare che rompere un turno */ }
    }, SESSION_SWEEP_MS);
    // Un timer che tiene vivo il processo trasformerebbe uno spegnimento pulito
    // in un'attesa di un minuto.
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    for (const s of this.sessions.values()) {
      // LA RAGIONE VIAGGIA DENTRO IL SEGNALE, anche qui.
      //
      // Un turno nativo vive DENTRO questo processo: quando il server si
      // spegne non resta nessun figlio nel broker da riadottare, quindi
      // questo `abort()` è la fine definitiva di quel turno, non una pausa.
      // Senza la causa, `sendChat` scriveva `cancelled/user` e a valle tutto
      // — registro della fine, `activity_log`, il cartello in chat — dava la
      // colpa a un utente che non aveva toccato niente. Misurato il 20/08 su
      // topic:9f9e9629: risposta troncata a metà frase, zero spiegazioni.
      try { s.abort?.abort("server-shutdown" satisfies StopCause); } catch { /* già finito */ }
    }
    this.sessions.clear();
    // The stdio MCP servers are OUR child processes: leaving them behind on
    // shutdown is how a machine collects orphans nobody can trace back.
    closeMcpFleet();
  }

  /**
   * Il contesto per i mestieri di Topics, o `null` se questa sessione non ne
   * ha diritto.
   *
   * Il PROFILO segue la stessa regola delle CLI (`writeMcpConfigForSession`):
   * un agente dispacciato con `mcp_policy = 'bridge-only'` prende il set
   * ridotto, perche' gli schemi dei tool viaggiano nel contesto di OGNI
   * chiamata e per un agente che lavora un task solo sono una tassa in token.
   * Regola duplicata? No: la stessa domanda, la stessa risposta, presa dalla
   * stessa colonna. Riscriverla diversamente sarebbe il modo di farle divergere.
   */
  /**
   * L'effort scelto su QUESTA topic, o null. Stessa colonna che legge il
   * terminale (`routes/terminal.ts`), presa dalla session_key invece che
   * dall'id: qui l'id della topic non passa mai.
   */
  private topicEffort(sessionKey: string): string | null {
    try {
      const { getDatabase } = require("../../db");
      const row = getDatabase()
        .prepare("SELECT effort FROM topics WHERE session_key = ? LIMIT 1")
        .get(sessionKey) as { effort?: string | null } | undefined;
      return row?.effort ?? null;
    } catch {
      return null;
    }
  }

  private topicsContext(sessionKey: string): TopicsToolContext | null {
    try {
      const { getDatabase } = require("../../db");
      const db = getDatabase();
      const row = db
        .prepare("SELECT mcp_policy FROM topics WHERE session_key = ? LIMIT 1")
        .get(sessionKey) as { mcp_policy?: string | null } | undefined;
      // Nessuna riga = nessuna topic: e' il caso di `complete` e dei test, dove
      // i mestieri di Topics non c'entrano niente.
      if (!row) return null;
      const rawGlobalOrchestrator = isGlobalOrchestratorSession(db, sessionKey);
      const eligibleGlobalOrchestrator = rawGlobalOrchestrator
        && isEligibleGlobalOrchestratorSession(db, sessionKey);
      // A mapped-but-corrupt coordinator is never an ordinary dispatch chat.
      // The HTTP front door rejects it too, but this closes direct provider
      // entry points before a mutable mcp_policy can grant local board tools.
      if (rawGlobalOrchestrator && !eligibleGlobalOrchestrator) return null;
      return {
        baseUrl: topicsAppBaseUrl(),
        sessionKey,
        gatewayToken: process.env.GATEWAY_TOKEN,
        // The mapping, not mcp_policy, owns the global coordinator role.
        // mcp_policy remains an ordinary session's fleet-scoping preference.
        profile: eligibleGlobalOrchestrator
          ? "global-orchestrator"
          : row.mcp_policy === "bridge-only" ? "dispatch" : undefined,
      };
    } catch {
      // Senza database si resta un agente che sa programmare e basta: meglio
      // meno strumenti che un turno che non parte.
      return null;
    }
  }

  /**
   * The provider boundary repeats the raw-registry fence from HTTP routes.
   * The coordinator is Codex-only, so neither a healthy nor a damaged
   * registry-mapped Topic may become a native run by bypassing `/api/chat`.
   */
  private hasGlobalCoordinatorRole(sessionKey: string): boolean {
    try {
      const { getDatabase } = require("../../db");
      const db = getDatabase();
      return isGlobalOrchestratorSession(db, sessionKey);
    } catch {
      // No DB means no durable role can be established; retain the normal
      // provider behavior for standalone completions and unit tests.
      return false;
    }
  }

  /** Vedi `resolveTurnAlive`: si parla solo per le proprie sessioni. */
  ownsSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /**
   * Un turno in volo su questa sessione?
   *
   * Qui «vivo» non è un processo ma una richiesta HTTP aperta: l'AbortController
   * esiste per la durata del turno e sparisce alla fine. È la risposta onesta
   * alla domanda che il dispatcher fa davvero — «sta ancora lavorando?».
   */
  isTurnProcessAlive(sessionKey: string): boolean {
    return Boolean(this.sessions.get(sessionKey)?.abort);
  }

  /**
   * Toglie dalla memoria le sessioni ferme da più di {@link SESSION_TTL_MS}.
   * Mai quelle con un turno in volo. Vedi il commento della costante per il
   * perché è sicuro.
   */
  private sweepIdleSessions(): number {
    const ora = Date.now();
    let tolte = 0;
    for (const [k, s] of this.sessions) {
      if (!sessionIsEvictable(s, ora)) continue;
      this.sessions.delete(k);
      tolte++;
    }
    return tolte;
  }

  private sessionFor(sessionKey: string): NativeSession {
    const existing = this.sessions.get(sessionKey);
    if (existing) { existing.lastUsedAt = Date.now(); return existing; }
    // La radice: il progetto della topic, poi quella dichiarata a config.
    //
    // `process.cwd()` NON è nella catena, ed è una scelta pagata: era il
    // ripiego ovvio, e il ripiego ovvio è la directory da cui è partito il
    // server — cioè il codice di Topics stesso. Un agente aperto su una topic
    // senza progetto si ritrovava a lavorare NEL REPO DELL'APPLICAZIONE
    // credendo di essere altrove: ha cercato il file che gli avevo chiesto con
    // un `find /` (osservato il 2026-08-16), e la volta che lo trova lo
    // modifica pure. Meglio un turno che fallisce con un motivo leggibile.
    const workspace =
      getTopicWorkspaceForSession(sessionKey)
      || this.config.defaultWorkspace
      || null;
    // UNA SESSIONE FRESCA NON È UNA CONVERSAZIONE NUOVA.
    //
    // Questa Map muore col processo, e su una macchina con
    // `TOPICS_SERVER_WATCH=1` il processo si riavvia a ogni salvataggio in
    // `server/`. Partire da `history: []` significava che, dopo un riavvio, la
    // stessa chat ricominciava da zero senza dirlo a nessuno: il 2026-08-18 su
    // topic:9fe7a291 l'utente ha chiesto «fammi un report di fine giornata» in
    // una conversazione che conteneva un'analisi da 2.396 caratteri e si è
    // sentito rispondere «Non ho trovato messaggi nel topic "New Chat"». Non era
    // un modello che sbaglia: era un modello a cui non era stato dato niente.
    //
    // La rotta non ce la manda, la storia, e ha ragione lei: `contextStrategy`
    // qui è `inline-system`, cioè «me la ricordo io». Quella promessa vale
    // finché il processo vive; oltre, l'unico posto dove la conversazione è
    // sopravvissuta è il DB. Si va a prenderla lì — una volta sola, quando la
    // sessione nasce, non a ogni turno.
    const fresh: NativeSession = {
      history: rehydrateHistory(sessionKey),
      workspace,
      lastUsedAt: Date.now(),
      calibration: { charsPerToken: DEFAULT_CHARS_PER_TOKEN },
    };
    this.sessions.set(sessionKey, fresh);
    return fresh;
  }

  async sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: { model?: string; history?: ChatMessage[]; systemPrompt?: string },
  ): Promise<{ runId?: string }> {
    if (this.hasGlobalCoordinatorRole(sessionKey)) {
      handler.onError("the global coordinator is Codex-only; reopen it from the Kanban");
      return {};
    }
    const session = this.sessionFor(sessionKey);
    await this.supersedeLiveTurn(sessionKey, session);

    // La storia del CHIAMANTE vince su quella in memoria: è lui che sa cosa è
    // successo davvero (riavvii, rami, modifiche). La nostra è una comodità,
    // non la verità.
    if (options?.history && options.history.length > 0) {
      session.history = options.history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
      }));
    }
    // Se in coda c'è già un `user`, il messaggio nuovo ci si FONDE invece di
    // accodarsi. Succede solo in un caso, ed è quello che conta: la storia
    // ricostruita dal DB può finire con una domanda rimasta senza risposta
    // (turno morto a metà, riavvio), e `historyFromPersistedThread` la lascia lì
    // apposta — buttarla via sarebbe perdere proprio ciò che l'utente non ha mai
    // ottenuto. In esercizio normale l'ultimo turno è sempre dell'assistente,
    // quindi questo ramo non scatta. Fondere tiene anche l'alternanza dei ruoli.
    // A rehydrated history can also end with the RESULTS of the last tool
    // calls (the turn died before the model wrote its closing sentence): the
    // new message joins them as a text block, after the results, which is the
    // order the API wants inside a user message.
    const tail = session.history[session.history.length - 1];
    if (tail && tail.role === "user" && typeof tail.content === "string") {
      tail.content = `${tail.content}\n\n${message}`;
    } else if (tail && tail.role === "user" && Array.isArray(tail.content)) {
      tail.content = [...tail.content, { type: "text", text: message }];
    } else {
      session.history.push({ role: "user", content: message });
    }
    // ── LA STORIA SI RIPARA PRIMA DI PARTIRE, NON SI SPERA CHE SIA SANA ──────
    //
    // Un turno morto a meta' (processo riavviato, rete caduta, stop) lascia in
    // memoria un `assistant` che chiede dei tool e nessuno che risponde. Quella
    // storia veniva rimandata IDENTICA al turno dopo, e l'API la rifiuta
    // sempre: «`tool_use` ids were found without `tool_result` blocks
    // immediately after». Nessun ritentativo la sblocca, quindi il dispatcher
    // bruciava i suoi due tentativi contro lo stesso muro e consegnava
    // all'umano una card senza niente sotto.
    //
    // Misurato il 17/08 sul db vivo: 20 turni cosi', 2 sessioni, dalle 16:57
    // alle 20:15. Una e' `5cf58e29`, arrivata in review vuota.
    //
    // Qui e non in `agent-loop`: il loop e' gia' corretto quando arriva in
    // fondo: e' la SOPRAVVIVENZA della storia fra un turno e l'altro il punto
    // in cui si rompe, e questo e' l'unico posto che entrambe le sorgenti (la
    // memoria e la storia del chiamante) attraversano. Vedi `history-repair.ts`
    // per perche' si pota invece di inventare risultati finti.
    session.history = pruneDanglingToolUses(session.history);

    // THE CLAIM IS SYNCHRONOUS WITH THE CHECK. `supersedeLiveTurn` returned
    // with `session.abort` empty, and nothing has yielded since: a third
    // caller queued behind the same old turn cannot slip in between and claim
    // the session too. It resumes after this, finds OUR controller, and
    // supersedes us in its turn.
    const abort = new AbortController();
    session.abort = abort;
    if (options?.model) session.model = options.model;
    const turn = this.driveTurn(sessionKey, session, handler, options, abort);
    session.turn = turn;
    return turn;
  }

  /**
   * ONE TURN PER SESSION, in the runtime and not only at the front door.
   *
   * The CLI serializes turns per session by construction: one child process,
   * one stdin. Here `sendChat` had no guard at all: a second call on a session
   * whose turn was still running overwrote `session.abort` with its own
   * controller, both loops pushed into the SAME `history`, and the first
   * turn's `finally` then cleared the second turn's handle, so
   * `isTurnProcessAlive` answered "dead" for a turn that was alive and the
   * sweeper killed it. Measured on 2026-08-27 and 2026-08-29: the turn the
   * user was told was over kept editing files, its tool blocks landed on the
   * next turn's row, and the shared history ended with a `tool_use` without a
   * `tool_result`, which the API rejects on every following call.
   *
   * By the time a second call reaches this method the front door has already
   * declared the previous turn over (it answers 409 `stream_in_flight` for a
   * live one): whatever is still running here is a zombie. So it is aborted
   * with a cause of its own and AWAITED, and only then does the new turn touch
   * the history. Merely refusing would leave a resumed card waiting behind a
   * zombie until it dies by itself.
   */
  private async supersedeLiveTurn(sessionKey: string, session: NativeSession): Promise<void> {
    for (;;) {
      const live = session.abort;
      if (!live) return;
      console.warn(`[native] ${sessionKey}: a turn is still in flight, superseding it before starting the next one`);
      try { live.abort("superseded" satisfies StopCause); } catch { /* already finished */ }
      const turn = session.turn;
      // A handle with no turn behind it (a session assembled by hand, or a
      // controller left by a failed claim) has no `finally` that will ever
      // clear it: clearing it here is the only way out of this loop.
      if (!turn) { session.abort = undefined; return; }
      // `driveTurn` never rejects; this await only orders the two turns. After
      // it resumes the loop re-checks: the turn that just ended clears its own
      // handle, and the check finds either nothing or a NEWER claimant.
      await turn;
    }
  }

  /** The turn proper. Split from `sendChat` so its promise can be kept on the session. */
  private async driveTurn(
    sessionKey: string,
    session: NativeSession,
    handler: StreamHandler,
    options: { model?: string; history?: ChatMessage[]; systemPrompt?: string } | undefined,
    abort: AbortController,
  ): Promise<{ runId?: string }> {
    try {
      // Senza una radice i tool di file non si offrono nemmeno: un agente che
      // riceve `read_file` e non ha una workspace prova a indovinare dove sia
      // il progetto, e indovinare significa toccare file a caso. Resta una
      // chat, che è la cosa onesta da essere.
      const workspace = session.workspace;
      // I due elenchi si UNISCONO: un agente che sa programmare ma non sa
      // muovere la card che sta lavorando e' meta' agente, ed e' esattamente
      // com'era prima di questa riga.
      const topics = this.topicsContext(sessionKey);
      const globalOrchestrator = topics?.profile === "global-orchestrator";
      // ── THE GLOBAL MCP FLEET, AND THE LEVER THAT TURNS IT OFF ───────────
      //
      // The servers configured on the machine (`~/.claude.json`) are mounted by
      // `mcp-fleet.ts` once per process; here we only decide whether THIS
      // session pays for them. `mcp_policy = 'bridge-only'` says no, and it is
      // the same lever the CLI has: the tool schemas travel in the context of
      // EVERY call of every round, so a dispatched agent working one task would
      // pay the whole fleet on every turn for tools it never calls.
      // A global coordinator must not inherit an arbitrary MCP fleet. Its
      // registry-gated Topics tools are the whole model-visible capability set.
      const fleetAllowed = !globalOrchestrator
        && readMcpPolicy(sessionKey) !== "bridge-only";
      if (fleetAllowed) await ensureMcpFleet();
      // Composed at every round, not once: `mcpToolSpecs()` is the live fleet,
      // and a child mounted by this very turn must be callable by the next
      // round. `fleetAllowed` and `workspace` stay captured, read once per turn
      // as before: the per-session policy is not the thing that changes.
      const tools = () => {
        // This is an ordinary unbound Topic with a special, registry-backed
        // capability profile—not an unbound coding/chat session. Do not append
        // even workspace-free coding tools or the MCP fleet: the five scoped
        // board tools are intentionally its entire model-visible surface.
        if (globalOrchestrator) {
          return topicsToolSpecs("global-orchestrator");
        }
        return [
          // No workspace does not mean no tools: the two that resolve no path
          // (the turn's plan, and reading a URL) stay. See `WORKSPACE_FREE_TOOLS`.
          ...(workspace ? CODING_TOOLS : WORKSPACE_FREE_TOOLS),
          ...(topics ? topicsToolSpecs(topics.profile) : []),
          ...(fleetAllowed ? mcpToolSpecs() : []),
        ];
      };
      // `resolveClaudeModel()` si rilegge A OGNI TURNO, non solo alla costruzione:
      // altrimenti cambiare il modello in Impostazioni non ha effetto finche' il
      // server non riparte — che e' esattamente il difetto che `resolveClaudeCodeModel`
      // ha gia' pagato una volta per claude-code (vedi il suo commento).
      const turnModel = session.model ?? resolveClaudeModel() ?? this.config.model ?? DEFAULT_MODEL;
      // L'effort si rilegge a ogni turno, come l'autonomia: chi muove lo slider
      // se lo aspetta dal messaggio dopo, non dalla prossima chat.
      const turnEffort = resolveClaudeEffort(this.topicEffort(sessionKey));
      // The output cap is read per turn as well, from the same setting the
      // CLI runtime honours (`claude_max_tokens`, then `CLAUDE_MAX_TOKENS`).
      // This runtime never passed one, so the loop's own default applied to
      // every session whatever the user had set.
      const turnMaxTokens = clampMaxTokens(resolveClaudeMaxTokens());
      const out = await runAgentTurn(
        {
          model: turnModel,
          effort: turnEffort,
          maxTokens: turnMaxTokens,
          // An unbound normal chat gets the truthful no-workspace note. The
          // registry-backed coordinator is different: it intentionally has no
          // workspace and only its five board tools, so adding that ordinary
          // note would falsely advertise web/file capabilities.
          system: globalOrchestrator
            ? options?.systemPrompt
            : (workspace
              ? options?.systemPrompt
              : [options?.systemPrompt, NO_WORKSPACE_NOTE].filter(Boolean).join("\n\n")),
          history: session.history,
          // Passed by REFERENCE: every turn restarts from what the previous
          // one measured, instead of from the assumed 4 chars per token.
          calibration: session.calibration,
          tools,
          // Il segnale scende FIN DENTRO il comando: il ciclo guarda l'abort in
          // cima al giro, ma un turno sta quasi sempre fermo dentro un tool, e
          // da lì quel controllo non si raggiunge. Vedi `ToolContext.signal`.
          toolContext: { workspace: workspace ?? "", signal: abort.signal },
          topics: topics ?? undefined,
          // Il livello di autonomia si RILEGGE a ogni turno, non si memorizza
          // sulla sessione: chi lo cambia in chat si aspetta che valga dal
          // messaggio dopo, non dalla prossima chat.
          autonomy: levelFor(readTopicAutonomy(sessionKey)),
          signal: abort.signal,
          // L'USO SI DEPOSITA A OGNI GIRO, non a fine turno.
          //
          // Il registro è quello che il dispatcher rilegge ogni quattro secondi
          // per il chip vivo della card. Depositando solo il totale finale, quel
          // chip restava fermo per l'intero turno — che su un agente dispacciato
          // sono decine di minuti — e al primo turno mostrava zero token: i token
          // «non scorrevano più». Un giro alla volta il numero cresce mentre il
          // lavoro succede, ed è anche l'unico modo di contare un turno che
          // finisce annullato o in errore, dove il totale non torna a nessuno.
          // TWO listeners, because the tally has two destinations and only one
          // of them was ever wired.
          //
          // `recordTurnUsage` feeds the in-memory registry the dispatcher polls
          // for the card's live chip. `handler.onCallUsage` is the OTHER door:
          // the chat route accumulates it, writes it onto the message row and
          // broadcasts it to the client, which is what makes a turn's token
          // count visible in the chat and survive a reload.
          //
          // The native runtime never called the second one - `grep -c
          // onCallUsage server/providers/native/` was 0, while claude-code
          // calls it - so every row written since sessions moved to this
          // runtime carries a NULL. Measured on the live DB on 2026-08-29: 0 of
          // 147 assistant rows in 24h had a token count, and the last one that
          // did was from 2026-08-24.
          //
          // No double count: this door ACCUMULATES per round, while `onDone`
          // hands over the turn total and the route ASSIGNS it at finalize.
          onRoundUsage: (u) => {
            recordTurnUsage(sessionKey, u);
            try { handler.onCallUsage?.({ ...toProviderUsage(u), model: turnModel }); }
            catch { /* the measurement never stops the work */ }
          },
        },
        handler,
      );
      // Il perché della fine si deposita dove il resto del server lo cerca:
      // è lo stesso registro che usano le CLI, e senza questo un turno
      // dispacciato non saprebbe dire com'è finito.
      recordTurnEnd(sessionKey, out.turnEnd);
      // L'uso NON si deposita qui: ci ha già pensato `onRoundUsage`, giro per
      // giro. Sommare anche `out.usage` — che di quei giri è la somma —
      // conterebbe ogni token due volte.
      return {};
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Un abort chiesto da noi non è un guasto: è la risposta a uno stop.
      // CHI l'ha chiesto viaggia dentro il segnale. Se non c'è (un `abort()`
      // senza argomenti, da una strada che non si è dichiarata) NON si
      // indovina: resta `cancelled` senza causa, e `cancelledNotice` su quel
      // ramo scrive comunque un cartello. Qui prima c'era `"user"` fisso, ed è
      // esattamente la bugia che ha fatto sparire la spiegazione dalla chat.
      if (abort.signal.aborted) {
        const causa = stopCauseFromSignal(abort.signal);
        const end: TurnEndInfo = causa ? cancelled(causa) : { end: "cancelled" };
        recordTurnEnd(sessionKey, end);
        handler.onAborted?.({ result: "", turnEnd: end });
        return {};
      }
      handler.onError(detail);
      recordTurnEnd(sessionKey, { end: "error", cause: "provider-error", detail });
      return {};
    } finally {
      // ONLY ITS OWN HANDLE. An unconditional clear is how the first turn's
      // end made the second turn look dead: the handle is released by the turn
      // that set it, and a newer claimant's stays where it is.
      if (session.abort === abort) {
        session.abort = undefined;
        session.turn = undefined;
      }
    }
  }

  /**
   * `reason` è OBBLIGATORIO, e non ha un default.
   *
   * Un default qui sarebbe una risposta inventata a una domanda che il
   * chiamante sa già: tutti e tre i chiamanti veri (`/api/chat/abort` →
   * "user", i due watchdog di `routes/chat.ts` → "watchdog") la passano. Ed
   * era proprio un default — `= "user"` — a trasformare uno spegnimento del
   * server in «l'utente ha premuto stop», che è il difetto del 20/08. Se un
   * domani nasce una quarta strada, il compilatore la ferma qui invece di
   * lasciarle raccontare una bugia plausibile.
   */
  async abort(sessionKey: string, _runId: string | undefined, reason: AbortReason): Promise<void> {
    const s = this.sessions.get(sessionKey);
    if (!s?.abort) return;
    // La ragione entra NEL segnale: `signal.reason` è dove la piattaforma la
    // mette, ed è l'unico posto che non può divergere dal segnale stesso.
    // Nessuna traduzione: `AbortReason` è per costruzione un sottoinsieme di
    // `StopCause`, ed è per questo che è definito come tale — due vocabolari
    // per la stessa cosa avrebbero avuto bisogno di una tabella, e una tabella
    // è un posto in cui divergere.
    s.abort.abort(reason satisfies StopCause);
  }

  /**
   * Completion senza tool e fuori dalla sessione: titoli, digest, le cose di
   * servizio. Una storia usa-e-getta, così non entra nel contesto del turno
   * vero — stesso patto degli altri provider.
   */
  async complete(messages: ChatMessage[], options?: { model?: string }): Promise<CompletionResult> {
    const history: AgentMessage[] = messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }));
    let text = "";
    const out = await runAgentTurn(
      {
        model: options?.model ?? this.config.model ?? DEFAULT_MODEL,
        history,
        tools: () => [],
        toolContext: { workspace: this.config.defaultWorkspace ?? "" },
      },
      {
        onTextDelta: (c) => { text += c; },
        onToolStart: () => {},
        onToolResult: () => {},
        onDone: () => {},
        onError: () => {},
      },
    );
    return { content: out.text || text };
  }

  async resetSession(sessionKey: string): Promise<void> {
    this.sessions.delete(sessionKey);
  }

  async listModels(): Promise<string[]> {
    return [...MODELS];
  }

  defaultModel(): string {
    return this.config.model ?? DEFAULT_MODEL;
  }

  async diagnose(): Promise<ProviderDiagnostic> {
    const creds = readCredentials();
    const requirements = [
      {
        key: "claude-oauth",
        label: "Credenziali Claude",
        present: Boolean(creds),
        hint: creds
          ? undefined
          : "Nessun login trovato. Esegui `claude` e fai /login una volta: il runtime legge quel file.",
      },
    ];
    if (!creds) {
      return { name: this.name, status: "unavailable", requirements, lastError: "nessuna credenziale" };
    }
    // Qui la validità si verifica DAVVERO, al contrario di `connected`: la
    // diagnostica la chiede una persona che vuole sapere se funziona, e vale
    // la chiamata di rete.
    try {
      const tok = await getAccessToken();
      return {
        name: this.name,
        status: tok ? "ready" : "unavailable",
        requirements,
        lastError: tok ? undefined : "token non rinnovabile: rifai /login con la CLI",
      };
    } catch (err) {
      return {
        name: this.name,
        status: "unavailable",
        requirements,
        lastError: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Il livello di autonomia scritto sul topic di questa sessione.
 *
 * Lettura stretta sulla riga, come fa `claude-code` per gli stessi override:
 * passare da `getTopicBySessionKey` creerebbe un import circolare con utils.ts.
 *
 * Un errore qui NON deve alzare i permessi: si torna `null`, che `levelFor`
 * traduce nel default (`auto-apply`). Il verso giusto in cui sbagliare è verso
 * il basso — una tabella assente non può diventare un lasciapassare.
 */
/**
 * The session's MCP policy, or null when there is no topic behind this key.
 *
 * Same column the CLI branch reads in `writeMcpConfigForSession`: one question,
 * one answer, taken from the same place. Reading it differently on the two
 * runtimes is exactly how they would drift.
 */
function readMcpPolicy(sessionKey: string): string | null {
  try {
    const { getDatabase } = require("../../db");
    const row = getDatabase()
      .prepare("SELECT mcp_policy FROM topics WHERE session_key = ? LIMIT 1")
      .get(sessionKey) as { mcp_policy?: string | null } | undefined;
    return row?.mcp_policy ?? null;
  } catch {
    return null;
  }
}

function readTopicAutonomy(sessionKey: string): string | null {
  try {
    const { getDatabase } = require("../../db");
    const row = getDatabase()
      .prepare("SELECT autonomy_level FROM topics WHERE session_key = ? LIMIT 1")
      .get(sessionKey) as { autonomy_level?: string | null } | undefined;
    return row?.autonomy_level ?? null;
  } catch {
    return null;
  }
}
