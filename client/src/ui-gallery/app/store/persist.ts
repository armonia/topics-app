/**
 * The state of the preview in localStorage, so a reload lands where the reader
 * left. A stored state of another version, or one that does not parse, is
 * dropped: the preview starts over rather than half-applying it.
 */
import { STATE_VERSION, initialState, type DemoState } from './state';

/** The key of the multi-organization preview; another edition (ORBIT alone) keeps its own. */
export const DEFAULT_STORAGE_KEY = 'topics-org-preview';

export function loadState(fresh: boolean, key = DEFAULT_STORAGE_KEY, persona?: string): DemoState {
  if (fresh) return initialState(persona);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return initialState(persona);
    const parsed = JSON.parse(raw) as DemoState;
    if (parsed?.version !== STATE_VERSION) return initialState(persona);
    return { ...initialState(persona), ...parsed };
  } catch {
    return initialState(persona);
  }
}

export function saveState(state: DemoState, key = DEFAULT_STORAGE_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* A full or blocked storage only costs the reload memory. */
  }
}
