/**
 * THE PROJECT ROW'S HUB DATA (hub-smistamento, HUBBR-16): what the usage hub
 * says of a project, on its sidebar row and in its menu.
 *
 * On the row, beside the name and outside the quiet rail: an arrow when the
 * priority is not normal, an amber dot when the Claude share of the week
 * reached the budget you set, then the state as the hub's own row says it:
 * agents at work outside Topics first (the brake holds new jobs, not running
 * ones; Topics' own chats have the row's loader), else a pause when the hub's
 * brake holds the project, a clock when its jobs wait in the hub's line, each
 * with the reason as its tooltip. On hover the share of the week takes the
 * place of the quiet signals, clear of the command rail: the number always,
 * its words only when they fit whole (never a half word), the full sentence in
 * the tooltip. In the menu: what the project is, the share of the week per
 * provider, the state in words (held with the hub's short reason and the day
 * it lets go, or idle since when and by whom last), the live agents
 * (ProjectHubAgents), and the priority and the budget,
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
import { ArrowDown, ArrowUp, Bot, Clock, Pause } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import PROJECT_HUB_IT from '../../lib/i18n-project-hub-it';
import PROJECT_HUB_EN from '../../lib/i18n-project-hub-en';
import { apiFetch } from '../../lib/shell/net';
import { refreshHubLive, useHubLive } from '../../state/hubLive';
import { POPOVER_DIVIDER, DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { Segmented } from '../Shared/Segmented';
import { PALLINO_ATTESA } from './chromeSignals';
import { ProjectHubAgents, spanWords } from './ProjectHubAgents';
import {
  HUB_PRIORITY_LEVELS, PROVIDER_NAMES, budgetChoices, holdWhy, matchHubProject, overBudget, projectSettingsBody, providerShares, readHubProjects,
  restartParts, shownShare, weekShare, working, workingOutside,
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

function untilWords(at: number, tr: Tr, locale: string): string {
  const { day, time } = restartParts(at, Date.now(), locale);
  return day ? tr('projectHub.untilDay', { day, time }) : tr('projectHub.until', { time });
}

/** The state in words, or null when the hub holds nothing back. */
function holdWords(p: HubProject, tr: Tr, locale: string): string | null {
  const { byBudget, why, waits } = holdWhy(p);
  if (p.hold === 'held') {
    const reason = waits.length ? tr('projectHub.waitsFor', { who: waits.join(', ') }) : why;
    const head = byBudget ? tr('projectHub.heldBudget') : reason ? tr('projectHub.held', { why: reason }) : tr('projectHub.heldBare');
    return p.waitUntil !== null && p.waitUntil > Date.now() ? `${head} \u00b7 ${untilWords(p.waitUntil, tr, locale)}` : head;
  }
  if (p.hold === 'queued') return why ? tr('projectHub.queued', { why }) : tr('projectHub.queuedBare');
  return null;
}

/** Agents at work, in words. */
function agentsWords(n: number, tr: Tr): string {
  return n === 1 ? tr('projectHub.agentsOne') : tr('projectHub.agents', { n });
}

/** A project nobody works on: since when, and who was last, as the hub's row says it. */
function idleWords(p: HubProject, tr: Tr, locale: string): string | null {
  if (working(p) > 0 || p.hold !== null) return null;
  if (!p.lastSeen) return tr('projectHub.idleLong');
  const day = new Date(p.lastSeen.at).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  return tr('projectHub.idle', { t: spanWords(tr, Date.now() - p.lastSeen.at), day, who: PROVIDER_NAMES[p.lastSeen.provider] ?? p.lastSeen.provider });
}

function weekWords(p: HubProject, tr: Tr): string {
  return p.budgetPct !== null
    ? tr('projectHub.weekBudget', { pct: weekShare(p.claude), cap: weekShare(p.budgetPct) })
    : tr('projectHub.week', { pct: weekShare(p.total) });
}

/** The row's signals and its hover hint; direct children of the row, so the row's CSS can trade them on hover. */
export function ProjectHubMark({ projectPath, expanded, onFill }: { projectPath: string; expanded: boolean; onFill: boolean }) {
  const tr = useT();
  const locale = useLocale();
  const p = useHubProject(projectPath);
  if (!p) return null;
  const over = overBudget(p);
  const busy = working(p);
  // Agents at work come before the brake, as on the hub's row: it holds new jobs, not the running ones.
  const hold = busy > 0 ? null : holdWords(p, tr, locale);
  const outside = workingOutside(p);
  const priority = p.priority === 'normale' ? null : tr(`projectHub.priorityIs.${p.priority}`);
  const tone = onFill ? 'opacity-80' : '';
  return (
    <>
      {(over || hold || outside > 0 || priority) && (
        <span
          data-testid="project-hub-mark"
          data-hold={p.hold && hold ? p.hold : undefined}
          data-over={over ? 'true' : undefined}
          data-working={busy > 0 ? String(busy) : undefined}
          className={`project-hub-signals flex flex-shrink-0 items-center gap-1.5 ${tone}`}
        >
          {priority && (
            <span data-testid="project-hub-priority-mark" data-priority={p.priority} className="flex flex-shrink-0" title={priority} aria-label={priority} role="img">
              {p.priority === 'alta'
                ? <ArrowUp size={12} className={WARNING_TEXT} aria-hidden="true" />
                : <ArrowDown size={12} className="text-app-text-tertiary" aria-hidden="true" />}
            </span>
          )}
          {over && (
            <span
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${PALLINO_ATTESA}`}
              title={`${tr('projectHub.over')}: ${weekWords(p, tr)}`}
              aria-label={tr('projectHub.over')}
            />
          )}
          {outside > 0 && (
            <span data-testid="project-hub-working" className="flex flex-shrink-0 items-center gap-0.5 text-mini tabular-nums text-app-text-secondary" title={agentsWords(busy, tr)} aria-label={agentsWords(busy, tr)} role="img">
              <Bot size={12} aria-hidden="true" />
              <span aria-hidden="true">{outside}</span>
            </span>
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
        title={[weekWords(p, tr), busy > 0 ? agentsWords(busy, tr) : hold ?? idleWords(p, tr, locale)].filter(Boolean).join('\n')}
      >
        <span className="flex-shrink-0">{weekShare(shownShare(p))}%</span>
        <span className="project-hub-hint-words">{'\u00a0'}{tr(p.budgetPct !== null ? 'projectHub.weekTailClaude' : 'projectHub.weekTail')}</span>
      </span>
    </>
  );
}

/** A share of the week on the menu's provider line: the bar of Consumi, the cap's tick on the Claude line. */
function ShareLine({ provider, pct, cap, hot }: { provider: 'claude' | 'codex' | 'muse'; pct: number; cap: number | null; hot: boolean }) {
  return (
    <div data-testid={`project-hub-share-${provider}`} className="flex h-4 items-center gap-2 tabular-nums">
      <span className="w-11 flex-none text-mini text-app-text-tertiary">{PROVIDER_NAMES[provider]}</span>
      <span className="relative h-1.5 min-w-0 flex-1 rounded-full bg-app-hover">
        <i className={`block h-full rounded-full ${hot ? 'bg-amber-500 dark:bg-amber-400' : 'bg-primary'}`} style={{ width: `${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}%` }} />
        {cap !== null && <u aria-hidden="true" className="absolute -top-[3px] h-3 w-0.5 rounded-[1px] bg-app-text-secondary" style={{ left: `${Math.min(100, cap)}%` }} />}
      </span>
      <span className={`w-8 flex-none text-right text-mini ${hot ? WARNING_TEXT : 'text-app-text-secondary'}`}>{weekShare(pct)}%</span>
    </div>
  );
}

/** The menu's section: the facts in words, then the priority and the budget as the hub holds them. */
export function ProjectHubMenu({ projectPath, onClose }: { projectPath: string; onClose?: () => void }) {
  const tr = useT();
  const locale = useLocale();
  const p = useHubProject(projectPath);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (!p) return null;
  const hold = holdWords(p, tr, locale);
  const idle = idleWords(p, tr, locale);
  const over = overBudget(p);

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
    <div data-testid="project-hub-menu" data-project-hub={p.name} className="w-[268px] max-w-full">
      <div className={POPOVER_DIVIDER} />
      <div className="flex flex-col gap-1 px-3 py-1.5 text-mini leading-snug text-app-text-secondary">
        {p.what && <div data-testid="project-hub-menu-what" className="line-clamp-2 text-app-text-tertiary" title={p.what}>{p.what}</div>}
        <div data-testid="project-hub-menu-week" className={`tabular-nums ${over ? WARNING_TEXT : ''}`}>{weekWords(p, tr)}</div>
        {providerShares(p).length > 0 && (
          <div data-testid="project-hub-shares" className="flex flex-col gap-0.5">
            {providerShares(p).map((s) => (
              <ShareLine key={s.provider} provider={s.provider} pct={s.pct} cap={s.provider === 'claude' ? p.budgetPct : null} hot={s.provider === 'claude' && over} />
            ))}
          </div>
        )}
        {hold && <div data-testid="project-hub-menu-hold" className={p.hold === 'held' ? WARNING_TEXT : ''}>{hold}</div>}
        {idle && <div data-testid="project-hub-menu-idle">{idle}</div>}
        {p.dirMissing && <div data-testid="project-hub-menu-gone" className="text-app-text-tertiary">{tr('projectHub.dirMissing')}</div>}
      </div>
      <ProjectHubAgents p={p} onOpened={onClose} />
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
        <span data-testid="project-hub-budget-hint" className="text-mini leading-snug text-app-text-tertiary">{tr('projectHub.budgetHint')}</span>
      </div>
      {failed && (
        <div data-testid="project-hub-menu-error" className={`px-3 pb-1.5 text-mini ${DANGER_TEXT}`}>
          {tr('projectHub.failed', { why: failed })}
        </div>
      )}
    </div>
  );
}
