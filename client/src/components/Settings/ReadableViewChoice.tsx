import { useEffect, useState } from 'react';
import { ToggleRow } from './ToggleRow';
import { apiFetch } from '../../lib/shell/net';
import { useT } from '@/hooks/useT';

interface ServerSettings { fallbackEnabled: boolean; model: string }

/**
 * The switch (and the model) for the readable-view fallback: a cheap model that
 * lays out a tool result shape Topics has never seen, and phrases an unknown
 * tool name. It names which fields to show, never a value. Both live on the
 * server (`readable_view_settings`); empty model = the server default.
 */
export function ReadableViewChoice() {
  const tr = useT();
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  useEffect(() => {
    let live = true;
    apiFetch('/api/readable-view/settings')
      .then((r) => (r.ok ? (r.json() as Promise<ServerSettings>) : null))
      .then((s) => { if (live && s) setSettings(s); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  const save = (patch: Partial<ServerSettings>) => {
    setSettings((cur) => (cur ? { ...cur, ...patch } : cur));
    void apiFetch('/api/readable-view/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => undefined);
  };
  if (!settings) return null;
  return (
    <div className="border-t border-app-border pt-2">
      <ToggleRow
        label={tr('settings.readableView.label')}
        description={tr('settings.readableView.blurb')}
        value={settings.fallbackEnabled}
        onChange={(v) => save({ fallbackEnabled: v })}
      />
      {settings.fallbackEnabled && (
        <input
          data-testid="readable-view-model"
          aria-label={tr('settings.readableView.model')}
          placeholder="claude-haiku-5-5"
          defaultValue={settings.model}
          onBlur={(e) => { if (e.target.value.trim() !== settings.model) save({ model: e.target.value.trim() }); }}
          className="mt-1 w-full rounded border border-app-border bg-transparent px-2 py-1 text-mini font-mono text-app-text"
        />
      )}
    </div>
  );
}
