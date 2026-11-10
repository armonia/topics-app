import type { LucideIcon } from 'lucide-react';
import { ArrowUpRight } from 'lucide-react';
import clsx from 'clsx';
import type { FunctionStatus } from './model';
import type { Tone } from '../types';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { Button } from '../primitives/Button';
import { KindChip } from './Block';

export interface PrincipleModel {
  id: string;
  icon: LucideIcon;
  name: string;
  text: string;
  /** What the principle is measured by, e.g. «dati veri inviati all'AI». */
  measure: string;
  value: string;
  kind: 'goal' | 'estimate' | 'example';
  kindLabel: string;
  /** Where the principle lives in the app. */
  onOpen: () => void;
  openLabel: string;
}

/** One promise of the product: its words, the number it is measured by and the place where it lives. */
export function PrincipleCard({ p }: { p: PrincipleModel }) {
  return (
    <Card title={p.name} icon={p.icon} tone="green" onOpen={p.onOpen} className="h-full" actions={<KindChip kind={p.kind} label={p.kindLabel} />}>
      <div data-tip={p.openLabel} className="flex h-full flex-col gap-2.5">
        <p>{p.text}</p>
        <div className="mt-auto flex items-baseline gap-3 border-t border-app-border pt-2 text-compact">
          <span className="min-w-0 flex-1 text-app-text-tertiary">{p.measure}</span>
          <span className="shrink-0 text-right text-body-lg font-semibold tabular-nums text-app-text">{p.value}</span>
        </div>
      </div>
    </Card>
  );
}

export interface FunctionModel {
  id: string;
  name: string;
  status: FunctionStatus;
  statusLabel: string;
  exists: string;
  toBuild: string;
  base: string;
  onOpen: () => void;
  openLabel: string;
}

const STATUS_TONE: Record<FunctionStatus, Tone> = { active: 'green', testing: 'amber', next: 'neutral' };

export interface FunctionColumnLabels { area: string; exists: string; toBuild: string; base: string }

/** The functions of the product: what exists, what is to build, the open source base, and the way to the place where each lives. */
export function FunctionList({ items, labels, ariaLabel }: { items: FunctionModel[]; labels: FunctionColumnLabels; ariaLabel: string }) {
  const grid = 'lg:grid lg:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)_150px] lg:gap-x-3';
  return (
    <ul aria-label={ariaLabel} className="overflow-hidden rounded-lg border border-app-border bg-surface">
      <li aria-hidden="true" className={clsx('hidden border-b border-app-border bg-app-inset px-3 py-2 text-compact font-medium text-app-text-secondary', grid)}>
        <span>{labels.area}</span><span>{labels.exists}</span><span>{labels.toBuild}</span><span>{labels.base}</span>
      </li>
      {items.map((f) => (
        <li key={f.id} className={clsx('flex flex-col gap-2 border-b border-app-border px-3 py-3 text-prose leading-5 last:border-b-0', grid)}>
          <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-start">
            <span className="font-semibold text-app-text">{f.name}</span>
            <Chip tone={STATUS_TONE[f.status]}>{f.statusLabel}</Chip>
            <Button size="sm" variant="ghost" icon={ArrowUpRight} onClick={f.onOpen} title={f.openLabel} className="lg:-ml-1.5">{f.openLabel}</Button>
          </div>
          <Cell label={labels.exists}>{f.exists}</Cell>
          <Cell label={labels.toBuild}>{f.toBuild}</Cell>
          <Cell label={labels.base}>{f.base}</Cell>
        </li>
      ))}
    </ul>
  );
}

/** A cell that names its column when the columns are stacked (a phone). */
function Cell({ label, children }: { label: string; children: string }) {
  return (
    <div className="min-w-0 text-app-text-secondary">
      <span className="mr-1.5 text-mini font-medium uppercase tracking-[0.06em] text-app-text-tertiary lg:hidden">{label}</span>
      {children}
    </div>
  );
}
