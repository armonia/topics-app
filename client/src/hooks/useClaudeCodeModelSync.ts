/**
 * useClaudeCodeModelSync — re-applies the user's saved Claude Code model
 * choice on app startup.
 *
 * The server falls back to env `CLAUDE_CODE_MODEL` (or the provider default)
 * on each cold start, so a fresh boot loses the in-settings selection. We
 * persist the choice in localStorage and, once the snapshot reports
 * claude-code as ready, push the saved model back to the server if it differs
 * from what the snapshot currently has at `models[0]`.
 *
 * Runs once per snapshot load — no polling, no re-applying after the first
 * sync — to avoid killing live CLI processes whenever the snapshot pushes.
 */
import { useEffect, useRef } from 'react';
import { providersApi } from '../lib/api';
import { useProvidersSnapshot } from './useProvidersSnapshot';

const STORAGE_KEY = 'claude-code-model';

export function useClaudeCodeModelSync(): void {
  const { snapshot } = useProvidersSnapshot();
  const synced = useRef(false);

  useEffect(() => {
    if (synced.current || !snapshot) return;
    const cc = snapshot.providers.find((p) => p.name === 'claude-code');
    if (!cc || cc.status !== 'ready') return;
    let saved: string | null = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch {}
    if (!saved) {
      synced.current = true;
      return;
    }
    // listModels reorders so models[0] is the current configured choice — if
    // it already matches, nothing to do.
    if (cc.models[0] === saved) {
      synced.current = true;
      return;
    }
    synced.current = true;
    providersApi.configureClaudeCode(saved).catch(() => {
      // Fail silently — the user can re-pick from settings if the bind fails.
    });
  }, [snapshot]);
}
