/**
 * v3 foundations AGENT-02 — Append-only epoch timeline store.
 *
 * Each agent session can have N epochs (new run = new epoch). Each epoch
 * has an ordered, append-only stream of events. This module is the SOLE
 * mutator of the `agent_epochs` and `agent_epoch_events` tables — every
 * other consumer reads via the typed accessors here.
 *
 * Design notes:
 *   - Append-only: no UPDATE/DELETE on events. State changes are NEW rows.
 *     This makes the schema crash-safe (daemon restart loses 0 events).
 *   - Bounded retention: per AGENT-02 spec, the last 200 events per agent
 *     are retained. `pruneOldestEvents` enforces this; callers run it
 *     after `recordEvent` (or batched by a periodic job).
 *   - Zod validation on emit: every event has a typed payload, validated
 *     before insert. Bad payloads crash at the boundary, not days later
 *     when a reader chokes.
 *   - Foundation for AGENT-03..08:
 *       * AGENT-03 reads `tool_call` events instead of polling JSONL.
 *       * AGENT-04 fixes the NaN token count by validating `token_usage`
 *         payloads on the way in.
 *       * AGENT-05..08 read the timeline through `readEpochTimeline`.
 */
import type { Database } from 'bun:sqlite';
import { z } from 'zod';

// ----- Event payload schemas ------------------------------------------------

const stateTransitionPayloadSchema = z.object({
  from: z.string(),
  to: z.string(),
  reason: z.string().optional(),
});

const toolCallPayloadSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  result: z.string().optional(),
  status: z.enum(['pending', 'running', 'success', 'error', 'waiting_for_input']).optional(),
});

const permissionRequestPayloadSchema = z.object({
  requestId: z.string(),
  prompt: z.string(),
  options: z.array(z.string()).optional(),
});

const permissionResponsePayloadSchema = z.object({
  requestId: z.string(),
  decision: z.enum(['allow', 'deny']),
  reason: z.string().optional(),
});

/**
 * AGENT-04 fix surface: provider-reported usage. The legacy NaN bug
 * happens when the provider emits `prompt_tokens: null` and the renderer
 * uses `+null + +undefined → NaN`. Validating here rejects nulls and
 * NaN at insertion time, so consumers can trust the stored value.
 */
const tokenUsagePayloadSchema = z.object({
  promptTokens: z.number().int().nonnegative().finite(),
  completionTokens: z.number().int().nonnegative().finite(),
  totalTokens: z.number().int().nonnegative().finite().optional(),
  cachedTokens: z.number().int().nonnegative().finite().optional(),
  costCents: z.number().nonnegative().finite().optional(),
});

const notePayloadSchema = z.object({
  message: z.string(),
  level: z.enum(['info', 'warn', 'error']).optional(),
}).passthrough();

const eventTypeSchema = z.enum([
  'state_transition',
  'tool_call',
  'permission_request',
  'permission_response',
  'token_usage',
  'note',
]);

export type AgentEpochEventType = z.infer<typeof eventTypeSchema>;

// ----- Validation entry point ----------------------------------------------

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

function formatZodIssues<T>(result: z.SafeParseReturnType<unknown, T>): string {
  if (result.success) return '';
  return result.error.issues
    .map((iss) => `${iss.path.length ? iss.path.join('.') : '<root>'}: ${iss.message}`)
    .join('; ');
}

/**
 * Validate that a payload shape matches its event_type. Returns
 * { ok: true, data } with the validated payload on success, or
 * { ok: false, error } with a path-qualified error string on failure.
 */
export function parseEpochEventPayload(
  eventType: AgentEpochEventType,
  payload: unknown,
): ParseResult<unknown> {
  let parsed;
  switch (eventType) {
    case 'state_transition':
      parsed = stateTransitionPayloadSchema.safeParse(payload);
      break;
    case 'tool_call':
      parsed = toolCallPayloadSchema.safeParse(payload);
      break;
    case 'permission_request':
      parsed = permissionRequestPayloadSchema.safeParse(payload);
      break;
    case 'permission_response':
      parsed = permissionResponsePayloadSchema.safeParse(payload);
      break;
    case 'token_usage':
      parsed = tokenUsagePayloadSchema.safeParse(payload);
      break;
    case 'note':
      parsed = notePayloadSchema.safeParse(payload);
      break;
  }
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: formatZodIssues(parsed) };
}

// ----- Types ----------------------------------------------------------------

export interface AgentEpoch {
  id: string;
  sessionId: string;
  epochIndex: number;
  startedAt: string;
  endedAt: string | null;
  endReason: 'completed' | 'error' | 'stale' | 'aborted' | null;
}

export interface AgentEpochEvent {
  id: string;
  epochId: string;
  sequence: number;
  eventType: AgentEpochEventType;
  payload: unknown;
  recordedAt: string;
}

// ----- Store factory --------------------------------------------------------

const DEFAULT_MAX_EVENTS_PER_AGENT = 200;

export interface AgentEpochStoreOptions {
  /** Per-AGENT-02 spec: bounded retention to keep query latency stable. */
  maxEventsPerAgent?: number;
}

export interface AgentEpochStore {
  /** Open (or get) a new epoch for the given session. */
  openEpoch(sessionId: string, options?: { now?: string }): AgentEpoch;
  /** Close an open epoch with a terminal reason. Idempotent. */
  closeEpoch(epochId: string, endReason: NonNullable<AgentEpoch['endReason']>, options?: { now?: string }): boolean;
  /** Append an event to an open epoch. Returns the event id. */
  recordEvent(
    epochId: string,
    eventType: AgentEpochEventType,
    payload: unknown,
    options?: { now?: string },
  ): AgentEpochEvent;
  /** Read the timeline for one session (most-recent first by default). */
  readEpochTimeline(sessionId: string, options?: { limit?: number; ascending?: boolean }): AgentEpochEvent[];
  /** Read the timeline for an entire agent (across all sessions). */
  readAgentTimeline(agentId: string, options?: { limit?: number; ascending?: boolean }): AgentEpochEvent[];
  /** Enforce retention. Idempotent. Returns number of events deleted. */
  pruneOldestEvents(agentId: string): number;
}

export function createAgentEpochStore(
  db: Database,
  options: AgentEpochStoreOptions = {},
): AgentEpochStore {
  const maxEvents = options.maxEventsPerAgent ?? DEFAULT_MAX_EVENTS_PER_AGENT;

  const stmts = {
    insertEpoch: db.prepare(`
      INSERT INTO agent_epochs (id, session_id, epoch_index, started_at)
      VALUES (?, ?, ?, ?)
    `),
    nextEpochIndex: db.prepare(`
      SELECT COALESCE(MAX(epoch_index), -1) + 1 AS next
      FROM agent_epochs WHERE session_id = ?
    `),
    closeEpoch: db.prepare(`
      UPDATE agent_epochs SET ended_at = ?, end_reason = ?
      WHERE id = ? AND ended_at IS NULL
    `),
    insertEvent: db.prepare(`
      INSERT INTO agent_epoch_events (id, epoch_id, sequence, event_type, payload, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    nextEventSeq: db.prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS next
      FROM agent_epoch_events WHERE epoch_id = ?
    `),
    readSessionTimeline: db.prepare(`
      SELECT e.id, e.epoch_id, e.sequence, e.event_type, e.payload, e.recorded_at
      FROM agent_epoch_events e
      JOIN agent_epochs ep ON ep.id = e.epoch_id
      WHERE ep.session_id = ?
      ORDER BY ep.epoch_index ASC, e.sequence ASC
    `),
    readSessionTimelineDesc: db.prepare(`
      SELECT e.id, e.epoch_id, e.sequence, e.event_type, e.payload, e.recorded_at
      FROM agent_epoch_events e
      JOIN agent_epochs ep ON ep.id = e.epoch_id
      WHERE ep.session_id = ?
      ORDER BY ep.epoch_index DESC, e.sequence DESC
      LIMIT ?
    `),
    readAgentTimeline: db.prepare(`
      SELECT e.id, e.epoch_id, e.sequence, e.event_type, e.payload, e.recorded_at
      FROM agent_epoch_events e
      JOIN agent_epochs ep ON ep.id = e.epoch_id
      JOIN agent_sessions s ON s.id = ep.session_id
      WHERE s.agent_id = ?
      ORDER BY e.recorded_at ASC
    `),
    readAgentTimelineDesc: db.prepare(`
      SELECT e.id, e.epoch_id, e.sequence, e.event_type, e.payload, e.recorded_at
      FROM agent_epoch_events e
      JOIN agent_epochs ep ON ep.id = e.epoch_id
      JOIN agent_sessions s ON s.id = ep.session_id
      WHERE s.agent_id = ?
      ORDER BY e.recorded_at DESC
      LIMIT ?
    `),
    countAgentEvents: db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM agent_epoch_events e
      JOIN agent_epochs ep ON ep.id = e.epoch_id
      JOIN agent_sessions s ON s.id = ep.session_id
      WHERE s.agent_id = ?
    `),
    pruneOldestAgentEvents: db.prepare(`
      DELETE FROM agent_epoch_events
      WHERE id IN (
        SELECT e.id
        FROM agent_epoch_events e
        JOIN agent_epochs ep ON ep.id = e.epoch_id
        JOIN agent_sessions s ON s.id = ep.session_id
        WHERE s.agent_id = ?
        ORDER BY e.recorded_at ASC
        LIMIT ?
      )
    `),
  };

  function newId(): string {
    return crypto.randomUUID();
  }

  function rowToEvent(row: {
    id: string;
    epoch_id: string;
    sequence: number;
    event_type: string;
    payload: string;
    recorded_at: string;
  }): AgentEpochEvent {
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      // Stored payloads are always valid JSON by insertion contract, but
      // defend against legacy rows: surface the raw string instead.
      parsed = { _raw: row.payload };
    }
    return {
      id: row.id,
      epochId: row.epoch_id,
      sequence: row.sequence,
      eventType: row.event_type as AgentEpochEventType,
      payload: parsed,
      recordedAt: row.recorded_at,
    };
  }

  return {
    openEpoch(sessionId, opts) {
      const id = newId();
      const now = opts?.now ?? new Date().toISOString();
      const next = (stmts.nextEpochIndex.get(sessionId) as { next: number }).next;
      stmts.insertEpoch.run(id, sessionId, next, now);
      return {
        id,
        sessionId,
        epochIndex: next,
        startedAt: now,
        endedAt: null,
        endReason: null,
      };
    },

    closeEpoch(epochId, endReason, opts) {
      const now = opts?.now ?? new Date().toISOString();
      const r = stmts.closeEpoch.run(now, endReason, epochId) as { changes?: number };
      return (r.changes ?? 0) > 0;
    },

    recordEvent(epochId, eventType, payload, opts) {
      const parsed = parseEpochEventPayload(eventType, payload);
      if (!parsed.ok) {
        throw new Error(`[agent-epoch] Refusing to record malformed ${eventType} event: ${parsed.error}`);
      }
      const id = newId();
      const now = opts?.now ?? new Date().toISOString();
      const seq = (stmts.nextEventSeq.get(epochId) as { next: number }).next;
      stmts.insertEvent.run(id, epochId, seq, eventType, JSON.stringify(parsed.data), now);
      return {
        id,
        epochId,
        sequence: seq,
        eventType,
        payload: parsed.data,
        recordedAt: now,
      };
    },

    readEpochTimeline(sessionId, opts) {
      const ascending = opts?.ascending ?? true;
      if (ascending) {
        const rows = stmts.readSessionTimeline.all(sessionId) as Array<{
          id: string; epoch_id: string; sequence: number;
          event_type: string; payload: string; recorded_at: string;
        }>;
        return rows.map(rowToEvent);
      }
      const limit = opts?.limit ?? maxEvents;
      const rows = stmts.readSessionTimelineDesc.all(sessionId, limit) as Array<{
        id: string; epoch_id: string; sequence: number;
        event_type: string; payload: string; recorded_at: string;
      }>;
      return rows.map(rowToEvent);
    },

    readAgentTimeline(agentId, opts) {
      const ascending = opts?.ascending ?? true;
      if (ascending) {
        const rows = stmts.readAgentTimeline.all(agentId) as Array<{
          id: string; epoch_id: string; sequence: number;
          event_type: string; payload: string; recorded_at: string;
        }>;
        return rows.map(rowToEvent);
      }
      const limit = opts?.limit ?? maxEvents;
      const rows = stmts.readAgentTimelineDesc.all(agentId, limit) as Array<{
        id: string; epoch_id: string; sequence: number;
        event_type: string; payload: string; recorded_at: string;
      }>;
      return rows.map(rowToEvent);
    },

    pruneOldestEvents(agentId) {
      const cnt = (stmts.countAgentEvents.get(agentId) as { cnt: number }).cnt;
      const overflow = cnt - maxEvents;
      if (overflow <= 0) return 0;
      const r = stmts.pruneOldestAgentEvents.run(agentId, overflow) as { changes?: number };
      return r.changes ?? 0;
    },
  };
}
