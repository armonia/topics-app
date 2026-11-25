/**
 * Which board ids are merged into the board on screen (accorpa).
 *
 * A card of a merged project keeps its own `projectId`, so on the parent's board
 * it has to say where it comes from: the card reads this set and shows its
 * project label when its own id is in it. Empty by default, so a card drawn
 * outside a board (the Plan, tests) behaves as before.
 */
import { createContext, useContext } from 'react';

const NONE: ReadonlySet<string> = new Set();

export const MergedBoardsContext = createContext<ReadonlySet<string>>(NONE);

/** Whether a card of `projectId` is drawn on a board it was merged into. */
export function useIsMergedHere(projectId: string): boolean {
  return useContext(MergedBoardsContext).has(projectId);
}
