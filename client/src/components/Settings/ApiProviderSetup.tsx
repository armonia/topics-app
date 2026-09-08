import { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { ApiError, providersApi } from '../../lib/api';
import { API_PROVIDERS, type ApiProviderName } from './providerFormat';

/** An absent provider has a setup card, without invented status or models. */
export function ApiProviderSetup({ provider, expanded, onToggle, onSaved }: {
  provider: ApiProviderName;
  expanded: boolean;
  onToggle: () => void;
  onSaved: () => Promise<void>;
}) {
  const tr = useT();
  return (
    <div data-testid={`api-provider-setup-${provider}`} className="rounded-lg border border-app-border bg-app-hover/40">
      <button type="button" onClick={onToggle} aria-expanded={expanded}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left">
        {expanded ? <ChevronDown size={13} className="shrink-0 text-app-text-secondary" /> : <ChevronRight size={13} className="shrink-0 text-app-text-secondary" />}
        <span className="flex-1 text-[12px] font-semibold text-app-text">{API_PROVIDERS[provider].label}</span>
        <span className="text-[11px] text-app-text-secondary">{tr('ai.api.notConnected')}</span>
      </button>
      {expanded && <div className="space-y-2 border-t border-app-border px-3 pb-3 pt-2">
        <p className="text-[12px] text-app-text-secondary">{tr('ai.api.chat')}</p>
        <ApiKeyForm provider={provider} replacing={false} onSaved={onSaved} />
      </div>}
    </div>
  );
}

export function ApiKeyForm({ provider, replacing, onSaved }: {
  provider: ApiProviderName;
  replacing: boolean;
  onSaved: () => Promise<void>;
}) {
  const tr = useT();
  const id = useId();
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
      <label htmlFor={id} className="block text-[12px] text-app-text">
        {tr(replacing ? 'ai.api.replaceKey' : 'ai.api.key')} · {API_PROVIDERS[provider].label}
      </label>
      <div className="flex flex-wrap gap-2">
        <input
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
          className="flex-1 min-w-0 w-full px-2 py-1.5 coarse:min-h-11 rounded-md text-base sm:text-[12px] bg-surface border border-app-border text-app-text placeholder:text-app-text-muted focus:outline-none focus:border-primary"
        />
        <button type="submit" disabled={saving || !apiKey.trim()} className="px-3 py-1.5 coarse:min-h-11 rounded-md text-[12px] font-medium bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50">
          {tr(saving ? 'ai.api.connecting' : 'ai.api.connect')}
        </button>
      </div>
      <p id={`${id}-hint`} className="text-[11px] text-app-text-muted">{tr('ai.api.storage')}</p>
      {saved && <p role="status" className="text-[11px] text-app-text-secondary">{tr('ai.api.saved')}</p>}
      {error && <p role="alert" className="text-[11px] text-red-500 break-words">{error}</p>}
    </form>
  );
}
