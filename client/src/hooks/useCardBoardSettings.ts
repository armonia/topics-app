import { useEffect, useState } from 'react';
import { AUTO_PROJECT_ID, boardApi, type BoardSettings } from '../lib/board';
import { cardBoardSettings } from '../lib/topicsRoutingGate';

/** The board settings the task drawer judges a card with: its own board's.
 *  The all-boards view lists every board's cards inside a project pane that
 *  holds its own board's settings, so a card of another board fetches that
 *  board's, and until they arrive its default is unknown (null), never the
 *  pane's. The fetch, the board it is filed under and the read live together
 *  here, so a caller has nothing left to file under the wrong board. */
export function useCardBoardSettings(
  cardBoardId: string | null | undefined,
  paneBoardId: string,
  paneSettings: BoardSettings | null,
): BoardSettings | null {
  const [fetched, setFetched] = useState<{ projectId: string; settings: BoardSettings } | null>(null);
  useEffect(() => {
    if (!cardBoardId || cardBoardId === paneBoardId) return;
    let alive = true;
    boardApi.getSettings(cardBoardId)
      .then((settings) => { if (alive) setFetched({ projectId: cardBoardId, settings }); })
      .catch(() => { /* default unknown: the drawer judges the task alone */ });
    return () => { alive = false; };
  }, [cardBoardId, paneBoardId]);
  return cardBoardSettings(cardBoardId, paneBoardId, paneSettings, fetched);
}

/** The board settings the composer judges the card it is about to create
 *  with: those of the board it is born on. In the project view that is the
 *  pane's; in the all-boards view the picker's target, fetched when it is
 *  another board. On Auto the server picks the board at creation, so no
 *  single default applies (null). */
export function useComposerBoardSettings(
  global: boolean,
  targetBoardId: string,
  paneBoardId: string,
  paneSettings: BoardSettings | null,
): BoardSettings | null {
  const boardId = !global ? paneBoardId : targetBoardId === AUTO_PROJECT_ID ? null : targetBoardId;
  const settings = useCardBoardSettings(boardId, paneBoardId, paneSettings);
  return boardId ? settings : null;
}
