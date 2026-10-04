/**
 * Stopping work another session started asks first (SUBAGENT-20).
 *
 * Owner, 04/10: work started by another session must not be closed lightly,
 * like a plain process; it should ask for confirmation first. A
 * sub-agent belongs to the session that spawned it: closing its terminal tab
 * kills its PTY, and a Stop on its chat cuts its turn. Either way the parent
 * gets a «stopped» result for work it is waiting on.
 *
 * Only when something actually stops: a session the person started, or a
 * child that already finished its turn, closes without a question.
 */
import { useCallback } from 'react';
import { useConfirm, type ConfirmOptions } from '../hooks/useConfirm';
import { useT } from '../hooks/useT';
import { useTerminalSessions, useTopics } from '../contexts/TopicsContext';
import type { TerminalSessionInfo, Topic } from '../types';

export interface StopTarget {
  name: string;
  /** Label of the session that started it. */
  startedBy: string;
}

type Tr = (key: string, vars?: Record<string, string | number>) => string;

/** A readable name for the parent session key: its chat, its terminal, or the key itself. */
export function parentLabel(
  parentSessionKey: string,
  topics: Record<string, Topic> | readonly Topic[],
  terminals: readonly TerminalSessionInfo[],
): string {
  const list = Array.isArray(topics) ? topics : Object.values(topics);
  const chat = list.find((t) => t.sessionKey === parentSessionKey);
  if (chat) return `«${chat.name}»`;
  const term = terminals.find((t) => t.id === parentSessionKey);
  if (term) return `«${term.name}»`;
  return parentSessionKey;
}

/**
 * A CLI sub-agent's terminal. Working = the server reads it working or still
 * waiting for its prompt; with no phase yet, the PTY being busy. A finished
 * turn is not work in progress, even with the PTY still alive.
 */
export function terminalStopTarget(
  session: TerminalSessionInfo | undefined,
  label: (parentSessionKey: string) => string,
): StopTarget | null {
  if (!session?.parentSessionKey) return null;
  const phase = session.subAgentPhase;
  const working = phase === 'working' || phase === 'waiting-prompt' || (phase == null && !!session.busy);
  return working ? { name: session.name, startedBy: label(session.parentSessionKey) } : null;
}

/** A native sub-agent's chat: only while its turn is streaming. */
export function chatStopTarget(
  topic: Pick<Topic, 'name' | 'subagentOf'> | undefined,
  streaming: boolean,
  label: (parentSessionKey: string) => string,
): StopTarget | null {
  if (!topic?.subagentOf || !streaming) return null;
  return { name: topic.name, startedBy: label(topic.subagentOf) };
}

export function stopConfirmOptions(target: StopTarget, tr: Tr): ConfirmOptions {
  const vars = { name: `«${target.name}»`, parent: target.startedBy };
  return {
    title: tr('subagent.stopConfirm.title', vars),
    body: tr('subagent.stopConfirm.body', vars),
    confirmLabel: tr('subagent.stopConfirm.confirm'),
    tone: 'danger',
  };
}

/** Resolves true at once when nothing would stop; otherwise asks. */
export function useConfirmSubagentStop(): (target: StopTarget | null) => Promise<boolean> {
  const confirm = useConfirm();
  const tr = useT();
  return useCallback(
    (target) => (target ? confirm(stopConfirmOptions(target, tr)) : Promise.resolve(true)),
    [confirm, tr],
  );
}

/** For a close that would retire a terminal session: asks only for a working sub-agent's. */
export function useConfirmTerminalStop(): (sessionId: string | null | undefined) => Promise<boolean> {
  const ask = useConfirmSubagentStop();
  const topics = useTopics();
  const terminals = useTerminalSessions();
  return useCallback(
    (sessionId) => {
      const session = sessionId ? terminals.find((t) => t.id === sessionId) : undefined;
      return ask(terminalStopTarget(session, (key) => parentLabel(key, topics, terminals)));
    },
    [ask, topics, terminals],
  );
}
