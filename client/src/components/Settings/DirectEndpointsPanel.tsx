import { useId, useState } from 'react';
import { useT } from '../../hooks/useT';
import { ApiError, providersApi } from '../../lib/api';

/**
 * The endpoints somebody runs themselves: a llama-server on the LAN, an
 * inference box, a gateway. Each saved one is a provider (`direct-<id>`) and a
 * card of the providers level, whose detail shows its URL and removes it
 * (model selector revision 2026-10-04, §5.5); this is the form behind
 * «+ Endpoint».
 *
 * Two things this form does that the API-key forms do not. It TESTS before it
 * saves, so a wrong port is a sentence under the field instead of a provider
 * that fails at the first message. And it never renders a token it did not
 * just receive from the person typing: what the server sends back is
 * `hasToken`, so an endpoint reopened for editing shows an empty password
 * field with "already set" next to it.
 */
/** The add form. Test is optional, but saving runs the same probe anyway. */
export function EndpointForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => Promise<void> }) {
  const tr = useT();
  const id = useId();
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[] | null>(null);

  const payload = () => ({
    label: label.trim(),
    baseUrl: baseUrl.trim(),
    auth: token.trim() ? ('bearer' as const) : ('none' as const),
    ...(token.trim() ? { token: token.trim() } : {}),
  });

  const run = async (action: 'test' | 'save') => {
    if (busy || !label.trim() || !baseUrl.trim()) return;
    setBusy(true);
    setError(null);
    setModels(null);
    try {
      if (action === 'test') {
        const result = await providersApi.testEndpoint(payload());
        if (!result.ok) setError(result.error ?? tr('ai.endpoints.unreachable'));
        else setModels(result.models);
        return;
      }
      await providersApi.saveEndpoint(payload());
      await onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : tr('ai.endpoints.unreachable'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="direct-endpoint-form" className="space-y-2 rounded-lg border border-app-border bg-app-hover/40 px-3 py-2.5">
      <label className="block text-mini text-app-text-secondary" htmlFor={`${id}-label`}>
        {tr('ai.endpoints.label')}
      </label>
      <input
        id={`${id}-label`}
        data-testid="direct-endpoint-label"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder={tr('ai.endpoints.labelPlaceholder')}
        className="w-full rounded-md border border-app-border bg-surface px-2 py-1.5 text-compact text-app-text"
      />

      <label className="block text-mini text-app-text-secondary" htmlFor={`${id}-url`}>
        {tr('ai.endpoints.url')}
      </label>
      <input
        id={`${id}-url`}
        data-testid="direct-endpoint-url"
        value={baseUrl}
        onChange={(event) => setBaseUrl(event.target.value)}
        placeholder="http://127.0.0.1:18080/v1"
        className="w-full rounded-md border border-app-border bg-surface px-2 py-1.5 font-mono text-compact text-app-text"
      />

      <label className="block text-mini text-app-text-secondary" htmlFor={`${id}-token`}>
        {tr('ai.endpoints.token')}
      </label>
      <input
        id={`${id}-token`}
        data-testid="direct-endpoint-token"
        type="password"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder={tr('ai.endpoints.tokenPlaceholder')}
        className="w-full rounded-md border border-app-border bg-surface px-2 py-1.5 text-compact text-app-text"
      />

      {error && (
        <p data-testid="direct-endpoint-error" className="text-mini text-amber-300">{error}</p>
      )}
      {models && (
        <p data-testid="direct-endpoint-models" className="text-mini text-emerald-400">
          {tr('ai.endpoints.reachable', { n: String(models.length) })}
        </p>
      )}

      <div className="flex gap-2 pt-0.5">
        <button
          type="button"
          data-testid="direct-endpoint-test"
          disabled={busy || !label.trim() || !baseUrl.trim()}
          onClick={() => { void run('test'); }}
          className="min-h-11 rounded-md border border-app-border px-2.5 py-1.5 text-compact text-app-text hover:bg-app-hover disabled:opacity-40"
        >
          {tr('ai.endpoints.test')}
        </button>
        <button
          type="button"
          data-testid="direct-endpoint-save"
          disabled={busy || !label.trim() || !baseUrl.trim()}
          onClick={() => { void run('save'); }}
          className="min-h-11 flex-1 rounded-md bg-primary px-2.5 py-1.5 text-compact font-medium text-white disabled:opacity-40"
        >
          {tr('ai.endpoints.save')}
        </button>
        <button
          type="button"
          data-testid="direct-endpoint-cancel"
          onClick={onCancel}
          className="min-h-11 rounded-md px-2.5 py-1.5 text-compact text-app-text-secondary hover:bg-app-hover"
        >
          {tr('ai.endpoints.cancel')}
        </button>
      </div>
    </div>
  );
}
