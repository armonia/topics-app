import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { ApiError, providersApi } from '../../lib/api';
import { API_PROVIDERS, type ApiProviderName } from './providerFormat';

/**
 * The key field of an API provider: typed, verified by the server, saved. It
 * sits in the account's detail (model selector revision 2026-10-04, §5.5) and
 * in "+ API key"; "Add key ›" opens it with the focus on the field.
 */
export function ApiKeyForm({ provider, replacing, onSaved, autoFocus = false }: {
  provider: ApiProviderName;
  replacing: boolean;
  onSaved: () => Promise<void>;
  /** Take the focus once mounted: the door that opened the detail asked for the key. */
  autoFocus?: boolean;
}) {
  const tr = useT();
  const id = useId();
  const fieldRef = useRef<HTMLInputElement>(null);
  // One frame later: the level that holds the form is placed (and visible) then.
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => fieldRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async () => {
    if (saving || !apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (provider === 'claude') await providersApi.configureClaude(apiKey.trim());
      else await providersApi.configureOpenAI(apiKey.trim());
      setApiKey('');
      setSaved(true);
      await onSaved();
    } catch (err) {
      setError(tr(err instanceof ApiError && err.code === 'api_key_rejected' ? 'ai.api.keyRejected' : 'ai.api.saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form data-testid={`api-key-form-${provider}`} onSubmit={(event) => { event.preventDefault(); void submit(); }} className="space-y-1.5">
      <label htmlFor={id} className="block text-compact text-app-text">
        {tr(replacing ? 'ai.api.replaceKey' : 'ai.api.key')} · {API_PROVIDERS[provider].label}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          ref={fieldRef}
          id={id}
          type="password"
          autoComplete="new-password"
          autoCapitalize="none"
          spellCheck={false}
          disabled={saving}
          value={apiKey}
          onChange={(event) => { setApiKey(event.target.value); setSaved(false); }}
          placeholder={API_PROVIDERS[provider].placeholder}
          aria-describedby={`${id}-hint`}
          aria-invalid={error ? true : undefined}
          className="flex-1 min-w-0 w-full px-2 py-1.5 coarse:min-h-11 rounded-md text-title sm:text-compact bg-surface border border-app-border text-app-text placeholder:text-app-text-muted focus:outline-none focus:border-primary"
        />
        <button type="submit" disabled={saving || !apiKey.trim()} className="px-3 py-1.5 coarse:min-h-11 rounded-md text-compact font-medium bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50">
          {tr(saving ? 'ai.api.connecting' : 'ai.api.connect')}
        </button>
      </div>
      <p id={`${id}-hint`} className="text-mini text-app-text-muted">{tr('ai.api.storage')}</p>
      {saved && <p role="status" className="text-mini text-app-text-secondary">{tr('ai.api.saved')}</p>}
      {error && <p role="alert" className="text-mini text-red-500 break-words">{error}</p>}
    </form>
  );
}
