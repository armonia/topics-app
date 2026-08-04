/**
 * Cross-window presence — pure snapshot builder.
 *
 * The WS presence channel rebroadcasts the FULL list of windows that have
 * declared themselves (via `hello` / `presence:announce`), plus the topics each
 * holds. Building that list from the live socket set is the only logic worth
 * unit-testing; keeping it pure (input = the presence facts on each socket,
 * output = the deduped window list) lets server.ts stay a thin adapter over it.
 */

// La forma di una tab sul filo è UNA, in `shared/types.ts`: era scritta
// identica anche qui e in `client/src/types/index.ts`, cioè due copie della
// stessa cosa libere di divergere (il test `no-type-mirrors` è lì per questo).
// Ri-esportata perché ogni import storico di questo modulo resti valido.
import type { PresenceTab } from "../shared/types";
export type { PresenceTab };

/** The presence-bearing subset of a socket's WSData (what the builder reads). */
export interface PresenceSource {
  id: string;
  windowId?: string;
  windowLabel?: string;
  detached?: boolean;
  presenceTopicIds?: string[];
  presenceFocusedTopicId?: string;
  presenceTabs?: PresenceTab[];
  /**
   * Il socket è ancora aperto? (`readyState === 1`)
   *
   * Il builder iterava OGNI socket in `wsClients` senza guardarlo, mentre tutte
   * le altre vie di broadcast lo filtrano. Un socket mezzo aperto — chiuso lato
   * client senza che il close handler sia mai scattato — restava quindi una
   * "finestra" per sempre: `wsClients.delete` sta in due punti soli, e se quel
   * percorso non scatta niente lo ripulisce.
   *
   * `undefined` = non dichiarato ⇒ si conta (chiamante non aggiornato, e i test
   * esistenti non devono cambiare significato).
   */
  alive?: boolean;
}

export interface PresenceWindowEntry {
  windowId: string;
  clientId: string;
  windowLabel?: string;
  detached?: boolean;
  topicIds: string[];
  focusedTopicId?: string;
  /** Absent when the window runs a client that predates the field — consumers
   *  fall back to `topicIds` rather than rendering an empty window. */
  tabs?: PresenceTab[];
}

/**
 * Deduped list of windows that have declared presence.
 *
 * Tre regole, in quest'ordine:
 *
 * 1. **Un socket che non ha annunciato** (`windowId` assente) **o che non è
 *    vivo** (`alive === false`) non è una finestra. Il secondo pezzo mancava, ed
 *    è metà del bug delle "4 finestre principali": un socket mezzo aperto
 *    restava nell'elenco per sempre.
 *
 * 2. **Stesso `windowId`** = stesso client che si è riconnesso prima che il
 *    vecchio socket cadesse: vince il primo (invariata).
 *
 * 3. **Stesso `windowLabel`** = STESSA FINESTRA DEL SISTEMA OPERATIVO. Nel
 *    guscio Tauri la finestra `main` è una per definizione: quattro socket che
 *    dichiarano `main` non sono quattro finestre, sono quattro contesti della
 *    stessa (rilevato dal vivo il 03/08: quattro `windowId` distinti, tutti
 *    `label=main`, tutti sullo stesso `__board__`). Qui vince l'ULTIMO che si è
 *    annunciato, così un reload SOSTITUISCE sé stesso invece di clonarsi.
 *
 *    Il label si applica solo quando c'è: sul web è assente, e lì più tab sono
 *    davvero più finestre — collassarle sarebbe il bug opposto.
 *
 * Ordine: quello di iterazione; una voce collassata per label tiene la posizione
 * dell'ultima occorrenza (è quella che sopravvive).
 */
export function buildPresenceSnapshot(sources: Iterable<PresenceSource>): PresenceWindowEntry[] {
  const seen = new Set<string>();
  const windows: PresenceWindowEntry[] = [];
  for (const s of sources) {
    if (!s.windowId || seen.has(s.windowId)) continue;
    if (s.alive === false) continue;
    seen.add(s.windowId);
    windows.push({
      windowId: s.windowId,
      clientId: s.id,
      windowLabel: s.windowLabel,
      detached: s.detached,
      topicIds: s.presenceTopicIds ?? [],
      focusedTopicId: s.presenceFocusedTopicId,
      tabs: s.presenceTabs,
    });
  }
  return collapseByWindowLabel(windows);
}

/** Una voce per `windowLabel` non vuoto, l'ultima vince. Le voci senza label
 *  passano tutte (caso web: più tab = più finestre davvero). */
function collapseByWindowLabel(windows: PresenceWindowEntry[]): PresenceWindowEntry[] {
  const lastIndexByLabel = new Map<string, number>();
  windows.forEach((w, i) => {
    if (w.windowLabel) lastIndexByLabel.set(w.windowLabel, i);
  });
  if (lastIndexByLabel.size === 0) return windows;
  return windows.filter((w, i) => !w.windowLabel || lastIndexByLabel.get(w.windowLabel) === i);
}
