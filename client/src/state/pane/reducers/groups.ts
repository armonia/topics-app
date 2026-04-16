import type { PaneState, PaneAction } from '../types';

export function groupsReducer(state: PaneState, action: PaneAction): void {
  switch (action.type) {
    case 'SPLIT': {
      const g = state.groups[action.payload.groupId];
      if (!g) break;
      g.splitAxis = action.payload.axis;
      g.splitRatio = action.payload.ratio;
      break;
    }
    case 'RESIZE': {
      const g = state.groups[action.payload.groupId];
      if (g) g.splitRatio = action.payload.ratio;
      break;
    }
    case 'REORDER_PANES': {
      const g = state.groups[action.payload.groupId];
      if (g) g.paneIds = [...action.payload.paneIds];
      break;
    }
  }
}
