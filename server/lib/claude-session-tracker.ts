/**
 * ClaudeSessionTracker — service layer that wires:
 *   1. Hook ingestion (route handler in routes/claude-hooks.ts feeds us)
 *   2. Persistence (ClaudeSessionRepo)
 *   3. WebSocket broadcast (`session:state`)
 *   4. JSONL recovery on boot
 *   5. Stale-phase reaper
 *
 * All pure derivation is delegated to claude-session-state.ts. This module
 * exists to compose those primitives with IO + side effects.
 */

import type { Database } from 'bun:sqlite';
import { promises as fsp } from 'fs';
import {
  applyHook,
  applyJsonlEvent,
  reapStaleSession,
  markPtyCrash,
  markDormant,
  makeInitialState,
  isActivePhase,
  parseJsonlLine,
  splitJsonlChunk,
  isKnownHookEvent,
  type HookPayload,
  type ClaudeSessionState,
  type ReaperConfig,
  DEFAULT_REAPER_CONFIG,
} from './claude-session-state';
import { createClaudeSessionRepo, type ClaudeSessionRepo } from './claude-session-repo';

export type Broadcaster = (msg: object) => void;

export interface ClaudeSessionTrackerOptions {
  db: Database;
  broadcast: Broadcaster;
  /**
   * Time provider for tests. Default `Date.now`.
   */
  now?: () => number;
  /**
   * Time window in ms for hook dedup. Two hooks with identical
   * (claude_session_id, hook_event_name) within this window collapse.
   * Default 100ms.
   */
  dedupWindowMs?: number;
  /**
   * Per-claude_session_id rate limit (events / second). Default 50.
   */
  rateLimitPerSec?: number;
  /**
   * Coalesce window: bursts of state changes within this many ms produce a
   * single WS broadcast carrying the latest state. Default 50ms.
   */
  coalesceWindowMs?: number;
  /**
   * Reaper thresholds. Defaults are the production values; tests pass
   * shorter ones.
   */
  reaperConfig?: ReaperConfig;
}

interface DedupEntry {
  lastEventAt: number;
}

interface RateBucket {
  windowStart: number;
  count: number;
}

interface CoalescedBroadcast {
  state: ClaudeSessionState;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ClaudeSessionTracker {
  /**
   * Apply a hook payload. Returns true if persisted + broadcast, false if
   * dropped (unknown session, rate-limit, dedup).
   */
  ingestHook(payload: HookPayload, now?: number): IngestResult;
  /**
   * Mark a session as PTY-crashed. Used by the terminal route when it sees a
   * non-zero exit without a SessionEnd hook.
   */
  notePtyCrash(claudeSessionId: string, exitCode: number, now?: number): boolean;
  /**
   * Mark a session as dormant (PTY exited cleanly, resumable).
   */
  noteDormant(claudeSessionId: string, now?: number): boolean;
  /**
   * Register a topic-less terminal claude session so its hooks resolve. These
   * have no `claude_code_sessions` row (the table's PK is a topic session_key
   * with an FK to topics), so their phase lives in-memory keyed by
   * claudeSessionId. Called by the terminal route at spawn time with the same
   * UUID it passes to `claude --session-id`. Idempotent; revives a dormant one.
   */
  registerTerminalSession(claudeSessionId: string, now?: number): void;
  /**
   * Forget an in-memory terminal session (its PTY is gone for good, e.g. the
   * session was deleted). No-op for DB-backed (topic) sessions.
   */
  dropTerminalSession(claudeSessionId: string): void;
  /**
   * Run one reaper pass. Returns the number of sessions whose phase changed.
   */
  reapOnce(now?: number): number;
  /**
   * Read-only access to current state.
   */
  listSessions(): ClaudeSessionState[];
  getSession(claudeSessionId: string): ClaudeSessionState | null;
  getSessionByKey(sessionKey: string): ClaudeSessionState | null;
  /**
   * Replay JSONL files from persisted offset for every active session.
   * Returns the number of sessions updated.
   */
  recoverFromJsonl(now?: number): Promise<number>;
  /**
   * Start the recurring reaper interval. Returns a stop fn.
   */
  startReaper(intervalMs?: number): () => void;
}

export type IngestResult =
  | { kind: 'ok'; state: ClaudeSessionState; changed: boolean }
  | { kind: 'unknown-session'; claudeSessionId: string }
  | { kind: 'rate-limited'; claudeSessionId: string }
  | { kind: 'duplicate'; claudeSessionId: string }
  | { kind: 'unknown-event'; event: string };

export function createClaudeSessionTracker(opts: ClaudeSessionTrackerOptions): ClaudeSessionTracker {
  const repo = createClaudeSessionRepo(opts.db);
  const broadcast = opts.broadcast;
  const now = opts.now ?? Date.now;
  const dedupWindowMs = opts.dedupWindowMs ?? 100;
  const rateLimitPerSec = opts.rateLimitPerSec ?? 50;
  const coalesceWindowMs = opts.coalesceWindowMs ?? 50;
  const reaperConfig = opts.reaperConfig ?? DEFAULT_REAPER_CONFIG;

  // Dedup map: claudeSessionId|event → DedupEntry
  const dedupMap = new Map<string, DedupEntry>();
  const rateBuckets = new Map<string, RateBucket>();
  const pendingBroadcasts = new Map<string, CoalescedBroadcast>();
  // In-memory phase for topic-less terminal claude sessions, keyed by
  // claudeSessionId. They can't live in claude_code_sessions (PK is a topic
  // session_key with an FK to topics), so this is their only home. Volatile by
  // design: terminal.ts re-registers on reconcile after a restart and the next
  // hook re-establishes phase.
  const terminalStates = new Map<string, ClaudeSessionState>();

  function dedupKey(claudeSessionId: string, event: string): string {
    return `${claudeSessionId}|${event}`;
  }

  function checkRateLimit(claudeSessionId: string, t: number): boolean {
    const bucket = rateBuckets.get(claudeSessionId);
    if (!bucket || t - bucket.windowStart >= 1000) {
      rateBuckets.set(claudeSessionId, { windowStart: t, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= rateLimitPerSec;
  }

  function checkDedup(claudeSessionId: string, event: string, t: number): boolean {
    const k = dedupKey(claudeSessionId, event);
    const entry = dedupMap.get(k);
    if (entry && t - entry.lastEventAt < dedupWindowMs) {
      entry.lastEventAt = t;
      return false;
    }
    dedupMap.set(k, { lastEventAt: t });
    return true;
  }

  function scheduleBroadcast(state: ClaudeSessionState): void {
    // Coalesce by sessionKey for topic sessions, else by claudeSessionId for
    // topic-less terminal sessions. Both surface to the client as
    // `session:state` (sessionKey may be null; the client falls back to
    // state.claudeSessionId as the key).
    const k = state.sessionKey ?? `csid:${state.claudeSessionId}`;
    const existing = pendingBroadcasts.get(k);
    if (existing) {
      // Update the pending state to the latest; the timer is already set.
      existing.state = state;
      return;
    }
    const entry: CoalescedBroadcast = { state, timer: null };
    pendingBroadcasts.set(k, entry);
    entry.timer = setTimeout(() => {
      const final = pendingBroadcasts.get(k);
      pendingBroadcasts.delete(k);
      if (!final) return;
      broadcast({ type: 'session:state', sessionKey: final.state.sessionKey, state: final.state });
    }, coalesceWindowMs);
  }

  function commit(prev: ClaudeSessionState, next: ClaudeSessionState): { changed: boolean; state: ClaudeSessionState } {
    if (next === prev) {
      // No-op transition. We may still want to persist last_hook_at; do that
      // without broadcasting to avoid wakeup spam.
      if (next.lastHookAt && next.lastHookAt !== prev.lastHookAt) {
        repo.update(next);
      }
      return { changed: false, state: next };
    }
    repo.update(next);
    scheduleBroadcast(next);
    return { changed: true, state: next };
  }

  /** Commit path for in-memory terminal sessions (no DB row). */
  function commitTerminal(prev: ClaudeSessionState, next: ClaudeSessionState): { changed: boolean; state: ClaudeSessionState } {
    terminalStates.set(next.claudeSessionId, next);
    if (next === prev) return { changed: false, state: next };
    scheduleBroadcast(next);
    return { changed: true, state: next };
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  function ingestHook(payload: HookPayload, overrideNow?: number): IngestResult {
    const t = overrideNow ?? now();
    const sid = payload.session_id;
    const event = payload.hook_event_name;

    if (!sid || typeof sid !== 'string') {
      return { kind: 'unknown-event', event: String(event) };
    }
    if (!isKnownHookEvent(event)) {
      return { kind: 'unknown-event', event: String(event) };
    }

    if (!checkRateLimit(sid, t)) {
      return { kind: 'rate-limited', claudeSessionId: sid };
    }

    if (!checkDedup(sid, event, t)) {
      return { kind: 'duplicate', claudeSessionId: sid };
    }

    // Topic sessions live in the DB; topic-less terminal sessions in-memory.
    const dbPrev = repo.loadByClaudeSessionId(sid);
    if (dbPrev) {
      const next = applyHook(dbPrev, payload, t);
      const res = commit(dbPrev, next);
      return { kind: 'ok', state: res.state, changed: res.changed };
    }
    const memPrev = terminalStates.get(sid);
    if (memPrev) {
      const next = applyHook(memPrev, payload, t);
      const res = commitTerminal(memPrev, next);
      return { kind: 'ok', state: res.state, changed: res.changed };
    }
    return { kind: 'unknown-session', claudeSessionId: sid };
  }

  function notePtyCrash(claudeSessionId: string, exitCode: number, overrideNow?: number): boolean {
    const t = overrideNow ?? now();
    const dbPrev = repo.loadByClaudeSessionId(claudeSessionId);
    if (dbPrev) return commit(dbPrev, markPtyCrash(dbPrev, exitCode, t)).changed;
    const memPrev = terminalStates.get(claudeSessionId);
    if (memPrev) return commitTerminal(memPrev, markPtyCrash(memPrev, exitCode, t)).changed;
    return false;
  }

  function noteDormant(claudeSessionId: string, overrideNow?: number): boolean {
    const t = overrideNow ?? now();
    const dbPrev = repo.loadByClaudeSessionId(claudeSessionId);
    if (dbPrev) return commit(dbPrev, markDormant(dbPrev, t)).changed;
    const memPrev = terminalStates.get(claudeSessionId);
    if (memPrev) return commitTerminal(memPrev, markDormant(memPrev, t)).changed;
    return false;
  }

  function registerTerminalSession(claudeSessionId: string, overrideNow?: number): void {
    // A topic session owns this id — leave it to the DB-backed path.
    if (repo.loadByClaudeSessionId(claudeSessionId)) return;
    const existing = terminalStates.get(claudeSessionId);
    // Already tracking a live incarnation — keep its phase.
    if (existing && isActivePhase(existing.phase)) return;
    const t = overrideNow ?? now();
    const state = makeInitialState(claudeSessionId, null, t);
    terminalStates.set(claudeSessionId, state);
    scheduleBroadcast(state);
  }

  function dropTerminalSession(claudeSessionId: string): void {
    terminalStates.delete(claudeSessionId);
  }

  function reapOnce(overrideNow?: number): number {
    const t = overrideNow ?? now();
    let changed = 0;
    repo.forEachLive((prev) => {
      const next = reapStaleSession(prev, t, reaperConfig);
      if (next !== prev) {
        repo.update(next);
        scheduleBroadcast(next);
        changed += 1;
      }
    });
    // Same stale-phase sweep for in-memory terminal sessions — EXCEPT the
    // starting→error rule. A terminal session sits at 'starting' while it idles
    // at an empty prompt (or after a reattach that won't re-fire SessionStart);
    // that's not a failed launch, so we must not mark it errored.
    for (const prev of terminalStates.values()) {
      if (prev.phase === 'starting') continue;
      const next = reapStaleSession(prev, t, reaperConfig);
      if (next !== prev) {
        commitTerminal(prev, next);
        changed += 1;
      }
    }
    return changed;
  }

  function listSessions(): ClaudeSessionState[] {
    return [...repo.listAll(), ...terminalStates.values()];
  }

  function getSession(claudeSessionId: string): ClaudeSessionState | null {
    return repo.loadByClaudeSessionId(claudeSessionId) ?? terminalStates.get(claudeSessionId) ?? null;
  }

  function getSessionByKey(sessionKey: string): ClaudeSessionState | null {
    return repo.loadBySessionKey(sessionKey);
  }

  async function recoverFromJsonl(overrideNow?: number): Promise<number> {
    const t = overrideNow ?? now();
    let updated = 0;
    const candidates = repo.listActive();
    for (const sess of candidates) {
      if (!sess.jsonlPath) continue;
      try {
        const stat = await fsp.stat(sess.jsonlPath);
        if (stat.size <= sess.jsonlOffset) continue;
        // Read only the new tail. For large files this is cheap; for the
        // initial backfill on a long-running session this can be MBs — still
        // fine on local SSD.
        const fh = await fsp.open(sess.jsonlPath, 'r');
        try {
          const len = stat.size - sess.jsonlOffset;
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, sess.jsonlOffset);
          const { lines, remainder } = splitJsonlChunk(buf.toString('utf-8'));
          let cur = sess;
          for (const line of lines) {
            const ev = parseJsonlLine(line);
            if (!ev) continue;
            cur = applyJsonlEvent(cur, ev, t);
          }
          // Persist offset = bytes consumed up to last newline.
          const consumedBytes = len - Buffer.byteLength(remainder, 'utf-8');
          const nextOffset = sess.jsonlOffset + consumedBytes;
          if (cur === sess && nextOffset === sess.jsonlOffset) continue;
          const final: ClaudeSessionState = { ...cur, jsonlOffset: nextOffset, updatedAt: t };
          repo.update(final);
          scheduleBroadcast(final);
          updated += 1;
        } finally {
          await fh.close();
        }
      } catch {
        // File missing / unreadable — leave as-is. The reaper or a later
        // SessionStart hook will move it forward.
      }
    }
    return updated;
  }

  function startReaper(intervalMs = 30_000): () => void {
    const handle = setInterval(() => {
      try { reapOnce(); } catch (err) { console.error('[claude-session-tracker] reaper error', err); }
    }, intervalMs);
    // Don't keep the event loop alive just for the reaper.
    if (typeof handle.unref === 'function') handle.unref();
    return () => clearInterval(handle);
  }

  return {
    ingestHook,
    notePtyCrash,
    noteDormant,
    registerTerminalSession,
    dropTerminalSession,
    reapOnce,
    listSessions,
    getSession,
    getSessionByKey,
    recoverFromJsonl,
    startReaper,
  };
}
