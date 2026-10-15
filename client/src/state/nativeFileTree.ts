import { useSyncExternalStore } from 'react';
import { loadSettings, saveSettings, SETTINGS_CHANGED_EVENT } from '../lib/settings';

function subscribe(listener: () => void): () => void {
  window.addEventListener(SETTINGS_CHANGED_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(SETTINGS_CHANGED_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

export function isNativeFileTreeEnabled(): boolean {
  return loadSettings().nativeFileTreeEnabled;
}

export function setNativeFileTreeEnabled(enabled: boolean): void {
  saveSettings({ ...loadSettings(), nativeFileTreeEnabled: enabled });
}

export function useNativeFileTreeEnabled(): boolean {
  return useSyncExternalStore(subscribe, isNativeFileTreeEnabled, () => true);
}
