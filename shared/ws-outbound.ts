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
 *
 * PERCHÉ vive in `shared/` (3.3, 29/07): fino a ieri il client ne teneva una
 * COPIA a mano (`client/src/schemas/ws-inbound.ts`, un sottoinsieme dei tipi
 * "letti a mano") con in testa un "KEEP IN SYNC". Due registri che descrivono
 * lo STESSO filo divergono per costruzione: il client ne validava 26 su 102 e
 * nessuno si accorgeva se un campo cambiava lato server. `shared/` è l'unica
 * cartella che i due progetti TS possono importare senza violare il confine
 * composite (TS6307), quindi ora il contratto è UNO e la deriva è impossibile,
 * non solo sconsigliata.
 *
 * Idioma `zod/mini` per lo stesso motivo: questo modulo finisce nel bundle
 * client, dove la variante method-heavy di zod pesa nel chunk d'ingresso.
 * `z.looseObject({...})` è il `.passthrough()` della API funzionale e
 * `.safeParse` è identico.
 */
import { z } from 'zod/mini';
import { welcomeMessageSchema, formatZodIssues } from './ws-handshake';

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
  messageId: z.optional(z.string()),
  // Il turno è stato fermato PRIMA che il modello producesse qualcosa, e il
  // segnaposto vuoto è stato cancellato invece che finalizzato: chi ha questa
  // riga in pagina deve toglierla, o gli resta una bolla vuota che il server non
  // ha più (e che sparirebbe solo al reload). Vedi `shared/empty-turn.ts`.
  discardedMessageId: z.optional(z.string()),
  topicId: z.optional(z.string()),
  reason: z.optional(z.string()),
  latencyMs: z.optional(z.number()),
  usagePromptTokens: z.optional(z.number()),
  usageCompletionTokens: z.optional(z.number()),
  costCents: z.optional(z.number()),
  // Il modello del turno, accanto al costo che ha prodotto. Va sul filo per la
  // stessa ragione per cui ci va lo scorporo della cache: la UI mostra il piede
  // del messaggio appena il turno finisce, senza rileggere la history. Assente
  // quando il provider non riporta l'usage.
  model: z.optional(z.string()),
  // Lo SCORPORO di `usagePromptTokens`: quanta parte era cache. Il totale da solo
  // dice quanto è costato il turno, non cosa l'ha reso costoso — e in un turno
  // agentico lungo la cache riletta è la voce schiacciante. Quote DISGIUNTE, come
  // in usage/pricing.ts: prompt = fresh + read + creation + creation1h, e
  // `cacheCreationTokens` NON include `cacheCreation1hTokens`.
  // Assenti (non zero) quando il provider non riporta l'usage: "non lo sappiamo" e
  // "misurato, nessuna cache" restano due cose diverse.
  cacheReadTokens: z.optional(z.number()),
  cacheCreationTokens: z.optional(z.number()),
  cacheCreation1hTokens: z.optional(z.number()),
  // PERCHÉ il turno è finito, col vocabolario di ACP (server/providers/stop-reason).
  // Assente quando lo stream è finito in errore: `error` non è una ragione ACP.
  stopReason: z.optional(z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])),
  // CHI l'ha fermato — `cancelled` da solo non distingue lo stop dell'umano dal
  // nostro watchdog, e a valle sono due politiche opposte.
  stopCause: z.optional(z.enum(['user', 'watchdog', 'wall-clock', 'session-reset', 'process-died', 'provider-error'])),
  // Marcatore POSITIVo di fine PULITA (`end_turn`, turno non vuoto): lo legge la
  // push di fine risposta (server/push-triggers) per non annunciare "risposta
  // pronta" su un turno morto. `dispatched` = turno d'agente guidato dalla board
  // (escluso dalla push). Vedi server/push-triggers.ts.
  completed: z.optional(z.boolean()),
  dispatched: z.optional(z.boolean()),
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
  sourceWindowId: z.optional(z.string()),
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
      windowLabel: z.optional(z.string()),
      detached: z.optional(z.boolean()),
      topicIds: z.array(z.string()),
      focusedTopicId: z.optional(z.string()),
      // Every tab the window holds, not just its chats — what the sidebar's
      // "Finestre" section groups. Optional: a window running an older client
      // announces none, and the row falls back to its topics.
      tabs: z.optional(z.array(z.object({
        id: z.string(),
        type: z.string(),
        title: z.optional(z.string()),
      }))),
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
 * inside topic. When a canonical Topic Zod schema lands, swap the
 * `z.looseObject` for the strict reference here.
 */
const topicObjectShape = z.looseObject({ id: z.string() });

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

const topicSwitchCompleteSchema = z.looseObject({
  type: z.literal('topic:switch:complete'),
});

// ---- Worktree events -------------------------------------------------------

const worktreeObjectShape = z.looseObject({ id: z.string() });

const worktreeNewSchema = z.looseObject({
  type: z.literal('worktree:new'),
  worktree: worktreeObjectShape,
  payload_version: z.optional(z.number()),
});

const worktreeUpdatedSchema = z.looseObject({
  type: z.literal('worktree:updated'),
  worktree: worktreeObjectShape,
  payload_version: z.optional(z.number()),
});

const worktreeDeletedSchema = z.looseObject({
  type: z.literal('worktree:deleted'),
  worktree: z.looseObject({ id: z.string() }),
  payload_version: z.optional(z.number()),
});

// ---- UI state events -------------------------------------------------------

const uiStateUpdatedSchema = z.looseObject({
  type: z.literal('ui-state:updated'),
  key: z.string(),
  value: z.unknown(),
  payload_version: z.optional(z.number()),
  server_seq: z.optional(z.number()),
  sourceClientId: z.optional(z.string()),
});

const uiStatePatchSchema = z.looseObject({
  type: z.literal('ui-state:patch'),
  sourceClientId: z.optional(z.string()),
  entries: z.array(z.unknown()),
});

// ---- Provider snapshot -----------------------------------------------------

const providersSnapshotSchema = z.looseObject({
  type: z.literal('providers:snapshot'),
  snapshot: z.unknown(), // Provider snapshot shape varies; keep loose.
});

// ---- Stream catchup --------------------------------------------------------

const streamCatchupSchema = z.looseObject({
  type: z.literal('stream:catchup'),
  sessionKey: z.string(),
  messageId: z.string(),
}); // toolCalls, blocks, content, thinking, isThinking are optional rich fields.

// ---- Project events --------------------------------------------------------

const projectObjectShape = z.looseObject({ id: z.string() });

const projectNewSchema = z.looseObject({
  type: z.literal('project:new'),
  project: projectObjectShape,
  payload_version: z.optional(z.number()),
});

const projectArchivedSchema = z.looseObject({
  type: z.literal('project:archived'),
  project: projectObjectShape,
  payload_version: z.optional(z.number()),
});

const projectUpdatedSchema = z.looseObject({
  type: z.literal('project:updated'),
  project: projectObjectShape,
  payload_version: z.optional(z.number()),
});

const projectDeletedSchema = z.looseObject({
  type: z.literal('project:deleted'),
  project: z.looseObject({ id: z.string() }),
  payload_version: z.optional(z.number()),
});

// ---- Error envelope --------------------------------------------------------

const errorMessageSchema = z.looseObject({
  type: z.literal('error'),
  message: z.string(),
});

// ---- Welcome (v3 WS-02 handshake echo on outbound side) --------------------
// Reuse the canonical handshake schema (same project — no TS6307) so the
// outbound guard can't drift from the source-of-truth welcome shape.

// ---- (the "agent" frame family is gone) -----------------------------------
//
// Profiles, assignments, heartbeats, escalations and the OpenClaw session
// roster all broadcast under `agent:*` / `agents:*`. None of it exists any
// more: an agent is a provider you picked, and the sub-agents a turn spawns
// are terminal sessions with a `parentSessionKey` (SubAgentsStrip), which ride
// the `terminal:*` frames like everything else.

// ---- Stream cluster (server → client message streaming) -------------------

const streamStartSchema = z.looseObject({
  type: z.literal('stream:start'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  messageId: z.string(),
});

const streamContentChunkSchema = z.looseObject({
  type: z.literal('stream:content_chunk'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  content: z.string(),
});

const streamThinkingStartSchema = z.looseObject({
  type: z.literal('stream:thinking_start'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
});

const streamThinkingEndSchema = z.looseObject({
  type: z.literal('stream:thinking_end'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
});

const streamThinkingChunkSchema = z.looseObject({
  type: z.literal('stream:thinking_chunk'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
});

/**
 * Contesto reale del modello dopo una chiamata (1b.5), nella forma standard
 * `usage_update` di ACP (3.1). Il blocco `usage` è l'oggetto ACP LETTERALE —
 * si inoltra senza tradurlo — e `used`/`size` sono obbligatori lì dentro:
 * è ciò che impedisce a un provider di mandare metà del rapporto e lasciare
 * la UI a indovinare il denominatore. Costruito in `usage/usage-update.ts`,
 * mai a mano. Fuori dal blocco resta solo la nostra presentazione.
 */
const streamContextSchema = z.looseObject({
  type: z.literal('stream:context'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  usage: z.object({
    sessionUpdate: z.literal('usage_update'),
    used: z.number(),
    size: z.number(),
    cost: z.optional(z.object({ amount: z.number(), currency: z.string() })),
  }),
  percent: z.number(),
  level: z.enum(['ok', 'warn', 'critical']),
  estimated: z.boolean(),
  model: z.optional(z.string()),
});

/**
 * Il CONSUMO del turno mentre cresce (live). Fratello di `stream:context`, e la
 * differenza fra i due e' tutta:
 *   - `stream:context` = il SERBATOIO. Quanto e' grande il prompt che il modello ha
 *     appena visto; sale e SCENDE con le compattazioni.
 *   - `stream:usage`   = la BOLLETTA. Quanto ha consumato il turno finora; solo
 *     cresce, e a fine turno coincide con i totali di `stream:end`.
 *
 * Prima esisteva solo il primo, e i numeri di consumo arrivavano una volta sola
 * alla fine: durante un turno agentico da otto tool call non si vedeva muovere
 * niente. Emesso a ogni chiamata al modello, con i totali GIA' accumulati dal
 * server — il client non somma, mostra.
 *
 * `calls` e' quante chiamate al modello sono state fatte nel turno: e' il numero
 * che spiega perche' il totale letto supera la finestra di contesto (lo stesso
 * prompt riletto N volte), e senza di lui il conteggio sembra rotto.
 *
 * Quote disgiunte come altrove: promptTokens = fresco + cacheRead +
 * cacheCreation + cacheCreation1h.
 */
const streamUsageSchema = z.looseObject({
  type: z.literal('stream:usage'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  /** Chiamate al modello nel turno finora. */
  calls: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  cacheCreation1hTokens: z.number(),
  /** Costo stimato finora in centesimi, quando il modello e' tariffabile. */
  costCents: z.optional(z.number()),
  model: z.optional(z.string()),
});

const streamErrorSchema = z.looseObject({
  type: z.literal('stream:error'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  error: z.string(),
});

const streamSlowSchema = z.looseObject({
  type: z.literal('stream:slow'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
});

const streamResumedSchema = z.looseObject({
  type: z.literal('stream:resumed'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
});

// Il turno ha compattato il contesto. Emesso DUE volte per lo stesso marker:
// la prima quando la compattazione avviene (`preTokens`), la seconda quando il
// risultato successivo rivela la dimensione post (`postTokens` riempito da
// backfillPostTokens) — stesso `markerId`, il divider si aggiorna in loco.
const streamCompactionSchema = z.looseObject({
  type: z.literal('stream:compaction'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  markerId: z.string(),
  // Il marker è ancorato DOPO questo messaggio; null quando la compattazione
  // cade a inizio thread (nessun messaggio precedente a cui appenderlo).
  afterMessageId: z.nullable(z.string()),
  trigger: z.enum(['auto', 'manual', 'unknown']),
  preTokens: z.optional(z.number()),
  postTokens: z.optional(z.number()),
  createdAt: z.string(),
});

const streamToolCallSchema = z.looseObject({
  type: z.literal('stream:tool_call'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  toolCall: z.looseObject({ id: z.string() }),
});

const streamToolDetailSchema = z.looseObject({
  type: z.literal('stream:tool_detail'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
});

const streamToolResultSchema = z.looseObject({
  type: z.literal('stream:tool_result'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
});

const streamToolUpdateSchema = z.looseObject({
  type: z.literal('stream:tool_update'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
});

// Il costo/token di UNA azione (tool call), attribuito dalla chiamata che l'ha
// decisa. Distinto da `stream:usage` (totale del turno): patcha la singola riga
// del tool. Arriva mentre il tool è ancora running.
const streamToolUsageSchema = z.looseObject({
  type: z.literal('stream:tool_usage'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  toolCallId: z.string(),
  tokens: z.optional(z.number()),
  costCents: z.optional(z.number()),
});

const streamToolUserInputRequiredSchema = z.looseObject({
  type: z.literal('stream:tool_user_input_required'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
});

// ---- Message cluster (legacy + new) ---------------------------------------

const messageLegacySchema = z.looseObject({
  type: z.literal('message'),
  sessionKey: z.string(),
  message: z.looseObject({ id: z.string() }),
});

const messageNewSchema = z.looseObject({
  type: z.literal('message:new'),
  topicId: z.optional(z.string()),
  sessionKey: z.string(),
  role: z.string(),
  messageId: z.string(),
  content: z.string(),
  preview: z.optional(z.string()),
});

const messageMediaSchema = z.looseObject({
  type: z.literal('message:media'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  media: z.unknown(),
});

// ---- Misc / domain-specific outbound --------------------------------------

const browserNavigateSchema = z.looseObject({
  type: z.literal('browser:navigate'),
  topicId: z.string(),
  url: z.string(),
  // Browser-pane contextId the client must register the native CDP target under
  // (== resolveContextIdForTopic(topic), i.e. topic.id). Without it the chat pane
  // registered under a random id that never matched the agent's contextId, so
  // every browser_* tool fell back to an invisible Playwright phantom. Optional
  // for back-compat with older clients/messages — omit, never send null.
  contextId: z.optional(z.string()),
});

// Fallback open: when open_browser_pane's normal broadcast mounted no visible
// pane (the spawner terminal/topic isn't a rendered tab), the server asks the
// primary window to force a visible browser pane open under `contextId`.
const browserForceOpenSchema = z.looseObject({
  type: z.literal('browser:force-open'),
  contextId: z.string(),
  url: z.string(),
});

// Remote pane close (close_browser_pane MCP tool / REST): whichever window
// renders `browser:<contextId>` closes it through its normal close flow (X
// button semantics — tombstone, persist, native teardown). Server-side state
// edits can't do this: live clients re-persist their in-memory layout and
// clobber the removal, so the CLIENT must originate the close.
const browserClosePaneSchema = z.looseObject({
  type: z.literal('browser:close-pane'),
  contextId: z.string(),
});

// Remote pane focus (browser_focus_tab MCP tool / REST): whichever window
// renders `browser:<contextId>` brings that tab to the front. Same client-
// originated model as close-pane — tab activation is device-local UI state, so
// the CLIENT applies it; non-owning windows no-op (idempotent broadcast).
const browserFocusPaneSchema = z.looseObject({
  type: z.literal('browser:focus-pane'),
  contextId: z.string(),
});

// Apertura ACCANTO a una pane esistente: un terminale Claude Code ha chiamato
// open_browser_pane, e il browser va messo di fianco a CHI l'ha aperto (la
// chat passa invece dal `browser:navigate` mirato al topic). `paneId` è la
// pane del terminale (`terminal:<sessionId>`); qualunque layout la renda —
// standalone o dentro un progetto — apre il browser lì.
const browserOpenNearPaneSchema = z.looseObject({
  type: z.literal('browser:open-near-pane'),
  paneId: z.string(),
  // contextId deterministico (`term-<terminalId>`) sotto cui la pane registra
  // il target nativo: è ciò che permette al terminale di GUIDARE la stessa
  // pane, non solo di aprirla. Assente → il singleton sceglie un id.
  contextId: z.optional(z.string()),
  url: z.string(),
});

// Browser di proprietà del TASK (dietro TOPICS_TASK_BROWSER): i layout globali
// ignorano di proposito questo frame, così la tab non finisce nel pane-store
// condiviso — la consuma solo il gruppo in-drawer del task.
const browserOpenTaskTabSchema = z.looseObject({
  type: z.literal('browser:open-task-tab'),
  taskId: z.string(),
  contextId: z.string(),
  url: z.string(),
});

// "Porta in primo piano la pane di questo topic". `projectPath` arriva inline
// (invece di leggerlo dal topic) così il client non deve aspettare che atterri
// un `topic:updated` precedente per sapere dentro quale progetto annidarlo.
const paneFocusSuggestSchema = z.looseObject({
  type: z.literal('pane:focus-suggest'),
  topicId: z.string(),
  taskId: z.optional(z.string()),
  projectPath: z.optional(z.string()),
});

const clearSchema = z.looseObject({
  type: z.literal('clear'),
});

const cronUpdatedSchema = z.looseObject({
  type: z.literal('cron:updated'),
  jobs: z.array(z.unknown()),
});

const gatewayStatusSchema = z.looseObject({
  type: z.literal('gateway:status'),
});

const machineShape = z.looseObject({ id: z.string() });

const machineUpdatedSchema = z.looseObject({
  type: z.literal('machine:updated'),
  machine: machineShape,
});

const machineUpsertedSchema = z.looseObject({
  type: z.literal('machine:upserted'),
  machine: machineShape,
});

// La DELETE manda solo `{ id }` dentro `machine` — l'helper `emit` del router
// impacchetta sempre il payload sotto la stessa chiave, quindi la forma sul
// filo resta identica agli altri due eventi machine:*.
const machineDeletedSchema = z.looseObject({
  type: z.literal('machine:deleted'),
  machine: machineShape,
});

const memoryUpdatedSchema = z.looseObject({
  type: z.literal('memory:updated'),
  scope: z.string(),
  topicId: z.optional(z.string()),
});

// Il goal di una topic è cambiato (3.4). Payload GRASSO — il goal intero, passi
// compresi — di proposito: è un oggetto piccolo che cambia raramente, e mandare
// solo l'id costringerebbe ogni finestra aperta a una GET per un dato che
// avevamo già in mano. `goal: null` è lo stato legittimo «non ce n'è uno
// attivo», e serve a spegnere la barra senza inventarsi un evento a parte.
const goalUpdatedSchema = z.looseObject({
  type: z.literal('goal:updated'),
  topicId: z.string(),
  goal: z.nullable(
    z.looseObject({
      id: z.string(),
      topicId: z.string(),
      content: z.string(),
      status: z.enum(['active', 'achieved', 'abandoned']),
      createdBy: z.enum(['human', 'agent']),
      createdAt: z.string(),
      closedAt: z.nullable(z.string()),
      steps: z.array(
        z.looseObject({
          id: z.string(),
          goalId: z.string(),
          position: z.number(),
          content: z.string(),
          status: z.enum(['pending', 'in_progress', 'completed']),
          updatedAt: z.string(),
        }),
      ),
    }),
  ),
});

const openProjectSchema = z.looseObject({
  type: z.literal('open-project'),
  projectPath: z.string(),
});

const topicsReorderedSchema = z.looseObject({
  type: z.literal('topics:reordered'),
  order: z.array(z.string()),
});

const uiStateInitSchema = z.looseObject({
  type: z.literal('ui-state:init'),
  data: z.unknown(),
  meta: z.optional(z.unknown()),
});

const scriptsOutputSchema = z.looseObject({
  type: z.literal('scripts:output'),
});

const scriptsUpdatedSchema = z.looseObject({
  type: z.literal('scripts:updated'),
});

const terminalSessionsSchema = z.looseObject({
  type: z.literal('terminal:sessions'),
  // Un `sessions: []` va creduto? Il server risponde/trasmette anche prima che
  // `reconcileSessions` abbia finito, quindi un roster vuoto puo' significare
  // "non lo so ancora". Facoltativo: i bundle vecchi non lo mandano, e chi lo
  // riceve assente deve trattarlo come "non lo so". Vedi client/src/hooks/rosterTrust.ts.
  reconciled: z.optional(z.boolean()),
});

// Battito di attività per sessione pty, tracciato sul percorso dati centrale:
// copre OGNI sessione, montata o no. `finished` marca la transizione
// attivo→inattivo (turno concluso) ed è ciò che alza la notifica.
const terminalActivitySchema = z.looseObject({
  type: z.literal('terminal:activity'),
  id: z.string(),
  busy: z.boolean(),
  finished: z.optional(z.boolean()),
  kind: z.optional(z.enum(['shell', 'claude-code', 'claude-code-team'])),
});

// ---- Board / task cluster --------------------------------------------------

// La riga completa del task. Come per topic/machine/project teniamo obbligatorie
// solo le colonne su cui il client indicizza davvero (id per la mappa, projectId
// per il filtro di board, status per la colonna kanban): il resto passa, così
// una colonna nuova sul server non fa fallire la validazione di un client vecchio.
const taskObjectShape = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  status: z.string(),
});

const taskCreatedSchema = z.looseObject({
  type: z.literal('task:created'),
  projectId: z.string(),
  task: taskObjectShape,
});

const taskUpdatedSchema = z.looseObject({
  type: z.literal('task:updated'),
  projectId: z.string(),
  task: taskObjectShape,
});

const taskDeletedSchema = z.looseObject({
  type: z.literal('task:deleted'),
  projectId: z.string(),
  taskId: z.string(),
});

// Il fronte "task ENTRATO in review", emesso IN AGGIUNTA a `task:updated` e solo
// sulla transizione: è il segnale di fine-lavoro che alza il banner OS e la
// web-push, senza dipendere dall'inferenza fragile sulla sessione idle.
const taskReviewReadySchema = z.looseObject({
  type: z.literal('task:review-ready'),
  projectId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  reason: z.optional(z.string()),
});

// Il gemello di FALLIMENTO del fronte qui sopra: il task è stato PARCHEGGIATO e
// non riparte da solo. Emesso solo sul park terminale (`requeue: false`) — mai
// su un rimessa-in-coda, dove il task si auto-guarisce e un banner sarebbe
// rumore su un ritentativo. `state` distingue le due domande che pone
// all'umano: 'failed' = l'agent non ha prodotto niente, 'blocked' = c'è una
// configurazione da sistemare (worktree, directory del progetto).
const taskParkedSchema = z.looseObject({
  type: z.literal('task:parked'),
  projectId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  state: z.union([z.literal('failed'), z.literal('blocked')]),
  reason: z.optional(z.string()),
});

// Anteprima LIVE del consumo mentre il turno gira (ogni 4s, mai persistita): la
// card somma `baseMs` + (adesso − turnStartedAt), quindi il tempo mostrato è
// solo ESECUZIONE — le pause tra un turno e l'altro non entrano mai nel conto.
const taskUsageLiveSchema = z.looseObject({
  type: z.literal('task:usage-live'),
  projectId: z.string(),
  taskId: z.string(),
  turnStartedAt: z.number(),
  baseMs: z.number(),
  liveTokens: z.number(),
  model: z.nullable(z.string()),
});

// L'interruttore auto-dispatch è GLOBALE, non per progetto: ogni header di board
// aperto — non solo quello del progetto toccato — deve girare la pill.
const boardDispatchSchema = z.looseObject({
  type: z.literal('board:dispatch'),
  autoDispatch: z.boolean(),
});

// Il cap macchina-wide vive sulla riga riservata '*'. `maxAgentsAuto` è un
// BOOLEANO ("scegli tu in base alla capacità"), non un numero.
const boardGlobalCapSchema = z.looseObject({
  type: z.literal('board:global-cap'),
  maxAgentsAuto: z.boolean(),
  maxAgents: z.number(),
});

const boardSettingsSchema = z.looseObject({
  type: z.literal('board:settings'),
  projectId: z.string(),
  settings: z.looseObject({}),
});

// ---- Dev bundle hot-delivery ----------------------------------------------

// Il bundle client è cambiato su disco. `rev` (i nomi ordinati di /assets/*)
// permette al client di NON ricaricarsi se già gira quella revisione.
const uiBundleUpdatedSchema = z.looseObject({
  type: z.literal('ui:bundle-updated'),
  at: z.number(),
  rev: z.optional(z.string()),
});

// Stesso `rev`, ma alla connessione: una finestra che era chiusa al momento del
// deploy converge lo stesso, invece di restare indietro fino al reload manuale.
const uiBundleRevSchema = z.looseObject({
  type: z.literal('ui:bundle-rev'),
  rev: z.string(),
});

// ---- External Claude sessions (il censimento di ciò che Topics NON ha avviato) ----

// Nome fuori convenzione (`external-sessions`, non `sessions:external`): è sul
// filo da prima della v3 e il client lo ascolta così com'è. Si rinomina quando
// si versiona il protocollo, non con una modifica di contorno. È anche il
// motivo per cui lo scan statico dei test non lo vedeva: senza `:` nel nome
// non passava il filtro — l'ha stanato il compilatore, non la regex.
const externalClaudeSessionShape = z.looseObject({
  sessionId: z.string(),
  cwd: z.string(),
  projectPath: z.nullable(z.string()),
  projectId: z.nullable(z.string()),
  lastActivityMs: z.number(),
  state: z.enum(['active', 'idle']),
});

const externalSessionProjectShape = z.looseObject({
  projectId: z.string(),
  projectPath: z.string(),
  total: z.number(),
  active: z.number(),
  lastActivityMs: z.number(),
});

const externalSessionsSchema = z.looseObject({
  type: z.literal('external-sessions'),
  sessions: z.array(externalClaudeSessionShape),
  projects: z.array(externalSessionProjectShape),
});

// ---- Legacy chat:* events (replaced by topic:* in v3, kept for compat) ----

// I `chat:*` (created/updated/archived/deleted), `provider:current`,
// `provider:changed` e `agent:status` stavano qui: sette schemi che NESSUNO
// mandava e NESSUNO ascoltava — ne' il server li emetteva, ne' il client li
// nominava. Un registro di protocollo che dichiara messaggi inesistenti fa
// credere che una via di sincronizzazione ci sia; il ciclo di vita delle chat
// passa da `topic:*`, che e' vivo. Il test di copertura difende il verso
// opposto (un broadcast senza schema), quindi questi non erano coperti da
// niente. Rimossi il 30/07.

// ---- Git status -----------------------------------------------------------

const gitStatusSchema = z.looseObject({
  type: z.literal('git:status'),
});

// ---- Claude session state + events (highest-traffic live path) ------------

/**
 * `session:state` is the hot phase-machine broadcast. We validate the
 * WRAPPER — sessionKey (nullable for terminal sessions) + a state object that
 * must carry claudeSessionId + phase — and accept the rest of the rich
 * ClaudeSessionState via z.looseObject (it evolves across migrations).
 */
const sessionStateSchema = z.looseObject({
  type: z.literal('session:state'),
  sessionKey: z.nullable(z.string()),
  state: z.looseObject({
    claudeSessionId: z.string(),
    phase: z.string(),
  }),
});

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
  // Approvals
  // Stream cluster (provider streaming)
  'stream:start': streamStartSchema,
  'stream:content_chunk': streamContentChunkSchema,
  'stream:context': streamContextSchema,
  'stream:usage': streamUsageSchema,
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
  'stream:tool_usage': streamToolUsageSchema,
  'stream:tool_user_input_required': streamToolUserInputRequiredSchema,
  // Message cluster
  'message': messageLegacySchema,
  'message:new': messageNewSchema,
  'message:media': messageMediaSchema,
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
  'goal:updated': goalUpdatedSchema,
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
  'task:parked': taskParkedSchema,
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
  // Provider niche
  // Git status — the live event git-watcher actually emits.
  'git:status': gitStatusSchema,
  // Claude session state (highest-traffic live path)
  'session:state': sessionStateSchema,
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
 * `z.looseObject`, quindi inferiscono un index signature `[k: string]: unknown`
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
  /** `type` c'è quando il frame ne aveva uno leggibile — serve al log lato client
   *  per dire QUALE messaggio è stato scartato, non solo che qualcosa è caduto. */
  | { ok: false; error: string; type?: string };

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
  const schema = (OUTBOUND_SCHEMAS as Record<string, z.ZodMiniType>)[type];
  if (!schema) {
    // Unmodeled type — passthrough is OK. Future commits add more schemas.
    return { ok: true };
  }
  const result = schema.safeParse(msg);
  if (result.success) return { ok: true };
  return { ok: false, type, error: formatZodIssues(result.error) };
}

/**
 * Convenience: returns true if the type is known to this module's registry.
 * Useful for tests + dev-mode diagnostics ("which outbound types are still
 * unmodeled?").
 */
export function isRegisteredOutboundType(type: string): boolean {
  return type in OUTBOUND_SCHEMAS;
}
