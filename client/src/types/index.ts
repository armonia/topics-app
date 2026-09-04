// Shared types — canonical defs live in /shared/types.ts so server +
// client can't drift. Re-exported here so existing call sites that do
// `import type { X } from '@/types'` keep working unchanged.
export type {
  ProviderStatus,
  ProviderSnapshotEntry,
  ProvidersSnapshot,
  AskUserQuestionItem,
  UserInputSchema,
  ToolUserResponse,
} from '../../../shared/types';
// `export type { … } from` ri-esporta ma NON porta i nomi in scope locale, e i
// payload WS qui sotto li usano. Import separato, non è una ridondanza.
import type {
  UserInputSchema,
  ToolUserResponse,
  AcpUsageUpdate,
  ClaudeSessionState,
  WSProvidersSnapshotMessage,
  WSGoalUpdatedMessage,
} from '../../../shared/types';
import type { NotificationRow } from '../../../shared/notification-log';

// ─── Entità di dominio: dichiarate in shared/, non qui ─────────────────
//
// Erano sei interfacce riscritte a mano con sopra "Mirrors server/types.ts:X".
// Il commento non ha impedito la deriva: `Topic.mcpPolicy` e
// `Topic.browserState` non sono mai arrivati fin qui, e il client si era
// costruito da solo `TopicsData.workspaceProjects` che il server manda davvero
// ma non dichiarava. Ora la dichiarazione è UNA, in `shared/types.ts`; questo
// re-export tiene valido ogni `import type { Topic } from '@/types'`.
export type {
  AutonomyLevel,
  Topic,
  Project,
  Machine,
  Worktree,
  TopicsData,
  UnreadData,
} from '../../../shared/types';
// `export type { … } from` ri-esporta ma NON porta i nomi in scope locale, e
// più sotto i payload WS li usano. Import separato, non è una ridondanza.
import type {
  AutonomyLevel,
  Topic,
  Project,
  Machine,
  Worktree,
} from '../../../shared/types';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

// ─── Payload del messaggio: dichiarati in shared/, non qui ─────────────
//
// ToolCallDetail, ToolCall e ContentBlock erano riscritti qui riga per riga,
// identici a `server/types.ts` a meno dei commenti, col solito "Mirrors" a
// fare da garanzia. Ora la dichiarazione è UNA, in `shared/types.ts`.
export type { ToolCallDetail, ToolCall, ContentBlock, TurnEndCause } from '../../../shared/types';
export type { PermissionDecision, ToolPermissionRequest, ToolPermissionOutcome } from '../../../shared/types';
import type { ToolCall, ContentBlock, ToolPermissionRequest, ToolPermissionOutcome } from '../../../shared/types';

import type { TerminalSessionType } from '../../../shared/terminal-session-types';
export interface ChatMessage extends Message {
  id: string;
  timestamp: string;
  pinned?: boolean;
  // Enhanced message structure
  thinking?: string;              // AI thinking content (collapsible)
  toolCalls?: ToolCall[];         // Tool calls made in this message
  /**
   * Chronological timeline of content blocks. Populated during streaming
   * (built incrementally from WS events) and preserved on history reload.
   * Older messages may not have this; MessageContent falls back to the
   * thinking/content/toolCalls buckets in that case.
   */
  blocks?: ContentBlock[];
  media?: string[];               // Media file paths
  partial?: boolean;              // True if message is still streaming
  queued?: boolean;               // True if message is queued to send (offline)
  streamedAt?: string;            // When streaming started (for recovery)
  // Branching support
  parentId?: string | null;       // ID of parent message in tree
  branchIndex?: number;           // Index among siblings (0-based)
  siblingCount?: number;          // Total siblings at this branch point
  activeBranchIndex?: number;     // Currently active sibling index
  // Per-message metadata (footer). Populated for assistant messages when the
  // upstream provider reports usage/cost; nullable so old rows don't render
  // a footer. See `server/db/migrations/014-message-meta.sql`.
  /** Total stream wall-clock duration in milliseconds (server measured). */
  latencyMs?: number | null;
  /** Prompt/input tokens reported by the provider. */
  usagePromptTokens?: number | null;
  /** Completion/output tokens reported by the provider. */
  usageCompletionTokens?: number | null;
  /** Best-effort cost in USD cents. May be null even when token counts exist. */
  costCents?: number | null;
  /**
   * Lo SCORPORO di `usagePromptTokens`: quanta parte era cache. Quote DISGIUNTE —
   * prompt = fresco + read + creation + creation1h, e `cacheCreationTokens` NON
   * include `cacheCreation1hTokens`. Vedi `server/db/migrations/070`.
   *
   * `null`/assente ≠ 0: assente vuol dire "non lo sappiamo" (riga anteriore alla
   * 070, provider che non riporta l'usage), 0 vuol dire "misurato, nessuna cache".
   */
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  cacheCreation1hTokens?: number | null;
  /**
   * Il modello che ha prodotto il turno. Il server lo conosce nell'istante in cui
   * calcola `costCents` e prima della migration 076 lo buttava: restava il
   * risultato del prezzo, non l'input che lo aveva determinato — e un costo senza
   * la sua tariffa non è verificabile né correggibile.
   *
   * `null`/assente sulle righe anteriori alla 076: non è ricostruibile.
   */
  model?: string | null;
}

export interface CreateTopicRequest {
  name: string;
  parentId?: string;
  color?: string;
  icon?: string;
  systemPrompt?: string;
  projectPath?: string;
  /** Phase A · TOPIC-WT-01. Optional binding to a Worktree. */
  worktreeId?: string | null;
  /** Phase C · TOPIC-IM-01. Optional one-shot initial message. */
  initialMessage?: string;
}

export interface UpdateTopicRequest {
  name?: string;
  color?: string;
  icon?: string;
  parentId?: string;
  systemPrompt?: string;
  contextFiles?: string[];
  pinnedMessages?: string[];
  projectPath?: string;
  autonomyLevel?: AutonomyLevel;
  provider?: string | null;
  /** Set to a model id to persist as the topic's last-used model; null clears. */
  model?: string | null;
  /**
   * Set the per-topic reasoning-effort tier (migration 033). One of
   * low/medium/high/xhigh/max; null/""/"default" clears the override. The
   * server validates the tier, forces an idle CLI respawn so it applies on the
   * next turn, and broadcasts `topic:updated` for cross-window sync.
   */
  effort?: string | null;
  /**
   * Set Fast Mode for this topic. Persists; null/undefined leaves it unchanged.
   * The server broadcasts `topic:updated` so other open windows for the same
   * topic stay in sync. See `server/db/migrations/024-topic-fast-mode.sql`.
   */
  fastMode?: boolean | null;
  /**
   * Per-topic notification mute (migration 073). `true` silences this topic's
   * completion banner + sound; the completion still counts toward the app
   * badge. null/undefined leaves it unchanged. The server broadcasts
   * `topic:updated` so every open window re-gates immediately.
   */
  muted?: boolean | null;
  disabledContextSources?: string[];
  /** Phase A · TOPIC-WT-01. Pass `null` to clear the binding. */
  worktreeId?: string | null;
  /** Phase C · TOPIC-IM-01. Pass `null` (or "") to clear after dispatch. */
  initialMessage?: string | null;
}

export interface LinkTopicRequest {
  targetId: string;
}

export interface ChatRequest {
  sessionKey: string;
  messages: Message[];
  /**
   * Fast Mode flag for this turn. When `true` AND no per-message `model`
   * override AND `topic.model` is null, the server resolves the effective
   * model via `getFastModelFor(provider.name)` (e.g. claude-haiku for
   * claude-code, gpt-4o-mini for openai/codex). Picker wins over fast.
   */
  fastMode?: boolean;
  /** Per-message provider override (e.g. "claude-code", "codex"). Falls back to topic.provider or global default. */
  provider?: string;
  /** Per-message model override. Ignored by providers without per-call model selection. */
  model?: string;
  /**
   * Chiave di idempotenza dell'invio: il server la ricorda appena ha scritto la
   * riga utente e risponde 409 `duplicate_message` a chi la ripete. Serve a un
   * caso solo, ma è quello che perdeva i messaggi: la connessione che muore
   * prima che la risposta cominci. Da qui «il server non l'ha ricevuto» e «l'ha
   * ricevuto e poi è caduto» sono identici, e chiedono l'opposto — rispedire o
   * non rispedire. Con la chiave si rispedisce sempre, e decide il server.
   */
  clientMessageId?: string;
}

// ============ Providers ============
// ProviderStatus / ProviderRequirement / ProviderSnapshotEntry /
// ProvidersSnapshot now live in shared/types.ts. Re-exported at the
// top of this file for back-compat with existing imports.

export interface HistoryRequest {
  limit?: number;
  offset?: number;
}

export interface HistoryMessage extends Message {
  id?: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  media?: string[];
  partial?: boolean;
}

export interface HistoryResponse {
  messages: HistoryMessage[];
  total?: number;
  hasOrphanedMessage?: boolean;
  isStreaming?: boolean;
  streamState?: {
    startedAt: string;
    isThinking: boolean;
  } | null;
}

export interface UploadResponse {
  path: string;
  filename: string;
  size: number;
}

export interface SearchResult {
  /** SQLite message id when the hit comes from the live messages table;
   *  null for legacy JSONL transcript hits (no stable id → open only). */
  messageId: string | null;
  sessionKey: string;
  topicId: string | null;
  topicName: string;
  topicIcon: string;
  role: string;
  content: string;
  timestamp: string | null;
}

// ---------------------------------------------------------------------------
// WebSocket message discriminated union
// ---------------------------------------------------------------------------
//
// `WSMessage` is the type emitted by `useWebSocket` and consumed by every
// handler the app registers. Variants below cover messages the client
// actively narrows on; everything else falls through to `WSUnknownMessage`
// (loose `[k: string]: unknown` — strictly better than `any` because reads
// require explicit narrowing).
//
// Adding a new typed variant: define an interface below, append it to the
// `WSMessage` union, then handlers narrowing on `msg.type === '<literal>'`
// automatically get the correct payload shape. No central registry edit.
//
// Server side broadcasts via `broadcastToAll(message: object)` — the wire
// format isn't enforced. These types document intent at the boundary; if the
// server changes a payload shape, narrowing here may surface stale reads.

// --- Snapshot / settings -----------------------------------------------------
export type { WSProvidersSnapshotMessage } from '../../../shared/types';
// 3.4 — il goal della chat: forma unica in shared/, niente copia qui.
export type { WSGoalUpdatedMessage, TopicGoal, GoalStepStatus } from '../../../shared/types';

export interface WSGatewayStatusMessage {
  type: 'gateway:status';
  connected: boolean;
}

// --- Topics ------------------------------------------------------------------
export interface WSTopicUpdatedMessage {
  type: 'topic:updated' | 'topic:created' | 'topic:archived';
  topic: Topic;
}

export interface WSTopicsReorderedMessage {
  type: 'topics:reordered';
  // Wire field is `order` (the server emits { order: string[] } — topics.ts).
  // Was mislabeled `topicIds`, which would read undefined in any consumer.
  order: string[];
}

export interface WSTopicSwitchCompleteMessage {
  type: 'topic:switch:complete';
  /** Original session id that just got migrated. */
  fromSessionKey: string;
  /** New session id the conversation now lives under. */
  toSessionKey: string;
  fromTopicId: string;
  toTopicId: string;
  /** First user message that triggered the switch (replayed cross-window). */
  userContent?: string;
  /** Assistant response from the switching turn. */
  assistantContent?: string;
  topicId?: string;
}

export interface WSTopicSwitchMessage {
  type: 'topic:switch';
  fromTopicId: string;
  toTopicId: string;
  toSessionKey: string;
  // Originating stream's session key — scopes the open+focus side-effect to the
  // window that drove the switch via isOwnStream(). Required on the wire (the
  // server always stamps it); inbound zod keeps it optional for version skew.
  fromSessionKey?: string;
}

export interface WSOpenProjectMessage {
  type: 'open-project';
  projectPath: string;
}

export interface WSDragMessage {
  type: 'drag:start' | 'drag:end' | 'drag:accepted' | 'drag:drop';
  /** Originating window id. Some emit sites only set `windowId`; receivers
   *  treat the two as synonyms. Both optional so the type accepts every
   *  current emit shape without forcing back-fill. */
  sourceWindowId?: string;
  windowId?: string;
  topicId?: string;
}

export type { PresenceTab } from '../../../shared/types';
// `export type { … } from` ri-esporta ma NON porta il nome in scope locale, e
// i payload di presenza qui sotto lo usano. Import separato, non è ridondanza.
import type { PresenceTab } from '../../../shared/types';

/** Cross-window presence — this window declaring the topics it holds (outbound
 *  client → server). Server rebroadcasts the full window list as
 *  `presence:windows`. WS-ephemeral; never persisted. */
export interface WSPresenceAnnounceMessage {
  type: 'presence:announce';
  windowId: string;
  windowLabel?: string;
  detached?: boolean;
  /** Lo Spazio (gruppo) a cui questa finestra è inchiodata (`?space=`), se lo
   *  è. È ciò che permette alla barra dei gruppi di dire "questo gruppo vive in
   *  una finestra sua" e di portarcela davanti invece di commutare. */
  spaceId?: string;
  topicIds: string[];
  focusedTopicId?: string;
  /** Every tab, not just the chats — see PresenceTab. Optional so an older
   *  client still announces successfully. */
  tabs?: PresenceTab[];
}

/** Per-topic delta routing — this window declaring the set of topics it
 *  currently has open (outbound client → server). The server stores it on the
 *  connection (`WSData.openTopicIds`) and routes streaming per-token deltas only
 *  to windows showing that topic. WS-ephemeral; never persisted. Re-sent on
 *  every open/close/focus change and on reconnect, so the set stays fresh. */
export interface WSSubscribeMessage {
  type: 'subscribe';
  topicIds: string[];
}

/** Full-list presence snapshot (inbound server → client). */
export interface WSPresenceWindowsMessage {
  type: 'presence:windows';
  windows: Array<{
    windowId: string;
    clientId: string;
    windowLabel?: string;
    detached?: boolean;
    spaceId?: string;
    topicIds: string[];
    focusedTopicId?: string;
    tabs?: PresenceTab[];
  }>;
}

// --- Streaming / chat --------------------------------------------------------
export interface WSStreamStartMessage {
  type: 'stream:start';
  sessionKey: string;
  /**
   * OBBLIGATORIO SUL FILO, e adesso anche qui.
   *
   * Lo schema condiviso lo dichiara richiesto (`shared/ws-outbound.ts`,
   * `streamStartSchema: messageId: z.string()`), e il commento in `useChat` lo
   * dava per scontato — «ce lo dice sempre». Questo tipo, riscritto a mano,
   * diceva il contrario: opzionale. La differenza non era teorica, teneva in
   * vita un ripiego (`event.messageId || generateMessageId()`) che ricrea un
   * difetto gia' chiuso — la riga in DB e la bolla a schermo con due nomi
   * diversi, quindi un `loadHistory` a meta' turno che disegna la stessa
   * risposta DUE volte.
   *
   * Un tipo che mente non fallisce: fa prendere in silenzio il ramo rotto.
   */
  messageId: string;
  /**
   * Il turno RIPRENDE dopo un riavvio del server: `messageId` è la bolla che
   * abbiamo già a schermo, piena, e il replay sta per ridettarla da capo. Va
   * svuotata qui, prima delle delta, o il replay si somma a quello che c'è.
   * Il record in DB non viene più toccato — vedi `reuseOrCreatePartialForReattach`.
   */
  reattached?: boolean;
  /**
   * NOBODY ASKED FOR THIS TURN: the boot resumed it by itself
   * (`server/lib/ripresa-boot.ts` resends the last user message of a turn its
   * own restart had cut). The banner reads it to say "resuming" instead of
   * offering Retry, which while a resend is running would buy a second turn.
   */
  resumedBy?: 'server';
}

export interface WSStreamEndMessage {
  type: 'stream:end';
  sessionKey: string;
  messageId?: string;
  topicId?: string;
  /** Wall-clock duration of the request in ms. Persisted on the message
   *  footer (`<duration>s · <tokens> · $<cost>`). Always present on the
   *  WS-streaming path; absent on the legacy `topic:user_abort` broadcast. */
  latencyMs?: number;
  /** Provider-reported prompt token count for the turn that just completed. */
  usagePromptTokens?: number;
  /** Provider-reported completion token count for the turn that just completed. */
  usageCompletionTokens?: number;
  /** Cost in cents (USD). Computed via `calculateCost` from prompt+completion. */
  costCents?: number;
  /** Il modello del turno, accanto al costo che ha prodotto. */
  model?: string;
  /** Lo scorporo della cache del turno appena finito (quote disgiunte). Assenti
   *  quando il provider non riporta l'usage. */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation1hTokens?: number;
  /** Free-form reason carried on non-success terminations (e.g. `user_abort`). */
  reason?: string;
  /** Vocabolario ACP del PERCHÉ del turno (`cancelled`, `refusal`, …) e CHI l'ha
   *  fermato (`watchdog`, `user`, …). Presenti solo su una fine non pulita. */
  stopReason?: string;
  stopCause?: string;
  /** The server's sentence about the failure, when the end carried one. It is
   *  the FALLBACK text of the verdict block: the banner renders the translated
   *  cause, so an end that carries only `stopCause` still explains itself. */
  error?: string;
  /** Marcatore POSITIVo di fine PULITA (`end_turn`): il modello ha chiuso da
   *  solo. Assente su annullo/limite/errore. Lo legge la push di fine risposta
   *  (server/push-triggers.ts) per non annunciare "risposta pronta" a vuoto. */
  completed?: boolean;
  /** Turno d'AGENTE guidato dalla board, non una chat umana: la push di fine
   *  risposta lo esclude. */
  dispatched?: boolean;
  /** Il turno è stato fermato prima che il modello producesse qualcosa e il
   *  segnaposto è stato CANCELLATO, non finalizzato: chi ha quella riga in
   *  pagina deve toglierla o gli resta una bolla vuota che il server non ha
   *  più. Vedi `shared/empty-turn.ts`. */
  discardedMessageId?: string;
}

// Per-event slices of a streaming assistant turn. The server's chat
// pipeline broadcasts these for cross-window sync; the local SSE stream
// that originated the turn ignores them (see `localSSESessionsRef` in
// `useChat.handleStreamEvent`) to avoid duplicate content. Every variant
// carries `sessionKey` so the receiver can route to the right pane.
export interface WSStreamThinkingStartMessage {
  type: 'stream:thinking_start';
  sessionKey: string;
}
export interface WSStreamThinkingChunkMessage {
  type: 'stream:thinking_chunk';
  sessionKey: string;
  content: string;
}
export interface WSStreamThinkingEndMessage {
  type: 'stream:thinking_end';
  sessionKey: string;
}
export interface WSStreamContentChunkMessage {
  type: 'stream:content_chunk';
  sessionKey: string;
  content: string;
}
export interface WSStreamToolCallMessage {
  type: 'stream:tool_call';
  sessionKey: string;
  toolCall: ToolCall;
}
export interface WSStreamToolResultMessage {
  type: 'stream:tool_result';
  sessionKey: string;
  /** Topic della chat che ha generato il tool. Il server lo manda da sempre
   *  (`broadcastStreamToTopic` in `server/routes/chat.ts`); serve a chi ascolta
   *  fuori dalla chat, che ragiona per topic e non conosce le sessionKey. */
  topicId?: string;
  toolCallId: string;
  status?: ToolCall['status'];
  result?: string;
  error?: string;
  detail?: ToolCall['detail'];
  /** Server-stamped close of the tool's real-usage window (epoch ms). */
  endedAt?: number;
}
export interface WSStreamToolUpdateMessage {
  type: 'stream:tool_update';
  sessionKey: string;
  toolCallId: string;
  partialResult?: string;
  /** Present when the event announces a transition instead of more output. */
  status?: ToolCall['status'];
  /** The answer that caused the transition, so the row can show it at once. */
  userResponse?: ToolUserResponse;
}
export interface WSStreamToolDetailMessage {
  type: 'stream:tool_detail';
  sessionKey: string;
  toolCallId: string;
  detail: ToolCall['detail'];
}
/** Costo/token attribuiti a UNA azione (tool call), dalla chiamata al modello
 *  che l'ha decisa. Distinto da `stream:usage` (totale del turno): patcha la
 *  singola riga del tool mentre è ancora running. */
export interface WSStreamToolUsageMessage {
  type: 'stream:tool_usage';
  sessionKey: string;
  toolCallId: string;
  tokens?: number;
  costCents?: number;
}
/**
 * I totali del turno mentre cresce — il consuntivo in diretta.
 *
 * Il server lo manda a ogni chiamata al modello (`onCallUsage`) coi valori GIÀ
 * accumulati: chi lo riceve mostra, non somma. Distinto da `stream:tool_usage`,
 * che è la quota di UNA azione.
 *
 * Non era dichiarato qui: l'unico consumatore se lo leggeva con un cast, e
 * quando è arrivato il secondo — la riga del messaggio, che deve conservare i
 * numeri attraverso i remount — il tipo mancante è saltato fuori come errore.
 * È il caso in cui il compilatore aveva ragione a lamentarsi.
 */
/**
 * Lo stream tace da un po' ma il provider è ancora collegato — e il contrario.
 *
 * Il server li annunciava già e nessuno li dichiarava: l'unico consumatore li
 * leggeva con un cast, quindi il compilatore non poteva accorgersi né di un
 * nome sbagliato né di un campo che cambia. Vale per entrambi i versi: senza
 * `stream:resumed` l'indicatore resterebbe «lento» per tutto il turno.
 */
export interface WSStreamSlowMessage {
  type: 'stream:slow';
  sessionKey: string;
  topicId?: string;
}
export interface WSStreamResumedMessage {
  type: 'stream:resumed';
  sessionKey: string;
  topicId?: string;
}
/**
 * The provider's API call failed transiently (overload, 5xx, dropped
 * connection, token renewal) and the turn is waiting to try it again.
 * `attempt` is the one that just failed, 1-based. Cleared by `stream:resumed`
 * when data flows again, and by the end of the turn.
 */
export interface WSStreamRetryMessage {
  type: 'stream:retry';
  sessionKey: string;
  topicId?: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}
export interface WSStreamUsageMessage {
  type: 'stream:usage';
  sessionKey: string;
  topicId?: string;
  /** Quante chiamate al modello in questo turno: spiega perché i letti superano la finestra. */
  calls: number;
  promptTokens?: number;
  completionTokens?: number;
  costCents?: number;
  /** Scorporo dei letti — quote DISGIUNTE, sommano a `promptTokens`. */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation1hTokens?: number;
  /** Il modello che sta macinando: serve a rendere verificabile il costo. */
  model?: string;
}
export interface WSStreamErrorMessage {
  type: 'stream:error';
  sessionKey: string;
  error?: string;
}
/** Marker di confine di compattazione (CHAT-COMPACT-01), come arriva da
 *  `GET /api/history`. UNA dichiarazione in shared/types.ts: la copia locale
 *  ometteva `topicId` e `sessionKey`, che il server manda comunque. */
export type { StoredCompactionMarker as CompactionMarker } from '../../../shared/types';
export interface WSStreamCompactionMessage {
  type: 'stream:compaction';
  sessionKey: string;
  topicId?: string;
  markerId: string;
  afterMessageId: string | null;
  trigger: 'auto' | 'manual' | 'unknown';
  preTokens?: number;
  /** Filled by a follow-up broadcast once the post-compaction context size is
   *  known (the next result's input tokens) — drives the pre→post delta. */
  postTokens?: number;
  createdAt: string;
}
/**
 * Il contesto REALE del modello, misurato su UNA chiamata
 * (`input + cache_read + cache_creation`) contro la finestra di quel modello.
 *
 * Da non confondere con il preventivo dell'envelope che mostra il Context
 * Inspector (`ContextBudgetBar`): quello è "cosa sto iniettando io", questo è
 * "cosa ha in pancia il modello adesso". Due domande diverse.
 */
export interface ContextUsage {
  used: number;
  size: number;
  /** 0–100, satura a 100. */
  percent: number;
  level: 'ok' | 'warn' | 'critical';
  /** Perché il livello non è `ok`. Vedi `ContextUpdatePayload.reason`. */
  reason?: 'window' | 'cost';
  /** true = finestra dedotta dal default perché il modello non è in tabella. */
  estimated: boolean;
  model?: string;
}
/**
 * Il blocco `usage_update` di ACP, verbatim (3.1). Arriva così sia dall'evento
 * WS che da `GET /api/context/live`: `used` e `size` stanno QUI dentro e sono
 * obbligatori — un provider non può mandare metà del rapporto e lasciare il
 * ring a indovinare il denominatore. Il resto del payload è presentazione
 * nostra e vive fuori dal blocco.
 */
export type { AcpUsageUpdate } from '../../../shared/types';
/** La sonda del costo (`GET /api/context/cost`): contesto × chiamate, e il
 *  prodotto. Il contratto sta in shared/ perché è la stessa forma che scrive il
 *  server — vedi `server/usage/cost-probe.ts`. */
export type { SessionCostProbe } from '../../../shared/types';
/** Payload sul filo: blocco ACP + presentazione. `useRealContext` lo appiattisce
 *  in `ContextUsage` per la UI, che di ACP non deve sapere niente. */
export interface ContextUpdatePayload {
  usage: AcpUsageUpdate;
  percent: number;
  level: 'ok' | 'warn' | 'critical';
  /** Perché il livello non è `ok`: `window` = la finestra sta finendo,
   *  `cost` = la finestra è ampia ma ogni chiamata rilegge già un prompt grosso.
   *  Due motivi diversi meritano due messaggi diversi. */
  reason?: 'window' | 'cost';
  estimated: boolean;
  model?: string;
}
export interface WSStreamContextMessage extends ContextUpdatePayload {
  type: 'stream:context';
  sessionKey: string;
  topicId?: string;
}
/**
 * A tool call paused the stream and is asking the user for input.
 * The client opens the inline `ToolInputForm` against `schema`; on
 * submission it `POST /api/chat/tool-response` with the resolved
 * `ToolUserResponse`. See `ToolCall.userInputSchema` for the lifecycle.
 */
export interface WSStreamToolUserInputRequiredMessage {
  type: 'stream:tool_user_input_required';
  sessionKey: string;
  topicId?: string;
  toolCallId: string;
  schema: UserInputSchema;
}
/**
 * La CLI chiede se questo strumento può partire. NON è una domanda: la riga va
 * in `awaiting_permission`, il pannello ha tre esiti esatti, e la risposta
 * torna su `POST /api/sessions/:key/permission-response` come enum — non come
 * testo dentro una mappa di risposte.
 */
/** La decisione presa su un permesso: la riga torna a girare e l'esito resta. */
export interface WSStreamToolPermissionResolvedMessage {
  type: 'stream:tool_permission_resolved';
  sessionKey: string;
  topicId?: string;
  toolCallId: string;
  outcome: ToolPermissionOutcome;
}
export interface WSStreamToolPermissionRequiredMessage {
  type: 'stream:tool_permission_required';
  sessionKey: string;
  topicId?: string;
  toolCallId: string;
  request: ToolPermissionRequest;
}
/**
 * Sent by the server when a client reconnects mid-stream. Carries the
 * accumulated buffer so the late joiner doesn't see a blank assistant
 * message until the next chunk arrives.
 */
export interface WSStreamCatchupMessage {
  type: 'stream:catchup';
  sessionKey: string;
  // Mirrors the wire shape — server emits topicId so cross-window UI can
  // route the catchup to the right topic row even when no client is
  // currently focused on it.
  topicId?: string;
  content?: string;
  thinking?: string;
  isThinking?: boolean;
  messageId?: string;
  /**
   * Tool calls already attached to the partial message in DB. Without these
   * the late joiner sees text-only content and loses any tools that ran
   * before they connected — the chronological timeline gets a hole that
   * the next `stream:tool_call` event cannot fill (it appends, not inserts).
   */
  toolCalls?: ToolCall[];
  /**
   * Chronological blocks timeline (text/thinking/tool interleaved) from DB.
   * Mirrors `StoredMessage.blocks` — preferred by the renderer when present.
   */
  blocks?: ContentBlock[];
}

/**
 * Lightweight presence event — another window in the same browser session
 * (or another connected client) is composing a reply on `topicId`. The
 * UI shows an "X is typing…" hint for ~2s.
 */
export interface WSTypingMessage {
  type: 'typing';
  topicId: string;
  text?: string;
}

export interface WSMessageNewMessage {
  type: 'message:new';
  topicId: string;
  sessionKey: string;
  role: 'user' | 'assistant';
  /** Stable message id — used for cross-window dedupe. Optional for legacy
   *  broadcasts; receivers fall back to last-of-role/content matching. */
  messageId?: string;
  /** Full message body — receivers also accept `preview` as a fallback. */
  content?: string;
  /** First 100 chars, used for unread previews. */
  preview?: string;
  message?: { id: string; role: string; content: string; timestamp?: string };
}

/** Inline media (images/files) appended to the last assistant message. */
export interface WSMessageMediaMessage {
  type: 'message:media';
  sessionKey: string;
  media: string[];
}

/** Server requests the client to drop a session's local message buffer. */
export interface WSClearMessage {
  type: 'clear';
  sessionKey: string;
}

// --- Sessions ----------------------------------------------------------------
export interface WSTerminalSessionsMessage {
  type: 'terminal:sessions';
  sessions: TerminalSessionInfo[];
  /**
   * `sessions: []` va creduto, o vuol dire "non lo so ancora"? Il server
   * trasmette anche prima che `reconcileSessions` abbia finito, quindi il secondo
   * caso è reale a ogni riavvio. Facoltativo: un bundle vecchio non lo manda, e
   * assente significa "non lo so". Vedi `hooks/rosterTrust.ts`.
   */
  reconciled?: boolean;
}

/** Per-session pty activity. Server-tracked from the central pty data path so
 *  it covers every session, mounted or not. `finished` marks an active→idle
 *  transition (a completed turn) — used to raise a notification for
 *  claude-code. `kind` is the session type. */
export interface WSTerminalActivityMessage {
  type: 'terminal:activity';
  id: string;
  busy: boolean;
  finished?: boolean;
  kind?: TerminalSessionType;
}

// --- Notifications -----------------------------------------------------------
/** Initial unread snapshot sent on WS connect. Keyed by topicId. */
export interface WSUnreadInitMessage {
  type: 'unread:init';
  data?: Record<string, { lastReadAt: string; unreadCount: number }>;
}
export interface WSUnreadUpdatedMessage {
  type: 'unread:updated';
  topicId: string;
  unreadCount: number;
}

/**
 * Emitted by the server to ask listeners to bring a topic's pane into focus.
 */
export interface WSPaneFocusSuggestMessage {
  type: 'pane:focus-suggest';
  topicId: string;
  /** Present when the focus was triggered by a board task (jump-to-tab). */
  taskId?: string;
  /**
   * When set, the listener opens this project window and nests the topic
   * inside it. Sent inline (rather than read from the topic) so the client
   * needn't wait for a preceding topic:updated to land first — used when a
   * session binds itself to a project via the bind/create/open-project
   * control endpoints or the /project command.
   */
  projectPath?: string;
}

/**
 * Lightweight "is doing something" presence ping per agent. Distinct from
 * heartbeat because consumers may want to update activity UI more often
 * than they refresh the heartbeat map.
 */
export interface WSAgentActiveMessage {
  type: 'agent_active';
  agentId: string;
  projectId?: string;
}

export interface WSDashboardUpdatedMessage {
  type: 'dashboard:updated' | 'cron:updated';
}

// --- Misc resource-update broadcasts ---------------------------------------
/** Memory store changed — consumers refetch. `scope` narrows the refresh
 *  (e.g. only the global memory or a specific topic's memory); when absent
 *  consumers refresh everything. */
export interface WSMemoryUpdatedMessage {
  type: 'memory:updated';
  projectId?: string;
  scope?: 'global' | 'topic';
  topicId?: string;
}
/** Repo git status snapshot updated. */
export interface WSGitStatusMessage {
  type: 'git:status';
  projectPath?: string;
  projectId?: string;
  status?: unknown;
}
/**
 * Qualcosa è cambiato sul filesystem del progetto.
 *
 * Senza payload di proposito: chi ascolta ricarica il pezzo che gli serve.
 * Spedire l'albero vorrebbe dire ricalcolare e trasmettere migliaia di voci a
 * ogni salvataggio, e chi lo riceve dovrebbe comunque riconciliare le cartelle
 * che ha caricato pigramente.
 */
export interface WSFilesChangedMessage {
  type: 'files:changed';
  projectPath: string;
}
/** Scripts list (package.json scripts etc.) changed. */
export interface WSScriptsUpdatedMessage {
  type: 'scripts:updated';
  projectPath?: string;
  projectId?: string;
  /** Full scripts payload — opaque to the type system; consumers cast. */
  scripts?: unknown;
}
/** Browser pane navigation broadcast. */
export interface WSBrowserNavigateMessage {
  type: 'browser:navigate';
  /** Topic that asked to surface the URL (membership guard + spawner tracking). */
  topicId: string;
  url: string;
  /**
   * Browser-pane contextId the pane must register its native CDP target under
   * (== resolveContextIdForTopic(topic) === topic.id). Lets the agent's
   * browser_observe/act/eval resolve the SAME native view the pane drives,
   * instead of an invisible Playwright phantom. Absent → legacy random id.
   */
  contextId?: string;
}
/**
 * Open a browser pane in the same layout group as a specific pane, then
 * navigate it. Emitted when a Claude Code *terminal* calls open_browser_pane
 * (the chat path uses topic-targeted `browser:navigate` instead). `paneId` is
 * the terminal's pane id (`terminal:<sessionId>`); whichever layout currently
 * renders that pane — standalone or project — opens the browser beside it.
 */
export interface WSBrowserOpenNearPaneMessage {
  type: 'browser:open-near-pane';
  paneId: string;
  /**
   * Deterministic browser contextId the pane must register under (e.g.
   * `term-<terminalId>`). Lets the server's observe/act/import-chrome routes
   * resolve the SAME pane the terminal opened — so a terminal can drive it,
   * not just open it. Absent → legacy behaviour (singleton picks an id).
   */
  contextId?: string;
  url: string;
}
/**
 * Fallback: open_browser_pane could not mount a VISIBLE native pane in any
 * rendered cell (the spawner terminal/topic isn't a tab anywhere), so the server
 * asks the PRIMARY window to force one open — otherwise the agent would drive an
 * off-screen browser the user can't see. The client routes this through
 * openBrowserPane (single-owner, idempotent). The url is then loaded by the
 * server over CDP once the forced pane registers its native target.
 */
export interface WSBrowserForceOpenMessage {
  type: 'browser:force-open';
  /** Deterministic browser contextId to mount the visible pane under. */
  contextId: string;
  url: string;
}
/**
 * Task-owned browser open (feature-flagged, server env TOPICS_TASK_BROWSER):
 * the agent working a task called open_browser_pane on its dispatch topic, so
 * instead of the layout-level `browser:navigate` the server forks a task-scoped
 * open. The GLOBAL layout hooks (usePaneOrdering / useProjectLayout) DELIBERATELY
 * ignore this frame — that's the fork that keeps the tab out of the global pane
 * store; only the task's in-drawer group (state/taskBrowserTabs via
 * useTaskBrowserTabsSync) consumes it, upserting `{contextId,url}` under `taskId`.
 * `contextId` is the canonical, self-describing `task-<id8>-…` the pane registers
 * its native target under, so the agent's browser_* tools drive the SAME tab.
 */
export interface WSBrowserOpenTaskTabMessage {
  type: 'browser:open-task-tab';
  /** Task that owns the tab group (its ui-state key `task-browser-tabs:<taskId>`). */
  taskId: string;
  /** Canonical task-scoped browser contextId (`task-<id8>-…`). */
  contextId: string;
  url: string;
  /** Il NOME prescritto dall'agente per questa tab (`open_browser_pane({url,
   *  name})`). Assente quando non ne ha dato uno: l'etichetta resta il titolo
   *  della pagina. Presente ⇒ entra come `titleSource:'agent'`, cioè pinnato. */
  title?: string;
}
/**
 * Remote pane close (close_browser_pane MCP tool / REST): every window that
 * renders `browser:<contextId>` closes it through its NORMAL close flow (same
 * as the tab's X — closedStack tombstone, membership persist, native
 * teardown), so live clients converge instead of clobbering a server-side
 * state edit back. Windows that don't own the pane ignore the frame.
 */
export interface WSBrowserClosePaneMessage {
  type: 'browser:close-pane';
  contextId: string;
}
/**
 * Remote pane focus (browser_focus_tab MCP tool / REST): every window that
 * renders `browser:<contextId>` brings that tab to the front (activates it in
 * its group / surfaces it if backgrounded). Same client-originated, idempotent
 * model as close-pane — windows that don't own the pane ignore the frame.
 */
export interface WSBrowserFocusPaneMessage {
  type: 'browser:focus-pane';
  contextId: string;
}
/**
 * Pane / sidebar UI state replicated across windows (Phase 30 PANE-02).
 * Split into init (full snapshot keyed by store key) vs updated (single
 * key/value pair) so consumers can narrow without optional-field casts.
 */
export interface WSUIStateInitMessage {
  type: 'ui-state:init';
  /** Full snapshot keyed by `useServerState` key. */
  data?: Record<string, unknown>;
  // Wire fields are server_seq / sourceClientId (ui-state.ts + ws-outbound).
  // Were mislabeled seq/originId — a future LWW/echo consumer would read
  // undefined and reintroduce duplicate-echo / stale-ordering bugs.
  server_seq?: number;
  sourceClientId?: string;
}
export interface WSUIStateUpdatedMessage {
  type: 'ui-state:updated';
  /** The store key that changed. */
  key: string;
  /** The new value for that key. Opaque to the type system. */
  value: unknown;
  server_seq?: number;
  sourceClientId?: string;
}

// --- Project + Worktree (Phase A · migrations 016-018) ----------------------
export interface WSProjectMessage {
  type: 'project:new' | 'project:updated' | 'project:archived' | 'project:deleted';
  /** Full row on new/updated/archived; `{ id }` on deleted. */
  project: Partial<Project> & { id: string };
  payload_version?: 1;
}

export interface WSWorktreeMessage {
  type: 'worktree:new' | 'worktree:updated' | 'worktree:deleted';
  /** Full row on new/updated; `{ id }` on deleted. */
  worktree: Partial<Worktree> & { id: string };
  payload_version?: 1;
}

export interface WSMachineMessage {
  type: 'machine:upserted' | 'machine:updated' | 'machine:deleted';
  machine: Partial<Machine> & { id: string };
  payload_version?: 1;
}

// --- Catch-all ---------------------------------------------------------------
// Non c'è un tipo catch-all. C'era (`WSUnknownMessage`, `{ type: string;
// [k: string]: unknown }`), tenuto FUORI dall'unione perché come membro il suo
// `type: string` avrebbe allargato `WSMessage['type']` a `string`, distruggendo
// il narrowing per literal su ogni handler. Fuori dall'unione, però, non gli è
// rimasto nessun chiamante: la forward-compatibility non passa dal tipo ma dal
// runtime — il server può mandare qualsiasi `{type, …}` e gli handler filtrano
// già con `if (msg.type === '<literal>')`, quindi i tipi sconosciuti cadono nel
// vuoto da soli. Se un giorno servisse ispezionarne uno, il cast sul posto è
// `as { type: string; [k: string]: unknown }`.

// ─── Claude Code session lifecycle (see openspec/changes/claude-session-tracker) ──

export type { ClaudeSessionPhase } from '../../../shared/types';

/**
 * The two visual tiers of "a session needs you", split so the UI can paint them
 * differently (the status-system redesign):
 *   - 'input' — a permission prompt mid-task (awaiting-approval): you must ACT
 *     now. Painted LOUD (amber, assertive pulse).
 *   - 'done'  — the turn finished or timed out (awaiting-user / paused): look
 *     when you're ready. Painted CALM (blue, gentle breathe).
 * Single definition shared by signals.ts (derivation) and selectionStyles.ts
 * (surface colours) so every surface agrees on the tier→colour mapping.
 */
export type AttentionTier = 'input' | 'done';

// UNA dichiarazione in shared/types.ts. La copia locale era una versione
// RIDOTTA dello stato che il server manda: senza `jsonlPath`, `jsonlOffset` e
// `createdAt`, che arrivano a ogni broadcast `session:state`.
export type {
  ClaudeSessionPendingApproval,
  ClaudeSessionState,
} from '../../../shared/types';

export interface WSSessionStateMessage {
  type: 'session:state';
  /** Null for topic-less terminal claude sessions — key off state.claudeSessionId. */
  sessionKey: string | null;
  state: ClaudeSessionState;
}

/** A board task just ENTERED review — the end-of-task cue. Emitted IN ADDITION
 *  to (not instead of) `task:updated`, only on the transition edge, so the
 *  completion notifier fires exactly once per delivery. `taskId` makes the OS
 *  banner clickable → opens that task's drawer (openTaskInApp). */
export interface WSTaskReviewReadyMessage {
  type: 'task:review-ready';
  projectId: string;
  taskId: string;
  taskTitle: string;
  reason?: string;
  /**
   * La domanda pendente dell'agente, quando la consegna È una domanda: le sue
   * opzioni diventano i TASTI del banner (shared/notify-actions).
   *
   * Tre stati, non due: l'oggetto = c'è una domanda · `null` = il server ha
   * guardato e domanda non ce n'è · ASSENTE = un server che questo campo non lo
   * manda (più vecchio del client — il guscio desktop e il demone si aggiornano
   * separatamente). Nel terzo caso il client se la va a prendere invece di
   * indovinare: vedi useCompletionNotifier.
   */
  question?: { text: string; options: string[] } | null;
}

/** Il gemello di FALLIMENTO: il task è stato PARCHEGGIATO e non riparte da
 *  solo. Emesso solo sul park terminale (mai su una rimessa in coda, che si
 *  auto-guarisce). `state`: 'failed' = l'agent non ha prodotto niente,
 *  'blocked' = c'è una configurazione da sistemare, 'waited_out' = la serie di
 *  attese dichiarate ha sfondato il tetto (niente da riparare: una condizione
 *  che non arriva). Tre stati perché sono tre domande diverse per l'umano, e la
 *  copy del banner cambia su questo campo. */
export interface WSTaskParkedMessage {
  type: 'task:parked';
  projectId: string;
  taskId: string;
  taskTitle: string;
  state: 'failed' | 'blocked' | 'waited_out';
  reason?: string;
}

/** A board task was ARCHIVED (the board's soft-delete). `taskIds` carries the
 *  whole archived subtree — archiving a parent cascades to its children, and
 *  anything holding per-task state must forget all of them, not just the root.
 *  Older servers omit it; fall back to `[taskId]`.
 *
 *  Typed here because `useTaskBrowserTabsSync` acts on it: the server has just
 *  deleted `task-browser-tabs:<id>` / `task-browser-layout:<id>`, so the client
 *  must drop its cache AND its pending debounced PUT. */
export interface WSTaskDeletedMessage {
  type: 'task:deleted';
  projectId: string;
  taskId: string;
  taskIds?: string[];
}

/** Una notifica è appena stata REGISTRATA (migration 102). Porta la riga intera
 *  e il conteggio: il tastino accanto a Topics si aggiorna dal vivo senza
 *  rileggere l'elenco. */
export interface WSNotificationNewMessage {
  type: 'notification:new';
  row: NotificationRow;
  unseen: number;
}

/** Il «visto» è stato applicato — il contatore vale ORA questo. Il «visto» è
 *  globale, quindi guardare la cronologia da una finestra spegne il pallino su
 *  tutte le altre. */
export interface WSNotificationSeenMessage {
  type: 'notification:seen';
  unseen: number;
}

export type WSMessage =
  | WSNotificationNewMessage
  | WSNotificationSeenMessage
  | WSTaskDeletedMessage
  | WSProvidersSnapshotMessage
  | WSGoalUpdatedMessage
  | WSGatewayStatusMessage
  | WSTopicUpdatedMessage
  | WSTopicsReorderedMessage
  | WSTopicSwitchCompleteMessage
  | WSTopicSwitchMessage
  | WSOpenProjectMessage
  | WSDragMessage
  | WSPresenceAnnounceMessage
  | WSSubscribeMessage
  | WSPresenceWindowsMessage
  | WSStreamStartMessage
  | WSStreamEndMessage
  | WSStreamThinkingStartMessage
  | WSStreamThinkingChunkMessage
  | WSStreamThinkingEndMessage
  | WSStreamContentChunkMessage
  | WSStreamToolCallMessage
  | WSStreamToolResultMessage
  | WSStreamToolUpdateMessage
  | WSStreamToolDetailMessage
  | WSStreamToolUsageMessage
  | WSStreamUsageMessage
  | WSStreamSlowMessage
  | WSStreamResumedMessage
  | WSStreamRetryMessage
  | WSStreamErrorMessage
  | WSStreamCompactionMessage
  | WSStreamContextMessage
  | WSStreamToolUserInputRequiredMessage
  | WSStreamToolPermissionRequiredMessage
  | WSStreamToolPermissionResolvedMessage
  | WSStreamCatchupMessage
  | WSTypingMessage
  | WSMessageNewMessage
  | WSMessageMediaMessage
  | WSClearMessage
  | WSTerminalSessionsMessage
  | WSTerminalActivityMessage
  | WSUnreadInitMessage
  | WSUnreadUpdatedMessage
  | WSPaneFocusSuggestMessage
  | WSAgentActiveMessage
  | WSDashboardUpdatedMessage
  | WSMemoryUpdatedMessage
  | WSGitStatusMessage
  | WSFilesChangedMessage
  | WSScriptsUpdatedMessage
  | WSBrowserNavigateMessage
  | WSBrowserOpenNearPaneMessage
  | WSBrowserForceOpenMessage
  | WSBrowserOpenTaskTabMessage
  | WSBrowserClosePaneMessage
  | WSBrowserFocusPaneMessage
  | WSUIStateInitMessage
  | WSUIStateUpdatedMessage
  | WSProjectMessage
  | WSWorktreeMessage
  | WSMachineMessage
  | WSTaskReviewReadyMessage
  | WSTaskParkedMessage
  | WSSessionStateMessage;
// (Nota storica: una forma precedente includeva un catch-all `{ type: string }`
// come membro dell'unione, e il suo `type` allargato a `string` rompeva il
// narrowing per literal su ogni handler. Vedi il blocco «Catch-all» qui sopra.)
// This was the contract before Phase A and the consumers we don't own
// (useBoard.ts, useChat.ts, …) still assume the wider shape. The new
// typed members above (WSProjectMessage, WSWorktreeMessage, …) are
// usable by their own consumers via discriminant checks; existing
// consumers are unaffected.

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface TopicTemplate {
  name: string;
  icon: string;
  color: string;
  systemPrompt: string;
  description: string;
}

export interface FileNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  size?: number;
  modified?: string;
  children?: FileNode[];
}




// git status of a folder: one declaration for both sides, see shared/git-status.ts
export type { GitStatus, GitStatusFile as GitFile } from '../../../shared/git-status';

export interface GitBranch {
  name: string;
  current: boolean;
  /** Solo per `isRemote`: il remote di provenienza (`origin`, `upstream`, …). */
  remote?: string;
  isRemote: boolean;
  /** Solo per `isRemote`: il nome SENZA il prefisso del remote — è questo che
   *  va passato al checkout. Passare `name` (`origin/foo`) stacca HEAD. */
  shortName?: string;
  ahead?: number;
  behind?: number;
}

export interface GitLogEntry {
  hash: string;
  shortHash?: string;
  message: string;
  author: string;
  date: string;
  ago: string;
}

/** Un file dentro un commit: cosa gli è successo e quanto è cambiato. */
export interface GitCommitFile {
  path: string;
  /** Una lettera: A, M, D, R, C, T. */
  status: string;
  origPath?: string;
  added: number;
  removed: number;
  binary?: boolean;
}

/**
 * Uno script del progetto, da qualunque manifest. La dichiarazione sta in
 * `shared/project-scripts.ts` — la produce il server e la consuma questa UI,
 * quindi è un tipo che attraversa il filo e ne esiste UNA copia sola.
 */
export type { DetectedScript } from "../../../shared/project-scripts";

/**
 * Un blocco di modifiche dentro un file, per la lista che permette di metterne
 * in stage uno alla volta. Non porta le righe: il diff sta nel visualizzatore
 * accanto, qui serve solo scegliere.
 */
export interface GitHunkSummary {
  index: number;
  /** Il testo dopo `@@`: di solito la funzione che contiene il blocco. */
  context: string;
  added: number;
  removed: number;
  /** La riga in cui comincia nel file com'è nell'indice. */
  oldStart: number;
}

/** Un commit aperto: i suoi metadati più i file che ha toccato. */
export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  ago: string;
  date: string;
  files: GitCommitFile[];
}

export type PanelTab = 'chat' | 'files' | 'changes' | 'processes' | 'browser' | 'terminal';

export interface TerminalSessionInfo {
  id: string;
  name: string;
  createdAt: string;
  cwd: string;
  command: string;
  clients: number;
  topicId?: string;
  type: TerminalSessionType;
  claudeSessionId?: string | null;
  /** sessionKey of the orchestrator that spawned this session as a sub-agent.
   *  Null for human-/chat-created sessions. Lets the roster nest sub-agents
   *  under the session that spawned them. */
  parentSessionKey?: string | null;
  /** Authoritative pty-busy snapshot from the server roster. Used to
   *  reconcile loading state so a missed terminal:activity busy:false delta
   *  (server restart / WS reconnect / dropped message) can't leave a session
   *  spinning forever. Absent on optimistic/cached entries → treated idle. */
  busy?: boolean;
}

// ── Pane types — single source of truth lives in state/pane/types.ts ─────────
// The pane-store reducer owns the canonical `Pane` + `PaneType` shapes. This
// file re-exports them so existing `import { Pane } from '@/types'` call sites
// continue to compile without churn during the cutover. New code should import
// directly from '@/state/pane/types'.
export type { Pane, PaneType } from '../state/pane/types';
// Solo i TIPI passano di qui. `PANE_TYPES` (l'array runtime da cui `PaneType` è
// derivato) si importa da '@/state/pane/types' — è già quello che fanno tutti i
// chiamanti veri, sanitizer compreso. Ri-esportarlo "per comodità di un futuro
// picker" creava un secondo nome per la stessa lista senza un consumatore.

// Pane Groups — each group has its own tab bar (like VS Code editor groups)
export type PaneGroupType = 'chat' | 'file' | 'utility';

export interface PaneGroup {
  id: string;
  paneIds: string[];
  activePaneId: string;
  type: PaneGroupType;
}

/**
 * Optional vertical sub-stack inside a single COLUMN of a `GroupLayoutRow`
 * (the project-window twin of `PanelGridCellStack`). A row's columns are
 * `groupIds[colIdx]` — one group per column. When the user drops a tab on a
 * column's top/bottom edge (or hits "Split Down"), we split JUST that column
 * vertically instead of inserting a full-width row under every column. The
 * soloed group is appended to `cellStacks[primaryGroupId].groupIds` and the
 * renderer composes the cell as `[primary, ...stack.groupIds]` stacked
 * top-to-bottom — leaving the row's sibling columns full-height.
 *
 * Invariants (mirrors PanelGridCellStack):
 *   - `groupIds` holds ONLY the additional groups below the primary; the
 *     primary (`row.groupIds[colIdx]`) is NOT included.
 *   - `heights.length === groupIds.length + 1` (primary slot + each member),
 *     every entry > 0, sum ≈ 1.
 *   - a column with no vertical split simply has no `cellStacks` entry, so the
 *     single-group-per-column legacy case stays `cellStacks` being absent.
 */
export interface GroupCellStack {
  groupIds: string[];
  heights: number[];
}

export interface GroupLayoutRow {
  groupIds: string[];
  widths: number[];       // fractions summing to 1
  /**
   * Optional per-column vertical stacks, keyed by the column's primary
   * `groupIds[colIdx]`. Present only for columns split vertically; absent for
   * the legacy single-group-per-column case. Persisted to the project layout.
   */
  cellStacks?: Record<string, GroupCellStack>;
}

/**
 * Optional vertical sub-stack inside a single cell of a `PanelGridRow`.
 *
 * Why this is additive (vs reshaping `itemKeys` into a list of cells): the
 * row's primary layout is already `itemKeys[colIdx]` → one pane per cell.
 * 99% of cells today host exactly one item; we don't need to pay the cost
 * of restructuring 40+ read sites in PanelGrid for that common case. When
 * the user splits-down on a tab inside cell C, we append the soloed pane
 * to `cellStacks[itemKeys[C]]` and the renderer composes it as a vertical
 * stack below the primary — leaving the row's columns intact.
 *
 * Invariants:
 *   - items.length === heights.length
 *   - heights[i] > 0, sum(heights) === 1 (small float drift tolerated)
 *   - the primary item (`itemKeys[colIdx]`) is NOT included in `items`;
 *     conceptually the cell renders [primary, ...stack.items] vertically
 *     with [primary_height, ...stack.heights] proportions, but storing
 *     only the *additional* items keeps the legacy single-pane case as
 *     `cellStacks` simply being absent.
 */
export interface PanelGridCellStack {
  items: string[];
  heights: number[];
}

export interface PanelGridRow {
  itemKeys: string[];     // GridItem.key values in this row (one per cell)
  widths: number[];       // fractions summing to 1 per row
  /**
   * Optional vertical sub-stacks keyed by the primary `itemKeys[colIdx]`.
   * Present only for cells that have been split vertically. Persisted to
   * localStorage when present; absent for the legacy single-pane case.
   */
  cellStacks?: Record<string, PanelGridCellStack>;
}

/** Preferenze della UI. Omonimo ma NON parente dell'`AppSettings` di
 *  `server/services/app-settings.ts`, che è la config dei provider AI
 *  (modello, max tokens, effort) e non ha un campo in comune con questo. */
export interface AppSettings {
  fontSize: number;       // 12-18
  messageDensity: 'compact' | 'comfortable';
  sidebarWidth: number;   // 180-400
  sidebarCollapsed: boolean;
  /**
   * La larghezza a cui la sidebar torna quando si RIAPRE, in px.
   *
   * Serve perché `sidebarWidth` è una cosa sola per due stati diversi:
   * chiudere la sidebar trascinandola la porta al minimo (180) e quel valore
   * viene salvato come preferenza permanente, così alla riapertura non c'è più
   * niente da ripristinare — la misura scelta a mano è andata. Qui si tiene
   * l'ULTIMA larghezza da aperta, che è quella a cui tornare.
   *
   * `undefined` (e non 180) è il default: senza una larghezza da aperta mai
   * registrata non si finge di averne una — chi legge deve poter distinguere
   * «non l'ho mai vista aperta» da «l'ho vista aperta al minimo».
   */
  sidebarWidthExpanded?: number;
  // Topic / agent completion notifications (in-app toast + native Electron).
  // Surfaced in Settings → Notifications. When `notificationsEnabled` is
  // false, no toast and no native notification fires for completions, and the
  // sub-toggles are ignored. `notifyEvenWhenFocused` lets the desktop
  // notification fire even when the corresponding topic is the focused tab —
  // useful when several topics run in parallel and the user wants the cue
  // even on the visible one.
  notificationsEnabled: boolean;
  notificationsSound: boolean;
  notifyEvenWhenFocused: boolean;
  // Per-PROJECT notification mute — a list of project paths whose topics'
  // agent-completion banners are silenced (no banner, no sound). A completion
  // in a muted project STILL counts toward the app badge (setAppBadge): the
  // count is untouched, only the interruption is. Persisted server-side via the
  // `settings` ui-state key (like every other AppSettings field) so the mute
  // holds across clients. Per-TOPIC mute lives on the topic itself
  // (Topic.muted, migration 073); this is the project-wide counterpart, keyed
  // by projectPath because a project has no guaranteed per-entity settings row.
  mutedProjects: string[];
  // NB: `enableNewChat` è stato RIMOSSO (2026-08-06). Esisteva perché una chat
  // nuova sembrava un turno a consumo; non lo è — il path `claude-code` pesca
  // dall'abbonamento Pro/Max. Il default era già passato a `true`, ma il valore
  // salvato (`false`) lo scavalcava per sempre su ogni client che l'aveva
  // toccato una volta: la voce "New Chat" spariva da TUTTI e sei gli host del
  // menu "+" senza che niente lo dicesse. Un interruttore che può solo rompere
  // non è una feature. Non reintrodurlo: se un giorno servisse davvero gatare
  // la creazione di chat, il gate va sul MOTIVO (provider a consumo), non su un
  // booleano di preferenza.
  /**
   * La lingua dell'interfaccia. `auto` segue il browser.
   *
   * Le stringhe convertite passano da `lib/i18n.ts`; quelle non ancora convertite
   * restano com'erano, quindi cambiare lingua oggi sposta le superfici già
   * migrate e lascia le altre — la migrazione è per superficie, non a tappeto,
   * perché ~190 testi cambiati in un colpo renderebbero indistinguibile un
   * errore vero da una stringa spostata nella suite e2e.
   */
  language?: 'auto' | 'it' | 'en';
  // EXPERIMENTAL, desktop-only. When on, every window split and the sidebar
  // render as detached, rounded "floating" cards separated by small gaps that
  // reveal the macOS window vibrancy underneath — making the split layout
  // easier to read. Gated to Electron (relies on native vibrancy) and ignored
  // on web/PWA. Surfaced in Settings → Appearance. Defaults OFF.
  floatingSplits: boolean;
  // Qui c'era `workingGlow`, l'interruttore dell'aura animata attorno alle pane
  // che lavorano. L'aura viene rimossa del tutto: un campo di preferenza per un
  // effetto che non esiste più non è retrocompatibilità, è un fossile che
  // `syncableSettings` continuerebbe a rispedire al server a ogni salvataggio
  // (è già successo con `enableNewChat`).
  /**
   * Larghezza massima della colonna di lettura della chat, in px. `0` =
   * nessun tetto (la chat riempie la pane, com'era prima).
   *
   * Vive nei settings e non in un CSS fisso perché la misura giusta dipende
   * da come si tiene l'app: chi guarda una chat sola a tutto schermo la vuole
   * più stretta di chi ne affianca tre. Viaggia come `--chat-measure` sul root
   * (App.tsx) e la legge l'utility `chat-measure`, così i punti che la usano —
   * lista, composer con le sue strisce, appuntati, scheletro — non possono
   * disallinearsi fra loro. Surfaced in Settings → Appearance.
   */
  chatMaxWidth: number;
  /**
   * La riga «Board generale» in cima alla sidebar. Accesa di serie.
   *
   * Esiste perché la riga aveva una condizione di comparsa — «c'è lavoro
   * aperto, oppure la sua tab è aperta» — e quel predicato si valutava anche
   * PRIMA che i task fossero arrivati dal server: a ogni ricarica la sidebar
   * nasceva senza Board e la riga si infilava dentro un istante dopo, spostando
   * in giù tutto il resto («quando aggiorno l'app, la board esce dopo»). Una
   * riga di navigazione non è un segnale: c'è perché quella superficie esiste,
   * non perché oggi ha qualcosa da dire. Chi non la vuole la spegne da
   * Impostazioni → Aspetto, che è una decisione, non una corsa con la rete.
   *
   * Il conteggio e le pastiglie continuano a comparire e sparire col lavoro
   * vero: lì il vuoto è informazione.
   */
  showBoardRow: boolean;
  /**
   * The voice loop board: when a task reaches review, the app announces it
   * out loud and — outside `off` — opens the mic for a spoken reply (approve
   * / feedback / close).
   *
   *  · `off` (default) — no announcement, no mic opened on its own.
   *  · `always` — every `task:review-ready` is announced and, right after,
   *    the app listens for the reply.
   *  · `wake-word` — still announces, but the reply is only recorded if the
   *    transcript contains the activation phrase (see
   *    `lib/voice/wakeWord.ts`): the mic stays on at low commitment instead
   *    of opening itself after every announcement.
   */
  voiceMode: 'off' | 'always' | 'wake-word';
}

// Qui c'erano due descrizioni senza lettori. `ScriptProcess`: la UI degli
// script legge `ScriptProcessInfo` da `lib/api` (che è la forma che il server
// manda davvero), e questa copia non l'ha mai importata nessuno. `StreamEvent`:
// una seconda scrittura dei frame di streaming, mentre quelli veri sono i
// membri `stream:*` dell'unione `WSMessage` qui sopra — l'unica forma su cui la
// chat fa il narrowing. Due tipi che nessuno usa non documentano un protocollo:
// divergono da quello vero senza che nessun compilatore se ne accorga.
