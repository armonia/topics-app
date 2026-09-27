import { useEffect, useState } from 'react';
import { boardApi, type BoardSettings } from '../lib/board';
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
