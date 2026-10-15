import { useCallback, useRef, useState } from 'react';
import type { Topic } from '../../types';
import { topicsApi } from '../../lib/api';
import { errMessage } from '../../lib/errMessage';
import { updateMessages } from '../../state/messageStore';
import type { useT } from '../../hooks/useT';
import { askSideQuestion, runSideQuestionFork, SideQuestionError } from './sideQuestion';

export type Translate = ReturnType<typeof useT>;
export interface SideQuestionState { token: number; question: string; answer?: string; error?: string; busy: boolean }

/**
 * `/btw` (CMD-10): the question goes to a throwaway fork of this chat, the answer stays in the
 * panel, and the fork is removed as soon as the answer is read, whatever happened.
 */
export function useSideQuestion({ topic, loadHistory, sendMessage, getSessionMessages, tr }: {
  topic: Pick<Topic, 'id' | 'sessionKey'>;
  loadHistory: (sessionKey: string) => Promise<unknown>;
  sendMessage: (sessionKey: string, content: string) => Promise<boolean>;
  getSessionMessages: (sessionKey: string) => { role: string; content?: string; partial?: boolean }[];
  tr: Translate;
}) {
  const [state, setState] = useState<SideQuestionState | null>(null);
  const tokenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const settle = (token: number, patch: Partial<SideQuestionState>) =>
    setState((current) => current?.token === token ? { ...current, ...patch, busy: false } : current);

  const ask = useCallback(async (question: string) => {
    abortRef.current?.abort();
    const token = ++tokenRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ token, question, busy: true });
    try {
      const answer = await runSideQuestionFork({
        createFork: () => topicsApi.sideQuestion(topic.id),
        ask: (branch) => askSideQuestion({ mainSessionKey: topic.sessionKey, sideSessionKey: branch.sessionKey, question, loadHistory, sendMessage, getSessionMessages, signal: controller.signal }),
        closeFork: (branch) => topicsApi.closeSideQuestion(branch.id),
        onClosed: (sessionKey) => updateMessages((previous) => {
          if (!(sessionKey in previous)) return previous;
          const next = { ...previous };
          delete next[sessionKey];
          return next;
        }),
      });
      settle(token, { answer });
    } catch (err) {
      const reason = err instanceof SideQuestionError ? tr(err.code === 'not-started' ? 'chat.btw.notStarted' : 'chat.btw.noAnswer') : errMessage(err);
      settle(token, { error: reason });
    } finally {
      // Cleanup errors are shown only while this request still owns the panel.
      // `runSideQuestionFork` closes and removes the local transcript in one finally path.
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [topic.id, topic.sessionKey, loadHistory, sendMessage, getSessionMessages, tr]);

  const close = useCallback(() => {
    tokenRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setState(null);
  }, []);
  return { state, ask, close };
}
