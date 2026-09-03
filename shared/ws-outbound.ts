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

/**
 * EVERY cause a turn can end with - this list IS the wire contract.
 *
 * It used to be written twice: here as a `z.enum([...])` with SIX values, and
 * in `server/providers/stop-reason.ts` as a documented union with NINE. The
 * three missing ones - `server-shutdown`, `stall`, `turn-in-flight` - were
 * really being emitted, and every `stream:end` carrying one was rejected as a
 * malformed broadcast: the client never received the end of the turn, so that
 * chat stayed "running" forever. The server log showed it in bursts:
 * "Malformed broadcast - stopCause: Invalid option".
 *
 * Three different ways to leave a dead chat alive, for one copied list. There
 * is one list now, and `stop-reason.ts` checks AT COMPILE TIME that it matches
 * this one both ways: adding a cause over there without adding it here no
 * longer builds.
 */
export const STOP_CAUSES = [
  'user',
  'watchdog',
  'wall-clock',
  'server-shutdown',
  'stall',
  'session-reset',
  'process-died',
  'turn-in-flight',
  'superseded',
  'provider-error',
] as const;


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
  stopCause: z.optional(z.enum(STOP_CAUSES)),
  // Marcatore POSITIVo di fine PULITA (`end_turn`, turno non vuoto): lo legge la
  // push di fine risposta (server/push-triggers) per non annunciare "risposta
  // pronta" su un turno morto. `dispatched` = turno d'agente guidato dalla board
  // (escluso dalla push). Vedi server/push-triggers.ts.
  completed: z.optional(z.boolean()),
  dispatched: z.optional(z.boolean()),
  // The turn DIED and this is the notice it left in the chat (provider error,
  // retries exhausted, watchdog, empty reply). Travels with `reason: 'error'`
  // so the failure push (server/push-triggers, `chat-error`) can say what
  // happened without re-reading the row. Absent on a clean end.
  error: z.optional(z.string()),
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
  // The wait the turn is in when this client attaches. `stream:retry` and
  // `stream:slow` are broadcast once, when the wait starts; a client that
  // connects during a backoff would otherwise see a moving ring and
  // "elaborando" for 30 s. Absent = the turn is flowing. Same fields as the
  // `stream:retry` frame, plus `at` (epoch ms) so the remaining delay can be
  // computed; `slow` mirrors `stream:slow`, and `stream:resumed` clears both.
  retry: z.optional(z.object({
    attempt: z.number(),
    maxAttempts: z.number(),
    delayMs: z.number(),
    reason: z.string(),
    at: z.number(),
  })),
  slow: z.optional(z.boolean()),
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
  // `.min(1)`, non solo `string`: la stringa vuota passava, e a valle il client
  // ci vedeva un valore mancante e coniava un id locale — cioe' la riga in DB e
  // la bolla a schermo con due nomi diversi, che e' il difetto che questo campo
  // esiste per impedire. Il posto per rifiutarla e' la porta, non il chiamante.
  messageId: z.string().check(z.minLength(1)),
  /**
   * Il turno non comincia: RIPRENDE. `messageId` punta a una bolla che il
   * client ha già piena — quella di prima del riavvio — e il replay sta per
   * ridettarla da capo. Chi la vede la svuota adesso, o le delta si sommano a
   * quello che c'è e il testo esce doppio.
   *
   * Prima questo azzeramento si faceva cancellando il corpo della riga in DB, e
   * bastava che la riadozione morisse prima di rimetterlo a posto per perderlo
   * per sempre. La vista si può rifare; il record no.
   */
  reattached: z.optional(z.boolean()),
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

// The provider's API call failed transiently and the turn is waiting to try it
// again. Transient like `stream:slow`: `stream:resumed` clears it when data
// flows again, and the end of the turn clears everything.
const streamRetrySchema = z.looseObject({
  type: z.literal('stream:retry'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  /** The attempt that just failed, 1-based. */
  attempt: z.number(),
  maxAttempts: z.number(),
  /** Wait before the next attempt, in milliseconds. */
  delayMs: z.number(),
  /** Short cause, e.g. `API 529`, `stream overloaded_error`, `network`. */
  reason: z.string(),
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

/**
 * Un permesso NON è una domanda, e ha il suo evento: `toolCallId` è la riga già
 * a schermo, `request` dice cosa la CLI vuole poter fare. Prima passava per
 * `tool_user_input_required` con uno schema di domande dentro, e la decisione
 * tornava indietro come testo dentro una mappa di risposte.
 */
const streamToolPermissionRequiredSchema = z.looseObject({
  type: z.literal('stream:tool_permission_required'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  toolCallId: z.string(),
  request: z.looseObject({
    toolName: z.string(),
    requestedAt: z.number(),
  }),
});

/**
 * La decisione presa. Simmetrico a `…_required`, e non un `stream:tool_update`
 * nudo: quell'evento porta solo `partialResult`, quindi un client che lo
 * riceveva non aveva modo di sapere COSA era stato deciso — il pannello
 * spariva e al suo posto non restava niente finché non ricaricavi.
 */
const streamToolPermissionResolvedSchema = z.looseObject({
  type: z.literal('stream:tool_permission_resolved'),
  sessionKey: z.string(),
  topicId: z.optional(z.string()),
  toolCallId: z.string(),
  outcome: z.looseObject({
    decision: z.string(),
    decidedAt: z.string(),
    // Chi ha deciso. C'è solo su `allow_free`, l'unica decisione che cambia il
    // regime della sessione e quindi l'unica che qualcuno andrà a chiedere «e
    // chi è stato?».
    actor: z.optional(z.string()),
  }),
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
// `title` è il NOME che l'agente ha prescritto alla tab (il manifesto), assente
// quando non ne ha dato uno — allora l'etichetta resta il titolo della pagina.
const browserOpenTaskTabSchema = z.looseObject({
  type: z.literal('browser:open-task-tab'),
  taskId: z.string(),
  contextId: z.string(),
  url: z.string(),
  title: z.optional(z.string()),
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
  /**
   * L'INTERO sottoalbero archiviato (root compresa): archiviare un task
   * archivia in cascata i suoi sottotask, e chi tiene stato per-task deve
   * dimenticarli tutti, non solo la root. Oggi lo usa il client per buttare via
   * `task-browser-tabs:<id>` / `task-browser-layout:<id>` dalla sua cache
   * (`useTaskBrowserTabsSync`): il server ha appena cancellato quelle righe, e
   * un client che se le ricorda le ri-PUTterebbe al primo debounce.
   * Assente ⇒ ricadi su `[taskId]`.
   */
  taskIds: z.optional(z.array(z.string())),
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
  // La domanda pendente dell'agente, quando la consegna È una domanda. Viaggia
  // QUI e non la si va a cercare dopo: è il dato che trasforma il banner in una
  // risposta (le opzioni diventano i tasti — shared/notify-actions), e chi lo
  // legge sono due superfici che non possono interrogare il DB (il service
  // worker della push) o che pagherebbero un fetch in più per ogni consegna
  // (il notificatore del client).
  // NULLABLE e non semplicemente opzionale: `null` = «questo server ha
  // guardato e domanda non ce n'è», assente = «server che non sa rispondere
  // alla domanda» (uno vecchio). Il client si comporta diversamente nei due
  // casi — vedi il commento in `emitReviewReadyEdge`.
  question: z.optional(
    z.nullable(
      z.looseObject({
        text: z.string(),
        options: z.array(z.string()),
      }),
    ),
  ),
  // Se l'ULTIMA parola dell'agente sta davvero chiedendo qualcosa a un
  // umano (`commentAsksHuman`, legge le opzioni non la fence). Distinto da
  // `question`, che porta anche le opzioni di una consegna landabile: senza
  // questo campo il titolo del banner e la lista dei tasti dovrebbero
  // condividere lo stesso predicato, e una consegna con la sola opzione
  // "Landa su main" si presenterebbe come una domanda. Opzionale per lo
  // stesso motivo di `question`: assente = server vecchio che non lo sa dire.
  isAsk: z.optional(z.boolean()),
});

// Il gemello di FALLIMENTO del fronte qui sopra: il task è stato PARCHEGGIATO e
// non riparte da solo. Emesso solo sul park terminale (`requeue: false`) — mai
// su un rimessa-in-coda, dove il task si auto-guarisce e un banner sarebbe
// rumore su un ritentativo. `state` distingue le due domande che pone
// all'umano: 'failed' = l'agent non ha prodotto niente, 'blocked' = c'è una
// configurazione da sistemare (worktree, directory del progetto), 'waited_out'
// = la serie di attese dichiarate ha sfondato il tetto, quindi non c'è niente
// di rotto: c'è una condizione che non arriva e la decisione torna all'umano.
// Il terzo valore esiste perché riusare 'blocked' farebbe dire al banner «da
// sistemare» su un task che non ha niente da sistemare.
const taskParkedSchema = z.looseObject({
  type: z.literal('task:parked'),
  projectId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  state: z.union([z.literal('failed'), z.literal('blocked'), z.literal('waited_out')]),
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
  // «Sta ancora inquadrando il task»: primo turno, card ancora intatta. Facoltativo
  // perché un client più vecchio del server non lo conosce e un server più vecchio
  // del client non lo manda: assente vale come falso, e nessuna delle due metà si
  // rompe per un chip.
  triage: z.optional(z.boolean()),
});

// «Questo task sta aspettando una PERSONA», mentre il turno è ancora vivo: un
// pannello di domanda o una richiesta di permesso aperti a metà turno.
//
// Transitorio come `task:usage-live`, e per la stessa ragione più una in più.
// La ragione in più: l'attesa vive nelle mappe in memoria di `ask-user-bridge` e
// `permission-bridge`, quindi a server riavviato NON esiste più. Scriverla in
// `dispatch_state` la farebbe sopravvivere a chi la sostiene — e, provato sul
// campo, farebbe anche uscire il task dalla porta del recupero orfani
// (`ACTIVE_DISPATCH_STATES`), lasciandolo `in_progress` per sempre.
const taskAwaitingHumanSchema = z.looseObject({
  type: z.literal('task:awaiting-human'),
  projectId: z.string(),
  taskId: z.string(),
  /** true quando l'attesa comincia, false quando finisce. */
  waiting: z.boolean(),
  /** Da quale porta arriva. Per chi guarda la board sono lo stesso fatto: serve nei log. */
  source: z.enum(['ask', 'permission']),
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
  // The two SPEND caps in USD cents, on the same '*' row and therefore in the
  // same announcement: zero means unlimited, and that is the starting state.
  // Optional: a server older than the counter does not send them, and the panel
  // must read "no cap" instead of failing to update.
  agentCostCapCents: z.optional(z.number()),
  agentCostCapCents24h: z.optional(z.number()),
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

// ---- File tree ------------------------------------------------------------

/**
 * Il filesystem del progetto è cambiato. Nessun payload di proposito: chi
 * ascolta ricarica il pezzo che gli serve (vedi `server/file-watcher.ts`).
 */
const filesChangedSchema = z.looseObject({
  type: z.literal('files:changed'),
  projectPath: z.string(),
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

// ---- Appaiamento dei dispositivi -------------------------------------------

/**
 * Un dispositivo NUOVO ha chiesto accesso. Va in broadcast perche' la richiesta
 * deve raggiungere la macchina gia' fidata OVUNQUE l'utente stia guardando: se
 * comparisse solo dentro un pannello di impostazioni, chi arriva col telefono in
 * mano resterebbe fermo su una schermata d'attesa senza sapere dove andare — che
 * e' esattamente il vicolo cieco per cui il pairing precedente non e' mai servito
 * a nessuno.
 *
 * `code` viaggia in chiaro e va bene: NON e' un segreto da indovinare, e' una
 * etichetta da CONFRONTARE con quella mostrata sul dispositivo che chiede. Chi
 * riceve questo frame e' gia' dentro.
 */
const authPairRequestedSchema = z.object({
  type: z.literal('auth:pair-requested'),
  requestId: z.string(),
  code: z.string(),
  name: z.string(),
  ip: z.nullable(z.string()),
});

/** La richiesta e' stata sciolta: serve a togliere il cartello da OGNI finestra
 *  aperta, non solo da quella dove qualcuno ha cliccato. */
const authPairResolvedSchema = z.object({
  type: z.literal('auth:pair-resolved'),
  requestId: z.string(),
  approved: z.boolean(),
  deviceId: z.optional(z.string()),
});

/** Un dispositivo e' stato revocato: le altre finestre aggiornano l'elenco. */
const authDeviceRevokedSchema = z.object({
  type: z.literal('auth:device-revoked'),
  deviceId: z.string(),
});

/**
 * Le concessioni di un dispositivo sono cambiate: qualcosa gli e' stato
 * condiviso, o tolto.
 *
 * NON porta la risorsa, ed e' deliberato: sulla REVOCA la concessione non esiste
 * piu', quindi un filtro per entita' scarterebbe proprio il frame che serve di
 * piu'. Per lo stesso motivo non passa da un broadcast filtrato ma da un invio
 * MIRATO al dispositivo interessato — che e' anche l'unico che ha motivo di
 * riceverlo.
 */
const authSharesChangedSchema = z.object({
  type: z.literal('auth:shares-changed'),
});

// ---- Cronologia delle notifiche --------------------------------------------

/**
 * Una notifica è appena stata REGISTRATA (migration 102 · db/notification-log).
 * Emesso una volta sola per evento, dopo il taglio del dedup: se due porte —
 * banner nativo e web-push — o N finestre staccate riportano la stessa notifica,
 * la riga è una e questo frame parte una volta.
 *
 * Porta la riga INTERA e non solo il conteggio, perché il tastino accanto a
 * Topics deve poter mostrare l'ultima voce senza rileggere l'elenco: il
 * contatore che si aggiorna «dal vivo» e una lista che si aggiorna solo
 * all'apertura sono due promesse diverse.
 */
const notificationNewSchema = z.looseObject({
  type: z.literal('notification:new'),
  row: z.looseObject({
    id: z.string(),
    createdAt: z.string(),
    kind: z.string(),
    title: z.string(),
    body: z.string(),
    targetKind: z.nullable(z.string()),
    targetId: z.nullable(z.string()),
    targetUrl: z.nullable(z.string()),
    source: z.string(),
    groupKey: z.nullable(z.string()),
    seenAt: z.nullable(z.string()),
  }),
  unseen: z.number(),
});

/**
 * Il «visto» è stato applicato: il contatore vale ORA questo.
 *
 * Il frame porta solo il numero perché il «visto» è GLOBALE, non per
 * dispositivo: guardare la cronologia su una finestra deve spegnere il pallino
 * anche sulle altre e sul telefono. Senza questo frame ogni finestra resterebbe
 * con il suo conteggio vecchio fino al ricaricamento — cioè col difetto che il
 * contatore live doveva togliere.
 */
const notificationSeenSchema = z.looseObject({
  type: z.literal('notification:seen'),
  unseen: z.number(),
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
  'stream:retry': streamRetrySchema,
  'stream:compaction': streamCompactionSchema,
  'stream:tool_call': streamToolCallSchema,
  'stream:tool_detail': streamToolDetailSchema,
  'stream:tool_result': streamToolResultSchema,
  'stream:tool_update': streamToolUpdateSchema,
  'stream:tool_usage': streamToolUsageSchema,
  'stream:tool_user_input_required': streamToolUserInputRequiredSchema,
  'stream:tool_permission_required': streamToolPermissionRequiredSchema,
  'stream:tool_permission_resolved': streamToolPermissionResolvedSchema,
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
  'task:awaiting-human': taskAwaitingHumanSchema,
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
  // Filesystem del progetto — l'evento che il file-watcher emette.
  'files:changed': filesChangedSchema,
  // Claude session state (highest-traffic live path)
  'session:state': sessionStateSchema,
  // Appaiamento dei dispositivi
  'auth:pair-requested': authPairRequestedSchema,
  'auth:pair-resolved': authPairResolvedSchema,
  'auth:device-revoked': authDeviceRevokedSchema,
  'auth:shares-changed': authSharesChangedSchema,
  // Cronologia delle notifiche
  'notification:new': notificationNewSchema,
  'notification:seen': notificationSeenSchema,
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
