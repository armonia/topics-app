/**
 * claudeAttention — topics whose Claude session needs the user, expressed as a
 * notification source (not just the phase dot).
 *
 * The ClaudeSessionContext already tracks per-topic phase and renders a dot,
 * but nothing fed those states into the badge/notification system — so Claude
 * needing approval, finishing a reply, or erroring never produced a count and
 * never rolled up to the project tab. This store mirrors the "notable" phases
 * so getBadgeCount can surface them as a badge.
 *
 * Why phase-derived gives "persist until you interact" for free: the notable
 * phases ARE interaction-gated — awaiting-approval holds until you approve,
 * awaiting-user holds until you reply, error holds until the next run. When
 * the user acts, the session leaves the notable set and the badge clears. No
 * separate ack/clear bookkeeping needed.
 *
 * App owns the single useClaudeSessionState subscription and syncs the set
 * here (mapping sessionKey → topic via the topics list).
 */
import { create } from 'zustand';
import type { ClaudeSessionPhase } from '../types';

/** Phases that mean "Claude needs you" — worth a notification badge. The
 *  loading-ish phases (running / tool-running) are surfaced as spinners, not
 *  notifications. */
export const NOTABLE_CLAUDE_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set<ClaudeSessionPhase>([
  'awaiting-approval',
  'awaiting-user',
  'error',
]);

interface ClaudeAttentionStore {
  topicIds: Set<string>;
  sync: (topicIds: Set<string>) => void;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export const useClaudeAttentionStore = create<ClaudeAttentionStore>((set) => ({
  topicIds: new Set(),
  sync: (topicIds) =>
    set((state) => (setsEqual(topicIds, state.topicIds) ? state : { topicIds })),
}));
