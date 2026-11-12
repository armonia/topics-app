/**
 * A machine that is not this computer (a paired node, a cloud server) drawn
 * like the Mac: the same section frame, the same gauges with the same history
 * line and hover, the same state wording. A machine a provider adapter
 * recognises adds one line of extras (cost, location, type, pending restart).
 * Card 672744e2.
 */
import { Cloud, CloudOff, Server } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { MachineOverviewRow } from '../../../../shared/machine-overview';
import { DANGER_TEXT, WARNING_TEXT, SUCCESS_TEXT } from '../../lib/popoverStyles';
import { NOT_MEASURED, formatPct, formatRate } from '../../lib/machineProcesses';
import { formatMoney, formatUptime, sampleSeries } from '../../lib/machineOverviewView';
import { FAINT, SECTION, SECTION_HEAD } from './processesStyles';
import { Gauge } from './MachineProcessesPane';

const KNOWN_REASONS = new Set(['not_paired', 'unreachable', 'not_a_node', 'powered_off', 'empty']);

export function RemoteMachineSection({ machine: m }: { machine: MachineOverviewRow }) {
  const tr = useT();
  const k = m.metrics;
  const dot = m.state === 'live' ? 'bg-emerald-500 dark:bg-emerald-400' : m.state === 'stopped' ? 'bg-app-text-faint opacity-50' : 'bg-red-500';
  const tone = m.state === 'live' ? SUCCESS_TEXT : m.state === 'stopped' ? FAINT : DANGER_TEXT;
  const reasonText = m.reason === null ? null : KNOWN_REASONS.has(m.reason) ? tr(`processes.remote.r.${m.reason}`) : tr('processes.remote.r.other', { why: m.reason });
  const memShare = k?.memPct == null ? null : k.memPct / 100;
  const summary = k ? [
    k.cores !== null ? tr('processes.remote.cores', { n: k.cores }) : null,
    k.memTotalGB !== null ? `${Math.round(k.memTotalGB)} GB` : null,
    k.uptimeSec !== null ? `${tr('processes.remote.up')} ${formatUptime(k.uptimeSec)}` : null,
  ].filter(Boolean).join(' · ') : '';
  const p = m.provider;
  const extras = p ? [
    formatMoney(p.monthly) ? `${tr('processes.remote.cost')} ${formatMoney(p.monthly)} ${tr('processes.remote.month')}` : null,
    formatMoney(p.spentThisMonth) ? `${tr('processes.remote.spent')} ${formatMoney(p.spentThisMonth)}` : null,
    p.location ? `${tr('processes.remote.where')} ${p.location}` : null,
    p.serverType ? `${tr('processes.remote.type')} ${p.serverType}` : null,
  ].filter(Boolean) : [];
  return (
    <section aria-label={m.name} className={`${SECTION} @container`} data-testid="machine-remote" data-machine={m.id} data-state={m.state}>
      <div className={SECTION_HEAD} title={summary || undefined}>
        {m.provider ? <Cloud size={14} className="flex-none text-app-text-secondary" aria-hidden="true" /> : <Server size={14} className="flex-none text-app-text-secondary" aria-hidden="true" />}
        <span className="text-compact font-semibold text-app-text-heading" data-testid="machine-remote-name">{m.name}</span>
        <span className={`inline-flex flex-none items-center gap-[5px] text-mini ${tone}`} data-testid="machine-remote-state"><span className={`h-[7px] w-[7px] rounded-full ${dot}`} />{tr(m.state === 'live' ? 'processes.remote.stateLive' : m.state === 'stopped' ? 'processes.remote.stateStopped' : 'processes.remote.stateUnreachable')}</span>
        <span className={`min-w-0 flex-1 truncate text-mini tabular-nums ${FAINT}`}>{summary}</span>
      </div>
      {k ? (
        <div className="grid grid-cols-2 border-b border-app-border-subtle tabular-nums @3xl:grid-cols-4">
          <Gauge label={tr('processes.cpu')} value={formatPct(k.cpuPct)} share={k.cpuPct === null ? null : k.cpuPct / 100} history={sampleSeries(m.history, 'cpu')} testId="machine-remote-cpu" />
          <Gauge label={tr('processes.memory')} value={k.memUsedGB === null ? NOT_MEASURED : k.memUsedGB.toFixed(1).replace('.', ',')} unit={k.memTotalGB ? `/ ${Math.round(k.memTotalGB)} GB` : undefined} share={memShare} warn={memShare !== null && memShare >= 0.8} history={sampleSeries(m.history, 'mem')} />
          <Gauge label={tr('processes.net')} value={k.netInBps === null ? NOT_MEASURED : `↓${formatRate(k.netInBps)}`} unit={k.netOutBps === null ? undefined : `↑${formatRate(k.netOutBps)}`} share={null} />
          <Gauge label={tr('processes.disk')} value={formatPct(k.diskPct)} share={k.diskPct === null ? null : k.diskPct / 100} warn={(k.diskPct ?? 0) >= 85} testId="machine-remote-disk" />
        </div>
      ) : (
        <div className={`flex min-h-[38px] items-center gap-2 border-b border-app-border-subtle px-2.5 py-1 text-compact ${m.state === 'stopped' ? FAINT : DANGER_TEXT}`} data-testid="machine-remote-reason" data-reason={m.reason ?? ''}>
          <CloudOff size={14} className="flex-none" aria-hidden="true" />
          <span className="min-w-0 flex-1">{reasonText}</span>
        </div>
      )}
      {extras.length > 0 && (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2.5 py-2 text-mini tabular-nums ${FAINT}`} data-testid="machine-remote-provider" title={p?.providerLabel}>
          {extras.map((e) => <span key={e}>{e}</span>)}
        </div>
      )}
      {k?.rebootRequired != null && p && (
        <div className={`px-2.5 pb-2 text-mini ${k.rebootRequired ? WARNING_TEXT : FAINT}`} data-testid="machine-remote-reboot" data-pending={k.rebootRequired}>
          {tr(k.rebootRequired ? 'processes.remote.reboot' : 'processes.remote.noReboot')}
        </div>
      )}
      {m.providerError && <div className={`px-2.5 pb-2 text-mini ${WARNING_TEXT}`}>{tr('processes.remote.providerError', { why: m.providerError })}</div>}
    </section>
  );
}
