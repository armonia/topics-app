/**
 * v3 foundations WS-01 — outbound message emit-side validation.
 *
 * The inbound side (chat-ws-inbound, browser-ws-messages) is fully Zod-
 * validated. The outbound side is not — server bugs that emit malformed
 * payloads slip through to clients and surface as runtime parse errors
 * or silent UI breakage.
 *
 * This module is a REGISTRY (not a discriminated union): each well-shaped
 * outbound type gets its own schema. Types not in the registry pass
 * through unchanged — we don't have to migrate everything at once, just
 * accumulate coverage. `validateOutbound(msg)` returns:
 *   - { ok: true }                   when the type has no registered schema
 *   - { ok: true }                   when the schema passes
 *   - { ok: false, error }           when the schema fails (registered + invalid)
 *
 * Use `validateOutbound` in dev mode inside the broadcast helpers to catch
 * server bugs at emit time (closer to the cause than catching them on the
 * client). In production it's a no-op — zero overhead, no behavior change.
 *
 * Adding a new schema: drop another entry in OUTBOUND_SCHEMAS keyed by the
 * type string. The validator picks it up automatically.
 */
import { z } from 'zod';
import { welcomeMessageSchema } from './ws-handshake';

// ---- Connection lifecycle --------------------------------------------------

const connectedSchema = z.object({
  type: z.literal('connected'),
  clientId: z.string(),
});

const pongSchema = z.object({
  type: z.literal('pong'),
});

// ---- Dashboard / unread ----------------------------------------------------

const dashboardUpdatedSchema = z.object({
  type: z.literal('dashboard:updated'),
});

const unreadInitSchema = z.object({
  type: z.literal('unread:init'),
  data: z.record(
    z.string(),
    z.object({
      lastReadAt: z.string(),
      unreadCount: z.number(),
    }),
  ),
});

const unreadUpdatedSchema = z.object({
  type: z.literal('unread:updated'),
  topicId: z.string(),
  unreadCount: z.number(),
});

// ---- Stream lifecycle ------------------------------------------------------

const streamEndSchema = z.object({
  type: z.literal('stream:end'),
  sessionKey: z.string(),
  // Present on normal completion and on error-with-partial finalisation; ABSENT
  // on the abort / timeout / stale-watchdog paths (a `user_abort` or
  // `stale_timeout` stream:end has no assistant message id to point at). The
  // client handler keys entirely off `sessionKey` and never reads `messageId`,
  // so requiring it here flagged EVERY abort/timeout broadcast as "malformed"
  // (a dev-only warning — the message was still delivered) even though those
  // shapes are correct. Optional + the known companion fields below make the
  // schema a faithful contract of what the server actually emits.
  messageId: z.string().optional(),
  topicId: z.string().optional(),
  reason: z.string().optional(),
  latencyMs: z.number().optional(),
  usagePromptTokens: z.number().optional(),
  usageCompletionTokens: z.number().optional(),
  costCents: z.number().optional(),
  // PERCHÉ il turno è finito, col vocabolario di ACP (server/providers/stop-reason).
  // Assente quando lo stream è finito in errore: `error` non è una ragione ACP.
  stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']).optional(),
  // CHI l'ha fermato — `cancelled` da solo non distingue lo stop dell'umano dal
  // nostro watchdog, e a valle sono due politiche opposte.
  stopCause: z.enum(['user', 'watchdog', 'wall-clock', 'session-reset', 'process-died', 'provider-error']).optional(),
});

// ---- Coordination broadcasts (mirrors of inbound) --------------------------

const typingBroadcastSchema = z.object({
  type: z.literal('typing'),
  topicId: z.string(),
  clientId: z.string(),
  text: z.string(),
});

const dragStartBroadcastSchema = z.object({
  type: z.literal('drag:start'),
  topicId: z.string(),
  sourceWindowId: z.string(),
});

const dragEndBroadcastSchema = z.object({
  type: z.literal('drag:end'),
  topicId: z.string(),
  sourceWindowId: z.string(),
});

const dragAcceptedBroadcastSchema = z.object({
  type: z.literal('drag:accepted'),
  topicId: z.string(),
  targetWindowId: z.string(),
  sourceWindowId: z.string().optional(),
});

// ---- Cross-window presence -------------------------------------------------

// Full-list snapshot of every window that has declared presence, plus the
// topics each holds. Broadcast to all sockets on hello / presence:announce /
// socket-close; the client projects it into "open in another window" markers.
const presenceWindowsBroadcastSchema = z.object({
  type: z.literal('presence:windows'),
  windows: z.array(
    z.object({
      windowId: z.string(),
      clientId: z.string(),
      windowLabel: z.string().optional(),
      detached: z.boolean().optional(),
      topicIds: z.array(z.string()),
      focusedTopicId: z.string().optional(),
    }),
  ),
});

// ---- Topic lifecycle -------------------------------------------------------

const topicSwitchSchema = z.object({
  type: z.literal('topic:switch'),
  fromTopicId: z.string(),
  // The originating stream's session key — the client uses isOwnStream() on
  // this to scope the open+focus side-effect to ONLY the window that drove the
  // switch (without it, every connected client steals focus). Mirrors the
  // fromSessionKey already carried by topic:switch:complete.
  fromSessionKey: z.string(),
  toTopicId: z.string(),
  toSessionKey: z.string(),
});

/**
 * Topic events carry a `topic` object whose shape evolves frequently
 * (Topic type lives across many migrations). We validate the WRAPPER —
 * type + topic-must-be-object-with-id — and accept any additional fields
 * inside topic. When a canonical Topic Zod schema lands, swap z.object
 * `.passthrough()` for the strict reference here.
 */
const topicObjectShape = z.object({ id: z.string() }).passthrough();

const topicCreatedSchema = z.object({
  type: z.literal('topic:created'),
  topic: topicObjectShape,
});

const topicUpdatedSchema = z.object({
  type: z.literal('topic:updated'),
  topic: topicObjectShape,
});

const topicArchivedSchema = z.object({
  type: z.literal('topic:archived'),
  topic: topicObjectShape,
});

const topicSwitchCompleteSchema = z.object({
  type: z.literal('topic:switch:complete'),
}).passthrough();

// ---- Worktree events -------------------------------------------------------

const worktreeObjectShape = z.object({ id: z.string() }).passthrough();

const worktreeNewSchema = z.object({
  type: z.literal('worktree:new'),
  worktree: worktreeObjectShape,
  payload_version: z.number().optional(),
}).passthrough();

const worktreeUpdatedSchema = z.object({
  type: z.literal('worktree:updated'),
  worktree: worktreeObjectShape,
  payload_version: z.number().optional(),
}).passthrough();

const worktreeDeletedSchema = z.object({
  type: z.literal('worktree:deleted'),
  worktree: z.object({ id: z.string() }).passthrough(),
  payload_version: z.number().optional(),
}).passthrough();

// ---- UI state events -------------------------------------------------------

const uiStateUpdatedSchema = z.object({
  type: z.literal('ui-state:updated'),
  key: z.string(),
  value: z.unknown(),
  payload_version: z.number().optional(),
  server_seq: z.number().optional(),
  sourceClientId: z.string().optional(),
}).passthrough();

const uiStatePatchSchema = z.object({
  type: z.literal('ui-state:patch'),
  sourceClientId: z.string().optional(),
  entries: z.array(z.unknown()),
}).passthrough();

// ---- Provider snapshot -----------------------------------------------------

const providersSnapshotSchema = z.object({
  type: z.literal('providers:snapshot'),
  snapshot: z.unknown(), // Provider snapshot shape varies; keep loose.
}).passthrough();

// ---- Stream catchup --------------------------------------------------------

const streamCatchupSchema = z.object({
  type: z.literal('stream:catchup'),
  sessionKey: z.string(),
  messageId: z.string(),
}).passthrough(); // toolCalls, blocks, content, thinking, isThinking are optional rich fields.

// ---- Project events --------------------------------------------------------

const projectObjectShape = z.object({ id: z.string() }).passthrough();

const projectNewSchema = z.object({
  type: z.literal('project:new'),
  project: projectObjectShape,
  payload_version: z.number().optional(),
}).passthrough();

const projectArchivedSchema = z.object({
  type: z.literal('project:archived'),
  project: projectObjectShape,
  payload_version: z.number().optional(),
}).passthrough();

const projectUpdatedSchema = z.object({
  type: z.literal('project:updated'),
  project: projectObjectShape,
  payload_version: z.number().optional(),
}).passthrough();

const projectDeletedSchema = z.object({
  type: z.literal('project:deleted'),
  project: z.object({ id: z.string() }).passthrough(),
  payload_version: z.number().optional(),
}).passthrough();

// ---- Error envelope --------------------------------------------------------

const errorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
}).passthrough();

// ---- Welcome (v3 WS-02 handshake echo on outbound side) --------------------
// Reuse the canonical handshake schema (same project — no TS6307) so the
// outbound guard can't drift from the source-of-truth welcome shape.

// ---- Agent lifecycle cluster ----------------------------------------------

const agentProfileShape = z.object({ id: z.string() }).passthrough();

const agentProfileCreatedSchema = z.object({
  type: z.literal('agent:profile:created'),
  profile: agentProfileShape,
}).passthrough();

const agentProfileUpdatedSchema = z.object({
  type: z.literal('agent:profile:updated'),
  profile: agentProfileShape,
}).passthrough();

const agentProfileDeletedSchema = z.object({
  type: z.literal('agent:profile:deleted'),
  agentId: z.string(),
}).passthrough();

const agentAssignedSchema = z.object({
  type: z.literal('agent:assigned'),
  assignment: z.object({ agentId: z.string(), topicId: z.string() }).passthrough(),
}).passthrough();

const agentUnassignedSchema = z.object({
  type: z.literal('agent:unassigned'),
  agentId: z.string(),
  topicId: z.string(),
}).passthrough();

const agentStatusSchema = z.object({
  type: z.literal('agent:status'),
  agentId: z.string(),
  status: z.string(),
  previousStatus: z.string().optional(),
}).passthrough();

const agentHeartbeatSchema = z.object({
  type: z.literal('agent:heartbeat'),
  agentId: z.string(),
  timestamp: z.string(),
}).passthrough();

const agentSessionPausedSchema = z.object({
  type: z.literal('agent:session:paused'),
  sessionKey: z.string(),
}).passthrough();

const agentSessionResumedSchema = z.object({
  type: z.literal('agent:session:resumed'),
  sessionKey: z.string(),
}).passthrough();

const agentEscalationSchema = z.object({
  type: z.literal('agent:escalation'),
}).passthrough();

const agentsSessionsSchema = z.object({
  type: z.literal('agents:sessions'),
  sessions: z.array(z.unknown()),
}).passthrough();

const agentsSpawnedSchema = z.object({
  type: z.literal('agents:spawned'),
  topicId: z.string(),
  sessionKey: z.string(),
  label: z.string().optional(),
}).passthrough();

const agentsStoppedSchema = z.object({
  type: z.literal('agents:stopped'),
  sessionKey: z.string(),
}).passthrough();

// ---- Stream cluster (server → client message streaming) -------------------

const streamStartSchema = z.object({
  type: z.literal('stream:start'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  messageId: z.string(),
}).passthrough();

const streamContentChunkSchema = z.object({
  type: z.literal('stream:content_chunk'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  content: z.string(),
}).passthrough();

const streamThinkingStartSchema = z.object({
  type: z.literal('stream:thinking_start'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamThinkingEndSchema = z.object({
  type: z.literal('stream:thinking_end'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamThinkingChunkSchema = z.object({
  type: z.literal('stream:thinking_chunk'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

/**
 * Contesto reale del modello dopo una chiamata (1b.5), nella forma standard
 * `usage_update` di ACP (3.1). Il blocco `usage` è l'oggetto ACP LETTERALE —
 * si inoltra senza tradurlo — e `used`/`size` sono obbligatori lì dentro:
 * è ciò che impedisce a un provider di mandare metà del rapporto e lasciare
 * la UI a indovinare il denominatore. Costruito in `usage/usage-update.ts`,
 * mai a mano. Fuori dal blocco resta solo la nostra presentazione.
 */
const streamContextSchema = z.object({
  type: z.literal('stream:context'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  usage: z.object({
    sessionUpdate: z.literal('usage_update'),
    used: z.number(),
    size: z.number(),
    cost: z.object({ amount: z.number(), currency: z.string() }).optional(),
  }),
  percent: z.number(),
  level: z.enum(['ok', 'warn', 'critical']),
  estimated: z.boolean(),
  model: z.string().optional(),
}).passthrough();

const streamErrorSchema = z.object({
  type: z.literal('stream:error'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  error: z.string(),
}).passthrough();

const streamSlowSchema = z.object({
  type: z.literal('stream:slow'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamResumedSchema = z.object({
  type: z.literal('stream:resumed'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

// Il turno ha compattato il contesto. Emesso DUE volte per lo stesso marker:
// la prima quando la compattazione avviene (`preTokens`), la seconda quando il
// risultato successivo rivela la dimensione post (`postTokens` riempito da
// backfillPostTokens) — stesso `markerId`, il divider si aggiorna in loco.
const streamCompactionSchema = z.object({
  type: z.literal('stream:compaction'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  markerId: z.string(),
  // Il marker è ancorato DOPO questo messaggio; null quando la compattazione
  // cade a inizio thread (nessun messaggio precedente a cui appenderlo).
  afterMessageId: z.string().nullable(),
  trigger: z.enum(['auto', 'manual', 'unknown']),
  preTokens: z.number().optional(),
  postTokens: z.number().optional(),
  createdAt: z.string(),
}).passthrough();

const streamToolCallSchema = z.object({
  type: z.literal('stream:tool_call'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  toolCall: z.object({ id: z.string() }).passthrough(),
}).passthrough();

const streamToolDetailSchema = z.object({
  type: z.literal('stream:tool_detail'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamToolResultSchema = z.object({
  type: z.literal('stream:tool_result'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamToolUpdateSchema = z.object({
  type: z.literal('stream:tool_update'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const streamToolUserInputRequiredSchema = z.object({
  type: z.literal('stream:tool_user_input_required'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
}).passthrough();

// ---- Message cluster (legacy + new) ---------------------------------------

const messageLegacySchema = z.object({
  type: z.literal('message'),
  sessionKey: z.string(),
  message: z.object({ id: z.string() }).passthrough(),
}).passthrough();

const messageNewSchema = z.object({
  type: z.literal('message:new'),
  topicId: z.string().optional(),
  sessionKey: z.string(),
  role: z.string(),
  messageId: z.string(),
  content: z.string(),
  preview: z.string().optional(),
}).passthrough();

const messageMediaSchema = z.object({
  type: z.literal('message:media'),
  sessionKey: z.string(),
  topicId: z.string().optional(),
  media: z.unknown(),
}).passthrough();

const messagePlanStatusSchema = z.object({
  type: z.literal('message:plan-status'),
  topicId: z.string(),
  messageId: z.string(),
  planStatus: z.string(),
}).passthrough();

// ---- Misc / domain-specific outbound --------------------------------------

const browserNavigateSchema = z.object({
  type: z.literal('browser:navigate'),
  topicId: z.string(),
  url: z.string(),
  // Browser-pane contextId the client must register the native CDP target under
  // (== resolveContextIdForTopic(topic), i.e. topic.id). Without it the chat pane
  // registered under a random id that never matched the agent's contextId, so
  // every browser_* tool fell back to an invisible Playwright phantom. Optional
  // for back-compat with older clients/messages — omit, never send null.
  contextId: z.string().optional(),
}).passthrough();

// Fallback open: when open_browser_pane's normal broadcast mounted no visible
// pane (the spawner terminal/topic isn't a rendered tab), the server asks the
// primary window to force a visible browser pane open under `contextId`.
const browserForceOpenSchema = z.object({
  type: z.literal('browser:force-open'),
  contextId: z.string(),
  url: z.string(),
}).passthrough();

// Remote pane close (close_browser_pane MCP tool / REST): whichever window
// renders `browser:<contextId>` closes it through its normal close flow (X
// button semantics — tombstone, persist, native teardown). Server-side state
// edits can't do this: live clients re-persist their in-memory layout and
// clobber the removal, so the CLIENT must originate the close.
const browserClosePaneSchema = z.object({
  type: z.literal('browser:close-pane'),
  contextId: z.string(),
}).passthrough();

// Remote pane focus (browser_focus_tab MCP tool / REST): whichever window
// renders `browser:<contextId>` brings that tab to the front. Same client-
// originated model as close-pane — tab activation is device-local UI state, so
// the CLIENT applies it; non-owning windows no-op (idempotent broadcast).
const browserFocusPaneSchema = z.object({
  type: z.literal('browser:focus-pane'),
  contextId: z.string(),
}).passthrough();

// Apertura ACCANTO a una pane esistente: un terminale Claude Code ha chiamato
// open_browser_pane, e il browser va messo di fianco a CHI l'ha aperto (la
// chat passa invece dal `browser:navigate` mirato al topic). `paneId` è la
// pane del terminale (`terminal:<sessionId>`); qualunque layout la renda —
// standalone o dentro un progetto — apre il browser lì.
const browserOpenNearPaneSchema = z.object({
  type: z.literal('browser:open-near-pane'),
  paneId: z.string(),
  // contextId deterministico (`term-<terminalId>`) sotto cui la pane registra
  // il target nativo: è ciò che permette al terminale di GUIDARE la stessa
  // pane, non solo di aprirla. Assente → il singleton sceglie un id.
  contextId: z.string().optional(),
  url: z.string(),
}).passthrough();

// Browser di proprietà del TASK (dietro TOPICS_TASK_BROWSER): i layout globali
// ignorano di proposito questo frame, così la tab non finisce nel pane-store
// condiviso — la consuma solo il gruppo in-drawer del task.
const browserOpenTaskTabSchema = z.object({
  type: z.literal('browser:open-task-tab'),
  taskId: z.string(),
  contextId: z.string(),
  url: z.string(),
}).passthrough();

// "Porta in primo piano la pane di questo topic". `projectPath` arriva inline
// (invece di leggerlo dal topic) così il client non deve aspettare che atterri
// un `topic:updated` precedente per sapere dentro quale progetto annidarlo.
const paneFocusSuggestSchema = z.object({
  type: z.literal('pane:focus-suggest'),
  topicId: z.string(),
  taskId: z.string().optional(),
  projectPath: z.string().optional(),
}).passthrough();

const clearSchema = z.object({
  type: z.literal('clear'),
}).passthrough();

const cronUpdatedSchema = z.object({
  type: z.literal('cron:updated'),
  jobs: z.array(z.unknown()),
}).passthrough();

const gatewayStatusSchema = z.object({
  type: z.literal('gateway:status'),
}).passthrough();

const machineShape = z.object({ id: z.string() }).passthrough();

const machineUpdatedSchema = z.object({
  type: z.literal('machine:updated'),
  machine: machineShape,
}).passthrough();

const machineUpsertedSchema = z.object({
  type: z.literal('machine:upserted'),
  machine: machineShape,
}).passthrough();

// La DELETE manda solo `{ id }` dentro `machine` — l'helper `emit` del router
// impacchetta sempre il payload sotto la stessa chiave, quindi la forma sul
// filo resta identica agli altri due eventi machine:*.
const machineDeletedSchema = z.object({
  type: z.literal('machine:deleted'),
  machine: machineShape,
}).passthrough();

const memoryUpdatedSchema = z.object({
  type: z.literal('memory:updated'),
  scope: z.string(),
  topicId: z.string().optional(),
}).passthrough();

const openProjectSchema = z.object({
  type: z.literal('open-project'),
  projectPath: z.string(),
}).passthrough();

const topicsReorderedSchema = z.object({
  type: z.literal('topics:reordered'),
  order: z.array(z.string()),
}).passthrough();

const uiStateInitSchema = z.object({
  type: z.literal('ui-state:init'),
  data: z.unknown(),
  meta: z.unknown().optional(),
}).passthrough();

const scriptsOutputSchema = z.object({
  type: z.literal('scripts:output'),
}).passthrough();

const scriptsUpdatedSchema = z.object({
  type: z.literal('scripts:updated'),
}).passthrough();

const terminalSessionsSchema = z.object({
  type: z.literal('terminal:sessions'),
}).passthrough();

// Battito di attività per sessione pty, tracciato sul percorso dati centrale:
// copre OGNI sessione, montata o no. `finished` marca la transizione
// attivo→inattivo (turno concluso) ed è ciò che alza la notifica.
const terminalActivitySchema = z.object({
  type: z.literal('terminal:activity'),
  id: z.string(),
  busy: z.boolean(),
  finished: z.boolean().optional(),
  kind: z.enum(['shell', 'claude-code', 'claude-code-team']).optional(),
}).passthrough();

// ---- Board / task cluster --------------------------------------------------

// La riga completa del task. Come per topic/machine/project teniamo obbligatorie
// solo le colonne su cui il client indicizza davvero (id per la mappa, projectId
// per il filtro di board, status per la colonna kanban): il resto passa, così
// una colonna nuova sul server non fa fallire la validazione di un client vecchio.
const taskObjectShape = z.object({
  id: z.string(),
  projectId: z.string(),
  status: z.string(),
}).passthrough();

const taskCreatedSchema = z.object({
  type: z.literal('task:created'),
  projectId: z.string(),
  task: taskObjectShape,
}).passthrough();

const taskUpdatedSchema = z.object({
  type: z.literal('task:updated'),
  projectId: z.string(),
  task: taskObjectShape,
}).passthrough();

const taskDeletedSchema = z.object({
  type: z.literal('task:deleted'),
  projectId: z.string(),
  taskId: z.string(),
}).passthrough();

// Il fronte "task ENTRATO in review", emesso IN AGGIUNTA a `task:updated` e solo
// sulla transizione: è il segnale di fine-lavoro che alza il banner OS e la
// web-push, senza dipendere dall'inferenza fragile sulla sessione idle.
const taskReviewReadySchema = z.object({
  type: z.literal('task:review-ready'),
  projectId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  reason: z.string().optional(),
}).passthrough();

// Anteprima LIVE del consumo mentre il turno gira (ogni 4s, mai persistita): la
// card somma `baseMs` + (adesso − turnStartedAt), quindi il tempo mostrato è
// solo ESECUZIONE — le pause tra un turno e l'altro non entrano mai nel conto.
const taskUsageLiveSchema = z.object({
  type: z.literal('task:usage-live'),
  projectId: z.string(),
  taskId: z.string(),
  turnStartedAt: z.number(),
  baseMs: z.number(),
  liveTokens: z.number(),
  model: z.string().nullable(),
}).passthrough();

// L'interruttore auto-dispatch è GLOBALE, non per progetto: ogni header di board
// aperto — non solo quello del progetto toccato — deve girare la pill.
const boardDispatchSchema = z.object({
  type: z.literal('board:dispatch'),
  autoDispatch: z.boolean(),
}).passthrough();

// Il cap macchina-wide vive sulla riga riservata '*'. `maxAgentsAuto` è un
// BOOLEANO ("scegli tu in base alla capacità"), non un numero.
const boardGlobalCapSchema = z.object({
  type: z.literal('board:global-cap'),
  maxAgentsAuto: z.boolean(),
  maxAgents: z.number(),
}).passthrough();

const boardSettingsSchema = z.object({
  type: z.literal('board:settings'),
  projectId: z.string(),
  settings: z.object({}).passthrough(),
}).passthrough();

// ---- Dev bundle hot-delivery ----------------------------------------------

// Il bundle client è cambiato su disco. `rev` (i nomi ordinati di /assets/*)
// permette al client di NON ricaricarsi se già gira quella revisione.
const uiBundleUpdatedSchema = z.object({
  type: z.literal('ui:bundle-updated'),
  at: z.number(),
  rev: z.string().optional(),
}).passthrough();

// Stesso `rev`, ma alla connessione: una finestra che era chiusa al momento del
// deploy converge lo stesso, invece di restare indietro fino al reload manuale.
const uiBundleRevSchema = z.object({
  type: z.literal('ui:bundle-rev'),
  rev: z.string(),
}).passthrough();

// ---- External Claude sessions (il censimento di ciò che Topics NON ha avviato) ----

// Nome fuori convenzione (`external-sessions`, non `sessions:external`): è sul
// filo da prima della v3 e il client lo ascolta così com'è. Si rinomina quando
// si versiona il protocollo, non con una modifica di contorno. È anche il
// motivo per cui lo scan statico dei test non lo vedeva: senza `:` nel nome
// non passava il filtro — l'ha stanato il compilatore, non la regex.
const externalClaudeSessionShape = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  projectPath: z.string().nullable(),
  projectId: z.string().nullable(),
  lastActivityMs: z.number(),
  state: z.enum(['active', 'idle']),
}).passthrough();

const externalSessionProjectShape = z.object({
  projectId: z.string(),
  projectPath: z.string(),
  total: z.number(),
  active: z.number(),
  lastActivityMs: z.number(),
}).passthrough();

const externalSessionsSchema = z.object({
  type: z.literal('external-sessions'),
  sessions: z.array(externalClaudeSessionShape),
  projects: z.array(externalSessionProjectShape),
}).passthrough();

// ---- Legacy chat:* events (replaced by topic:* in v3, kept for compat) ----

const chatObjectShape = z.object({ id: z.string() }).passthrough();

const chatCreatedSchema = z.object({
  type: z.literal('chat:created'),
  chat: chatObjectShape,
}).passthrough();

const chatUpdatedSchema = z.object({
  type: z.literal('chat:updated'),
  chat: chatObjectShape,
}).passthrough();

const chatArchivedSchema = z.object({
  type: z.literal('chat:archived'),
  chat: chatObjectShape,
}).passthrough();

const chatDeletedSchema = z.object({
  type: z.literal('chat:deleted'),
  chatId: z.string(),
}).passthrough();

// ---- Provider niche events -------------------------------------------------

const providerCurrentSchema = z.object({
  type: z.literal('provider:current'),
}).passthrough();

const providerChangedSchema = z.object({
  type: z.literal('provider:changed'),
}).passthrough();

// ---- Git status -----------------------------------------------------------

const gitStatusSchema = z.object({
  type: z.literal('git:status'),
}).passthrough();

// ---- Claude session state + events (highest-traffic live path) ------------

/**
 * `session:state` is the hot phase-machine broadcast. We validate the
 * WRAPPER — sessionKey (nullable for terminal sessions) + a state object that
 * must carry claudeSessionId + phase — and accept the rest of the rich
 * ClaudeSessionState via .passthrough() (it evolves across migrations).
 */
const sessionStateSchema = z.object({
  type: z.literal('session:state'),
  sessionKey: z.string().nullable(),
  state: z.object({
    claudeSessionId: z.string(),
    phase: z.string(),
  }).passthrough(),
}).passthrough();

/**
 * `claude-event` carries a notification event whose inner shape is still
 * settling (Phase F triple-layer capture). Validate the wrapper + the
 * suppressed flag; keep the event payload loose.
 */
const claudeEventSchema = z.object({
  type: z.literal('claude-event'),
  event: z.unknown(),
  suppressed: z.boolean().optional(),
}).passthrough();

// ---- Registry --------------------------------------------------------------

const OUTBOUND_SCHEMAS = {
  // Connection lifecycle
  'connected': connectedSchema,
  'pong': pongSchema,
  // Notification
  'dashboard:updated': dashboardUpdatedSchema,
  'unread:init': unreadInitSchema,
  'unread:updated': unreadUpdatedSchema,
  // Stream
  'stream:end': streamEndSchema,
  'stream:catchup': streamCatchupSchema,
  // Collaboration
  'typing': typingBroadcastSchema,
  'drag:start': dragStartBroadcastSchema,
  'drag:end': dragEndBroadcastSchema,
  'drag:accepted': dragAcceptedBroadcastSchema,
  'presence:windows': presenceWindowsBroadcastSchema,
  // Topic lifecycle
  'topic:switch': topicSwitchSchema,
  'topic:created': topicCreatedSchema,
  'topic:updated': topicUpdatedSchema,
  'topic:archived': topicArchivedSchema,
  'topic:switch:complete': topicSwitchCompleteSchema,
  // Task / board
  // Worktree
  'worktree:new': worktreeNewSchema,
  'worktree:updated': worktreeUpdatedSchema,
  'worktree:deleted': worktreeDeletedSchema,
  // UI state
  'ui-state:updated': uiStateUpdatedSchema,
  'ui-state:patch': uiStatePatchSchema,
  // Project — the live events the server actually emits (projects.ts).
  'project:new': projectNewSchema,
  'project:archived': projectArchivedSchema,
  'project:updated': projectUpdatedSchema,
  'project:deleted': projectDeletedSchema,
  // Provider
  'providers:snapshot': providersSnapshotSchema,
  // Errors
  'error': errorMessageSchema,
  // Handshake echo (welcome is sent right after connected)
  'welcome': welcomeMessageSchema,
  // Agent lifecycle
  'agent:profile:created': agentProfileCreatedSchema,
  'agent:profile:updated': agentProfileUpdatedSchema,
  'agent:profile:deleted': agentProfileDeletedSchema,
  'agent:assigned': agentAssignedSchema,
  'agent:unassigned': agentUnassignedSchema,
  'agent:status': agentStatusSchema,
  'agent:heartbeat': agentHeartbeatSchema,
  'agent:session:paused': agentSessionPausedSchema,
  'agent:session:resumed': agentSessionResumedSchema,
  'agent:escalation': agentEscalationSchema,
  'agents:sessions': agentsSessionsSchema,
  'agents:spawned': agentsSpawnedSchema,
  'agents:stopped': agentsStoppedSchema,
  // Approvals
  // Stream cluster (provider streaming)
  'stream:start': streamStartSchema,
  'stream:content_chunk': streamContentChunkSchema,
  'stream:context': streamContextSchema,
  'stream:thinking_start': streamThinkingStartSchema,
  'stream:thinking_end': streamThinkingEndSchema,
  'stream:thinking_chunk': streamThinkingChunkSchema,
  'stream:error': streamErrorSchema,
  'stream:slow': streamSlowSchema,
  'stream:resumed': streamResumedSchema,
  'stream:compaction': streamCompactionSchema,
  'stream:tool_call': streamToolCallSchema,
  'stream:tool_detail': streamToolDetailSchema,
  'stream:tool_result': streamToolResultSchema,
  'stream:tool_update': streamToolUpdateSchema,
  'stream:tool_user_input_required': streamToolUserInputRequiredSchema,
  // Message cluster
  'message': messageLegacySchema,
  'message:new': messageNewSchema,
  'message:media': messageMediaSchema,
  'message:plan-status': messagePlanStatusSchema,
  // Misc domain
  'browser:navigate': browserNavigateSchema,
  'browser:force-open': browserForceOpenSchema,
  'browser:close-pane': browserClosePaneSchema,
  'browser:focus-pane': browserFocusPaneSchema,
  'browser:open-near-pane': browserOpenNearPaneSchema,
  'browser:open-task-tab': browserOpenTaskTabSchema,
  'pane:focus-suggest': paneFocusSuggestSchema,
  'clear': clearSchema,
  'cron:updated': cronUpdatedSchema,
  'gateway:status': gatewayStatusSchema,
  'machine:updated': machineUpdatedSchema,
  'machine:upserted': machineUpsertedSchema,
  'machine:deleted': machineDeletedSchema,
  'memory:updated': memoryUpdatedSchema,
  'open-project': openProjectSchema,
  'topics:reordered': topicsReorderedSchema,
  'ui-state:init': uiStateInitSchema,
  'scripts:output': scriptsOutputSchema,
  'scripts:updated': scriptsUpdatedSchema,
  'terminal:sessions': terminalSessionsSchema,
  'terminal:activity': terminalActivitySchema,
  // Board / task
  'task:created': taskCreatedSchema,
  'task:updated': taskUpdatedSchema,
  'task:deleted': taskDeletedSchema,
  'task:review-ready': taskReviewReadySchema,
  'task:usage-live': taskUsageLiveSchema,
  'board:dispatch': boardDispatchSchema,
  'board:global-cap': boardGlobalCapSchema,
  'board:settings': boardSettingsSchema,
  // Dev bundle hot-delivery
  'ui:bundle-updated': uiBundleUpdatedSchema,
  'ui:bundle-rev': uiBundleRevSchema,
  // Census of Claude sessions Topics didn't start
  'external-sessions': externalSessionsSchema,
  // Legacy chat:* (replaced by topic:* in v3, kept for backward compat)
  'chat:created': chatCreatedSchema,
  'chat:updated': chatUpdatedSchema,
  'chat:archived': chatArchivedSchema,
  'chat:deleted': chatDeletedSchema,
  // Provider niche
  'provider:current': providerCurrentSchema,
  'provider:changed': providerChangedSchema,
  // Git status — the live event git-watcher actually emits.
  'git:status': gitStatusSchema,
  // Claude session state + events (highest-traffic live path)
  'session:state': sessionStateSchema,
  'claude-event': claudeEventSchema,
} as const;

/**
 * Stable list of outbound types this module knows about. Exposed so tests
 * can lock the registry size (contract guard).
 */
export const REGISTERED_OUTBOUND_TYPES = Object.keys(OUTBOUND_SCHEMAS).sort();

/**
 * I tipi che il server può mandare — DERIVATI dal registro, non riscritti a
 * mano: aggiungere uno schema aggiunge il tipo, e non c'è modo di scordarsi
 * l'uno o l'altro.
 */
export type OutboundType = keyof typeof OUTBOUND_SCHEMAS;

/**
 * La forma minima di un messaggio in uscita: il `type` deve stare nel registro,
 * il resto del payload lo controlla lo schema a runtime (`validateOutbound`, in
 * dev) e i fixture in `tests/unit/ws-outbound-schema.test.ts`.
 *
 * PERCHÉ solo il `type` e non l'intero payload inferito da Zod: gli schemi sono
 * `.passthrough()`, quindi inferiscono un index signature `[k: string]: unknown`
 * — e un'INTERFACCIA TypeScript (`Task`, `Topic`, `Machine`…) non è assegnabile
 * a un tipo con index signature, perché le interfacce non ne ricevono uno
 * implicito. Pretendere il payload completo qui vorrebbe dire riscrivere ogni
 * call site per accontentare una regola di assegnabilità, non per correggere un
 * bug. Il vincolo sul `type` invece paga subito: un broadcast con un tipo NUOVO
 * (o costruito da una `string` qualsiasi) non compila finché non ha uno schema.
 */
export interface OutboundMessage {
  type: OutboundType;
  [key: string]: unknown;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate an outbound message at emit time. Returns ok:true for types
 * not in the registry (passthrough — incremental migration), ok:true for
 * registered types that pass their schema, ok:false with the path-qualified
 * Zod error when a registered type fails to parse.
 */
export function validateOutbound(msg: unknown): ValidationResult {
  if (typeof msg !== 'object' || msg === null) {
    return { ok: false, error: '<root>: expected object' };
  }
  const type = (msg as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return { ok: false, error: 'type: missing or not a string' };
  }
  const schema = (OUTBOUND_SCHEMAS as Record<string, z.ZodTypeAny>)[type];
  if (!schema) {
    // Unmodeled type — passthrough is OK. Future commits add more schemas.
    return { ok: true };
  }
  const result = schema.safeParse(msg);
  if (result.success) return { ok: true };
  return {
    ok: false,
    error: result.error.issues
      .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
      .join('; '),
  };
}

/**
 * Convenience: returns true if the type is known to this module's registry.
 * Useful for tests + dev-mode diagnostics ("which outbound types are still
 * unmodeled?").
 */
export function isRegisteredOutboundType(type: string): boolean {
  return type in OUTBOUND_SCHEMAS;
}
