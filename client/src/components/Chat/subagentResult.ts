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

const ENVELOPE = /<subagent-result((?: [a-z_]+="[^"]*")*)>\n([\s\S]*?)\n<\/subagent-result>/g;
const STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped', 'undelivered', 'lost']);
/** The server writes `<` as `<\\` in the child's words (`neutralizeTags`): the card shows them as written. */
const unescapeTags = (s: string) => s.replace(/<\\/g, '<');

/**
 * The result a foreground `spawn_agent` returned as its answer (SUBAGENT-13),
 * read back from the `<subagent-result>` envelope of that answer
 * (`server/services/subagent-wake.ts` `subagentWakeText`). That turn never
 * becomes a chat row, so the call's own answer is the only place the card can
 * find it. Null for a background spawn, a wait that handed over, or another child.
 */
export function foregroundSpawnResult(output: string | undefined, agentId: string | undefined): SubagentResultCard | null {
  if (!output || !agentId) return null;
  for (const m of output.matchAll(ENVELOPE)) {
    const attrs = Object.fromEntries([...m[1]!.matchAll(/([a-z_]+)="([^"]*)"/g)].map((a) => [a[1]!, unescapeTags(a[2]!)]));
    if (attrs.agent_id !== agentId || !STATUSES.has(attrs.status ?? '')) continue;
    const status = attrs.status as SubagentResultCard['status'];
    const body = unescapeTags(m[2]!);
    // Only a completed turn's body is the child's words; any other quotes the last line seen.
    const text = status === 'completed'
      ? (body === '_(finished with no output)_' ? '' : body)
      : body.split('\n').filter((l) => l.startsWith('>')).map((l) => l.replace(/^> ?/, '')).join('\n');
    const reason: SubagentResultCard['reason'] | undefined = attrs.reason
      ? {
        code: attrs.reason,
        ...(attrs.reason_detail ? { detail: attrs.reason_detail } : {}),
        ...(attrs.exit_code && Number.isFinite(Number(attrs.exit_code)) ? { exitCode: Number(attrs.exit_code) } : {}),
      }
      : undefined;
    return {
      agentId, name: attrs.agent ?? '', turn: Number(attrs.turn) || 1, status,
      partial: attrs.partial === 'true', text,
      ...(reason ? { reason } : {}),
      ...(attrs.branch ? { branch: attrs.branch } : {}),
    };
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
