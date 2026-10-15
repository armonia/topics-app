import { useSyncExternalStore } from 'react';
import { loadSettings, SETTINGS_CHANGED_EVENT } from '../lib/settings';

function subscribe(onChange: () => void): () => void {
  window.addEventListener(SETTINGS_CHANGED_EVENT, onChange);
  // Un'altra finestra dell'app che cambia l'opzione.
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** L'opzione `showLiveTerminals`, viva: cambiarla da Vista mostra o toglie la tendina subito. */
export function useShowLiveTerminals(): boolean {
  return useSyncExternalStore(subscribe, () => loadSettings().showLiveTerminals !== false);
}
