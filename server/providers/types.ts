/**
 * AIProvider — abstraction layer for AI inference backends.
 *
 * Implementations:
 *   - OpenClawProvider: wraps gateway-ws.ts (WebSocket + HTTP to OpenClaw Gateway)
 *   - ClaudeProvider:   uses Anthropic SDK directly (standalone mode)
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { CompactionMarker } from "./claude/compaction";
import type { TurnEndInfo } from "./stop-reason";
import type { AcpAgentSpec } from "./acp/agents";

// ============ Message Types ============

// Dichiarato UNA volta in shared/types.ts (dove si chiama `ProviderChatMessage`,
// perché nel client `ChatMessage` è il messaggio ricco della UI). Ri-esportato
// col nome storico: i call site del server non cambiano.
export type { ProviderChatMessage as ChatMessage } from "../../shared/types";
import type { ProviderChatMessage as ChatMessage } from "../../shared/types";

// ============ Stream Event Types ============

/**
 * Tool arguments arrive as JSON-decoded objects from the model.
 * Always an object (never an array/scalar at the top level), but the inner
 * fields are arbitrary, so we use `unknown` for the values.
 */
export type ToolArgs = Record<string, unknown>;

/**
 * CHI ha chiesto di annullare un turno.
 *
 * È un sottoinsieme di {@link StopCause} — le sole cause che un CHIAMANTE può
 * dichiarare — e non un tipo a sé stante per caso: la causa dichiarata qui
 * diventa la `StopCause` del `TurnEndInfo` che il provider deposita, e
 * scriverla due volte in due vocabolari diversi è il modo in cui i due
 * divergono. `"user"` resta il default per retro-compatibilità con chi non la
 * passa, ma vale la regola opposta a quella dei valori di default: se la sai,
 * la dici. Un annullamento etichettato `user` mette a tacere il cartello che
 * spiega all'utente cos'è successo — vedi `stop-reason.ts`, `server-shutdown`.
 */
export type AbortReason = "user" | "watchdog" | "server-shutdown";

/**
 * Token usage attached to a completed turn. Field names mirror what the
 * providers actually emit (Claude Code uses `inputTokens`/`outputTokens`/
 * cache fields; Codex uses `input_tokens`/`output_tokens` which the provider
 * normalizes before passing it here).
 */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreation?: number;
  /**
   * La quota di `cacheCreation` scritta con TTL a UN'ORA, che costa 2× un token
   * fresco invece di 1.25×. Arriva scorporata dal provider
   * (`usage.cache_creation.ephemeral_1h_input_tokens`): si legge, non si deduce
   * dal tempo fra le richieste. Sottoinsieme di `cacheCreation`, non un addendo.
   */
  cacheCreation1h?: number;
  cacheRead?: number;
  reasoningTokens?: number;
}

/**
 * Trailing payload attached to `done` / `aborted` events.
 * Providers stuff arbitrary metadata here (token usage, finish_reason, raw
 * upstream object). The picker/footer code only reads known fields and falls
 * back gracefully, so the open shape is intentional.
 */
export interface ProviderDoneMessage {
  result?: string;
  usage?: ProviderUsage;
  /** End-to-end turn latency in milliseconds. */
  durationMs?: number;
  /** Total cost in USD reported by the provider. */
  costUsd?: number;
  /** Raw upstream payload — providers may surface their native shape here. */
  raw?: unknown;
  /**
   * PERCHÉ il turno è finito, col vocabolario di ACP. Il provider lo SA (glielo
   * dice l'evento `result`, o il marcatore con cui muore la promise) e prima lo
   * buttava via: chi stava a valle poteva solo indovinarlo dalla durata. Vedi
   * `./stop-reason`.
   */
  turnEnd?: TurnEndInfo;
  [key: string]: unknown;
}

// Qui viveva una seconda descrizione dello streaming: otto interfacce-evento
// (`TextDeltaEvent`, `ToolStartEvent`, … ) e l'unione `StreamEvent` che le
// raccoglieva. Nessun provider le ha mai emesse e nessuna route le ha mai lette:
// il protocollo VERO è `StreamHandler` qui sotto, callback per callback, ed è
// quello che i provider implementano. Un'unione parallela mai referenziata è
// esattamente lo specchio che `tests/unit/no-type-mirrors.test.ts` esiste per
// impedire — con l'aggravante che `ErrorEvent` ombreggiava l'omonimo del DOM.
// I frame che arrivano davvero al browser sono i `stream:*` dell'unione
// `WSMessage` in `client/src/types/index.ts`.

// ============ Completion (non-streaming) ============

export interface CompletionResult {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

// ============ Provider Capabilities ============

export type ProviderCapability =
  | "streaming"      // supports streamChat
  | "tools"          // tool call visibility during streaming
  | "thinking"       // extended thinking / reasoning visibility
  | "sessions"       // session management (pause, resume, history)
  | "abort"          // can abort an in-progress stream
  | "context"        // injects external context (OpenClaw SOUL.md, etc.)
  | "history";       // accepts options.history on sendChat (stateless providers
                     // that need the full transcript every turn — claude, openai).
                     // Providers without this flag manage history internally
                     // (process-resident CLI, gateway-side session, etc.).

// `ProviderContextStrategy` è dichiarato in shared/types.ts (con la doc delle
// tre strategie). Ri-esportato qui perché l'interfaccia `AIProvider` lo dichiara
// e perché importarlo da `server/context/envelope.ts` farebbe ciclo:
// `provider-strategy.ts` importa `AIProvider` da qui.
export type { ProviderContextStrategy } from "../../shared/types";
import type { ProviderContextStrategy } from "../../shared/types";

// ============ Status & Diagnostics ============

// ProviderStatus + ProviderRequirement live in shared/types.ts so the
// client doesn't keep a parallel definition that can drift. Re-exported
// below for back-compat with `import { ProviderStatus } from
// "./providers/types"`.
export type { ProviderStatus, ProviderRequirement } from "../../shared/types";

// Import the types so the local references in this file resolve (a bare
// `export … from` re-export does not create an in-module binding).
import type { ProviderStatus, ProviderRequirement, GoalStepStatus } from "../../shared/types";

export interface ProviderDiagnostic {
  name: string;
  status: ProviderStatus;
  /** Set if provider is the current default */
  isDefault?: boolean;
  /** Filesystem path of the binary (for CLI providers) */
  binaryPath?: string;
  /** Detected version string */
  version?: string;
  /** Number of available models, if listModels is implemented */
  modelsCount?: number;
  /** Per-requirement breakdown */
  requirements: ProviderRequirement[];
  /** Last error message from a failed health-check */
  lastError?: string;
}

// ============ Stream Handler (callback-style) ============

/** Callback-style handler — maps to the existing ChatStreamHandler pattern */
export interface StreamHandler {
  /**
   * Nuovo testo dal modello: `(delta, cumulato)`.
   *
   * Il PRIMO argomento è il pezzo nuovo e basta — il consumatore lo appende
   * senza guardarlo. Il secondo è il testo del turno finora, per chi preferisce
   * lo stato al pezzo; i due devono restare coerenti (`cumulato` finisce per
   * `delta`).
   *
   * Il contratto è scritto qui perché è stato disatteso: `gateway-ws.ts` mandava
   * il messaggio INTERO come primo argomento, e la route compensava indovinando
   * — se il testo era identico al precedente lo scartava. Su claude, openai,
   * codex e claude-code, che i delta li mandano veri, quella regola cancellava
   * ogni token ripetuto di fila. Chi è cumulativo si normalizza da sé con
   * `nextTextDelta` (./text-delta.ts) e chiama questo con il pezzo.
   */
  onTextDelta: (text: string, fullText: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolStart: (toolCallId: string, name: string, args?: ToolArgs) => void;
  onToolUpdate?: (toolCallId: string, partialResult: string) => void;
  /**
   * The tool's input is now complete. With `--include-partial-messages`
   * (claude-code) a tool is announced via onToolStart the moment the model
   * STARTS writing its input (args still empty/partial); this callback
   * delivers the parsed full args once the input block closes. Consumers
   * upsert by id — same ToolCall, richer args.
   *
   * Also fired PROVISIONALLY while the input JSON is still streaming, as soon
   * as a primary field (file_path / command / url / …) is fully received, so
   * the row shows `Write(App.tsx)` within moments instead of a blank running
   * row for the whole (possibly minutes-long) input generation. Idempotent
   * upsert: a later call with fuller args overwrites.
   */
  onToolArgsUpdate?: (toolCallId: string, args: ToolArgs) => void;
  /**
   * Keep-alive: the tool's input is actively streaming (input_json_delta),
   * even though no new field is parseable yet. Lets the route reset its
   * stream inactivity timer so a legitimately slow-to-write Edit/Write input
   * doesn't trip the false "stream slow" annotation. No persistence, no
   * broadcast — purely a liveness signal.
   */
  onToolActivity?: (toolCallId: string) => void;
  /**
   * Tool finished. `isError = true` means the tool reported a failure (Claude
   * SDK's `tool_result.is_error`). Default false; existing callers that pass
   * only 2 args remain valid.
   */
  onToolResult: (toolCallId: string, result: string, isError?: boolean) => void;
  /**
   * L'usage attribuito a UNA azione (tool call), non al turno. Nasce dallo
   * stesso evento `assistant` che annuncia il `tool_use`: quella chiamata al
   * modello ha DECISO l'azione, quindi il suo costo è il costo dell'azione. Se
   * una chiamata produce più tool_use paralleli, la quota è spartita in parti
   * uguali fra loro — una sola chiamata non distingue quale blocco è pesato di
   * più. Chi ascolta NON accumula: è già la quota di questa azione.
   *
   * Fire-once per tool: gli eventi della CLI sono cumulativi, il provider
   * deduplica e attribuisce solo alla prima chiamata che porta quel tool_use.
   * Le sotto-sessioni (sidechain) restano fuori, come per `onCallUsage`.
   *
   * Quote disgiunte come altrove: `inputTokens` è il totale letto e comprende
   * `cacheRead` + `cacheCreation`; `cacheCreation1h` è una quota di
   * `cacheCreation`. La somma delle azioni di un turno non supera il totale
   * del turno (i troncamenti della divisione la tengono ≤).
   */
  onToolUsage?: (
    toolCallId: string,
    u: {
      inputTokens: number;
      outputTokens: number;
      cacheRead: number;
      cacheCreation: number;
      cacheCreation1h: number;
      model?: string;
    },
  ) => void;
  /**
   * Sub-agent (Task tool) activity update. Fired when a Claude Code sidechain
   * emits a child event tagged with `parent_tool_use_id`. The provider's
   * SidechainTracker accumulates child events into an `actions[]` log keyed
   * by parent tool id; this callback delivers the latest snapshot so the
   * route can patch the parent Task call's `detail.sub_agent` and re-broadcast.
   *
   * `actions` is the full current log (snapshot, not a delta) — consumers
   * replace, not append. Bounded at 200 entries by the tracker.
   */
  onSubAgentUpdate?: (
    parentToolCallId: string,
    snapshot: {
      subAgentType?: string;
      description?: string;
      actions: Array<{ index: number; toolName: string; summary?: string; status?: 'running' | 'success' | 'error' }>;
      finished: boolean;
      result?: string;
    },
  ) => void;
  /**
   * The most recently announced `tool_use` is one that semantically requires
   * a human answer (Claude Agent SDK's `AskUserQuestion`, MCP elicitation).
   * Provider has paused the turn and the route SHOULD:
   *   1. Mark the corresponding `ToolCall.status = 'waiting_for_input'`
   *      and persist `userInputSchema` onto the row.
   *   2. Broadcast `stream:tool_user_input_required` so the client renders
   *      the form.
   *   3. Suspend its inactivity / soft-timeout timers until either
   *      `POST /api/chat/tool-response` or `POST /api/chat/abort` arrives.
   * If the provider that fired this callback does not implement
   * `resumeWithToolResponse`, the route MUST fail the tool fast with
   * `status: 'error'` and let the stream finalise — never leave it
   * hanging on an unanswerable request.
   */
  onUserInputRequired?: (
    toolCallId: string,
    toolName: string,
    schema: import("../types").UserInputSchema,
  ) => void;
  /**
   * Context compaction happened mid-session (Claude Code `compact_boundary`).
   * Render-only: the route surfaces it as a "context compacted" divider and
   * persists a display marker — it never re-enters the model's context and
   * never resumes a turn. See CHAT-COMPACT-01.
   */
  onCompaction?: (marker: CompactionMarker) => void;
  /**
   * Context size (tokens) of ONE model call, as reported per assistant message:
   * `input + cache_read + cache_creation`. This is the live size of the prompt
   * the model just saw — NOT the turn total. The final `result` usage is an
   * AGGREGATE over every call in the turn, so it is orders of magnitude larger
   * on a long turn and must never be read as "how big is the context now"
   * (that made the post-compaction divider report a context EXPLOSION).
   * Fires once per assistant message; sub-agent (sidechain) calls are excluded.
   *
   * `model` is the model that produced THAT call — the only honest source for
   * the denominator of the ring. Resolving it from the request options instead
   * would be wrong the moment the CLI falls back to another model mid-turn
   * (fast mode, overload), and a 200k window under a 1M model reads "90% full"
   * on a session that is at 18%.
   *
   * `windowTokens` is the denominator when the provider STATES it (Codex sends
   * `model_context_window`). A declared window beats our lookup table and is
   * not flagged as estimated: it is the only way to be right about a model we
   * have never heard of.
   */
  onContextSize?: (tokens: number, model?: string, windowTokens?: number) => void;
  /**
   * L'usage di UNA chiamata al modello, appena il provider la vede.
   *
   * Perché serve, distinto da `onContextSize`. Le due nascono dallo STESSO evento
   * e rispondono a due domande diverse: `onContextSize` dice quanto è grande il
   * prompt che il modello ha appena visto — il SERBATOIO, che sale e scende con le
   * compattazioni — mentre questo dice quanto è stato CONSUMATO da quella chiamata,
   * cioè la bolletta, che solo cresce. Prima esisteva solo il primo, e i numeri di
   * consumo arrivavano al client una volta sola, alla fine del turno: durante un
   * turno agentico da otto tool call l'utente non vedeva niente muoversi.
   *
   * Chiamata una volta PER CHIAMATA, non per turno: chi ascolta ACCUMULA. Il
   * `result` finale del provider somma già tutte le chiamate, quindi sommare anche
   * quello sarebbe contare due volte.
   *
   * Le chiamate delle sotto-sessioni (sidechain) sono ESCLUSE: hanno un loro
   * contesto e un loro conto, e mescolarle qui gonfierebbe il turno del genitore.
   *
   * Quote disgiunte come altrove: `inputTokens` è il TOTALE letto e comprende
   * `cacheRead` + `cacheCreation`; `cacheCreation1h` è una quota di
   * `cacheCreation`, non un'aggiunta.
   */
  onCallUsage?: (u: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreation: number;
    cacheCreation1h: number;
    model?: string;
  }) => void;
  /**
   * L'agente ha dichiarato (o aggiornato) il suo piano — oggi solo ACP, che
   * manda `session/update` con `sessionUpdate: "plan"`.
   *
   * È uno SNAPSHOT: l'elenco intero a ogni cambio di stato di un passo. Chi
   * ascolta sostituisce, non accoda — accodare produrrebbe un piano che cresce
   * di una copia a ogni spunta.
   *
   * Non è trascritto: il piano è stato della topic (i passi del goal), non un
   * messaggio. Se finisse nel testo del modello sarebbe persistito, e a ogni
   * tick il contesto avrebbe un elenco in più uguale al precedente.
   */
  onPlan?: (steps: Array<{ content: string; status: GoalStepStatus }>) => void;
  onDone: (message?: ProviderDoneMessage) => void;
  onError: (error: string) => void;
  onAborted?: (message?: ProviderDoneMessage) => void;
}

// ============ The Provider Interface ============

export interface AIProvider {
  /** Provider identifier */
  readonly name: string;

  /** What this provider supports */
  readonly capabilities: Set<ProviderCapability>;

  /**
   * How `adaptEnvelope()` should shape a `ContextEnvelope` for this provider.
   * Optional for backwards compatibility — when absent, the registry helper
   * `getProviderStrategy()` derives the strategy from `capabilities.has("history")`.
   * Providers SHOULD declare it explicitly so the policy is visible at the
   * provider level, not buried in route handler conditionals.
   */
  readonly contextStrategy?: ProviderContextStrategy;

  /** Whether the provider is currently connected/ready */
  readonly connected: boolean;

  // --- Lifecycle ---

  /** Initialize the provider (connect, authenticate, etc.) */
  start(): void;

  /** Shut down the provider */
  stop(): void;

  // --- Streaming Chat (primary) ---

  /**
   * Send a chat message and stream the response via callbacks.
   * Returns a runId for tracking/aborting.
   *
   * `options.model` overrides the configured default for this single request,
   * without mutating shared provider config.
   */
  sendChat(
    sessionKey: string,
    message: string,
    handler: StreamHandler,
    options?: {
      model?: string;
      /**
       * Prior conversation turns (excluding the new user message). Only
       * consumed by providers that declare the "history" capability —
       * stateless backends like the Anthropic and OpenAI APIs need the
       * full transcript every turn, while CLI/gateway providers ignore it
       * because they hold session state themselves.
       */
      history?: ChatMessage[];
      /**
       * Il messaggio come sarebbe stato SENZA deduplicazione del preambolo:
       * testo utente con tutti i blocchi di contesto davanti.
       *
       * Serve a un caso solo, ma reale. `message` a regime è il testo nudo,
       * perché gli slot di contesto la sessione CLI li ha già. Se però quella
       * sessione muore e il provider rispedisce su una CLI APPENA CONIATA
       * (`SESSION_RESET`), il testo nudo la trova vergine: un turno intero senza
       * system prompt del topic, file di contesto, progetto, memoria, pinned.
       *
       * Chi compone il messaggio è la route, non il provider — quindi il
       * rimpiazzo glielo deve passare la route. Ignorato da chi non fa dedup.
       */
      resetFallbackContent?: string;
      /**
       * Optional Anthropic-format Tool[] to register for this turn (Phase 30
       * BROWSER-CHAT-04). Providers with `isPassthroughProvider(name) === true`
       * forward to the underlying SDK; CLI/gateway providers ignore the field
       * (their tool surface is managed upstream).
       */
      tools?: Tool[];
    },
  ): Promise<{ runId?: string }>;

  /**
   * Register a handler to receive stream events for a session.
   * Used when the provider pushes events asynchronously (e.g., WebSocket).
   */
  registerStreamHandler?(sessionKey: string, runId: string | undefined, handler: StreamHandler): void;

  /**
   * Unregister a stream handler.
   *
   * `handler` è OPZIONALE ma va passato quando lo si ha: chi lo riceve deve
   * spegnere solo SE è ancora il proprietario corrente. La route chiude i turni
   * in ordine sparso — un `onDone` che finalizza mentre un secondo turno è già
   * partito è la norma su una chat viva — e un azzeramento incondizionato
   * spegnerebbe l'handler del turno NUOVO, lasciandolo muto.
   */
  unregisterStreamHandler?(sessionKey: string, handler?: StreamHandler): void;

  // --- HTTP Streaming (SSE fallback) ---

  /**
   * Stream a chat completion via HTTP SSE.
   * Returns a Response with Content-Type: text/event-stream.
   * Used when WebSocket is unavailable or for simpler streaming.
   */
  streamHTTP?(
    messages: ChatMessage[],
    options?: { sessionKey?: string; signal?: AbortSignal }
  ): Promise<Response>;

  // --- Non-streaming ---

  /**
   * Simple completion (non-streaming). For auto-naming, journal digests, the
   * dispatcher's model classifier, etc. `options.model` overrides the
   * provider's configured model for THIS call only (e.g. force a cheap/fast
   * tier); implementations may ignore it.
   */
  complete(messages: ChatMessage[], options?: { model?: string }): Promise<CompletionResult>;

  // --- Session Management (optional) ---

  /**
   * Cancel the in-flight turn for a session. `reason` distinguishes a human
   * stop ("user") from the stream watchdog giving up ("watchdog") and from the
   * server shutting down under a live turn ("server-shutdown"), so the provider
   * can label the resulting turn end honestly — a watchdog or shutdown abort
   * must NOT read as "user stop" in logs/UI.
   *
   * `reason` NON ha un default, di proposito. Un default qui è una risposta
   * inventata a una domanda che il chiamante conosce già, e per mesi è stato
   * `"user"`: il 20/08 (topic:9f9e9629) è così che uno spegnimento del server è
   * diventato «l'utente ha premuto stop» — e siccome a chi preme stop non si
   * spiega cos'ha premuto, il turno è morto senza una parola in chat. Ora una
   * strada nuova che si dimentica di dichiararsi la ferma il compilatore,
   * invece di lasciarle raccontare una bugia plausibile.
   */
  abort?(sessionKey: string, runId: string | undefined, reason: AbortReason): Promise<void>;

  /**
   * Riadotta il turno che era in volo per questa sessione, dopo un riavvio del
   * server.
   *
   * DICHIARARLO QUI È IL PUNTO. Averlo o non averlo separa i provider in due
   * specie, e la differenza non è un dettaglio implementativo: chi ce l'ha
   * esegue il turno in un processo FIGLIO — che il SIGTERM non tocca, che il
   * broker ritrova, e che questo metodo riprende — mentre chi non ce l'ha lo
   * esegue DENTRO il server, e quando il server muore il turno muore con lui.
   *
   * Da quella differenza dipende quanto un riavvio pianificato deve aspettare
   * (`lib/quiescence.ts`): un turno che nessuno riprenderà merita l'attesa
   * lunga di una card. Finché il metodo esisteva solo sulla classe concreta,
   * la domanda si poteva porre solo con un cast — cioè fuori dal controllo del
   * compilatore, che è dove i contratti taciti vanno a marcire.
   */
  reattach?(sessionKey: string, handler: StreamHandler): Promise<"completed" | "live" | "awaiting-input" | "dead">;

  /**
   * True when the provider's child process for this session is currently
   * alive. The stream watchdog consults this before finalizing a silent
   * stream as timed out: a live child that emits nothing is NOT dead — e.g.
   * the Claude CLI is mute for the whole duration of an auto-compact
   * (observed 3+ minutes) and only the hard cap should bound that. Providers
   * without a per-session child leave this undefined (watchdog behavior
   * unchanged).
   */
  isTurnProcessAlive?(sessionKey: string): boolean;

  /**
   * Signal that a session's persisted config changed (e.g. the per-topic
   * effort tier — migration 033) so the provider can pick it up. For providers
   * that spawn a long-lived subprocess with spawn-time flags (claude-code),
   * this drops the idle pooled process so the next turn respawns with the new
   * config; a no-op while a turn is streaming and for providers that read
   * config per-request. Fire-and-forget from the topic PATCH route.
   */
  refreshSessionConfig?(sessionKey: string): void;

  /**
   * Re-inject the user's answer to a tool that paused the stream (via the
   * detector in `ask-user-detector.ts`, today only `AskUserQuestion` and
   * MCP elicitation). Implemented by providers that own a long-running
   * subprocess waiting on stdin (claude-code) or a paused gateway session.
   *
   * Contract:
   *   - The stream must already be open; this call resumes the existing
   *     turn, it does NOT start a new model round-trip.
   *   - Providers that don't support in-band user input leave this
   *     undefined; the route handler will refuse the suspend and the
   *     tool will fail-fast with `status: 'error'` instead of hanging.
   *   - The serialised payload is provider-defined: claude-code writes a
   *     stream-json `tool_result` line to stdin, MCP would post an
   *     `elicitation/result` notification, etc.
   */
  resumeWithToolResponse?(
    sessionKey: string,
    toolCallId: string,
    response: import("../../shared/types").ToolUserResponse,
  ): Promise<void>;
  /**
   * Drop a pending user-input entry WITHOUT writing to stdin. Used when the
   * answer is delivered out-of-band — i.e. the Topics MCP bridge tool
   * (`mcp__topics__ask_user_question`), whose result returns through the
   * bridge's own JSON-RPC response, not through a `tool_result` line. The
   * route still needs the provider to forget the pending entry so a reattach
   * REPLAY doesn't re-surface a form for an already-answered question.
   * Returns true if an entry existed and was cleared.
   */
  clearPendingInput?(sessionKey: string, toolCallId: string): boolean;
  /**
   * Da quando questa sessione è ferma ad aspettare una risposta (ms epoch), o
   * null se sta lavorando.
   *
   * Serve a chi guarda da FUORI la chat: la sidebar e il registro degli stream
   * mostravano lo stesso pallino di un turno che macina, mentre lo stato vero è
   * «sospeso, la palla è tua». Se ci sono più domande aperte vale la più
   * vecchia — è da lì che la sessione ha smesso di lavorare.
   *
   * Il provider che non sa sospendersi lascia questo undefined: nessuna delle
   * sue sessioni può essere in attesa.
   */
  pendingInputSince?(sessionKey: string): number | null;
  /**
   * C'è un turno in volo per questa sessione, secondo la fonte AUTORITATIVA del
   * provider (per claude-code: lo store del broker), indipendentemente da ciò
   * che il DB ricorda?
   *
   * La usa il setaccio di boot prima di UCCIDERE un figlio sopravvissuto: la
   * riga `partial` in DB è un'ombra che si perde, e su una sessione ferma su
   * una domanda perderla significa buttare via la domanda. `unknown` non è
   * `idle`: chi non sa non uccide.
   *
   * `park: true` è una PROMESSA del chiamante: «se dici "open" riadotto subito».
   * Chi la fa autorizza il provider a tenersi la scansione appena fatta invece
   * di buttarla, così la riadozione non se la rifà da capo. Chi sonda e basta
   * (la rotta della storia, a ogni caricamento della chat) la omette.
   */
  brokerTurnState?(sessionKey: string, opts?: { park?: boolean }): Promise<"open" | "idle" | "unknown">;
  getHistory?(sessionKey: string, limit?: number): Promise<unknown>;
  pauseSession?(sessionKey: string): Promise<void>;
  resumeSession?(sessionKey: string): Promise<void>;
  listSessions?(options?: { kinds?: string[]; activeMinutes?: number }): Promise<unknown>;
  sendToSession?(sessionKey: string, message: string): Promise<void>;
  getSessionStatus?(sessionKey: string): Promise<unknown>;

  /**
   * Forget everything the model remembers of this session, so the next turn
   * starts from a blank slate.
   *
   * Serve a `/clear`. Nei provider a respawn (claude-code) la memoria non sta
   * in Topics: sta nel file di sessione della CLI, che il turno dopo viene
   * ricaricato con `--resume <id>`. Svuotare i messaggi nel DB quindi pulisce
   * solo quello che si VEDE — il modello continua a ricordare tutto ciò che
   * l'utente ha appena visto sparire, e lo tira fuori al primo riferimento.
   * `resetSession` rompe quel legame (dimentica l'id, stacca il processo in
   * pool) così lo spawn successivo riparte con `--session-id` su un uuid
   * nuovo: è la stessa semantica che ha `/clear` nella CLI.
   *
   * I provider dove la conversazione vive lato server (openclaw) non la
   * implementano: lì `/clear` passa da `sendToSession`, che è in banda.
   */
  resetSession?(sessionKey: string): Promise<void>;

  // --- Tools RPC (optional, OpenClaw-specific) ---

  invokeTool?(tool: string, args: ToolArgs): Promise<unknown>;

  // --- Diagnostics ---

  /** Inspect config + connectivity. Returns a structured report for the UI. */
  diagnose?(): Promise<ProviderDiagnostic>;

  /** List available models for this provider (for the picker UI) */
  listModels?(): Promise<string[]>;

  /**
   * Il tier di effort/reasoning che Topics FORZA allo spawn per le sessioni di
   * questo provider — lo stesso che risolve il percorso di spawn, così il badge
   * del picker dice quello che una sessione NUOVA otterrebbe davvero.
   *
   * Lo dichiara il provider, e non è un dettaglio: prima erano due `if`
   * cablati su `claude-code` e `codex` dentro lo snapshot manager, cioè un
   * provider nuovo restava senza badge finché qualcuno non andava ad
   * aggiungere il terzo `if` in un file che non è il suo. Chi non forza
   * nessun tier semplicemente non implementa il metodo.
   */
  effortTier?(): string | undefined;

  /**
   * Il modello su cui parte una sessione che NON ha scelto niente.
   *
   * Senza questo la UI tirava a indovinare — mostrava `models[0]` — e indovinava
   * male: la lista guida con l'id nudo (`claude-opus-5`) mentre lo spawn usa da
   * sempre il suo gemello a finestra lunga. Risultato: il badge diceva 200k su
   * una sessione da un milione, cioè la stessa bugia che il badge esiste per
   * evitare. Chi conosce il default è il provider, non il picker.
   */
  defaultModel?(): string | null;

  // --- Event routing ---

  /**
   * Handle a raw provider event and route it to registered handlers.
   * Returns true if the event was handled.
   */
  routeEvent?(event: unknown): boolean;

  /** Subscribe to provider-level events (connect, disconnect, etc.) */
  onConnect?(handler: () => void): void;
  onDisconnect?(handler: (reason: string) => void): void;
}

// ============ Provider Configuration ============

export interface OpenClawProviderConfig {
  type: "openclaw";
  gatewayUrl: string;
  token: string;
  refreshToken?: () => string;
}

export interface ClaudeProviderConfig {
  type: "claude";
  apiKey: string;
  model?: string;       // defaults to "claude-sonnet-4-20250514"
  maxTokens?: number;   // defaults to 8192
}

export interface ClaudeCodeProviderConfig {
  type: "claude-code";
  model?: string;           // defaults to "claude-sonnet-4-6"
  permissionMode?: string;  // defaults to "bypassPermissions"
  defaultWorkspace?: string; // defaults to HOME
}

export interface CodexProviderConfig {
  type: "codex";
  model?: string;             // defaults to "gpt-5-codex"
  approvalMode?: "auto" | "full-access";
  defaultWorkspace?: string;  // defaults to HOME
}

export interface OpenAIProviderConfig {
  type: "openai";
  apiKey: string;
  model?: string;             // defaults to "gpt-4o"
  maxTokens?: number;         // defaults to 8192
}

/**
 * Un agente che parla Agent Client Protocol.
 *
 * È l'unico config in cui `type` NON è il nome del provider: `type` è
 * "acp" per tutti, il nome è quello dell'agente (`gemini`, `goose`, …). Il
 * registro indicizza per NOME, quindi ogni posto che deduplicava su
 * `config.type` passa da `providerNameForConfig()` — senza, il secondo agente
 * ACP registrato spegnerebbe il primo. Vedi `server/providers/acp.ts`.
 */
export interface AcpProviderConfig extends AcpAgentSpec {
  type: "acp";
  /** Directory di lavoro quando la topic non ne dichiara una. */
  defaultWorkspace?: string;
}

/**
 * Il runtime NATIVO: nessun processo esterno, la sessione vive dentro il
 * server. Vedi `server/providers/native/provider.ts` per il perche'.
 */
export interface NativeProviderConfig {
  type: "native";
  /** Radice usata quando una sessione non ha un progetto suo. */
  defaultWorkspace?: string;
  model?: string;
}

export type ProviderConfig =
  | OpenClawProviderConfig
  | ClaudeProviderConfig
  | ClaudeCodeProviderConfig
  | CodexProviderConfig
  | OpenAIProviderConfig
  | AcpProviderConfig
  | NativeProviderConfig;

/**
 * Il nome sotto cui un config si registra. Per tutti i provider storici è il
 * `type` stesso; per ACP è il nome dell'agente, perché N agenti condividono
 * lo stesso `type`.
 */
export function providerNameForConfig(config: ProviderConfig): string {
  // Il runtime nativo si chiama `topics` e non `native`: il nome lo legge chi
  // sceglie un provider nel picker, e «native» non dice niente a nessuno.
  if (config.type === "native") return "topics";
  return config.type === "acp" ? config.name : config.type;
}

// ============ Snapshot (server-authoritative state for clients) ============
// ProviderSnapshotEntry + ProvidersSnapshot live in shared/types.ts so
// the WS payload shape can be type-checked symmetrically on both sides.
export type { ProviderSnapshotEntry, ProvidersSnapshot } from "../../shared/types";
