import { useEffect } from 'react';

/**
 * Binds Cmd+Shift+. (macOS) / Ctrl+Shift+. (other) to the given callback.
 *
 * Dev-only tooling — the caller is expected to guard import of the overlay
 * behind an `import.meta.env.DEV` check so the hook is tree-shaken from
 * production bundles (PANE-05 strip contract).
 *
 * @param onChord callback invoked when the chord fires (takes no arguments)
 */
export function useKeyChord(onChord: () => void): void {
  useEffect(() => {
    function handler(e: KeyboardEvent): void {
      const isMac =
        typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && (e.key === '.' || e.key === '>')) {
        e.preventDefault();
        onChord();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onChord]);
}
