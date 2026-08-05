/**
 * spaceHelpers — the non-component surface of the Spazi feature, split out of
 * SpaceSwitcher.tsx so that file only exports components (react-refresh
 * fast-refresh hygiene: a module mixing component + function exports forces a
 * full reload on every edit). Pure/imperative helpers shared by the switcher
 * chips and the "Sposta nello Spazio →" tab menu live here.
 */
import { usePaneStore } from '../../state/pane/store';
import { selectVisiblePaneIds } from '../../state/pane/selectors';
import { resolvePaneSpace } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, type SpaceMeta } from '../../state/pane/types';
import { generateUUID } from '../../utils/uuid';

/** Label for the implicit default space (never stored in the registry). */
export const DEFAULT_SPACE_LABEL = 'Principale';

/** Live (non-deleted) spaces, ordered — the switcher's chip list after the
 *  default chip. */
export function liveSpacesOrdered(spaces: Record<string, SpaceMeta>): SpaceMeta[] {
  return Object.values(spaces)
    .filter((s) => !s.deleted)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Mint a fresh space id (`space:` prefix per the coherence ruling). */
export function createSpaceId(): string {
  return `space:${generateUUID()}`;
}

/** Default name for the Nth user group ("Gruppo 2", …). Nel codice restano
 *  "space"/"Spazio" (id, azioni, chiavi); a schermo si dice GRUPPO, che è la
 *  parola che l'utente usa e quella che il modello merita: il gruppo è
 *  l'unità, e una finestra è un gruppo staccato. */
export function nextSpaceName(spaces: Record<string, SpaceMeta>): string {
  return `Gruppo ${liveSpacesOrdered(spaces).length + 2}`;
}

/** Detached pop-out windows (`?topics=`) skip every pane-store bridge — the
 *  switcher (and the "Sposta nello Spazio" menu) must not render there
 *  (coherence ruling 3.8).
 *
 *  Ri-esportato da `lib/windowRole`, che è ora l'unica risposta: questa copia
 *  guardava solo `?topic=` (singolare) e quindi dichiarava NON staccata ogni
 *  pop-out moderna `?topics=<id,…>` — cioè quasi tutte. Chi importa da qui non
 *  cambia riga; chi sta in `lib/` importa la fonte. */
export { isDetachedWindow } from '../../lib/windowRole';

/**
 * Move an app-level pane to another Spazio ("Sposta nello Spazio →"). The
 * membership write is a plain UPDATE_PANE (spaceId is a synced Pane field);
 * the default space is encoded as ABSENT. If the moved pane was the focused
 * one it just left the visible set — hand focus to the first pane still
 * visible (or null) BEFORE the focus-follow effect could yank the window to
 * the target space. No auto-switch: Arc semantics, the tab travels quietly.
 */
export function movePaneToSpace(paneId: string, targetSpaceId: string): void {
  const s = usePaneStore.getState();
  const pane = s.panes[paneId];
  if (!pane) return;
  if (resolvePaneSpace(pane, s.spaces) === targetSpaceId) return; // already there
  s.dispatch({
    type: 'UPDATE_PANE',
    payload: {
      id: paneId,
      updates: { spaceId: targetSpaceId === DEFAULT_SPACE_ID ? undefined : targetSpaceId },
    },
  });
  const after = usePaneStore.getState();
  if (after.focusedPaneId === paneId) {
    const visible = selectVisiblePaneIds(after);
    after.dispatch({ type: 'FOCUS_PANE', payload: { id: visible[0] ?? null } });
  }
}
