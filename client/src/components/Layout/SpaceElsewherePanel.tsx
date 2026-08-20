/**
 * «Questo gruppo è aperto in un'altra finestra».
 *
 * Un gruppo lo disegna UNA finestra sola. Senza questo pannello, staccare un
 * gruppo lasciava la finestra di partenza a disegnare le stesse tab: due
 * finestre, la stessa griglia, gli stessi terminali vivi in doppio — il
 * "la finestra è duplicata" che si vedeva al primo detach. Qui la griglia si
 * ferma e la finestra dice dov'è finito il gruppo, con le due sole cose che
 * hanno senso fare: andarci, o riprenderselo.
 *
 * Lo stato viene dalla PRESENZA (WS, `useSpaceWindows`), non da una variabile
 * locale: se quella finestra muore, il pannello sparisce da solo e la griglia
 * torna, senza nessuno da avvisare.
 */
import { AppWindow, CornerDownLeft } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { usePaneStore } from '../../state/pane/store';
import { closeSpaceWindow, focusSpaceWindow } from '../../lib/popOutSpace';
import { DEFAULT_SPACE_ID } from '../../state/pane/types';
import { DEFAULT_SPACE_LABEL, firstOtherLiveSpace } from './spaceHelpers';

interface Props {
  spaceId: string;
  /** L'etichetta della finestra che ospita il gruppo (dalla presenza). */
  windowLabel: string;
}

export function SpaceElsewherePanel({ spaceId, windowLabel }: Props) {
  const tr = useT();
  const dispatch = usePaneStore((s) => s.dispatch);
  const name = usePaneStore((s) =>
    spaceId === DEFAULT_SPACE_ID ? DEFAULT_SPACE_LABEL : (s.spaces[spaceId]?.name || 'Gruppo'),
  );

  return (
    // `bg-app-bg`: senza, si vedeva attraverso. La finestra è TRASPARENTE (la
    // vibrancy nativa passa nei buchi fra le card), e questo pannello prende il
    // posto della griglia, che lo sfondo lo dipinge da sé — quindi qui si vedeva
    // la scrivania sotto al testo.
    <div
      className="flex flex-1 flex-col items-center justify-center gap-3 bg-app-bg px-6 text-center"
      data-testid="space-elsewhere"
    >
      <AppWindow size={22} className="text-app-text-tertiary" aria-hidden="true" />
      <div className="text-[13px] text-app-text">
        <b>{name}</b> {tr('space.elsewhere')}
      </div>
      <div className="max-w-[380px] text-[12px] text-app-text-secondary">
        {tr('space.elsewhere.blurb')}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => { void focusSpaceWindow(windowLabel); }}
          className="rounded-md border border-app-border px-3 py-1.5 text-[12px] text-app-text transition-colors hover:bg-app-hover"
          data-testid="space-elsewhere-focus"
        >
          Portala davanti
        </button>
        <button
          onClick={() => {
            void closeSpaceWindow(windowLabel).then((closed) => {
              // Se la finestra non c'era più, la presenza lo scoprirà da sola:
              // qui basta non restare su un gruppo che nessuno disegna.
              if (!closed) {
                const next = firstOtherLiveSpace(usePaneStore.getState().spaces, spaceId);
                if (next) dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: next } });
              }
            });
          }}
          className="flex items-center gap-1.5 rounded-md border border-app-border px-3 py-1.5 text-[12px] text-app-text transition-colors hover:bg-app-hover"
          data-testid="space-elsewhere-reattach"
        >
          <CornerDownLeft size={13} />
          Riporta qui
        </button>
      </div>
    </div>
  );
}
