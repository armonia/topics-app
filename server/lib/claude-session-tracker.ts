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
import { promises as fsp, statSync } from 'fs';
import { homedir } from 'os';
import {
  applyHook,
  applyJsonlEvent,
  reapStaleSession,
  markPtyCrash,
  markDormant,
  reviveOnPtyActivity,
  makeInitialState,
  isActivePhase,
  isTerminalPhase,
  parseJsonlLine,
  splitJsonlChunk,
  isKnownHookEvent,
  deriveTranscriptPath,
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
  /**
   * How long (ms) a terminal session's PTY has been idle, by claudeSessionId,
   * or null when unknown. The reaper consults this to tell a genuinely-stuck
   * `running` session (PTY silent for a long time → demote to dormant) from a
   * long-but-live turn (PTY still busy → leave it). Injected by the server from
   * the terminal route's activity tracker; omitted in tests → reaper sees null.
   */
  ptyIdleMs?: (claudeSessionId: string) => number | null;
  /**
   * Home directory used to derive canonical transcript paths for terminal
   * sessions (`<home>/.claude/projects/<enc-cwd>/<csid>.jsonl`). Defaults to
   * os.homedir(); tests point it at a temp dir.
   */
  homeDir?: string;
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
   * Note live PTY output for a session. Revives a `dormant` session (one the
   * reaper demoted while it was merely silent) back to `running` so the loading
   * dots return; no-op for any other phase. Called by the terminal route on
   * each non-cosmetic frame.
   */
  notePtyActivity(claudeSessionId: string, now?: number): boolean;
  /**
   * Register a topic-less terminal claude session so its hooks resolve. These
   * have no `claude_code_sessions` row (the table's PK is a topic session_key
   * with an FK to topics), so their phase lives in-memory keyed by
   * claudeSessionId. Called by the terminal route at spawn time with the same
   * UUID it passes to `claude --session-id`. Idempotent; revives a dormant one.
   *
   * When `opts.cwd` is given, the canonical transcript path is derived up
   * front (no SessionStart hook needed) so the live JSONL tail covers the
   * session; if the file already exists (a `--resume`, a server-restart
   * re-registration) the offset snaps to its current size — only lines written
   * AFTER tracking starts are ever consumed (no history replay).
   */
  registerTerminalSession(claudeSessionId: string, opts?: { cwd?: string; now?: number }): void;
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
   * One live-tail sweep: for every live session (DB-backed AND in-memory
   * terminal) whose transcript grew past the tracked offset, apply the new
   * events (causally gated) and advance the offset. Broadcasts only on real
   * phase-machine changes (rev bump). Returns the number of sessions advanced.
   */
  tailOnce(now?: number): Promise<number>;
  /**
   * Start the recurring live JSONL tail. Returns a stop fn. This is what keeps
   * the phase honest for turns no hook announces — a Monitor task-notification,
   * a background task completing, a teammate message (see CCS-07).
   */
  startJsonlTail(intervalMs?: number): () => void;
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
  const ptyIdleMs = opts.ptyIdleMs;
  const homeDir = opts.homeDir ?? homedir();

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

  /** Current byte size of a file, or 0 when missing/unreadable. Sync — used
   *  only on the rare registration / jsonlPath-change paths, never per-frame. */
  function fileSizeOrZero(path: string): number {
    try { return statSync(path).size; } catch { return 0; }
  }

  /** Last-write time of a file in epoch ms, or undefined when missing/unreadable.
   *  Sync — same rare-path budget as fileSizeOrZero. */
  function fileMtimeMs(path: string): number | undefined {
    try { return statSync(path).mtimeMs; } catch { return undefined; }
  }

  /**
   * When a hook ESTABLISHES a new transcript path (SessionStart with a path we
   * didn't have), snap the offset to the file's current size: the live tail
   * must only ever consume lines written after tracking started — replaying a
   * resumed session's multi-MB history live would be wasted IO and, worse,
   * time-travel the phase through stale lines. A SessionStart re-fire with the
   * SAME path leaves the persisted offset alone (boot-recovery contract).
   */
  function snapOffsetIfPathChanged(prev: ClaudeSessionState, next: ClaudeSessionState): ClaudeSessionState {
    if (next === prev) return next;
    if (!next.jsonlPath || next.jsonlPath === prev.jsonlPath) return next;
    return { ...next, jsonlOffset: fileSizeOrZero(next.jsonlPath) };
  }

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
      const next = snapOffsetIfPathChanged(dbPrev, applyHook(dbPrev, payload, t));
      const res = commit(dbPrev, next);
      return { kind: 'ok', state: res.state, changed: res.changed };
    }
    const memPrev = terminalStates.get(sid);
    if (memPrev) {
      const next = snapOffsetIfPathChanged(memPrev, applyHook(memPrev, payload, t));
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

  function notePtyActivity(claudeSessionId: string, overrideNow?: number): boolean {
    const t = overrideNow ?? now();
    const dbPrev = repo.loadByClaudeSessionId(claudeSessionId);
    if (dbPrev) return commit(dbPrev, reviveOnPtyActivity(dbPrev, t)).changed;
    const memPrev = terminalStates.get(claudeSessionId);
    if (memPrev) return commitTerminal(memPrev, reviveOnPtyActivity(memPrev, t)).changed;
    return false;
  }

  function registerTerminalSession(claudeSessionId: string, regOpts?: { cwd?: string; now?: number }): void {
    // A topic session owns this id — leave it to the DB-backed path.
    if (repo.loadByClaudeSessionId(claudeSessionId)) return;
    // Canonical transcript path, derived from cwd — no SessionStart hook
    // needed for the live tail to cover this session. Offset starts at the
    // file's CURRENT size (0 if it doesn't exist yet): a fresh spawn's file is
    // created empty by Claude moments later, while a --resume / re-register
    // points at real history that must not be replayed live.
    const jsonlPath = regOpts?.cwd ? deriveTranscriptPath(homeDir, regOpts.cwd, claudeSessionId) : undefined;
    const existing = terminalStates.get(claudeSessionId);
    // Already tracking a live incarnation — keep its phase; just backfill the
    // transcript pointer if it was missing (silent: nothing user-visible moved).
    if (existing && isActivePhase(existing.phase)) {
      if (jsonlPath && !existing.jsonlPath) {
        terminalStates.set(claudeSessionId, { ...existing, jsonlPath, jsonlOffset: fileSizeOrZero(jsonlPath) });
      }
      return;
    }
    const t = regOpts?.now ?? now();
    const state = makeInitialState(claudeSessionId, null, t, jsonlPath);
    if (jsonlPath) {
      state.jsonlOffset = fileSizeOrZero(jsonlPath);
      // This branch fires both for a brand-new session AND for reattaching to
      // one that already existed before a server restart wiped terminalStates
      // (it's in-memory only — see the module doc). For the reattach case `t`
      // (now) is a LIE: the transcript may not have been touched in hours, but
      // stamping phaseUpdatedAt/updatedAt = now makes deriveSessionLastActivity
      // (client/src/state/signals.ts) report the session as freshly active,
      // jumping a stale terminal to the top of the sidebar right after every
      // kickstart. Seed from the transcript's own mtime instead — the last
      // real write IS the true last-activity signal. For a genuinely new
      // session the file was just created, so mtime ≈ now anyway: no change
      // in that case.
      const mtime = fileMtimeMs(jsonlPath);
      if (mtime !== undefined) {
        state.phaseUpdatedAt = mtime;
        state.updatedAt = mtime;
      }
    }
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
      // DB-backed (topic) sessions need the PTY-idle signal too: without it the
      // `running` rules never fire for them, so a topic session whose Stop hook
      // was missed — or whose headless task process died — stayed `running`
      // forever, pinning the active-session count.
      const idle = ptyIdleMs?.(prev.claudeSessionId) ?? null;
      const next = reapStaleSession(prev, t, reaperConfig, idle);
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
      const idle = ptyIdleMs?.(prev.claudeSessionId) ?? null;
      const next = reapStaleSession(prev, t, reaperConfig, idle);
      if (next !== prev) {
        commitTerminal(prev, next);
        changed += 1;
      }
    }
    // Reap stale dedup/rate-limit bookkeeping. These maps are keyed by
    // claudeSessionId (unbounded over the process lifetime) and are only ever
    // written, never deleted, so without this sweep they grow for every session
    // ever seen. An entry is useless once its window has elapsed: a dedup entry
    // older than dedupWindowMs can no longer suppress a duplicate, and a rate
    // bucket older than its 1s window is recreated on the next event. A live
    // session simply re-adds its entry on the next hook, so dropping stale ones
    // is safe. (Deleting during Map for-of iteration is well-defined in JS.)
    for (const [k, e] of dedupMap) {
      if (t - e.lastEventAt >= dedupWindowMs) dedupMap.delete(k);
    }
    for (const [k, b] of rateBuckets) {
      if (t - b.windowStart >= 1000) rateBuckets.delete(k);
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

  /**
   * Read + apply the unconsumed tail of one session's transcript. Returns the
   * advanced state (offset always moved past complete lines; phase moved per
   * `applyJsonlEvent`'s causally-gated rules) or null when there is nothing
   * new / the file is unreadable. Pure read — the CALLER owns commit +
   * broadcast, because persistence differs by store (DB row vs in-memory) and
   * because it must re-check for a concurrent hook before writing.
   */
  async function readSessionTail(sess: ClaudeSessionState, t: number): Promise<ClaudeSessionState | null> {
    if (!sess.jsonlPath) return null;
    try {
      const stat = await fsp.stat(sess.jsonlPath);
      if (stat.size <= sess.jsonlOffset) return null;
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
        if (cur === sess && nextOffset === sess.jsonlOffset) return null;
        return { ...cur, jsonlOffset: nextOffset, updatedAt: t };
      } finally {
        await fh.close();
      }
    } catch {
      // File missing / unreadable — leave as-is. The reaper or a later
      // SessionStart hook will move it forward.
      return null;
    }
  }

  async function recoverFromJsonl(overrideNow?: number): Promise<number> {
    const t = overrideNow ?? now();
    let updated = 0;
    for (const sess of repo.listActive()) {
      const next = await readSessionTail(sess, t);
      if (!next) continue;
      repo.update(next);
      scheduleBroadcast(next);
      updated += 1;
    }
    return updated;
  }

  async function tailOnce(overrideNow?: number): Promise<number> {
    const t = overrideNow ?? now();
    let updated = 0;
    // DB-backed topic sessions — every NON-TERMINAL phase, dormant included:
    // the reaper demotes a merely-silent running session to dormant, and that
    // exact session is the one a Monitor/background event can wake. The read
    // is async, so a hook can land mid-read and advance the row; committing
    // our stale-based derivation would clobber it. The rev re-check makes the
    // sweep optimistic: on conflict we simply skip — the offset didn't move,
    // so the NEXT sweep re-reads the same lines, now causally gated against
    // the hook's fresher phaseUpdatedAt.
    for (const sess of repo.listLive()) {
      const next = await readSessionTail(sess, t);
      if (!next) continue;
      const fresh = repo.loadByClaudeSessionId(sess.claudeSessionId);
      if (!fresh || fresh.rev !== sess.rev) continue;
      repo.update(next);
      // Broadcast only a real phase-machine change (rev bump): the offset
      // advances on EVERY consumed line — assistant chunks land many times a
      // second mid-turn — and each would otherwise wake every client.
      if (next.rev !== sess.rev) scheduleBroadcast(next);
      updated += 1;
    }
    // In-memory terminal sessions — the store the boot-only recovery never
    // covered, and where the Monitor/background wake-ups actually live.
    for (const sess of [...terminalStates.values()]) {
      if (isTerminalPhase(sess.phase)) continue;
      const next = await readSessionTail(sess, t);
      if (!next) continue;
      if (terminalStates.get(sess.claudeSessionId) !== sess) continue; // hook won mid-read
      terminalStates.set(sess.claudeSessionId, next);
      if (next.rev !== sess.rev) scheduleBroadcast(next);
      updated += 1;
    }
    return updated;
  }

  function startJsonlTail(intervalMs = 1_500): () => void {
    let sweeping = false; // re-entrancy guard: a slow sweep must not stack
    const handle = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      tailOnce()
        .catch((err) => console.error('[claude-session-tracker] jsonl tail error', err))
        .finally(() => { sweeping = false; });
    }, intervalMs);
    // Don't keep the event loop alive just for the tail.
    if (typeof handle.unref === 'function') handle.unref();
    return () => clearInterval(handle);
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
    notePtyActivity,
    registerTerminalSession,
    dropTerminalSession,
    reapOnce,
    listSessions,
    getSession,
    getSessionByKey,
    recoverFromJsonl,
    tailOnce,
    startJsonlTail,
    startReaper,
  };
}
