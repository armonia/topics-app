/**
 * THE PROJECT'S OWN 24H QUOTA LIMIT (project quota, USAGE-29): a
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
import { refreshProjectQuota } from '../../hooks/useProjectQuota';
import { apiFetch } from '../../lib/shell/net';
import { POPOVER_DIVIDER, DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { Segmented } from '../Shared/Segmented';
import { QUOTA_LIMIT_CHOICES } from '../../../../shared/usage-shapes';



export function ProjectQuotaMenu({ projectPath }: { projectPath: string }) {
  const tr = useT();
  // `undefined` = not known: still reading, or the read failed. Never the default
  // in disguise: a menu that shows 10 while the server said nothing lies.
  const [limit, setLimit] = useState<number | null | undefined>(undefined);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLimit(undefined);
    setReadFailed(false);
    apiFetch(`/api/projects/quota-limit?path=${encodeURIComponent(projectPath)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((body: { limit: number | null }) => { if (!cancelled) setLimit(body.limit); })
      .catch(() => { if (!cancelled) setReadFailed(true); });
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
      setReadFailed(false);
      refreshProjectQuota();
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
        value={limit === null ? 'none' : String(limit ?? 'none')}
        unset={limit === undefined}
        options={QUOTA_LIMIT_CHOICES.map((v) => (v === null ? { value: 'none', label: tr('projectQuota.limit.none') } : { value: String(v), label: String(v) }))}
        onChange={(v) => { void write(v === 'none' ? null : Number(v)); }}
        ariaLabel={tr('projectQuota.limit')}
        testId="project-quota-limit"
        disabled={busy}
      />
      {readFailed && limit === undefined && (
        <div data-testid="project-quota-unknown" className={`text-mini ${WARNING_TEXT}`}>
          {tr('projectQuota.limit.unknown')}
        </div>
      )}
      {failed && (
        <div data-testid="project-quota-failed" className={`text-mini ${DANGER_TEXT}`}>
          {tr('projectQuota.failed', { why: failed })}
        </div>
      )}
    </div>
  );
}
