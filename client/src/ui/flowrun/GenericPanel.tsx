import { Eye } from 'lucide-react';
import type { FieldRef } from '../types';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { FieldChip } from '../primitives/Chip';
import { Select, TextArea, TextField } from '../primitives/Field';
import type { StepKind } from './model';
import { KindChip, SettingRow } from './common';

export interface GenericView {
  kind: StepKind;
  program?: string;
  title: string;
  office: string;
  offices: Array<{ value: string; label: string }>;
  hours: number;
  note: string;
  uses: FieldRef[];
  produces: FieldRef[];
  opens?: string;
}

export interface GenericHandlers {
  onOffice: (v: string) => void;
  onHours: (n: number) => void;
  onNote: (v: string) => void;
  onOpenView: () => void;
}

/** The page of a step that is not a block of its own: who does it, what it takes and returns, and the view it opens. */
export function GenericPanel({ copy, view, handlers, editable, deniedTitle }: {
  copy: UiCopy;
  view: GenericView;
  handlers: GenericHandlers;
  editable: boolean;
  deniedTitle?: string;
}) {
  const c = copy.flowRun.generic;
  const off = editable ? undefined : deniedTitle;
  const timed = view.kind === 'person';
  return (
    <div className="mx-auto flex w-full max-w-[920px] min-w-0 flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <KindChip kind={view.kind} program={view.program} copy={copy} />
        <h2 className="min-w-0 text-title font-semibold text-app-text">{view.title}</h2>
      </div>
      <p className="max-w-[720px] text-prose leading-6 text-app-text-secondary">{c.lead[view.kind]}</p>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={c.who}>
          <SettingRow label={c.office}>
            <Select size="sm" value={view.office} options={view.offices} onChange={handlers.onOffice} disabled={!editable} title={off ?? c.office} />
          </SettingRow>
          {timed && (
            <SettingRow label={c.within} hint={c.withinHint}>
              <TextField size="sm" type="number" value={String(view.hours)} onChange={(v) => handlers.onHours(Math.max(0, Math.min(240, Number(v) || 0)))} disabled={!editable} title={off ?? c.within} />
            </SettingRow>
          )}
        </Card>
        <Card title={c.when}>
          <p>{c.whenText[view.kind](view.hours)}</p>
        </Card>
      </div>
      <Card title={c.what}>
        <TextArea label={c.noteLabel} value={view.note} onChange={handlers.onNote} rows={3} disabled={!editable} hint={off} />
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={c.takes}>
          <div className="flex flex-wrap gap-1.5">
            {view.uses.length ? view.uses.map((f) => <FieldChip key={f.name} field={f} />) : <span className="text-app-text-tertiary">{c.nothing}</span>}
          </div>
        </Card>
        <Card title={c.gives}>
          <div className="flex flex-wrap gap-1.5">
            {view.produces.length ? view.produces.map((f) => <FieldChip key={f.name} field={f} />) : <span className="text-app-text-tertiary">{c.nothing}</span>}
          </div>
        </Card>
      </div>
      {view.opens && (
        <Card title={c.opensTitle}>
          <div className="flex flex-wrap items-center gap-3">
            <Button icon={Eye} onClick={handlers.onOpenView}>{view.opens}</Button>
            <span className="text-compact text-app-text-tertiary">{c.opensHint}</span>
          </div>
        </Card>
      )}
    </div>
  );
}
