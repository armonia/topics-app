import type { Pane, PaneAction } from './types';

export const openPane = (
  p: Pane & { groupId: string; insertIndex?: number },
): PaneAction => ({ type: 'OPEN_PANE', payload: p });
