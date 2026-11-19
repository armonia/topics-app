/**
 * THE PROJECT'S OWN 24H QUOTA LIMIT (limiti-consumo-progetto, USAGE-29): a
 * small, native selector in the project's menu, next to (never inside) the
 * external hub's own section (`ProjectHubMenu`) — a project without the hub
 * still gets this one, since it has nothing to do with the hub's brake.
 *
 * `GET`/`POST /api/projects/quota-limit` are Topics' own route, not the
 * hub's `project-settings`: the value shown is read back after a write, same
 * discipline as the hub's own selector, so a refused write never looks saved.
 */
import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import PROJECT_QUOTA_IT from '../../lib/i18n-project-quota-it';
import PROJECT_QUOTA_EN from '../../lib/i18n-project-quota-en';
import { apiFetch } from '../../lib/shell/net';
import { POPOVER_DIVIDER, DANGER_TEXT } from '../../lib/popoverStyles';
import { Segmented } from '../Shared/Segmented';

addCatalogue('it', PROJECT_QUOTA_IT);
addCatalogue('en', PROJECT_QUOTA_EN);

/** The steps the selector offers, mirroring `server/routes/projects.ts:QUOTA_LIMIT_CHOICES`. */
const QUOTA_LIMIT_CHOICES: Array<number | null> = [null, 5, 10, 15, 20, 30];

export function ProjectQuotaMenu({ projectPath }: { projectPath: string }) {
  const tr = useT();
  const [limit, setLimit] = useState<number | null>(10);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/projects/quota-limit?path=${encodeURIComponent(projectPath)}`)
      .then((r) => r.json())
      .then((body: { limit: number | null }) => { if (!cancelled) setLimit(body.limit); })
      .catch(() => { /* keeps the default shown while offline; the next write still tries */ });
    return () => { cancelled = true; };
  }, [projectPath]);

  const write = async (next: number | null) => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await apiFetch('/api/projects/quota-limit', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: projectPath, limit: next }),
      });
      const body = (await r.json().catch(() => null)) as { limit?: number | null; error?: unknown } | null;
      if (!r.ok) { setFailed(typeof body?.error === 'string' ? body.error : `HTTP ${r.status}`); return; }
      setLimit(body?.limit ?? null);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 px-3 pb-1.5 pt-1">
      <div className={POPOVER_DIVIDER} />
      <span className="text-mini text-app-text-tertiary">{tr('projectQuota.limit')}</span>
      <Segmented
        value={limit === null ? 'none' : String(limit)}
        options={QUOTA_LIMIT_CHOICES.map((v) => (v === null ? { value: 'none', label: tr('projectQuota.limit.none') } : { value: String(v), label: String(v) }))}
        onChange={(v) => { void write(v === 'none' ? null : Number(v)); }}
        ariaLabel={tr('projectQuota.limit')}
        testId="project-quota-limit"
        disabled={busy}
      />
      {failed && (
        <div data-testid="project-quota-failed" className={`text-mini ${DANGER_TEXT}`}>
          {tr('projectQuota.failed', { why: failed })}
        </div>
      )}
    </div>
  );
}
