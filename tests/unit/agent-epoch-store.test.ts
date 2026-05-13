/**
 * Integration tests for the v3 foundations AGENT-02 epoch timeline store.
 *
 * Verifies:
 *   - Append-only behavior: events accumulate, never updated.
 *   - Epoch indices are monotonic per session.
 *   - Event sequences are monotonic per epoch.
 *   - Payload validation rejects malformed shapes (NaN tokens, missing
 *     fields, wrong types).
 *   - Bounded retention enforces the 200-event cap.
 *   - Timeline reads return ordered slices.
 *
 * Run with: `bun test tests/unit/agent-epoch-store.test.ts`
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createAgentEpochStore,
  parseEpochEventPayload,
} from '../../server/agent-epoch-store';

function freshDb(): Database {
  const db = new Database(':memory:');
  // Minimum schema: agent_profiles + agent_sessions (FK target) + the new
  // agent_epochs / agent_epoch_events tables from migration 025.
  db.prepare(`
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'busy', 'paused', 'offline')),
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `).run();
  db.prepare(`
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      session_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT ''
    )
  `).run();
  db.prepare(`
    CREATE TABLE agent_epochs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      epoch_index INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT CHECK(end_reason IS NULL OR end_reason IN ('completed', 'error', 'stale', 'aborted')),
      UNIQUE(session_id, epoch_index)
    )
  `).run();
  db.prepare(`
    CREATE TABLE agent_epoch_events (
      id TEXT PRIMARY KEY,
      epoch_id TEXT NOT NULL REFERENCES agent_epochs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      recorded_at TEXT NOT NULL,
      UNIQUE(epoch_id, sequence)
    )
  `).run();
  return db;
}

function seedSession(db: Database, sessionId: string, agentId: string = 'agent-1'): void {
  // Ensure profile exists for FK.
  db.prepare(`INSERT OR IGNORE INTO agent_profiles (id, name) VALUES (?, ?)`).run(agentId, agentId);
  db.prepare(`
    INSERT INTO agent_sessions (id, agent_id, session_key, status, started_at)
    VALUES (?, ?, ?, 'active', '2026-05-13T00:00:00Z')
  `).run(sessionId, agentId, `sk-${sessionId}`);
}

// ---- Payload validation ----------------------------------------------------

describe('parseEpochEventPayload', () => {
  test('state_transition requires from + to strings', () => {
    expect(parseEpochEventPayload('state_transition', {
      from: 'active', to: 'stale',
    }).ok).toBe(true);
    expect(parseEpochEventPayload('state_transition', {
      from: 'active', to: 'stale', reason: 'heartbeat timeout',
    }).ok).toBe(true);
    expect(parseEpochEventPayload('state_transition', { from: 'active' }).ok).toBe(false);
  });

  test('tool_call requires toolCallId + toolName', () => {
    expect(parseEpochEventPayload('tool_call', {
      toolCallId: 'tc-1', toolName: 'Bash', args: { command: 'ls' },
    }).ok).toBe(true);
    expect(parseEpochEventPayload('tool_call', { toolCallId: 'tc-1' }).ok).toBe(false);
  });

  test('token_usage rejects NaN / null / negative (AGENT-04 fix)', () => {
    expect(parseEpochEventPayload('token_usage', {
      promptTokens: 100, completionTokens: 50, totalTokens: 150,
    }).ok).toBe(true);
    // Real-world bug: provider emits NaN
    expect(parseEpochEventPayload('token_usage', {
      promptTokens: NaN, completionTokens: 0,
    }).ok).toBe(false);
    // Real-world bug: provider emits null
    expect(parseEpochEventPayload('token_usage', {
      promptTokens: null, completionTokens: 0,
    }).ok).toBe(false);
    // Negative is rejected (clamps drift to ≥0)
    expect(parseEpochEventPayload('token_usage', {
      promptTokens: -1, completionTokens: 0,
    }).ok).toBe(false);
    // Non-integer is rejected
    expect(parseEpochEventPayload('token_usage', {
      promptTokens: 1.5, completionTokens: 0,
    }).ok).toBe(false);
  });

  test('permission_request requires requestId + prompt', () => {
    expect(parseEpochEventPayload('permission_request', {
      requestId: 'req-1', prompt: 'May I run this?',
    }).ok).toBe(true);
    expect(parseEpochEventPayload('permission_request', { requestId: 'req-1' }).ok).toBe(false);
  });

  test('permission_response requires requestId + decision in allow|deny', () => {
    expect(parseEpochEventPayload('permission_response', {
      requestId: 'req-1', decision: 'allow',
    }).ok).toBe(true);
    expect(parseEpochEventPayload('permission_response', {
      requestId: 'req-1', decision: 'maybe',
    }).ok).toBe(false);
  });

  test('note requires message string + tolerates extras', () => {
    expect(parseEpochEventPayload('note', { message: 'hello' }).ok).toBe(true);
    expect(parseEpochEventPayload('note', {
      message: 'oops', level: 'error', extra: 'context',
    }).ok).toBe(true);
    expect(parseEpochEventPayload('note', {}).ok).toBe(false);
  });
});

// ---- Store integration -----------------------------------------------------

describe('agent-epoch-store — open/close epoch', () => {
  test('first epoch gets index 0, second gets 1', () => {
    const db = freshDb();
    seedSession(db, 's-1');
    const store = createAgentEpochStore(db);
    const e0 = store.openEpoch('s-1');
    const e1 = store.openEpoch('s-1');
    expect(e0.epochIndex).toBe(0);
    expect(e1.epochIndex).toBe(1);
    db.close();
  });

  test('different sessions have independent epoch index sequences', () => {
    const db = freshDb();
    seedSession(db, 's-a');
    seedSession(db, 's-b');
    const store = createAgentEpochStore(db);
    expect(store.openEpoch('s-a').epochIndex).toBe(0);
    expect(store.openEpoch('s-b').epochIndex).toBe(0);
    expect(store.openEpoch('s-a').epochIndex).toBe(1);
    db.close();
  });

  test('closeEpoch sets endedAt + endReason and is idempotent', () => {
    const db = freshDb();
    seedSession(db, 's-1');
    const store = createAgentEpochStore(db);
    const e = store.openEpoch('s-1');
    expect(store.closeEpoch(e.id, 'completed')).toBe(true);
    // Second call is a no-op (already closed)
    expect(store.closeEpoch(e.id, 'completed')).toBe(false);
    db.close();
  });
});

describe('agent-epoch-store — recordEvent', () => {
  test('events accumulate in sequence per epoch', () => {
    const db = freshDb();
    seedSession(db, 's-1');
    const store = createAgentEpochStore(db);
    const e = store.openEpoch('s-1');
    const ev0 = store.recordEvent(e.id, 'state_transition', { from: 'active', to: 'paused' });
    const ev1 = store.recordEvent(e.id, 'tool_call', { toolCallId: 'tc-1', toolName: 'Bash' });
    const ev2 = store.recordEvent(e.id, 'note', { message: 'hello' });
    expect(ev0.sequence).toBe(0);
    expect(ev1.sequence).toBe(1);
    expect(ev2.sequence).toBe(2);
    db.close();
  });

  test('refuses to record a malformed payload', () => {
    const db = freshDb();
    seedSession(db, 's-1');
    const store = createAgentEpochStore(db);
    const e = store.openEpoch('s-1');
    expect(() =>
      store.recordEvent(e.id, 'state_transition', { from: 'active' }), // missing `to`
    ).toThrow(/state_transition/);
    db.close();
  });

  test('refuses NaN token_usage payload (AGENT-04 fix)', () => {
    const db = freshDb();
    seedSession(db, 's-1');
    const store = createAgentEpochStore(db);
    const e = store.openEpoch('s-1');
    expect(() =>
      store.recordEvent(e.id, 'token_usage', { promptTokens: NaN, completionTokens: 0 }),
    ).toThrow(/token_usage/);
    db.close();
  });
});

describe('agent-epoch-store — read timelines', () => {
  test('readEpochTimeline returns events in session order', () => {
    const db = freshDb();
    seedSession(db, 's-1');
    const store = createAgentEpochStore(db);

    const e0 = store.openEpoch('s-1', { now: '2026-05-13T00:00:00Z' });
    store.recordEvent(e0.id, 'note', { message: 'first' }, { now: '2026-05-13T00:00:01Z' });
    store.recordEvent(e0.id, 'note', { message: 'second' }, { now: '2026-05-13T00:00:02Z' });

    const e1 = store.openEpoch('s-1', { now: '2026-05-13T00:01:00Z' });
    store.recordEvent(e1.id, 'note', { message: 'third' }, { now: '2026-05-13T00:01:01Z' });

    const timeline = store.readEpochTimeline('s-1');
    expect(timeline.length).toBe(3);
    expect(timeline.map((e) => (e.payload as { message: string }).message))
      .toEqual(['first', 'second', 'third']);
    db.close();
  });

  test('readAgentTimeline aggregates across sessions of the same agent', () => {
    const db = freshDb();
    seedSession(db, 's-a', 'agent-X');
    seedSession(db, 's-b', 'agent-X');
    seedSession(db, 's-c', 'agent-Y');
    const store = createAgentEpochStore(db);

    const ea = store.openEpoch('s-a', { now: '2026-05-13T00:00:00Z' });
    store.recordEvent(ea.id, 'note', { message: 'A1' }, { now: '2026-05-13T00:00:01Z' });
    const eb = store.openEpoch('s-b', { now: '2026-05-13T00:00:02Z' });
    store.recordEvent(eb.id, 'note', { message: 'B1' }, { now: '2026-05-13T00:00:03Z' });
    const ec = store.openEpoch('s-c', { now: '2026-05-13T00:00:04Z' });
    store.recordEvent(ec.id, 'note', { message: 'C1' }, { now: '2026-05-13T00:00:05Z' });

    const x = store.readAgentTimeline('agent-X');
    expect(x.map((e) => (e.payload as { message: string }).message)).toEqual(['A1', 'B1']);
    const y = store.readAgentTimeline('agent-Y');
    expect(y.map((e) => (e.payload as { message: string }).message)).toEqual(['C1']);
    db.close();
  });

  test('readEpochTimeline descending + limit returns most-recent N', () => {
    const db = freshDb();
    seedSession(db, 's-1');
    const store = createAgentEpochStore(db);
    const e = store.openEpoch('s-1');
    for (let i = 0; i < 5; i++) {
      store.recordEvent(e.id, 'note', { message: `n-${i}` }, { now: `2026-05-13T00:00:0${i}Z` });
    }
    const desc = store.readEpochTimeline('s-1', { ascending: false, limit: 3 });
    expect(desc.length).toBe(3);
    // First in DESC = last inserted
    expect((desc[0].payload as { message: string }).message).toBe('n-4');
    db.close();
  });
});

describe('agent-epoch-store — bounded retention', () => {
  test('pruneOldestEvents enforces maxEventsPerAgent cap', () => {
    const db = freshDb();
    seedSession(db, 's-1', 'agent-prune');
    const store = createAgentEpochStore(db, { maxEventsPerAgent: 5 });
    const e = store.openEpoch('s-1');
    for (let i = 0; i < 10; i++) {
      store.recordEvent(e.id, 'note', { message: `m-${i}` }, {
        now: `2026-05-13T00:00:${i.toString().padStart(2, '0')}Z`,
      });
    }
    // 10 inserted; cap is 5 → 5 should be pruned (oldest first).
    const pruned = store.pruneOldestEvents('agent-prune');
    expect(pruned).toBe(5);

    const remaining = store.readAgentTimeline('agent-prune');
    expect(remaining.length).toBe(5);
    // Oldest pruned, newest 5 kept (m-5 through m-9)
    expect(remaining.map((e2) => (e2.payload as { message: string }).message))
      .toEqual(['m-5', 'm-6', 'm-7', 'm-8', 'm-9']);
    db.close();
  });

  test('pruneOldestEvents is a no-op when under cap', () => {
    const db = freshDb();
    seedSession(db, 's-1', 'agent-small');
    const store = createAgentEpochStore(db, { maxEventsPerAgent: 200 });
    const e = store.openEpoch('s-1');
    for (let i = 0; i < 3; i++) {
      store.recordEvent(e.id, 'note', { message: `m-${i}` });
    }
    expect(store.pruneOldestEvents('agent-small')).toBe(0);
    db.close();
  });
});
