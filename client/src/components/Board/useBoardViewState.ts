import { useCallback, useState } from 'react';
import {
  BOARD_DENSITY_STORAGE_KEY, BOARD_GROUP_BY_STORAGE_KEY, BOARD_THEN_BY_STORAGE_KEY, boardStorageKey, parseBoardDensity,
  readBoardGroupBy, readBoardThenBy, writeBoardPreference, type BoardDensity, type BoardGroupBy,
} from './boardGeometry';
import { DETAIL_STORAGE_KEY, readDetailLevel, type DetailLevel } from './detailLevel';

interface ViewState { detail: DetailLevel; groupBy: BoardGroupBy; thenBy: BoardGroupBy; density: BoardDensity | null }

function readDensity(boardId: string): BoardDensity | null {
  try { return parseBoardDensity(localStorage.getItem(boardStorageKey(BOARD_DENSITY_STORAGE_KEY, boardId))); }
  catch { return null; }
}

const read = (boardId: string): ViewState => ({
  detail: readDetailLevel(boardId), groupBy: readBoardGroupBy(boardId), thenBy: readBoardThenBy(boardId), density: readDensity(boardId),
});

/** The density a view draws when the reader never moved the slider: the cards view is compact, the others full. */
export function effectiveDensity(density: BoardDensity | null, detail: DetailLevel): BoardDensity {
  return density ?? (detail === 'plan' ? 'compact' : 'full');
}

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
  setDensity: (v: BoardDensity) => void;
} {
  const [state, setState] = useState(() => ({ boardId, view: read(boardId) }));
  let view = state.view;
  if (state.boardId !== boardId) {
    view = read(boardId);
    setState({ boardId, view });
  }
  const set = useCallback(<K extends keyof ViewState>(field: K, storageKey: string, value: NonNullable<ViewState[K]>) => {
    writeBoardPreference(boardStorageKey(storageKey, boardId), value);
    setState((s) => ({ boardId, view: { ...(s.boardId === boardId ? s.view : read(boardId)), [field]: value } }));
  }, [boardId]);
  const setDetail = useCallback((v: DetailLevel) => set('detail', DETAIL_STORAGE_KEY, v), [set]);
  const setGroupBy = useCallback((v: BoardGroupBy) => set('groupBy', BOARD_GROUP_BY_STORAGE_KEY, v), [set]);
  const setThenBy = useCallback((v: BoardGroupBy) => set('thenBy', BOARD_THEN_BY_STORAGE_KEY, v), [set]);
  const setDensity = useCallback((v: BoardDensity) => set('density', BOARD_DENSITY_STORAGE_KEY, v), [set]);
  return { ...view, setDetail, setGroupBy, setThenBy, setDensity };
}
