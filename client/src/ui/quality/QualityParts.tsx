import { ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { Select, Toggle } from '../primitives/Field';
import { KeyValue, PanelHeading, PanelSection } from '../primitives/Panel';
import { Table, type TableRowModel } from '../primitives/Table';
import { TONE_TEXT } from '../tone';
import type { CheckRowModel, DimensionRowModel, OddityRowModel, QualityKpiModel } from './model';

export function Kpis({ kpis }: { kpis: QualityKpiModel[] }) {
  return (
    <div className="grid grid-cols-4 gap-2.5 max-lg:grid-cols-2 max-sm:grid-cols-1">
      {kpis.map((k) => (
        <div key={k.id} className="min-w-0 rounded-lg border border-app-border bg-surface px-4 py-3.5">
          <div className={clsx('text-[26px] font-semibold leading-9 tracking-[-0.01em] tabular-nums', k.tone && k.tone !== 'neutral' ? TONE_TEXT[k.tone] : 'text-app-text')}>{k.value}</div>
          <div className="text-prose leading-5 text-app-text-secondary">{k.label}</div>
          {k.detail && <div className="mt-0.5 text-compact leading-4 text-app-text-tertiary">{k.detail}</div>}
        </div>
      ))}
    </div>
  );
}

/** The six dimensions of ISO/IEC 25012 the controls measure; each opens its controls. */
export function DimensionsCard({ rows, copy, onOpen }: { rows: DimensionRowModel[]; copy: UiCopy; onOpen: (id: string) => void }) {
  const t = copy.dataMore.quality;
  const tableRows: TableRowModel[] = rows.map((r) => ({
    id: r.id,
    onOpen: () => onOpen(r.id),
    cells: {
      name: <span className="font-semibold">{r.name}</span>,
      means: <span className="block whitespace-normal leading-5">{r.means}</span>,
      example: <span className="block whitespace-normal leading-5">{r.example}</span>,
      checks: <span className="text-app-text-secondary">{t.checksOn(r.on, r.total)}</span>,
      pct: <span className={clsx('font-semibold', TONE_TEXT[r.tone])}>{r.pctText}</span>,
    },
  }));
  return (
    <Card title={t.dimensionsTitle} actions={<span className="text-compact font-normal text-app-text-tertiary max-sm:hidden">{t.dimensionsNote}</span>}>
      <Table
        ariaLabel={t.dimensionsTitle}
        columns={[
          { id: 'name', label: t.columns.dimension, width: 130 },
          { id: 'means', label: t.columns.means, width: 210 },
          { id: 'example', label: t.columns.example, width: 360 },
          { id: 'checks', label: t.columns.checks, width: 96 },
          { id: 'pct', label: t.columns.score, width: 84, align: 'right' },
        ]}
        rows={tableRows}
      />
    </Card>
  );
}

/** What was found this week, each line opens the item. */
export function OddityCard({ rows, copy, onOpen }: { rows: OddityRowModel[]; copy: UiCopy; onOpen: (id: string) => void }) {
  const t = copy.dataMore.quality;
  return (
    <Card title={t.oddTitle}>
      <Table
        ariaLabel={t.oddTitle}
        columns={[
          { id: 'title', label: t.columns.what, width: 230 },
          { id: 'where', label: t.columns.where, width: 120 },
          { id: 'summary', label: t.columns.happened, width: 340 },
          { id: 'status', label: t.columns.status, width: 150 },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          onOpen: () => onOpen(r.id),
          cells: {
            title: <span className="font-semibold">{r.title}</span>,
            where: r.where,
            summary: <span className="block whitespace-normal leading-5">{r.summary}</span>,
            status: <Chip tone={r.statusTone}>{r.statusText}</Chip>,
          },
        }))}
        empty={<EmptyState icon={ShieldCheck} title={t.noOdd} className="min-h-0 py-4" />}
      />
    </Card>
  );
}

/** The controls that weigh on the score: each can be switched off, and says what it measured. */
export function ChecksCard({ rows, copy, dimension, dimensionOptions, onDimension, onToggle, canEdit, deniedTitle, empty }: {
  rows: CheckRowModel[];
  copy: UiCopy;
  dimension: string;
  dimensionOptions: Array<{ value: string; label: string }>;
  onDimension: (v: string) => void;
  onToggle: (id: string, on: boolean) => void;
  canEdit: boolean;
  deniedTitle?: string;
  empty: string;
}) {
  const t = copy.dataMore.quality;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px]"><Select title={t.dimensionFilter} value={dimension} options={dimensionOptions} onChange={onDimension} /></div>
      </div>
      <Table
        ariaLabel={t.checksTitle}
        columns={[
          { id: 'on', label: t.columns.active, width: 76 },
          { id: 'label', label: t.columns.check, width: 380 },
          { id: 'dimension', label: t.columns.dimension, width: 130 },
          { id: 'scope', label: t.columns.scope, width: 150 },
          { id: 'basis', label: t.columns.basis, width: 170 },
          { id: 'pct', label: t.columns.score, width: 84, align: 'right' },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          muted: !r.on,
          cells: {
            on: <Toggle checked={r.on} onChange={(v) => onToggle(r.id, v)} disabled={!canEdit} title={canEdit ? t.toggleCheck(r.label) : deniedTitle} />,
            label: (
              <span className="flex flex-col leading-5">
                <span className="whitespace-normal">{r.label}</span>
                <span className="whitespace-normal text-mini text-app-text-tertiary">{r.where}{r.failing > 0 ? ` · ${t.failing(r.failing)}` : ''}</span>
              </span>
            ),
            dimension: r.dimension,
            scope: r.scope,
            basis: <span className="text-app-text-secondary">{r.basis}</span>,
            pct: <span className={clsx('font-semibold', TONE_TEXT[r.tone])}>{r.pctText}</span>,
          },
        }))}
        empty={empty}
      />
    </div>
  );
}

/** The side panel of the overview: the golden rule, the automatic corrections, how many controls run, the nightly comparison. */
export function QualitySide({ copy, counts, lastRun, phone }: {
  copy: UiCopy;
  counts: Array<{ label: string; value: string }>;
  lastRun: string;
  phone: boolean;
}) {
  const t = copy.dataMore.quality;
  return (
    <aside className={clsx('flex shrink-0 flex-col border-app-border bg-surface', phone ? 'w-full border-t' : 'h-full w-[320px] border-l')}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PanelHeading tag={t.goldenTag} title={t.goldenTitle}>{t.goldenBody}</PanelHeading>
        <PanelSection label={t.autoTitle}><p className="text-prose leading-6 text-app-text-secondary">{t.autoBody}</p></PanelSection>
        <PanelSection label={t.activeControls}>
          {counts.map((c) => <KeyValue key={c.label} label={c.label} value={c.value} />)}
        </PanelSection>
        <PanelSection label={t.nightTitle}>
          <p className="text-prose leading-6 text-app-text-secondary">{t.nightBody}</p>
          <p className="mt-2 text-compact text-app-text-tertiary">{lastRun}</p>
        </PanelSection>
      </div>
    </aside>
  );
}
