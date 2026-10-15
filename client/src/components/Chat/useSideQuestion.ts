import { useCallback, useRef, useState } from 'react';
import type { Topic } from '../../types';
import { topicsApi } from '../../lib/api';
import { errMessage } from '../../lib/errMessage';
import { updateMessages } from '../../state/messageStore';
import type { useT } from '../../hooks/useT';
import { askSideQuestion, SideQuestionError } from './sideQuestion';

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
  const settle = (token: number, patch: Partial<SideQuestionState>) =>
    setState((current) => current?.token === token ? { ...current, ...patch, busy: false } : current);

  const ask = useCallback(async (question: string) => {
    const token = ++tokenRef.current;
    setState({ token, question, busy: true });
    let branch: Topic | null = null;
    try {
      branch = await topicsApi.sideQuestion(topic.id);
      const answer = await askSideQuestion({ mainSessionKey: topic.sessionKey, sideSessionKey: branch.sessionKey, question, loadHistory, sendMessage, getSessionMessages });
      settle(token, { answer });
    } catch (err) {
      const reason = err instanceof SideQuestionError ? tr(err.code === 'not-started' ? 'chat.btw.notStarted' : 'chat.btw.noAnswer') : errMessage(err);
      settle(token, { error: reason });
    } finally {
      if (branch) {
        const sessionKey = branch.sessionKey;
        try { await topicsApi.closeSideQuestion(branch.id); }
        catch (err) { settle(token, { error: errMessage(err) }); }
        updateMessages((previous) => {
          if (!(sessionKey in previous)) return previous;
          const next = { ...previous };
          delete next[sessionKey];
          return next;
        });
      }
    }
  }, [topic.id, topic.sessionKey, loadHistory, sendMessage, getSessionMessages, tr]);

  const close = useCallback(() => { tokenRef.current++; setState(null); }, []);
  return { state, ask, close };
}
