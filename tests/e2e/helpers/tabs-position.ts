/**
 * The browser storage every spec opens with.
 *
 * The board hides Done by default (a board of live work); the suite reads
 * cards in Done, so a test starts with the column shown. board-group-density
 * checks the default. Same for the origin preset: a board opens on «My work»,
 * which hides cards in progress and the agents' cards; the suite starts on
 * «All» and board-origin-filters checks the default.
 *
 * Tabs: since 24/11 a new client lists its tabs in ONE place (the column by
 * default), closing a tab leaves a closed row and pinned tabs cannot be
 * closed. More than a hundred specs were written against the layout of before,
 * reading a tab in the strip AND its row in the column, and expecting a closed
 * tab to leave: the suite starts there (`tabsPosition: both`, a value the View
 * level does not offer). sidebar-tab-states.spec.ts checks the new defaults.
 */
import { E2E_BASE } from "./test-server";

export function suiteStorageState() {
  return {
    cookies: [],
    origins: [{
      origin: E2E_BASE,
      localStorage: [
        { name: "topics.board.showDone", value: "true" },
        { name: "topics.board.preset", value: "all" },
        { name: "app-settings", value: JSON.stringify({ tabsPosition: "both", closeArchives: true, pinnedClosable: true }) },
      ],
    }],
  };
}
