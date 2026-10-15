import { useSyncExternalStore } from 'react';
import { loadSettings, SETTINGS_CHANGED_EVENT } from '../lib/settings';

function subscribe(onChange: () => void): () => void {
  window.addEventListener(SETTINGS_CHANGED_EVENT, onChange);
  // Another app window flipping the option.
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The `showLiveTerminals` option, live: flipping it from View shows or hides the menu at once. */
export function useShowLiveTerminals(): boolean {
  return useSyncExternalStore(subscribe, () => loadSettings().showLiveTerminals !== false);
}
