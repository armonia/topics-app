/**
 * The closed text of a card's model trigger and the long sentence of its
 * Automatic (model selector revision 2026-10-04 §3.7-3.8), for the card
 * composer, the drawer and the board settings: one format, «label · who».
 */
import { useProvidersSnapshot } from './useProvidersSnapshot';
import { useT } from './useT';
import { taskTriggerLine } from '../lib/modelLabel';
import { taskModelSelection, topicsRoute } from '../../../shared/task-coding-models';
import type { ProvidersSnapshot } from '../types';

/** Whether a card value runs through Topics with the switch as given. */
export function taskRunsThroughTopics(value: string | null | undefined, enabled: boolean, snapshot: ProvidersSnapshot | null): boolean {
  const selection = taskModelSelection(value);
  if (!selection.model || !enabled) return false;
  const provider = selection.provider && selection.provider !== 'topics'
    ? selection.provider
    : selection.model.startsWith('claude-') ? 'claude-code' : null;
  return topicsRoute(true, { provider, model: selection.model }, snapshot, 'task').via === 'topics';
}

export function useTaskModelTrigger(
  value: string | null | undefined,
  routingEnabled: boolean,
  surface: 'task' | 'board',
  boardValue?: string | null,
): { line: string; automatic: { who: string; hint: string } } {
  const tr = useT();
  const { snapshot } = useProvidersSnapshot();
  const line = taskTriggerLine(value, { snapshot, tr, surface, viaTopics: taskRunsThroughTopics(value, routingEnabled, snapshot) });
  if (surface === 'board') {
    return { line, automatic: { who: tr('ai.selector.auto.topicsPicks'), hint: tr('ai.selector.auto.topicsPicksLong') } };
  }
  const board = boardValue && boardValue !== 'auto'
    ? taskTriggerLine(boardValue, { snapshot, tr, surface: 'board', viaTopics: taskRunsThroughTopics(boardValue, routingEnabled, snapshot) })
    : null;
  return {
    line,
    automatic: {
      who: tr('ai.selector.auto.followsBoard'),
      hint: board ? tr('ai.selector.auto.followsBoardLong', { model: board }) : tr('ai.selector.auto.followsBoardNone'),
    },
  };
}
