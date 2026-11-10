/** Settings · Compliance (`q03`): the standards and laws with their state, their proof, the date of the last check and a job that verifies each. */
import { CircleAlert, Download, FileCheck2, RefreshCw, Search, X } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import type { ComplianceScope, StandardGroup, StandardId, StandardStatus } from '../../../../ui/settings/model';
import { P } from '../../paths';
import { settingsFrame } from '../settings-frame';
import { Block, Callout, Notes } from '../../../../ui/settings/Block';
import { StandardList } from '../../../../ui/settings/Compliance';
import { STANDARD_TONE } from '../../../../ui/settings/tones';
import { Tabs } from '../../../../ui/primitives/Tabs';
import { Select, TextField } from '../../../../ui/primitives/Field';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { StatCard } from '../../../../ui/primitives/Card';
import { ProgressBar } from '../../../../ui/primitives/Progress';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { KeyValue } from '../../../../ui/primitives/Panel';
import { addDays } from '../../../../ui/fixtures/org/clock';
import { SECTOR_STANDARD_TEXT, STANDARDS, type StandardSeed } from '../../../../ui/fixtures/settings';
import { adminGate, dayText, isRunning } from './helpers';

interface CheckRecord {
  day: string;
  result: 'pass' | 'fail' | 'external';
}

interface ComplianceState {
  checks: Partial<Record<StandardId, CheckRecord>>;
  receipt: { file: string; count: number } | null;
}

const GROUP_ORDER: StandardGroup[] = ['documents', 'sector', 'personal', 'data'];
const SCOPES: ComplianceScope[] = ['nocera', 'sarim', 'topics'];
const OPEN_STATUSES: StandardStatus[] = ['in-progress', 'partial', 'to-certify', 'to-request'];

type GeneralId = 'gdpr' | 'iso27001' | 'acn' | 'nis2' | 'iso25012' | 'iso8000' | 'aiact' | 'iso42001' | 'wcag';

export function CompliancePage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.settings;
  const k = c.compliance;
  const gate = adminGate(ctx);
  const [st, setSt] = ctx.slice<ComplianceState>('compliance', { checks: {}, receipt: null });
  const [scope, setScope] = ctx.ui<ComplianceScope>('conformita.scope', 'nocera');
  const [query, setQuery] = ctx.ui<string>('conformita.q', '');
  const [statusFilter, setStatusFilter] = ctx.ui<'all' | StandardStatus>('conformita.status', 'all');
  const [openId, setOpenId] = ctx.ui<StandardId | null>('conformita.open', null);
  const today = ctx.now.slice(0, 10);

  const textOf = (s: StandardSeed) => SECTOR_STANDARD_TEXT[s.id] ?? k.items[s.id as GeneralId];
  const checkedDay = (s: StandardSeed) => st.checks[s.id]?.day ?? addDays(today, -s.checkedDaysAgo);
  const proofPath = (s: StandardSeed): string | undefined => {
    switch (s.proofPath) {
      case 'quality': return P.quality();
      case 'log': return P.settings('registro');
      case 'versions': return P.flowVersions('pec');
      case 'security': return P.settings('sicurezza');
      case 'anonymization': return P.settings('anonimizzazione');
      case 'hosting': return P.settings('dove-gira');
      default: return undefined;
    }
  };

  const inScope = STANDARDS.filter((s) => s.scopes.includes(scope));
  const q = query.trim().toLowerCase();
  const shown = inScope.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (!q) return true;
    const t = textOf(s);
    return [s.name, t.about, t.how, t.proof].some((x) => x.toLowerCase().includes(q));
  });

  const verify = (s: StandardSeed) =>
    ctx.startJob({
      id: `verify-${s.id}`,
      title: k.verifyJob.title(s.name),
      steps: k.verifyJob.steps.map((label, i) => ({ label, ms: 650, fails: s.verify === 'fail' && i === 1 })),
      onDone: (ok) => {
        const result: CheckRecord['result'] = s.verify === 'external' ? 'external' : ok ? 'pass' : 'fail';
        setSt((prev) => ({ ...prev, checks: { ...prev.checks, [s.id]: { day: today, result } } }));
        ctx.log(k.verifyJob.title(s.name), 'test', ctx.path);
        if (result === 'pass') ctx.toast({ tone: 'ok', title: k.results.pass(s.name, dayText(today)) });
        else if (result === 'external') ctx.toast({ tone: 'info', title: s.name, body: k.results.external });
        else ctx.toast({ tone: 'error', title: k.results.fail(s.name), body: k.results.failBody[s.id as 'gdpr' | 'iso8000' | 'wcag'] });
      },
    });

  const exportFile = () =>
    ctx.startJob({
      id: 'compliance-export',
      title: k.export.job.title,
      steps: k.export.job.steps.map((label) => ({ label, ms: 750 })),
      onDone: (ok) => {
        if (!ok) return;
        const file = k.export.file(today);
        setSt((prev) => ({ ...prev, receipt: { file, count: inScope.length } }));
        ctx.log(k.export.job.title, 'access', ctx.path);
        ctx.toast({ tone: 'ok', title: k.export.toast, body: file });
      },
    });

  const groups = GROUP_ORDER.map((g) => ({
    id: g,
    label: k.groups[g],
    rows: shown.filter((s) => s.group === g).map((s) => {
      const running = isRunning(ctx, `verify-${s.id}`);
      const job = ctx.job(`verify-${s.id}`);
      return {
        id: s.id,
        name: s.name,
        about: textOf(s).about,
        how: textOf(s).how,
        proof: textOf(s).proof,
        status: s.status,
        statusLabel: k.statuses[s.status],
        checked: k.checkedOn(dayText(checkedDay(s)).slice(0, 5)),
        selected: openId === s.id,
        onOpen: () => setOpenId(s.id),
        progress: running && job ? <ProgressBar value={job.progress} label={job.current} /> : undefined,
        action: running && job ? null : (
          <Button size="sm" variant="ghost" icon={RefreshCw} title={gate.title} onClick={ctx.allow('admin', () => verify(s))}>{k.verify}</Button>
        ),
      };
    }),
  })).filter((g) => g.rows.length > 0);

  const covered = inScope.filter((s) => s.status === 'covered').length;
  const progress = inScope.filter((s) => OPEN_STATUSES.includes(s.status)).length;
  const others = inScope.length - covered - progress;

  const open = openId ? STANDARDS.find((s) => s.id === openId) : undefined;
  const openCheck = open ? st.checks[open.id] : undefined;

  const downloadProof = (s: StandardSeed) => {
    const file = `${s.id}-${checkedDay(s)}.pdf`;
    ctx.toast({ tone: 'info', title: k.detail.downloaded(file) });
  };

  const statusOptions = [{ value: 'all', label: k.allStatuses }, ...(Object.keys(k.statuses) as StandardStatus[]).map((v) => ({ value: v, label: k.statuses[v] }))];

  return settingsFrame(ctx, 'conformita', {
    actions: (
      <Button variant="secondary" icon={Download} onClick={isRunning(ctx, 'compliance-export') ? false : ctx.allow('export', exportFile)} title={ctx.deniedTitle('export') ?? (isRunning(ctx, 'compliance-export') ? ctx.copy.app.jobs.running : undefined)}>
        {k.export.button}
      </Button>
    ),
    children: (
      <div className="flex flex-col gap-4">
        <Tabs<ComplianceScope>
          ariaLabel={k.columns.standard}
          value={scope}
          onChange={(v) => { setScope(v); setOpenId(null); }}
          options={SCOPES.map((v) => ({ value: v, label: k.scopes[v] }))}
        />

        {st.receipt && (
          <Callout icon={FileCheck2} tone="green">
            <div className="font-medium">{k.export.receiptTitle}</div>
            <div>{k.export.receiptLine(st.receipt.file, st.receipt.count)}</div>
          </Callout>
        )}
        {isRunning(ctx, 'compliance-export') && <ProgressBar value={ctx.job('compliance-export')?.progress ?? 0} label={k.export.job.title} detail={ctx.job('compliance-export')?.current} />}

        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          <StatCard label={k.summary.covered} value={covered} tone="green" />
          <StatCard label={k.summary.progress} value={progress} tone="amber" />
          <StatCard label={k.summary.others} value={others} />
        </div>

        {open && (
          <Block
            title={open.name}
            actions={
              <>
                <Chip tone={STANDARD_TONE[open.status]}>{k.statuses[open.status]}</Chip>
                <Button size="sm" variant="ghost" icon={X} onClick={() => setOpenId(null)}>{k.detail.close}</Button>
              </>
            }
            description={textOf(open).about}
            bodyClassName="flex flex-col gap-3"
          >
            <div>
              <div className="mb-0.5 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{k.detail.howTitle}</div>
              <p className="text-prose leading-5 text-app-text">{textOf(open).how}</p>
            </div>
            <div>
              <KeyValue label={k.detail.proofTitle} value={textOf(open).proof} />
              <KeyValue label={k.detail.lastCheck(dayText(checkedDay(open)))} value={openCheck?.result === 'fail' ? k.results.fail(open.name) : ''} />
            </div>
            {openCheck?.result === 'fail' && (
              <Callout icon={CircleAlert} tone="red">{k.results.failBody[open.id as 'gdpr' | 'iso8000' | 'wcag']}</Callout>
            )}
            <div className="flex flex-wrap gap-2">
              {proofPath(open) && <Button variant="secondary" onClick={() => ctx.go(proofPath(open)!)}>{k.detail.openProof}</Button>}
              <Button variant="secondary" icon={Download} onClick={() => downloadProof(open)}>{k.detail.download}</Button>
            </div>
          </Block>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <TextField size="sm" type="search" icon={Search} value={query} onChange={setQuery} placeholder={k.search} className="min-w-[200px] flex-1 sm:max-w-xs" />
          <Select size="sm" value={statusFilter} options={statusOptions} onChange={(v) => setStatusFilter(v as 'all' | StandardStatus)} title={k.columns.state} className="w-48" />
        </div>

        {groups.length === 0 ? (
          <Block>
            <EmptyState icon={FileCheck2} title={k.empty.title} action={<Button onClick={() => { setQuery(''); setStatusFilter('all'); }}>{c.common.clearFilters}</Button>} className="min-h-0 py-6">
              {k.empty.body}
            </EmptyState>
          </Block>
        ) : (
          <StandardList ariaLabel={k.columns.standard} groups={groups} labels={{ standard: k.columns.standard, how: k.columns.how, proof: k.columns.proof, state: k.columns.state }} />
        )}

        <Notes
          items={[
            { title: k.fromWhere.title, text: k.fromWhere.text },
            { title: k.legend.title, text: `${k.statuses.covered}: ${k.legend.covered} · ${k.statuses['to-certify']}: ${k.legend.todo} · ${k.statuses['by-others']}: ${k.legend.others}` },
            { title: k.notPromised.title, text: k.notPromised.text },
          ]}
        />
      </div>
    ),
  });
}
