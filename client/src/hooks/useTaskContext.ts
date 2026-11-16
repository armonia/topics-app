import { useMemo } from 'react';
import type { WSMessage } from '../types';
import { useTopics } from '../contexts/TopicsContext';
import { subscribeFrames } from '../lib/wsFrameBus';
import { useRealContext } from './useRealContext';
import { contextMeasure, type ContextMeasure } from '../../../shared/task-countdown';

/** The live-context frames, as `useRealContext` wants its message source. Module-level so the hook's effect does not resubscribe each render. */
const contextFrames = (handler: (msg: WSMessage) => void) =>
  subscribeFrames((f) => handler(f as WSMessage), { types: ['stream:context'] });

/** The session key a topic id stands for, from the topics already loaded; `null` when the topic is not known here. */
export function useSessionKeyOfTopic(topicId: string | null | undefined): string | null {
  const topics = useTopics();
  return topicId ? topics[topicId]?.sessionKey ?? null : null;
}

/**
 * The context the provider measured on the session of a card's assigned topic:
 * exact tokens of the last call against the model window. `null` while there
 * is no assigned topic, no measure yet or the topic is not loaded: the caller
 * then draws no percent.
 */
export function useTaskContext(assignedTopicId: string | null | undefined): ContextMeasure | null {
  const sessionKey = useSessionKeyOfTopic(assignedTopicId);
  const usage = useRealContext(sessionKey, contextFrames);
  return useMemo(() => (usage ? contextMeasure({ usage: { used: usage.used, size: usage.size }, estimated: usage.estimated }) : null), [usage]);
}
