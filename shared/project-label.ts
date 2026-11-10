/**
 * A card's project as a person reads it: the project row whose folder hashes
 * to the board id, else the board id without its hash (`acme-web-gr9brd` is
 * `acme-web`), never the bare id. One function so the load screen, the card
 * drawer and the Processes view name a project the same way.
 */
export function projectLabel(boardId: string, nameByBoard: ReadonlyMap<string, string>): string {
  return nameByBoard.get(boardId) ?? (boardId.replace(/-[0-9a-z]{1,6}$/, '') || boardId);
}
