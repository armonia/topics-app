import { useCallback, useState } from 'react';
import {
  BOARD_GROUP_BY_STORAGE_KEY, BOARD_THEN_BY_STORAGE_KEY, boardStorageKey, readBoardGroupBy, readBoardThenBy,
  writeBoardPreference, type BoardGroupBy,
} from './boardGeometry';
import { DETAIL_STORAGE_KEY, readDetailLevel, type DetailLevel } from './detailLevel';

interface Prefs { detail: DetailLevel; groupBy: BoardGroupBy; thenBy: BoardGroupBy }

const read = (boardId: string): Prefs => ({
  detail: readDetailLevel(boardId), groupBy: readBoardGroupBy(boardId), thenBy: readBoardThenBy(boardId),
});

/**
 * The view, the grouping and the second level of grouping, kept PER BOARD:
 * the global board and each project remember their own. The write happens in
 * the setter, not in an effect, so a switch of board never writes the old
 * board's choice under the new board's key.
 */
export function useBoardViewPrefs(boardId: string): Prefs & {
  setDetail: (v: DetailLevel) => void;
  setGroupBy: (v: BoardGroupBy) => void;
  setThenBy: (v: BoardGroupBy) => void;
} {
  const [state, setState] = useState(() => ({ boardId, prefs: read(boardId) }));
  let prefs = state.prefs;
  if (state.boardId !== boardId) {
    prefs = read(boardId);
    setState({ boardId, prefs });
  }
  const set = useCallback(<K extends keyof Prefs>(field: K, storageKey: string, value: Prefs[K]) => {
    writeBoardPreference(boardStorageKey(storageKey, boardId), value);
    setState((s) => ({ boardId, prefs: { ...(s.boardId === boardId ? s.prefs : read(boardId)), [field]: value } }));
  }, [boardId]);
  const setDetail = useCallback((v: DetailLevel) => set('detail', DETAIL_STORAGE_KEY, v), [set]);
  const setGroupBy = useCallback((v: BoardGroupBy) => set('groupBy', BOARD_GROUP_BY_STORAGE_KEY, v), [set]);
  const setThenBy = useCallback((v: BoardGroupBy) => set('thenBy', BOARD_THEN_BY_STORAGE_KEY, v), [set]);
  return { ...prefs, setDetail, setGroupBy, setThenBy };
}
