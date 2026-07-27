import { createContext } from 'react';

/**
 * True for the message rendered directly under a compaction divider, whose
 * body therefore carries the CLI's recap — the divider already owns that recap
 * and renders the expander itself.
 *
 * Without it the same boundary announced ITSELF TWICE, back to back: the
 * "Contesto compattato" divider, then the message's own "Riassunto del contesto
 * compattato" pill. One event, one signal — so `ProseBlock` reads this and
 * strips the recap silently instead of drawing a second chip. It stays FALSE
 * everywhere else, so a session whose boundary was never captured as a marker
 * (older history, a compaction outside a Topics turn) still shows its own fold
 * and the recap remains reachable.
 */
export const CompactionHoistContext = createContext(false);
