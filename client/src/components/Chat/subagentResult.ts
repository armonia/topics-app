/**
 * What the sub-agent card of a `spawn_agent` call shows (SUBAGENT-16), decided
 * here and drawn by `SubAgentResultCard.tsx`: the live state comes from the
 * terminal roster (the server reads it from the child's transcript, not from
 * its PTY bytes), the result from the chat's `subagent-result` rows.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { ContentBlock, SubagentResultCard } from '../../types';
import type { TerminalSessionInfo } from '../../types';
import { getSessionMessagesFromStore, subscribeSession } from '../../state/messageStore';
import type { useT } from '../../hooks/useT';

/** The newest result of this child among the rows, or null. Returns the stored object: a stable identity. */
export function latestSubagentResult(
  messages: readonly { blocks?: readonly ContentBlock[] | null }[],
  agentId: string,
): SubagentResultCard | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i]!.blocks ?? []) {
      if (b.kind !== 'subagent-result') continue;
      for (let j = b.results.length - 1; j >= 0; j--) if (b.results[j]!.agentId === agentId) return b.results[j]!;
    }
  }
  return null;
}

export type SpawnCardState = 'starting' | 'waiting-prompt' | 'working' | 'finished' | 'ended';

/**
 * A live child says its own phase. Gone from the roster, it has finished if a
 * result says so, and simply ended otherwise; before the roster lists it, a
 * call still running is starting.
 */
export function spawnCardState(i: {
  live: Pick<TerminalSessionInfo, 'subAgentPhase'> | null;
  result: SubagentResultCard | null;
  isRunning: boolean;
}): SpawnCardState {
  if (i.live) return i.live.subAgentPhase ?? (i.result ? 'finished' : 'working');
  if (i.result) return 'finished';
  return i.isRunning ? 'starting' : 'ended';
}

/** The reason of a result in words, or null for a code this client does not know. */
export function reasonText(tr: ReturnType<typeof useT>, reason: SubagentResultCard['reason']): string | null {
  if (!reason) return null;
  const key = `chat.subagent.reason.${reason.code}`;
  const text = tr(key, { detail: reason.detail ?? '', code: String(reason.exitCode ?? '') });
  return text === key ? null : text;
}

/** The newest result of `agentId` in this chat, kept live with the chat's rows. */
export function useSubagentResult(sessionKey: string | undefined, agentId: string | undefined): SubagentResultCard | null {
  const subscribe = useCallback(
    (onChange: () => void) => (sessionKey ? subscribeSession(sessionKey, onChange) : () => {}),
    [sessionKey],
  );
  const snapshot = useCallback(
    () => (sessionKey && agentId ? latestSubagentResult(getSessionMessagesFromStore(sessionKey), agentId) : null),
    [sessionKey, agentId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
