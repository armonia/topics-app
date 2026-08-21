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
import type { OutboundMessage } from "../../shared/ws-outbound";
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
import { createClaudeSessionRepo } from './claude-session-repo';
import { findForkContinuation } from './transcript-fork';
import { basename } from 'path';
import { parseTranscriptDelta } from './claude-transcript-import';
import type { StoredMessage } from '../types';

export type Broadcaster = (msg: OutboundMessage) => void;

/**
 * The message store the import sweep writes through. Injected so the tracker
 * stays free of DB-message plumbing and unit-testable with a fake. All four
 * ops are keyed by the topic's session_key.
 */
export interface ImportSink {
  /** id of the last row in the session's active thread, or null when empty —
   *  the parent the first newly-imported message chains from. */
  getLastMessageId(sessionKey: string): string | null;
  /** Append already-chained messages (id/parentId/toolCalls decided upstream). */
  appendMessages(sessionKey: string, msgs: StoredMessage[]): void;
  /** Patch a tool_result onto the tool call in the session's LAST message —
   *  the cross-chunk case where a tool_use was imported in an earlier sweep. */
  resolveToolResult(sessionKey: string, toolUseId: string, result: string, isError: boolean): void;
  /** Topic id for the WS `message:new` fan-out, or null if unmapped. */
  topicIdForSessionKey(sessionKey: string): string | null;
}

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
  /**
   * Message store for the ADOPTED-session import sweep. Omitted ⇒ the import
   * sweep is a no-op (the phase tracker still runs). Wired by the server from
   * the topic message store.
   */
  importSink?: ImportSink;
  /**
   * True while Topics owns a LIVE claude child for this session_key (the chat
   * provider's `isTurnProcessAlive`). The import sweep uses it as the
   * double-import guard: while Topics drives the session it also streams +
   * persists the turns, so the sweep must NOT re-import the same JSONL bytes —
   * it advances the cursor past them instead. Omitted ⇒ treated as "not driven"
   * (pure terminal), which is the common adopted case.
   */
  isSessionLocallyDriven?: (sessionKey: string) => boolean;
  /**
   * Quanto deve essere FERMO il transcript di una sessione adottata prima che
   * lo sweep si chieda "ha forkato?" (ms). Una sessione viva scrive di
   * continuo; solo un file che ha smesso di crescere merita la scansione.
   * Default 8s.
   */
  forkStaleMs?: number;
  /**
   * Intervallo minimo tra due scansioni di fork per la STESSA sessione (ms).
   * La scansione legge i transcript vicini: va fatta di rado. Default 10s.
   */
  forkScanCooldownMs?: number;
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
   * L'attesa aperta da un `Monitor` è finita: la sua risposta è arrivata.
   * Spegne `monitorArmed` per quella chat, così lo `Stop` del turno risvegliato
   * la riporta a riposo invece di lasciarla in `watching` per sempre.
   * Torna `false` se non c'era nessuna attesa armata (idempotente).
   */
  noteWatchDelivered(sessionKey: string, now?: number): boolean;
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
   *
   * La fase iniziale segue lo stesso indizio: transcript già scritto ⇒
   * riattaccata ⇒ `dormant` (a riposo, risvegliabile); file assente o vuoto ⇒
   * nascita vera ⇒ `starting`. Vedi il commento esteso nell'implementazione:
   * `starting` è la fase che sul client apre il fallback pty, e regalarla a
   * una tab vecchia fa partire banner di lavoro chiuso da giorni.
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
   * One MESSAGE-import sweep over every adopted session (import_offset set): read
   * the transcript tail, append the new turns to the topic's chat (with tool
   * calls + thinking), patch cross-chunk tool_results, advance import_offset.
   * While Topics drives the session, the cursor is advanced WITHOUT importing
   * (the stream already persisted those turns). Returns sessions that changed.
   */
  importOnce(now?: number): Promise<number>;
  /**
   * Start the recurring import sweep. Returns a stop fn. No-op without an
   * `importSink`. This is what unfreezes an adopted chat: turns typed in the
   * TERMINAL land in Topics within one interval.
   */
  startImportSweep(intervalMs?: number): () => void;
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
  const importSink = opts.importSink;
  const isSessionLocallyDriven = opts.isSessionLocallyDriven ?? (() => false);
  const forkStaleMs = opts.forkStaleMs ?? 8_000;
  const forkScanCooldownMs = opts.forkScanCooldownMs ?? 10_000;

  /**
   * LE ATTESE ARMATE, che il DB non sa tenere.
   *
   * `monitorArmed` è deliberatamente SENZA COLONNA (vedi il campo in
   * `shared/types.ts`): conta solo per una sessione viva, e dopo un riavvio del
   * server la fase `watching` si ricarica da sola dalla colonna `phase`.
   *
   * Ma «senza colonna» qui significava «perso al primo giro»: ogni transizione
   * passa da `repo.update()` e poi rilegge la riga, e `rowToState` quel campo
   * non lo conosce. Il flag moriva quindi FRA UN HOOK E IL SUCCESSIVO, non al
   * riavvio — cioè non arrivava mai allo `Stop` che doveva guardarlo, che è
   * l'unica cosa per cui esiste. Verificato: `PreToolUse(Monitor)` + `Stop` su
   * una sessione DB-backed dava `awaiting-user`, come se nessuno stesse
   * sorvegliando niente.
   *
   * Questo Set è la memoria che mancava: sta accanto al DB, non dentro, e vive
   * quanto il processo — esattamente la durata dichiarata per quel campo.
   */
  const attesArmate = new Set<string>();

  /** Rimette il flag sullo stato appena riletto dal DB, che lo ha perso. */
  function conAttesa(s: ClaudeSessionState): ClaudeSessionState {
    if (!s.sessionKey) return s;
    return attesArmate.has(s.sessionKey) ? { ...s, monitorArmed: true } : s;
  }

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
  // Stato del "seguire il fork", per sessionKey adottata: quando abbiamo
  // guardato l'ultima volta e quali file vicini abbiamo già scartato (con il
  // loro mtime, così un file che cambia torna candidabile). Volatile: al
  // riavvio si riparte a guardare, che è il comportamento giusto.
  const forkWatch = new Map<string, { lastScanAt: number; rejected: Map<string, number> }>();

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
      // Il flag dell'attesa si rimette PRIMA di applicare l'hook (il DB l'ha
      // perso) e si rilegge DOPO (l'hook può averlo acceso o spento). Vedi
      // `attesArmate`.
      const next = snapOffsetIfPathChanged(dbPrev, applyHook(conAttesa(dbPrev), payload, t));
      if (next.sessionKey) {
        if (next.monitorArmed) attesArmate.add(next.sessionKey);
        else attesArmate.delete(next.sessionKey);
      }
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

  /**
   * L'ATTESA È FINITA: il Monitor ha consegnato.
   *
   * Si chiama per `sessionKey` e non per `claudeSessionId` perché chi lo sa è il
   * server, che adotta il turno risvegliato conoscendo la chiave della chat
   * (vedi `adottaTurniRisvegliati` in server.ts). È l'equivalente vivo del vecchio
   * hook `MonitorClosed`, che questa CLI non manda più.
   *
   * Fa una cosa sola: spegne `monitorArmed`. La FASE non la tocca, ed è
   * deliberato — quando questo scatta il turno risvegliato sta già partendo, e i
   * suoi hook (`PreToolUse`, `Stop`) la muovono da soli. Toccarla qui sarebbe
   * una seconda mano sullo stesso volante. Ciò che conta è che lo `Stop` di
   * QUEL turno non trovi il flag ancora acceso, o la sessione resterebbe in
   * `watching` con nessuno che guarda più niente.
   */
  function noteWatchDelivered(sessionKey: string, overrideNow?: number): boolean {
    const t = overrideNow ?? now();
    if (!attesArmate.delete(sessionKey)) return false; // nessuna attesa: no-op
    const prev = repo.loadBySessionKey(sessionKey);
    if (!prev) return false;
    return commit(prev, { ...prev, monitorArmed: false, updatedAt: t, rev: prev.rev + 1 }).changed;
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
      const size = fileSizeOrZero(jsonlPath);
      state.jsonlOffset = size;
      // Un transcript che ha GIÀ del contenuto vuol dire che questa non è una
      // nascita: è una riattaccata (il riavvio del server ha svuotato
      // `terminalStates`, che è solo in memoria) o un `--resume`. Dire
      // `starting` lì è una bugia con un costo preciso, e non è cosmetico:
      // `starting` è l'UNICA fase che il client non classifica né attiva né a
      // riposo (ACTIVE_CLAUDE_PHASES / RESTING_CLAUDE_PHASES in
      // client/src/state/signals.ts), ed è esattamente la condizione che apre
      // la guardia del fallback pty in `useCompletionNotifier` — il ramo
      // grezzo pensato per le sessioni SENZA hook. Risultato misurato il
      // 2026-08-09: dopo 161 riattacchi, una tab claude-code finita giorni
      // prima stava a `starting` con `rev 0`, e da lì bastava un frame di
      // repaint (il `lastVisibleSig` si azzera con lo stesso riavvio, quindi
      // il primo frame non può mai essere classificato cosmetico) per far
      // partire il banner «Lavoro completato» di un lavoro chiuso da giorni.
      // Nessuno la tirava fuori da lì: il reaper salta `starting` per i
      // terminali e l'offset è già a EOF.
      //
      // `dormant` è la fase onesta per «il PTY c'è ma non abbiamo alcun
      // segnale, e l'ultima scrittura è vecchia»: è a riposo (niente banner,
      // niente spinner bugiardo) e resta risvegliabile — il primo frame pty
      // vero la riporta a `running` via reviveOnPtyActivity, un hook o una
      // riga di transcript la muovono comunque. Una sessione appena nata (file
      // ancora inesistente o vuoto) resta `starting`: è la popolazione che il
      // fallback pty serve davvero.
      if (size > 0) state.phase = 'dormant';
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
    const s = repo.loadByClaudeSessionId(claudeSessionId);
    // `conAttesa` anche qui: chi legge lo stato deve vedere l'attesa armata,
    // non solo chi applica un hook. Le sessioni in memoria il flag ce l'hanno
    // già dentro — non passano dal DB, quindi non lo perdono.
    if (s) return conAttesa(s);
    return terminalStates.get(claudeSessionId) ?? null;
  }

  function getSessionByKey(sessionKey: string): ClaudeSessionState | null {
    const s = repo.loadBySessionKey(sessionKey);
    return s ? conAttesa(s) : null;
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

  /**
   * Il transcript seguito non cresce più: la sessione ha forkato? Un `--resume`
   * può ripartire da un file NUOVO (`<nuovo-id>.jsonl`) in cui la CLI ricopia la
   * storia del padre. Chi taillava il padre resterebbe fermo per sempre e la
   * chat si ricongelerebbe. Il figlio però copia gli uuid del padre: cerchiamo
   * nella cartella di progetto un transcript più recente che contenga le righe
   * che abbiamo già consumato e ci riagganciamo al punto in cui la copia
   * finisce (così non reimportiamo nulla).
   *
   * Percorso di RECUPERO, non principale: gira solo su una sessione adottata,
   * solo quando il file è fermo da `forkStaleMs`, al più una volta ogni
   * `forkScanCooldownMs`, e non riesamina candidati già scartati e immutati.
   * Ritorna lo stato riletto dopo il relink, o null se non c'è nulla da seguire.
   */
  async function maybeFollowFork(sess: ClaudeSessionState, t: number): Promise<ClaudeSessionState | null> {
    const sessionKey = sess.sessionKey;
    if (!sessionKey || !sess.jsonlPath || sess.importOffset == null) return null;
    // Mentre Topics guida la sessione è il provider a decidere resume e path:
    // un relink euristico gli si metterebbe di traverso.
    if (isSessionLocallyDriven(sessionKey)) return null;

    let watch = forkWatch.get(sessionKey);
    if (!watch) { watch = { lastScanAt: 0, rejected: new Map() }; forkWatch.set(sessionKey, watch); }
    if (t - watch.lastScanAt < forkScanCooldownMs) return null;
    const mtime = fileMtimeMs(sess.jsonlPath);
    // Ancora caldo: una pausa dentro un turno non è un fork.
    if (mtime !== undefined && t - mtime < forkStaleMs) return null;
    watch.lastScanAt = t;

    const currentPath = sess.jsonlPath;
    const { found, rejected } = await findForkContinuation({
      currentPath,
      consumedBytes: sess.importOffset,
      isPathTaken: (p) => repo.isTranscriptPathTaken(p, sessionKey),
      skip: (p, m) => watch!.rejected.get(p) === m,
    });
    for (const r of rejected) watch.rejected.set(r.path, r.mtimeMs);
    if (!found) return null;
    // Il nome del file diventa il claude_session_id con cui faremo `--resume`:
    // stesso guardrail di charset dell'adozione, niente path traversal.
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(found.sessionId)) return null;

    const moved = repo.relinkTranscript({
      sessionKey,
      fromPath: currentPath,
      toPath: found.path,
      claudeSessionId: found.sessionId,
      offset: found.offset,
      updatedAt: t,
    });
    // CAS perso: un hook ha già stabilito il path del figlio. Va bene così —
    // la prova diretta batte l'euristica, e il prossimo sweep legge la sua.
    if (!moved) return null;
    watch.rejected.clear();
    console.log(
      `[claude-session-tracker] fork seguito per ${sessionKey}: ${basename(currentPath)} → ` +
      `${basename(found.path)} (${found.matched} righe già note, riprendo da ${found.offset})`
    );
    return repo.loadBySessionKey(sessionKey);
  }

  /**
   * Import the unconsumed tail of ONE adopted session's transcript into its
   * chat. Returns the number of messages imported (0 when nothing new, or when
   * the cursor was merely advanced past Topics-authored bytes). Mirrors
   * `readSessionTail`'s byte accounting so import_offset always lands on a
   * complete-line boundary. `followFork` è false nella chiamata ricorsiva dopo
   * un relink: si segue un fork alla volta, mai a catena dentro uno sweep.
   */
  async function importSessionTail(sess: ClaudeSessionState, t: number, followFork = true): Promise<number> {
    if (!importSink || !sess.sessionKey || !sess.jsonlPath || sess.importOffset == null) return 0;
    const sessionKey = sess.sessionKey;
    const fromOffset = sess.importOffset;
    let consumedText: string;
    let nextOffset: number;
    try {
      const stat = await fsp.stat(sess.jsonlPath);
      if (stat.size <= fromOffset) {
        // Fermo. O la sessione è solo silenziosa, o è ripartita altrove.
        if (!followFork) return 0;
        const relinked = await maybeFollowFork(sess, t);
        return relinked ? importSessionTail(relinked, t, false) : 0;
      }
      const fh = await fsp.open(sess.jsonlPath, 'r');
      try {
        const len = stat.size - fromOffset;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, fromOffset);
        const { lines, remainder } = splitJsonlChunk(buf.toString('utf-8'));
        // Advance past complete lines only; the partial tail waits for the next
        // sweep (same rule the phase tail uses).
        const consumedBytes = len - Buffer.byteLength(remainder, 'utf-8');
        nextOffset = fromOffset + consumedBytes;
        if (nextOffset === fromOffset) return 0; // no complete new line yet
        consumedText = lines.join('\n');
      } finally {
        await fh.close();
      }
    } catch {
      // File sparito o illeggibile. Non si segue nessun fork da qui: senza gli
      // uuid già consumati non c'è prova di parentela, e agganciarsi al file
      // più recente della cartella vorrebbe dire rubare la sessione di un
      // altro topic. Si lascia il cursore; uno sweep successivo riprova.
      return 0;
    }

    // Double-import guard: while Topics owns a live child for this session, the
    // chat provider already streamed + persisted these turns into the SAME
    // JSONL. Skip the import but advance the cursor so that, once the child
    // dies, only genuinely-external (terminal) turns remain to import.
    if (isSessionLocallyDriven(sessionKey)) {
      repo.setImportOffset(sessionKey, nextOffset);
      return 0;
    }

    const parentId = importSink.getLastMessageId(sessionKey);
    const { messages, resolutions } = parseTranscriptDelta(consumedText, { parentId });

    // Cross-chunk tool_results FIRST: they patch the session's current last
    // message (a tool_use imported in an earlier sweep), which must still be the
    // last row when we patch — before we append this chunk's new turns.
    for (const r of resolutions) {
      try { importSink.resolveToolResult(sessionKey, r.toolUseId, r.result, r.isError); }
      catch (err) { console.error('[claude-session-tracker] resolveToolResult failed', err); }
    }
    if (messages.length) importSink.appendMessages(sessionKey, messages);
    repo.setImportOffset(sessionKey, nextOffset);

    // Push the new turns to any open chat + sidebar preview, reusing the same
    // `message:new` the streaming paths emit (the client appends by messageId).
    // Text-only, like every other emitter; a reload hydrates tool cards from the
    // rows we just wrote.
    if (messages.length) {
      const topicId = importSink.topicIdForSessionKey(sessionKey);
      for (const m of messages) {
        const content = m.content ?? '';
        if (!content) continue; // pure tool-call rows carry no preview text
        broadcast({
          type: 'message:new',
          topicId: topicId ?? undefined,
          sessionKey,
          role: m.role,
          messageId: m.id,
          content,
          preview: content.slice(0, 100),
        } as OutboundMessage);
      }
    }
    return messages.length;
  }

  async function importOnce(overrideNow?: number): Promise<number> {
    if (!importSink) return 0;
    const t = overrideNow ?? now();
    let changed = 0;
    const live = new Set<string>();
    for (const sess of repo.listImportable()) {
      if (sess.sessionKey) live.add(sess.sessionKey);
      try {
        if ((await importSessionTail(sess, t)) > 0) changed += 1;
      } catch (err) {
        console.error('[claude-session-tracker] import sweep error', err);
      }
    }
    // Una sessione uscita dallo sweep (topic cancellato) non deve lasciarsi
    // dietro la sua cache di fork.
    if (forkWatch.size > live.size) {
      for (const key of [...forkWatch.keys()]) if (!live.has(key)) forkWatch.delete(key);
    }
    return changed;
  }

  function startImportSweep(intervalMs = 1_500): () => void {
    if (!importSink) return () => {};
    let sweeping = false; // re-entrancy guard: a slow sweep must not stack
    const handle = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      importOnce()
        .catch((err) => console.error('[claude-session-tracker] import sweep error', err))
        .finally(() => { sweeping = false; });
    }, intervalMs);
    // Don't keep the event loop alive just for the import sweep.
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
    noteWatchDelivered,
    registerTerminalSession,
    dropTerminalSession,
    reapOnce,
    listSessions,
    getSession,
    getSessionByKey,
    recoverFromJsonl,
    tailOnce,
    startJsonlTail,
    importOnce,
    startImportSweep,
    startReaper,
  };
}
