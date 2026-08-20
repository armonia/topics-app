import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { ShieldCheck, Trash2, Loader2 } from 'lucide-react';
import { toolGrantsApi, type ToolGrant } from '../../lib/api';

/**
 * Gli strumenti a cui hai detto «Consenti sempre», e il gesto per ritirarlo.
 *
 * Esiste per lo stesso motivo dell'elenco dei dispositivi: un permesso
 * permanente che non si può rileggere né togliere è una porta che si apre e
 * basta. E qui il rischio è specifico — «Consenti sempre» si preme dentro una
 * chat, di corsa, mentre si sta facendo altro; se poi non c'è nessun posto dove
 * ritrovare quella decisione, l'unica cosa che resta è il ricordo di averla
 * presa.
 *
 * A differenza dei dispositivi, qui una riga revocata SPARISCE: non è una
 * cronologia di accessi, è l'elenco di ciò che vale ADESSO — e una regola
 * barrata in mezzo alle altre si rilegge come una regola.
 */
export function PermissionsSection() {
  const tr = useT();
  const [grants, setGrants] = useState<ToolGrant[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setGrants(await toolGrantsApi.list());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'non è stato possibile leggere le regole');
      setGrants([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function revoke(pattern: string) {
    setBusy(pattern);
    try {
      setGrants(await toolGrantsApi.remove(pattern));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'revoca non riuscita');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="settings-permissions">
      <div>
        <h3 className="text-[13px] font-medium text-app-text mb-1">{tr('perms.title')}</h3>
        <p className="text-[12px] leading-snug text-app-text-muted">
          {tr('perms.blurb')}
        </p>
      </div>

      {error && (
        <div className="text-[12px] text-red-500 bg-red-500/5 rounded px-2 py-1.5">{error}</div>
      )}

      {grants === null ? (
        <div className="flex items-center gap-2 text-[12px] text-app-text-muted">
          <Loader2 size={13} className="animate-spin" /> {tr('common.loading')}
        </div>
      ) : grants.length === 0 ? (
        <div className="text-[12px] text-app-text-muted border border-dashed border-app-border rounded-md px-3 py-4 text-center">
          {tr('perms.empty')}
        </div>
      ) : (
        <ul className="space-y-1" data-testid="tool-grant-list">
          {grants.map((g) => (
            <li
              key={g.pattern}
              className="flex items-center gap-2 rounded-md border border-app-border px-2.5 py-2"
              data-testid={`tool-grant-${g.pattern}`}
            >
              <ShieldCheck size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12px] text-app-text">{g.pattern}</div>
                <div className="text-[11px] text-app-text-muted">
                  consentito il {new Date(g.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void revoke(g.pattern)}
                disabled={busy === g.pattern}
                title={tr('perms.revoke')}
                data-testid={`tool-grant-revoke-${g.pattern}`}
                className="shrink-0 rounded p-1.5 text-app-text-muted hover:bg-app-hover hover:text-red-500 disabled:opacity-40 transition-colors"
              >
                {busy === g.pattern ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
