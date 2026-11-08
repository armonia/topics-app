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

export function isNativeGitStatusEnabled(): boolean {
  return loadSettings().nativeGitStatusEnabled;
}

export function setNativeGitStatusEnabled(enabled: boolean): void {
  saveSettings({ ...loadSettings(), nativeGitStatusEnabled: enabled });
}

export function useNativeGitStatusEnabled(): boolean {
  return useSyncExternalStore(subscribe, isNativeGitStatusEnabled, () => true);
}
