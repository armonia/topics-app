import { Check, RotateCw, Sparkles } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip, FieldChip } from '../primitives/Chip';
import { Select } from '../primitives/Field';
import { PanelSection, SidePanel } from '../primitives/Panel';
import { ProgressBar, Spinner } from '../primitives/Progress';
import { Table, type TableColumnModel } from '../primitives/Table';
import type { FieldKind } from '../types';
import { FactRow, Slider } from './common';
import type { ContextRow, JobView } from './model';

export interface DecidesView {
  /** The run and step the page is about. */
  runOptions: Array<{ value: string; label: string }>;
  runId: string;
  stepOptions: Array<{ value: string; label: string }>;
  stepId: string;
  /** Whole context: what the step had in front of it, and whether it was all there. */
  context: ContextRow[];
  complete: boolean;
  totalTokens: string;
  fixed: Array<{ label: string; value: string }>;
  answer: { title: string; reason: string };
  replay: { times: number; type: string; typeOk: number; office: string; officeOk: number; confidence: string };
  share: Array<{ label: string; value: string }>;
  threshold: number;
  belowPct: number;
  thresholdChanged: boolean;
  /** What happens when the context is incomplete. */
  onMissing: 'stop' | 'person';
}

export interface DecidesHandlers {
  onRun: (id: string) => void;
  onStep: (id: string) => void;
  onReplay: () => void;
  onThreshold: (n: number) => void;
  onMissing: (v: 'stop' | 'person') => void;
  onOpenRun: () => void;
  onOpenStep: () => void;
}

const SOURCE_KIND: Record<ContextRow['state'], 'green' | 'amber' | 'neutral'> = { present: 'green', missing: 'amber', 'not-needed': 'neutral' };

/** How an AI step decides (g03): temperature 0, what it read, how it is fixed, the same answer on every replay, the thresholds. */
export function DecidesPanel({ copy, view, handlers, editable, deniedTitle, job }: {
  copy: UiCopy;
  view: DecidesView;
  handlers: DecidesHandlers;
  editable: boolean;
  deniedTitle?: string;
  job?: JobView;
}) {
  const c = copy.flowRun.decides;
  const off = editable ? undefined : deniedTitle;
  const columns: TableColumnModel[] = [
    { id: 'source', label: c.colSource, width: 170 },
    { id: 'what', label: c.colWhat },
    { id: 'weight', label: c.colWeight, width: 96, align: 'right' },
    { id: 'state', label: c.colState, width: 140 },
  ];
  const rows = view.context.map((r) => ({
    id: r.id,
    cells: {
      source: <FieldChip field={{ kind: r.kind as FieldKind, name: r.source }} />,
      what: <span className="whitespace-normal text-app-text-secondary">{r.what}</span>,
      weight: r.weight,
      state: <Chip tone={SOURCE_KIND[r.state]} icon={r.state === 'present' ? Check : undefined}>{c.state[r.state]}</Chip>,
    },
  }));
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="min-w-0 flex-1 space-y-4 p-5 md:overflow-y-auto">
        <div className="flex flex-wrap items-end gap-3">
          <Select label={c.pickRun} className="min-w-[220px] flex-1" value={view.runId} options={view.runOptions} onChange={handlers.onRun} />
          <Select label={c.pickStep} className="min-w-[220px] flex-1" value={view.stepId} options={view.stepOptions} onChange={handlers.onStep} />
        </div>
        <Card title={c.contextTitle} actions={<Chip tone={view.complete ? 'green' : 'amber'}>{view.complete ? c.complete : c.incomplete}</Chip>}>
          <Table ariaLabel={c.contextTitle} columns={columns} rows={rows} empty={c.noContext} dense />
          <p className="mt-2 text-compact text-app-text-tertiary">{c.totalWeight(view.totalTokens)}</p>
        </Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={c.fixedTitle}>
            {view.fixed.map((f) => <FactRow key={f.label} label={f.label} value={f.value} />)}
          </Card>
          <Card title={c.replayTitle(view.replay.times)}>
            <FactRow label={c.replayType} value={c.replayOf(view.replay.type, view.replay.typeOk, view.replay.times)} tone="green" />
            <FactRow label={c.replayOffice} value={c.replayOf(view.replay.office, view.replay.officeOk, view.replay.times)} tone="green" />
            <FactRow label={c.replayConfidence} value={view.replay.confidence} />
            <p className="mt-1.5 text-compact text-app-text-tertiary">{c.nightly}</p>
            {job && job.status === 'running' && (
              <div className="mt-2 flex flex-col gap-1.5">
                <ProgressBar value={job.progress} label={job.current ?? job.title} detail={c.progress(Math.round(job.progress * 100))} />
                <span className="flex items-center gap-1.5 text-compact text-app-text-secondary"><Spinner size={11} />{job.current}</span>
              </div>
            )}
          </Card>
        </div>
        <Card title={c.thresholdsTitle}>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <div className="mb-1 text-prose font-medium text-app-text">{c.thresholdLabel}</div>
              <Slider value={view.threshold} min={50} max={99} onChange={handlers.onThreshold} label={c.thresholdLabel} disabled={!editable} title={off} />
              <FactRow label={c.thresholdBelow(view.threshold)} value={c.thresholdShare(view.belowPct)} />
              {view.thresholdChanged && <p className="mt-1 text-compact text-amber-700 dark:text-amber-400">{c.thresholdDraft}</p>}
            </div>
            <div>
              <Select
                label={c.missingLabel}
                value={view.onMissing}
                options={[{ value: 'person', label: c.missingPerson }, { value: 'stop', label: c.missingStop }]}
                onChange={(v) => handlers.onMissing(v === 'stop' ? 'stop' : 'person')}
                disabled={!editable}
                title={off}
              />
              <p className="mt-1.5 text-compact text-app-text-tertiary">{off ?? c.missingHint}</p>
            </div>
          </div>
        </Card>
      </div>
      <SidePanel width={360} className="w-full border-t md:w-[360px] md:border-t-0">
        <div className="border-b border-app-border px-4 pb-4 pt-4">
          <Chip tone="pink" icon={Sparkles} strong>{c.answerTag}</Chip>
          <h3 className="mt-2 text-body-lg font-semibold leading-5 text-app-text">{view.answer.title}</h3>
          <p className="mt-1 text-prose leading-5 text-app-text-secondary">{c.reasonLead(view.answer.reason)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button icon={RotateCw} onClick={job?.status === 'running' ? false : handlers.onReplay}>{c.replay}</Button>
            <Button size="md" variant="ghost" onClick={handlers.onOpenStep}>{c.openStep}</Button>
            <Button size="md" variant="ghost" onClick={handlers.onOpenRun}>{c.openRun}</Button>
          </div>
        </div>
        <PanelSection label={c.ifMissingTitle}>
          <p className="text-prose leading-5 text-app-text-secondary">{view.onMissing === 'person' ? c.ifMissingPerson : c.ifMissingStop}</p>
        </PanelSection>
        <PanelSection label={c.howFixedTitle}>
          {view.share.map((s) => <FactRow key={s.label} label={s.label} value={s.value} />)}
        </PanelSection>
      </SidePanel>
    </div>
  );
}
