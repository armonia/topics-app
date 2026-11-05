/**
 * THE PROJECT ROW'S HUB DATA (hub-smistamento, HUBBR-16): what the usage hub
 * says of a project, on its sidebar row and in its menu.
 *
 * On the row, beside the name and outside the quiet rail: an amber dot when
 * the share of the week went past the budget you set, a pause when the hub's
 * brake holds the project, a clock when its jobs wait in the hub's line, each
 * with the reason as its tooltip. On hover the share of the week takes the
 * place of the quiet signals (the share in words), clear of the command
 * rail. In the menu: the same facts in words, and the priority and the budget,
 * written to the hub's `project-settings` and shown as the hub reads them back,
 * so a write that did not land does not look made.
 *
 * Nothing here exists for a project the hub does not recognise
 * (`matchHubProject`), nor where the hub is not part of the installation: the
 * caller mounts this chunk only once the hub was read. A hub that stops
 * answering drops its numbers (the live store keeps the error only), and the
 * row and the menu go back to what Topics alone shows.
 */
import { useState } from 'react';
import { Clock, Pause } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import PROJECT_HUB_IT from '../../lib/i18n-project-hub-it';
import PROJECT_HUB_EN from '../../lib/i18n-project-hub-en';
import { apiFetch } from '../../lib/shell/net';
import { refreshHubLive, useHubLive } from '../../state/hubLive';
import { POPOVER_DIVIDER, DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { Segmented } from '../Shared/Segmented';
import { PALLINO_ATTESA } from './chromeSignals';
import {
  HUB_PRIORITY_LEVELS, budgetChoices, matchHubProject, overBudget, projectSettingsBody, readHubProjects, weekShare,
  type HubPriority, type HubProject,
} from '../../lib/projectHub';

// The row's strings travel with its chunk, before its first render.
addCatalogue('it', PROJECT_HUB_IT);
addCatalogue('en', PROJECT_HUB_EN);

/**
 * Room the hint leaves on its right for the command rail that shows on hover:
 * the rail sits 2px from the edge with a 28px box per command, the row pads
 * 8px, and 4px keep the two apart. One command (archive) on a closed project,
 * two (add and archive) on an open one. index.css caps the name's width with
 * the same sums (78px closed, 106px open): change one, change the other.
 */
const railClear = (expanded: boolean): number => 28 * (expanded ? 2 : 1) + 2 + 4 - 8;

function useHubProject(projectPath: string): HubProject | null {
  const data = useHubLive().projects?.data;
  return data === undefined ? null : matchHubProject(readHubProjects(data), projectPath);
}

type Tr = ReturnType<typeof useT>;

function clock(at: number, locale: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** The state in words, or null when the hub holds nothing back. */
function holdWords(p: HubProject, tr: Tr, locale: string): string | null {
  if (p.hold === 'held') {
    const head = p.why ? tr('projectHub.held', { why: p.why }) : tr('projectHub.heldBare');
    return p.waitUntil !== null && p.waitUntil > Date.now() ? `${head} · ${tr('projectHub.until', { time: clock(p.waitUntil, locale) })}` : head;
  }
  if (p.hold === 'queued') return p.why ? tr('projectHub.queued', { why: p.why }) : tr('projectHub.queuedBare');
  return null;
}

function weekWords(p: HubProject, tr: Tr): string {
  return p.budgetPct !== null
    ? tr('projectHub.weekBudget', { pct: weekShare(p.total), cap: weekShare(p.budgetPct) })
    : tr('projectHub.week', { pct: weekShare(p.total) });
}

/** The row's signals and its hover hint; direct children of the row, so the row's CSS can trade them on hover. */
export function ProjectHubMark({ projectPath, expanded, onFill }: { projectPath: string; expanded: boolean; onFill: boolean }) {
  const tr = useT();
  const locale = useLocale();
  const p = useHubProject(projectPath);
  if (!p) return null;
  const over = overBudget(p);
  const hold = holdWords(p, tr, locale);
  const tone = onFill ? 'opacity-80' : '';
  return (
    <>
      {(over || hold) && (
        <span
          data-testid="project-hub-mark"
          data-hold={p.hold ?? undefined}
          data-over={over ? 'true' : undefined}
          className={`project-hub-signals flex flex-shrink-0 items-center gap-1.5 ${tone}`}
        >
          {over && (
            <span
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${PALLINO_ATTESA}`}
              title={`${tr('projectHub.over')}: ${weekWords(p, tr)}`}
              aria-label={tr('projectHub.over')}
            />
          )}
          {hold && (
            <span className="flex flex-shrink-0" title={hold} aria-label={hold} role="img">
              {p.hold === 'held'
                ? <Pause size={13} className={WARNING_TEXT} aria-hidden="true" />
                : <Clock size={13} className="text-app-text-tertiary" aria-hidden="true" />}
            </span>
          )}
        </span>
      )}
      <span
        data-testid="project-hub-week"
        className="project-hub-hint text-mini tabular-nums text-app-text-tertiary whitespace-nowrap"
        data-open={expanded ? '' : undefined}
        style={{ marginRight: railClear(expanded) }}
        title={[weekWords(p, tr), hold].filter(Boolean).join('\n')}
      >
        <span className="flex-shrink-0">{weekShare(p.total)}%</span>
        <span className="project-hub-hint-words">{'\u00a0'}{tr('projectHub.weekTail')}</span>
      </span>
    </>
  );
}

/** The menu's section: the facts in words, then the priority and the budget as the hub holds them. */
export function ProjectHubMenu({ projectPath }: { projectPath: string }) {
  const tr = useT();
  const locale = useLocale();
  const p = useHubProject(projectPath);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!p) return null;
  const hold = holdWords(p, tr, locale);

  const write = async (change: { priority: HubPriority } | { budgetPct: number | null }) => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await apiFetch('/api/hub/project-settings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: projectSettingsBody(p.name, change),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
        setFailed(typeof body?.error === 'string' ? body.error : `HTTP ${r.status}`);
      }
      // The choice shown is the hub's, read back: the bridge reads the hub again before it answers.
      await refreshHubLive();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const budgets = budgetChoices(p.budgetPct);
  return (
    <div data-testid="project-hub-menu" data-project-hub={p.name}>
      <div className={POPOVER_DIVIDER} />
      <div className="px-3 py-1.5 text-mini leading-snug text-app-text-secondary">
        <div data-testid="project-hub-menu-week" className={`tabular-nums ${overBudget(p) ? WARNING_TEXT : ''}`}>{weekWords(p, tr)}</div>
        {hold && <div data-testid="project-hub-menu-hold" className={p.hold === 'held' ? WARNING_TEXT : ''}>{hold}</div>}
      </div>
      <div className="flex flex-col gap-1 px-3 py-1">
        <span className="text-mini text-app-text-tertiary">{tr('projectHub.priority')}</span>
        <Segmented
          value={p.priority}
          options={HUB_PRIORITY_LEVELS.map((v) => ({ value: v, label: tr(`projectHub.priority.${v}`) }))}
          onChange={(v) => { void write({ priority: v }); }}
          ariaLabel={tr('projectHub.priority')}
          testId="project-hub-priority"
          disabled={busy}
        />
      </div>
      <div className="flex flex-col gap-1 px-3 pb-1.5 pt-1">
        <span className="text-mini text-app-text-tertiary">{tr('projectHub.budget')}</span>
        <Segmented
          value={p.budgetPct === null ? 'none' : String(p.budgetPct)}
          options={budgets.map((b) => ({ value: b === null ? 'none' : String(b), label: b === null ? tr('projectHub.budget.none') : tr('projectHub.budget.pct', { pct: b }) }))}
          onChange={(v) => { void write({ budgetPct: v === 'none' ? null : Number(v) }); }}
          ariaLabel={tr('projectHub.budget')}
          testId="project-hub-budget"
          disabled={busy}
        />
      </div>
      {failed && (
        <div data-testid="project-hub-menu-error" className={`px-3 pb-1.5 text-mini ${DANGER_TEXT}`}>
          {tr('projectHub.failed', { why: failed })}
        </div>
      )}
    </div>
  );
}
