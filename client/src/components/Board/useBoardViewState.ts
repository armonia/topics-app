import { useCallback, useState } from 'react';
import {
  BOARD_GROUP_BY_STORAGE_KEY, BOARD_THEN_BY_STORAGE_KEY, boardStorageKey, readBoardGroupBy, readBoardThenBy,
  writeBoardPreference, type BoardGroupBy,
} from './boardGeometry';
import { DETAIL_STORAGE_KEY, readDetailLevel, type DetailLevel } from './detailLevel';

interface ViewState { detail: DetailLevel; groupBy: BoardGroupBy; thenBy: BoardGroupBy }

const read = (boardId: string): ViewState => ({
  detail: readDetailLevel(boardId), groupBy: readBoardGroupBy(boardId), thenBy: readBoardThenBy(boardId),
});

/**
 * The view, the grouping and the second level of grouping, kept PER BOARD:
 * the global board and each project remember their own. The write happens in
 * the setter, not in an effect, so a switch of board never writes the old
 * board's choice under the new board's key.
 */
export function useBoardViewState(boardId: string): ViewState & {
  setDetail: (v: DetailLevel) => void;
  setGroupBy: (v: BoardGroupBy) => void;
  setThenBy: (v: BoardGroupBy) => void;
} {
  const [state, setState] = useState(() => ({ boardId, view: read(boardId) }));
  let view = state.view;
  if (state.boardId !== boardId) {
    view = read(boardId);
    setState({ boardId, view });
  }
  const set = useCallback(<K extends keyof ViewState>(field: K, storageKey: string, value: ViewState[K]) => {
    writeBoardPreference(boardStorageKey(storageKey, boardId), value);
    setState((s) => ({ boardId, view: { ...(s.boardId === boardId ? s.view : read(boardId)), [field]: value } }));
  }, [boardId]);
  const setDetail = useCallback((v: DetailLevel) => set('detail', DETAIL_STORAGE_KEY, v), [set]);
  const setGroupBy = useCallback((v: BoardGroupBy) => set('groupBy', BOARD_GROUP_BY_STORAGE_KEY, v), [set]);
  const setThenBy = useCallback((v: BoardGroupBy) => set('thenBy', BOARD_THEN_BY_STORAGE_KEY, v), [set]);
  return { ...view, setDetail, setGroupBy, setThenBy };
}
