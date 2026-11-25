/**
 * THE WEEKLY QUOTA BY PROJECT, on the Dashboard's usage section: for each
 * project the points of the last 24 hours and 7 days, its limit, where the
 * points went (card, chat, their subagents, single calls, outside Topics) and,
 * on request, the heaviest chats.
 *
 * Not the token table below it: that one is tokens and dollars of Topics' own
 * chats and board, this one is the share of the account's weekly quota, read
 * from the quota history. Two units, two tables.
 */
import { useState } from 'react';
import { ChevronRight, FolderGit2 } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useProjectQuota } from '../../hooks/useProjectQuota';
import { formatPoints, quotaTone, type QuotaTone } from '../../lib/projectQuotaMeter';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { QUOTA_SURFACES, type ProjectQuotaRow } from '../../../../shared/usage-shapes';


const TONE_INK: Record<QuotaTone, string> = { ok: 'text-app-text', warn: WARNING_TEXT, over: DANGER_TEXT };

const points = (v: number | null) => (v === null ? '-' : formatPoints(v));

/** The folder's last segment: what a person calls the project. */
function projectName(row: ProjectQuotaRow, outside: string): string {
  if (row.projectId === null) return outside;
  const parts = (row.projectPath ?? row.projectId).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || row.projectId;
}

export function ProjectQuotaTable() {
  const tr = useT();
  const { quota, error } = useProjectQuota();
  const [open, setOpen] = useState<string | null>(null);

  if (!quota) {
    return error ? <div data-testid="project-quota-unavailable" className="px-1 py-2 text-app-text-secondary">{tr('projectQuota.unavailable')}</div> : null;
  }
  const rows = quota.projects.filter((p) => p.projectId === null ? (p.points7d ?? p.weighted7d) > 0 : true);

  return (
    <div data-testid="project-quota-table" className="mb-2 border-b border-app-border pb-2">
      <div className="px-1 pb-1 text-mini font-medium text-app-text">{tr('projectQuota.title')}</div>
      {!quota.quotaHistory && <div className="px-1 pb-1 text-mini text-app-text-secondary">{tr('projectQuota.noHistory')}</div>}
      <div className="flex items-center gap-2 px-1 pb-1 text-mini uppercase tracking-wide text-app-text-faint">
        <span className="min-w-0 flex-1">{tr('projectQuota.col.project')}</span>
        <span className="w-14 flex-shrink-0 text-right">{tr('projectQuota.col.day')}</span>
        <span className="w-12 flex-shrink-0 text-right">{tr('projectQuota.col.week')}</span>
        <span className="w-12 flex-shrink-0 text-right">{tr('projectQuota.col.limit')}</span>
      </div>
      {rows.map((p) => {
        const key = p.projectId ?? 'outside';
        const tone = quotaTone(p.points24h, p.limit);
        const expanded = open === key;
        const where = QUOTA_SURFACES.filter((s) => (p.surfaces[s].points24h ?? 0) > 0)
          .map((s) => `${tr(`projectQuota.surface.${s}`)} ${points(p.surfaces[s].points24h)}`).join(' · ');
        return (
          <div key={key} data-testid="project-quota-row" data-tone={tone}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : key)}
              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-app-hover"
              title={p.projectPath ?? undefined}
            >
              <ChevronRight size={11} className={`flex-shrink-0 text-app-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
              <FolderGit2 size={11} className="flex-shrink-0 text-app-text-muted" />
              <span className="min-w-0 flex-1 truncate text-app-text">{projectName(p, tr('projectQuota.outside'))}</span>
              <span data-testid="project-quota-day" className={`w-14 flex-shrink-0 text-right tabular-nums ${TONE_INK[tone]}`}>{points(p.points24h)}</span>
              <span className="w-12 flex-shrink-0 text-right tabular-nums text-app-text-secondary">{points(p.points7d)}</span>
              <span className="w-12 flex-shrink-0 text-right tabular-nums text-app-text-secondary">{p.limit === null ? tr('projectQuota.noLimit') : p.limit}</span>
            </button>
            {expanded && (
              <div data-testid="project-quota-detail" className="mb-1 ml-5 flex flex-col gap-0.5 text-mini text-app-text-secondary">
                <div>{tr('projectQuota.col.surfaces')}: {where || '-'}</div>
                {p.topChats.length > 0 && (
                  <>
                    <div className="text-app-text-faint">{tr('projectQuota.topChats')}</div>
                    {p.topChats.map((c) => (
                      <div key={c.topicId} className="truncate">{tr('projectQuota.chatRow', { title: c.title, day: points(c.points24h), week: points(c.points7d) })}</div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
