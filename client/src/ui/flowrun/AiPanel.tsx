import { Plus, Trash2 } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button, IconButton } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Checkbox, TextArea, TextField } from '../primitives/Field';
import type { FieldDef } from './model';
import { FactRow, Slider } from './common';
import { KnowledgeChips } from './KnowledgeChips';

export interface AiView {
  prompt: string;
  knowledge: string[];
  knowledgePool: string[];
  fields: FieldDef[];
  threshold: number;
  belowPct: number;
  corrections: number;
  lastCorrection: string;
  model: string;
  personalData: string;
  cost: string;
  lastTest: { label: string; same: number; diffs: Array<{ id: string; label: string; n: number }> };
  changed: boolean;
}

export interface AiHandlers {
  onPrompt: (v: string) => void;
  onField: (id: string, patch: Partial<FieldDef>) => void;
  onAddField: () => void;
  onRemoveField: (id: string) => void;
  onThreshold: (n: number) => void;
  onAddKnowledge: (name: string) => void;
  onRemoveKnowledge: (name: string) => void;
  onOpenKnowledge: (name: string) => void;
  onOpenCorrections: () => void;
  onOpenTests: () => void;
}

/** The page of an AI block (n05): what it must do, what it reads, what it returns, how sure it must be, how it did on the last test. */
export function AiPanel({ copy, view, handlers, editable, deniedTitle }: {
  copy: UiCopy;
  view: AiView;
  handlers: AiHandlers;
  editable: boolean;
  deniedTitle?: string;
}) {
  const c = copy.flowRun.ai;
  const off = editable ? undefined : deniedTitle;
  return (
    <div className="grid min-w-0 gap-4 p-5 xl:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        <Card title={c.promptTitle}>
          <TextArea label={c.promptLabel} value={view.prompt} onChange={handlers.onPrompt} rows={8} disabled={!editable} hint={off ?? c.promptHint} />
        </Card>
        <Card title={c.knowledgeTitle}>
          <KnowledgeChips
            copy={copy}
            used={view.knowledge}
            pool={view.knowledgePool}
            editable={editable}
            deniedTitle={deniedTitle}
            onAdd={handlers.onAddKnowledge}
            onRemove={handlers.onRemoveKnowledge}
            onOpen={handlers.onOpenKnowledge}
          />
        </Card>
        <Card title={c.learnTitle}>
          <FactRow label={c.corrections} value={c.correctionsValue(view.corrections)} onOpen={handlers.onOpenCorrections} />
          <FactRow label={c.lastCorrection} value={view.lastCorrection} />
        </Card>
        <Card title={c.modelTitle}>
          <FactRow label={c.model} value={view.model} />
          <FactRow label={c.personalData} value={view.personalData} />
          <FactRow label={c.cost} value={view.cost} />
          <FactRow label={c.temperature} value={c.temperatureValue} />
        </Card>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Card title={c.fieldsTitle}>
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[420px] text-prose">
              <thead>
                <tr className="text-left text-compact font-medium text-app-text-secondary">
                  <th className="py-1.5 pr-2 font-medium">{c.colField}</th>
                  <th className="py-1.5 pr-2 font-medium">{c.colType}</th>
                  <th className="py-1.5 pr-2 font-medium">{c.colRequired}</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {view.fields.map((f) => (
                  <tr key={f.id} className="border-t border-app-border align-middle">
                    <td className="py-1.5 pr-2">
                      <TextField size="sm" value={f.name} onChange={(v) => handlers.onField(f.id, { name: v })} disabled={!editable} title={off ?? c.fieldName(f.name)} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <TextField size="sm" value={f.type} onChange={(v) => handlers.onField(f.id, { type: v })} disabled={!editable} title={off ?? c.fieldType(f.name)} />
                    </td>
                    <td className="py-1.5 pr-2">
                      <Checkbox checked={f.required} onChange={(v) => handlers.onField(f.id, { required: v })} disabled={!editable} title={off ?? c.fieldRequired(f.name)} />
                    </td>
                    <td className="py-1.5 text-right">
                      {editable && <IconButton icon={Trash2} label={c.removeField(f.name)} onClick={() => handlers.onRemoveField(f.id)} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2">
            <Button icon={Plus} size="sm" onClick={editable ? handlers.onAddField : false} title={off}>{c.addField}</Button>
          </div>
        </Card>
        <Card title={c.thresholdTitle}>
          <Slider value={view.threshold} min={50} max={99} onChange={handlers.onThreshold} label={c.thresholdTitle} disabled={!editable} title={off} />
          <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-compact leading-5 text-app-text-secondary">
            <span>{c.thresholdBelow(view.threshold)}</span>
            <span className="tabular-nums">{c.thresholdShare(view.belowPct)}</span>
          </div>
          {view.changed && <p className="mt-1 text-compact text-amber-700 dark:text-amber-400">{c.thresholdDraft}</p>}
        </Card>
        <Card title={c.lastTestTitle} actions={<span className="text-compact font-normal text-app-text-tertiary">{view.lastTest.label}</span>}>
          <FactRow label={c.testSame} value={view.lastTest.same} tone="green" onOpen={handlers.onOpenTests} />
          {view.lastTest.diffs.map((d) => <FactRow key={d.id} label={d.label} value={d.n} tone={d.n ? 'amber' : undefined} onOpen={handlers.onOpenTests} />)}
        </Card>
      </div>
    </div>
  );
}
