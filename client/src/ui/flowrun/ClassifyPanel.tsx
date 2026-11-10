import { Plus, Sparkles, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { FieldRef } from '../types';
import type { UiCopy } from '../copy/types';
import { Button, IconButton } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { FieldChip } from '../primitives/Chip';
import { TextField } from '../primitives/Field';
import { PanelHeading, PanelSection, SidePanel } from '../primitives/Panel';
import { Table, type TableColumnModel } from '../primitives/Table';
import { FOCUS_RING } from '../shell/pressable';
import type { ClassifyType, PreRule } from './model';
import { FactRow, Slider } from './common';
import { KnowledgeChips } from './KnowledgeChips';

export interface ClassifyView {
  takes: Array<{ field: FieldRef; from: string }>;
  gives: Array<{ field: FieldRef; note: string }>;
  types: ClassifyType[];
  preRules: PreRule[];
  corrections: Array<{ id: string; label: string; n: number }>;
  threshold: number;
  belowPct: number;
  perMonth: number;
  knowledge: string[];
  knowledgePool: string[];
  /** What the preview can say about the threshold of this step: draft of the version, not yet active. */
  changed: boolean;
}

export interface ClassifyHandlers {
  onThreshold: (n: number) => void;
  onTypeWhen: (id: string, text: string) => void;
  onAddRule: (when: string, then: string) => void;
  onRemoveRule: (id: string) => void;
  onAddKnowledge: (name: string) => void;
  onRemoveKnowledge: (name: string) => void;
  onOpenKnowledge: (name: string) => void;
  onOpenType: (letter: string) => void;
}

/**
 * A text box that is as tall as its text, at any width: a hidden copy of the text sets the height and the real
 * field is laid over it, so nothing is clipped and nothing scrolls inside.
 */
function GrowingText({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const box = 'col-start-1 row-start-1 min-w-0 rounded-lg border px-2.5 py-1.5 text-compact leading-5 [overflow-wrap:break-word]';
  return (
    <div className="grid min-w-0">
      <div aria-hidden="true" className={clsx(box, 'invisible whitespace-pre-wrap border-transparent')}>{`${value} `}</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={1}
        className={clsx(box, 'h-full w-full resize-none overflow-hidden border-app-border-input bg-surface text-app-text placeholder:text-app-placeholder transition-colors hover:border-black/20 dark:hover:border-white/20', FOCUS_RING)}
      />
    </div>
  );
}

/** «C · Comunicazione da ente»: the letter and the dot stay glued to the first word of the name (non-breaking spaces), never alone on a line. */
function glueLetter(letter: string, name: string): string {
  const [first, ...rest] = name.split(' ');
  return [`${letter}\u00A0·\u00A0${first}`, ...rest].join(' ');
}

/** The step that recognizes the type of what arrives (w02): what it takes, what it returns, the types, and how it decides. */
export function ClassifyPanel({ copy, view, handlers, editable, deniedTitle, draftWhen, draftThen, onDraftWhen, onDraftThen }: {
  copy: UiCopy;
  view: ClassifyView;
  handlers: ClassifyHandlers;
  editable: boolean;
  deniedTitle?: string;
  draftWhen: string;
  draftThen: string;
  onDraftWhen: (v: string) => void;
  onDraftThen: (v: string) => void;
}) {
  const c = copy.flowRun.classify;
  // Beside the steps rail and the 320 px panel the card is about 490 px wide: five columns left the definition
  // 190 px and a row six lines tall. Two columns: the type with its numbers and where it goes under the name,
  // and the definition, which is the sentence the clerk reads and edits.
  const columns: TableColumnModel[] = [
    { id: 'type', label: c.colType, width: 260 },
    { id: 'when', label: c.colWhen, width: 380 },
  ];
  const rows = view.types.map((t) => ({
    id: t.id,
    onOpen: undefined,
    cells: {
      type: (
        <span className="flex min-w-0 flex-col gap-0.5">
          <button type="button" onClick={() => handlers.onOpenType(t.letter)} data-tip={c.seeCases(t.letter)} className="text-left font-semibold hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
            {glueLetter(t.letter, t.name)}
          </button>
          <span className="text-compact leading-4 text-app-text-tertiary">{c.typeFacts(t.perMonth ? String(t.perMonth) : '-', view.perMonth ? `${t.correct}%` : '-')}</span>
          <span className="text-compact leading-4 text-app-text-secondary">{c.typeGoes(t.goesTo)}</span>
        </span>
      ),
      when: editable ? (
        // A box that grows with its text: the definition of a type is a sentence and must be read whole.
        <div data-tip={c.editWhen(t.name)} className="min-w-0">
          <GrowingText value={t.when} onChange={(v) => handlers.onTypeWhen(t.id, v)} placeholder={c.whenPlaceholder} />
        </div>
      ) : (
        <span data-tip={deniedTitle} className="whitespace-normal text-app-text-secondary">{t.when}</span>
      ),
    },
  }));
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="min-w-0 flex-1 space-y-4 p-5 md:overflow-y-auto">
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={c.takes}>
            <ul className="flex flex-col gap-2">
              {view.takes.map((t) => (
                <li key={t.field.name} className="flex min-w-0 flex-wrap items-center justify-between gap-2"><FieldChip field={t.field} /><span className="text-app-text-tertiary">{t.from}</span></li>
              ))}
            </ul>
          </Card>
          <Card title={c.gives}>
            <ul className="flex flex-col gap-2">
              {view.gives.map((t) => (
                <li key={t.field.name} className="flex min-w-0 flex-wrap items-center justify-between gap-2"><FieldChip field={t.field} /><span className="text-app-text-tertiary">{t.note}</span></li>
              ))}
            </ul>
          </Card>
        </div>
        <Card title={c.typesTitle(view.types.length)} actions={<span className="text-compact font-normal text-app-text-tertiary">{c.typesNote(view.perMonth)}</span>}>
          <Table
            ariaLabel={c.typesTitle(view.types.length)}
            columns={columns}
            rows={rows}
            className="-mx-0.5"
          />
        </Card>
      </div>
      <SidePanel width={320} className="w-full border-t md:w-[320px] md:border-t-0 md:h-auto">
        <PanelHeading tag={copy.common.ai} tagIcon={Sparkles} title={c.howTitle}>{c.howBody}</PanelHeading>
        <PanelSection label={c.beforeTitle}>
          {view.preRules.length === 0 && <p className="text-prose text-app-text-tertiary">{c.noRules}</p>}
          {view.preRules.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1"><FactRow label={r.when} value={r.then} /></div>
              {editable && <IconButton icon={Trash2} label={c.removeRule(r.when)} onClick={() => handlers.onRemoveRule(r.id)} />}
            </div>
          ))}
          <div className="mt-2 flex flex-col gap-2">
            <TextField size="sm" value={draftWhen} onChange={onDraftWhen} placeholder={c.ruleWhen} disabled={!editable} title={editable ? undefined : deniedTitle} />
            <div className="flex gap-2">
              <TextField size="sm" value={draftThen} onChange={onDraftThen} placeholder={c.ruleThen} disabled={!editable} title={editable ? undefined : deniedTitle} className="flex-1" />
              <Button
                icon={Plus}
                onClick={editable ? () => handlers.onAddRule(draftWhen.trim(), draftThen.trim() || c.ruleThenDefault) : false}
                title={editable ? undefined : deniedTitle}
              >
                {c.addRule}
              </Button>
            </div>
          </div>
        </PanelSection>
        <PanelSection label={c.thresholdTitle}>
          <Slider value={view.threshold} min={50} max={99} onChange={handlers.onThreshold} label={c.thresholdTitle} disabled={!editable} title={editable ? undefined : deniedTitle} />
          <FactRow label={c.thresholdBelow(view.threshold)} value={c.thresholdShare(view.belowPct)} />
          {view.changed && <p className="mt-1 text-compact text-amber-700 dark:text-amber-400">{c.thresholdDraft}</p>}
        </PanelSection>
        <PanelSection label={c.knowledgeTitle}>
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
        </PanelSection>
        <PanelSection label={c.correctionsTitle}>
          {view.corrections.map((k) => <FactRow key={k.id} label={k.label} value={k.n} />)}
          <FactRow label={c.correctionsUsed} value={view.corrections.reduce((s, k) => s + k.n, 0)} />
        </PanelSection>
      </SidePanel>
    </div>
  );
}
