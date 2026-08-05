/**
 * SpaceTitle — il nome del gruppo che stai guardando, in cima alla sidebar.
 *
 * La metà "titolo in alto" della grammatica Arc/Dia, di cui la SpaceBar in
 * fondo è la metà "e qui sotto gli altri". Serve a rispondere alla domanda che
 * prima non aveva risposta da nessuna parte: *di quale gruppo sono queste tab?*
 * — perché l'elenco qui sotto mostra solo quelle del gruppo attivo.
 *
 * Non si disegna finché esiste il solo gruppo implicito: con un gruppo solo il
 * titolo direbbe «Principale» sopra l'unica lista possibile, che è rumore.
 * Stessa regola di zero-chrome che governa la barra in fondo.
 */
import { useMemo } from 'react';
import { AppWindow, Layers } from 'lucide-react';
import { usePaneStore } from '../../state/pane/store';
import { useWindowPresenceStore } from '../../state/windowPresence';
import { DEFAULT_SPACE_ID } from '../../state/pane/types';
import { ROW_INSET } from '../../lib/selectionStyles';
import { DEFAULT_SPACE_LABEL, liveSpacesOrdered, isDetachedWindow } from '../Layout/spaceHelpers';
import { spaceWindowId } from '../../lib/windowRole';

export function SpaceTitle() {
  const activeSpaceId = usePaneStore((s) => s.activeSpaceId);
  const spaces = usePaneStore((s) => s.spaces);
  const windows = useWindowPresenceStore((s) => s.windows);
  const ordered = useMemo(() => liveSpacesOrdered(spaces), [spaces]);

  const pinned = spaceWindowId();
  // In una finestra-gruppo il titolo si disegna SEMPRE: lì è l'unica cosa che
  // dice quale gruppo stai guardando (la barra in fondo non c'è, perché non
  // c'è dove andare).
  if (isDetachedWindow()) return null;
  if (!pinned && ordered.length === 0) return null;

  const name =
    activeSpaceId === DEFAULT_SPACE_ID
      ? DEFAULT_SPACE_LABEL
      : spaces[activeSpaceId]?.name || 'Gruppo';

  // Questo gruppo è aperto in una finestra sua? (Lo dice la presenza, non un
  // flag locale: la finestra staccata può essere stata chiusa da un pezzo.)
  const detachedElsewhere =
    !pinned &&
    Object.values(windows).some((w) => w.spaceId === activeSpaceId && !!w.windowLabel);

  return (
    <div
      className="flex items-center gap-1.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-app-text-tertiary"
      style={{ paddingLeft: ROW_INSET + 4, paddingRight: ROW_INSET }}
      data-testid="sidebar-space-title"
      data-space-id={activeSpaceId}
    >
      <Layers size={12} className="flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate normal-case tracking-normal text-[12px] text-app-text">{name}</span>
      {(pinned || detachedElsewhere) && (
        <AppWindow
          size={11}
          className="flex-shrink-0"
          aria-label="gruppo in una finestra sua"
          data-testid="space-title-detached"
        />
      )}
    </div>
  );
}
