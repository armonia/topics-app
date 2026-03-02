import { useState, useCallback } from 'react';

const STORAGE_KEY = 'claude-skip-permissions';

function getStored(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === 'true'; // default true
  } catch {
    return true;
  }
}

export function useClaudeSkipPermissions(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(getStored);

  const set = useCallback((v: boolean) => {
    setValue(v);
    try { localStorage.setItem(STORAGE_KEY, String(v)); } catch {}
  }, []);

  return [value, set];
}
