/**
 * The facts of one automation, in its detail: when it runs and what it does,
 * the next and the last run, the runs of today and the last twenty as ticks
 * with how many went well, what it costs, whether the last message reached
 * you, the outside proof of a run, what you could lose if it breaks, who runs
 * it, what it writes to you and its area.
 *
 * And the technical details behind a fold: the system, the schedule, the exit
 * code, the sources fused into the row, the exact command or prompt, and the
 * run on GitHub.
 */
import { ChevronRight, ExternalLink } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { DANGER_TEXT } from '../../lib/popoverStyles';
import { noIds } from '../../lib/automationGraph';
import { usageTotal } from '../../lib/automationsHead';
import { systemOf, type AutomationRow } from '../../lib/automations';
import { durationWords, providerName, tokenWords, type Clock } from './automationsUi';

const DT = 'text-app-text-muted';
const DD = 'm-0 text-app-text-body';

function Ticks({ row }: { row: AutomationRow }) {
  const tr = useT();
  const h = [...row.history].reverse();
  if (h.length < 2) return null;
  const bad = h.filter((x) => x.outcome === 'error').length;
  return (
    <span className="inline-flex items-center gap-2" data-testid="automation-ticks">
      <span className="inline-flex gap-[2px]" aria-hidden="true">
        {h.map((x, i) => (
          <i key={i} className={`h-2.5 w-1.5 rounded-[1px] ${x.outcome === 'error' ? 'bg-red-500 dark:bg-red-400' : x.outcome === 'ok' ? 'bg-emerald-500/75 dark:bg-emerald-400/70' : 'bg-app-text-faint/50'}`} />
        ))}
      </span>
      <span className={`tabular-nums ${bad ? DANGER_TEXT : ''}`}>{tr('auto.facts.ticks', { ok: h.length - bad, n: h.length })}</span>
    </span>
  );
}

export function Facts({ row, now, clock }: { row: AutomationRow; now: number; clock: Clock }) {
  const tr = useT();
  const locale = useLocale();
  const l = row.last;
  const u = row.usage;
  const usage = !u ? null : u.kind === 'script' ? tr('auto.usage.script') : u.kind === 'unmeasured' ? tr('auto.usage.unmeasured')
    : tr('auto.facts.usage', { d7: tokenWords(usageTotal(u), locale), d1: tokenWords(usageTotal(u, 'd1'), locale), who: Object.keys(u.d7).map(providerName).join(', ') });
  // The proof already worded in the reason of a broken row is not said twice.
  const proof = row.proof && !(row.proof.ok === false && row.reason?.includes(row.proof.words)) ? row.proof : null;
  const fact = (label: string, value: React.ReactNode, testId?: string, cls = '') => (
    <><dt className={DT}>{label}</dt><dd className={`${DD} ${cls}`} data-testid={testId}>{value}</dd></>
  );
  return (
    <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-mini" data-testid="automation-facts">
      {row.when && fact(tr('auto.facts.when'), row.when)}
      {row.what && fact(tr('auto.facts.what'), row.what)}
      {row.next !== null && row.next > now && row.enabled !== false && fact(
        tr('auto.facts.next'),
        tr(row.nextApprox ? 'auto.facts.nextApprox' : 'auto.facts.nextIn', { time: clock.dayTime(row.next), dur: durationWords(row.next - now, tr) }),
        'automation-fact-next', 'tabular-nums',
      )}
      {row.votable && fact(
        tr('auto.facts.last'),
        l.at === null ? tr(l.outcome ? 'auto.facts.lastNoTime' : 'auto.facts.lastNever', { outcome: tr(`auto.run.${l.outcome ?? 'skipped'}`) })
          : `${clock.dayTime(l.at)}, ${tr(`auto.run.${l.outcome ?? 'skipped'}`)}`,
        'automation-fact-last', 'tabular-nums',
      )}
      {row.votable && fact(tr('auto.facts.today'), row.runsToday, undefined, 'tabular-nums')}
      {row.history.length >= 2 && fact(tr('auto.facts.recent'), <Ticks row={row} />)}
      {usage && fact(tr('auto.facts.cost'), usage, 'automation-fact-usage')}
      {row.delivered && fact(tr('auto.facts.delivered'), tr(row.delivered === 'delivered' ? 'auto.facts.deliveredOk' : 'auto.facts.deliveredFailed'), 'automation-fact-delivered', row.delivered === 'failed' ? DANGER_TEXT : '')}
      {proof && fact(tr('auto.facts.proof'), proof.words, 'automation-fact-proof', proof.ok === false ? DANGER_TEXT : '')}
      {row.votable && row.area && fact(tr('auto.facts.ifBroken'), row.ifBroken ? noIds(row.ifBroken) : tr('auto.facts.notWritten'), 'automation-fact-ifbroken', row.ifBroken ? '' : 'text-app-text-faint')}
      {row.who && fact(tr('auto.facts.who'), noIds(row.who), 'automation-fact-who')}
      {row.means && fact(tr('auto.facts.means'), noIds(row.means), 'automation-fact-means')}
      {row.area && fact(tr('auto.facts.area'), tr(`auto.area.${row.area}`))}
    </dl>
  );
}

const ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function TechPart({ row, part, partTitle }: { row: AutomationRow; part: string; partTitle: string }) {
  const tr = useT();
  const t = row.tech;
  const cmd = t.command ?? t.prompt;
  return (
    <details className={`${part} group`} data-testid="automation-tech">
      <summary className={`${partTitle} mb-0 cursor-pointer list-none group-open:mb-2`}>
        <ChevronRight size={12} className="group-open:rotate-90" aria-hidden="true" />{tr('auto.tech.title')}
      </summary>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-mini">
        <dt className={DT}>{tr('auto.tech.system')}</dt><dd className={DD}>{row.where ?? tr(`auto.source.${row.system}`)}</dd>
        {t.schedule && <><dt className={DT}>{tr('auto.facts.when')}</dt><dd className={`${DD} font-mono`}>{t.schedule}</dd></>}
        {row.last.exit !== null && <><dt className={DT}>{tr('auto.tech.exit')}</dt><dd className={`${DD} tabular-nums`} data-testid="automation-tech-exit">{tr('auto.tech.code', { n: row.last.exit })}</dd></>}
        {row.sources.length > 1 && (
          <><dt className={DT}>{tr('auto.tech.sources')}</dt><dd className={DD}>{row.sources.map((s, i) => {
            const system = systemOf(s);
            return <span key={`${s}-${i}`} className="block">{system ? tr(`auto.source.${system}`) : s}</span>;
          })}</dd></>
        )}
      </dl>
      {cmd && (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-app-border-subtle bg-app-inset p-2 font-mono text-mini text-app-text-body" data-testid="automation-tech-command">
          {noIds(cmd.replace(ID, '…'), true)}
        </pre>
      )}
      {t.url && row.system === 'github' && (
        <a href={t.url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-mini text-primary hover:underline" data-testid="automation-tech-github">
          {tr('auto.tech.github')}<ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
    </details>
  );
}
