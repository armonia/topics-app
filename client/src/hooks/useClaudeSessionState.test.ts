/**
 * Merging session-state frames under the revision guard, and re-verifying a
 * phase that looks phantom instead of trusting it.
 *
 * @covers CCS-01
 */
import { describe, it, expect } from 'bun:test';
import {
  mergeSessionState,
  isPhaseReverifyCandidate,
  REVERIFY_BUSY_STALE_MS,
  REVERIFY_SETTLED_STALE_MS,
} from './useClaudeSessionState';
import type { ClaudeSessionState, ClaudeSessionPhase } from '../types';

// Fixture builder — only the fields the rev/phase guard reads matter.
function st(rev: number, phase: ClaudeSessionPhase, key = 'k1'): ClaudeSessionState {
  return {
    sessionKey: key,
    claudeSessionId: `cs-${key}`,
    phase,
    phaseUpdatedAt: rev,
    // `jsonlOffset` e `createdAt` non li legge la guardia rev/fase, ma non sono
    // opzionali: il tracker li scrive sempre. Una fixture che li ometteva
    // descriveva una sessione che il server non emette.
    jsonlOffset: 0,
    rev,
    createdAt: rev,
    updatedAt: rev,
  };
}

describe('mergeSessionState — rev/phase monotonicity guard (coalescing correctness)', () => {
  it('inserts a brand-new key', () => {
    const prev = new Map<string, ClaudeSessionState>();
    const next = mergeSessionState(prev, 'k1', st(1, 'running'));
    expect(next).not.toBe(prev);
    expect(next.get('k1')?.rev).toBe(1);
  });

  it('applies a newer rev with the same phase', () => {
    const prev = new Map([['k1', st(1, 'running')]]);
    const next = mergeSessionState(prev, 'k1', st(2, 'running'));
    expect(next).not.toBe(prev);
    expect(next.get('k1')?.rev).toBe(2);
  });

  it('rejects a lower rev with the same phase (no-op, same ref)', () => {
    const prev = new Map([['k1', st(5, 'running')]]);
    const next = mergeSessionState(prev, 'k1', st(3, 'running'));
    expect(next).toBe(prev); // identity preserved → no re-render
  });

  it('rejects an equal rev with the same phase (no-op, same ref)', () => {
    const prev = new Map([['k1', st(5, 'running')]]);
    const next = mergeSessionState(prev, 'k1', st(5, 'running'));
    expect(next).toBe(prev);
  });

  it('ACCEPTS an equal/lower rev when the phase CHANGED (phase transition wins)', () => {
    const prev = new Map([['k1', st(5, 'running')]]);
    const next = mergeSessionState(prev, 'k1', st(5, 'awaiting-user'));
    expect(next).not.toBe(prev);
    expect(next.get('k1')?.phase).toBe('awaiting-user');
  });

  it('folds a burst in order → last newer state wins, keys independent', () => {
    // Simulates flushSessions applying a per-key-buffered batch sequentially.
    let m = new Map<string, ClaudeSessionState>();
    m = mergeSessionState(m, 'k1', st(1, 'starting', 'k1'));
    m = mergeSessionState(m, 'k2', st(1, 'running', 'k2'));
    m = mergeSessionState(m, 'k1', st(2, 'running', 'k1'));
    m = mergeSessionState(m, 'k1', st(3, 'tool-running', 'k1'));
    expect(m.get('k1')?.rev).toBe(3);
    expect(m.get('k1')?.phase).toBe('tool-running');
    expect(m.get('k2')?.rev).toBe(1);
  });
});

describe('isPhaseReverifyCandidate — heal phantom phases via a lazy re-fetch', () => {
  const NOW = 1_000_000_000;

  it('busy spinner (running) is suspect after the short busy window', () => {
    expect(isPhaseReverifyCandidate('running', NOW - REVERIFY_BUSY_STALE_MS, NOW)).toBe(true);
    expect(isPhaseReverifyCandidate('tool-running', NOW - REVERIFY_BUSY_STALE_MS, NOW)).toBe(true);
    expect(isPhaseReverifyCandidate('starting', NOW - REVERIFY_BUSY_STALE_MS, NOW)).toBe(true);
  });

  it('a still-fresh busy spinner is NOT re-verified (a long tool call is alive)', () => {
    expect(isPhaseReverifyCandidate('running', NOW - (REVERIFY_BUSY_STALE_MS - 1), NOW)).toBe(false);
  });

  it('awaiting-user (the quadra phantom) is re-verified only after the long settled window', () => {
    // Just past the busy window it is STILL left alone — an open "your turn" you
    // stepped away from must not thrash the server every couple of minutes.
    expect(isPhaseReverifyCandidate('awaiting-user', NOW - REVERIFY_BUSY_STALE_MS, NOW)).toBe(false);
    // Only once it has sat silent for the full settled window is it treated as a
    // possible phantom worth a snapshot check (present → kept, absent → dropped).
    expect(isPhaseReverifyCandidate('awaiting-user', NOW - REVERIFY_SETTLED_STALE_MS, NOW)).toBe(true);
    expect(isPhaseReverifyCandidate('awaiting-user', NOW - (REVERIFY_SETTLED_STALE_MS - 1), NOW)).toBe(false);
  });

  it('calm/terminal phases are never re-verified (their row is not a phantom)', () => {
    for (const p of ['completed', 'dormant', 'paused', 'awaiting-approval', 'error'] as ClaudeSessionPhase[]) {
      expect(isPhaseReverifyCandidate(p, NOW - REVERIFY_SETTLED_STALE_MS * 10, NOW)).toBe(false);
    }
  });
});
