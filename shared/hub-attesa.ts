/**
 * The hub's «waiting for you» items that belong to a board card.
 *
 * Whoever opens an item for a card writes the card's id in `taskId`. The Plan
 * view reads the hub's list next to the cards' own `needsYou`: an item whose
 * card is already waiting for the person is that same wait, so it is merged
 * into the card's row and not listed twice; every other item (no `taskId`, or
 * a card that waits for nothing) goes to the «outside the board» section.
 *
 * Lives in shared/ because the client and the server tests both import it.
 */

/** A card id out of the hub's wire value; null when the item is not tied to a card. */
export function hubTaskId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

export interface HubWaitSplit<T> {
  /** Items merged into a card that already waits, by card id. */
  merged: Map<string, T[]>;
  /** Items shown outside the board, in the hub's order. */
  outside: T[];
}

/** Splits the hub's items by whether their card is among the ones waiting for the person. */
export function splitHubWaits<T extends { taskId: string | null }>(items: readonly T[], waitingCardIds: ReadonlySet<string>): HubWaitSplit<T> {
  const merged = new Map<string, T[]>();
  const outside: T[] = [];
  for (const item of items) {
    if (item.taskId !== null && waitingCardIds.has(item.taskId)) {
      const list = merged.get(item.taskId) ?? [];
      list.push(item);
      merged.set(item.taskId, list);
    } else {
      outside.push(item);
    }
  }
  return { merged, outside };
}
