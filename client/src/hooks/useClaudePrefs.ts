import { useCallback } from 'react';
import type { WSMessage } from '../types';
import { useServerState } from './useServerState';

export function useClaudeSkipPermissions(
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): [boolean, (v: boolean) => void] {
  const [value, setValue] = useServerState<boolean>('claude-prefs-skip', true, {
    localStorageKey: 'claude-skip-permissions',
    debounceMs: 300,
    onMessage,
  });

  const set = useCallback((v: boolean) => {
    setValue(v);
  }, [setValue]);

  return [value, set];
}
