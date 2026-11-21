import { ToggleRow } from './ToggleRow';
import { setReadableViewPrefs, useReadableViewPrefs } from '../../state/readableViewPrefs';
import { useT } from '@/hooks/useT';

/**
 * The switch (and the model) for the readable-view fallback: a cheap model that
 * lays out a tool result shape Topics has never seen. It names which fields to
 * show, never a value. Empty model = the server default.
 */
export function ReadableViewChoice() {
  const tr = useT();
  const prefs = useReadableViewPrefs();
  return (
    <div className="border-t border-app-border pt-2">
      <ToggleRow
        label={tr('settings.readableView.label')}
        description={tr('settings.readableView.blurb')}
        value={prefs.fallbackEnabled}
        onChange={(v) => setReadableViewPrefs({ fallbackEnabled: v })}
      />
      {prefs.fallbackEnabled && (
        <input
          data-testid="readable-view-model"
          aria-label={tr('settings.readableView.model')}
          placeholder="claude-haiku-5-5"
          value={prefs.model}
          onChange={(e) => setReadableViewPrefs({ model: e.target.value.trim() })}
          className="mt-1 w-full rounded border border-app-border bg-transparent px-2 py-1 text-mini font-mono text-app-text"
        />
      )}
    </div>
  );
}
