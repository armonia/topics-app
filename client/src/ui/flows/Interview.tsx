import { BookOpen, Check, CircleAlert, Inbox, Sparkles, User, Workflow, type LucideIcon } from 'lucide-react';
import type { FieldRef } from '../types';
import { Button } from '../primitives/Button';
import { Chip, FieldChip } from '../primitives/Chip';
import { Card } from '../primitives/Card';
import type { Action, Tone } from '../types';
import type { UiCopy } from '../copy/types';

export interface KnowledgeFactModel {
  id: string;
  title: string;
  /** `Chi`, `Ogni quanto`, `Programmi`: the label and the value, in order. (allow-italian: quotes the Italian interface) */
  rows: Array<{ label: string; value: string }>;
  data: FieldRef[];
  exception: string;
  /** What is still missing: the document the rule is written in. */
  missing: string;
  /** Already added to the knowledge. */
  added: boolean;
}

export type InterviewOutputKind = 'procedure' | 'request' | 'flow' | 'person';

export interface InterviewOutputModel {
  id: string;
  kind: InterviewOutputKind;
  title: string;
  /** The state, worded: `bozza, da approvare`, `card aperta`. */
  state: string;
  tone: Tone;
  /** What the row does, and the place it leads once done. */
  actionLabel: string;
  onAction: Action;
  done: boolean;
}

const OUTPUT_ICON: Record<InterviewOutputKind, LucideIcon> = {
  procedure: BookOpen, request: Inbox, flow: Workflow, person: User,
};

/**
 * What the interview has learned (o02): each fact a person alone knows, with
 * the words it comes from, what is still missing, and the button that adds it
 * to the knowledge; then what comes out of the interview, each with its own
 * action. An example, and it says so.
 */
export function InterviewSide({ copy, facts, outputs, onAdd, onOpenMap, onOpenMissing }: {
  copy: UiCopy;
  facts: KnowledgeFactModel[];
  outputs: InterviewOutputModel[];
  onAdd: (id: string) => Action;
  onOpenMap: () => void;
  onOpenMissing: (id: string) => void;
}) {
  const t = copy.flowBuild.interview;
  return (
    <div className="flex flex-col gap-4">
      {facts.map((fact) => (
        <section key={fact.id} className="rounded-lg border border-rose-500/50 bg-surface px-4 py-3.5">
          <header className="flex flex-wrap items-center gap-2">
            <Chip tone="red" icon={CircleAlert} strong>{t.atRisk}</Chip>
            <h3 className="min-w-0 flex-1 text-body-lg font-semibold text-app-text">{fact.title}</h3>
          </header>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-prose sm:grid-cols-[auto_1fr_auto_1fr]">
            {fact.rows.map((r) => (
              <div key={r.label} className="contents">
                <dt className="text-app-text-secondary">{r.label}</dt>
                <dd className="text-right font-semibold text-app-text">{r.value}</dd>
              </div>
            ))}
            <dt className="text-app-text-secondary">{t.data}</dt>
            <dd className="flex flex-wrap justify-end gap-1.5">{fact.data.map((d) => <FieldChip key={d.name} field={d} />)}</dd>
          </dl>
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-black/[0.04] px-3 py-2 text-prose dark:bg-white/[0.06]">
            <span><strong className="font-semibold">{t.exception}</strong> {fact.exception}</span>
            <button
              type="button"
              onClick={() => onOpenMissing(fact.id)}
              className="inline-flex h-5 items-center rounded-full bg-sky-500/15 px-2 text-mini font-medium text-sky-800 transition-colors hover:bg-sky-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:text-sky-300"
            >
              {fact.missing}
            </button>
            <Chip>{t.example}</Chip>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {fact.added ? (
              <>
                <Chip tone="green" icon={Check} strong>{t.added}</Chip>
                <Button onClick={onOpenMap}>{t.openMap}</Button>
              </>
            ) : (
              <Button variant="primary" icon={Sparkles} onClick={onAdd(fact.id)}>{t.addToKnowledge}</Button>
            )}
          </div>
        </section>
      ))}
      <Card title={t.outputsTitle}>
        <ul className="-mx-1 divide-y divide-app-border">
          {outputs.map((o) => {
            const Icon = OUTPUT_ICON[o.kind];
            return (
              <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1 py-2">
                <Icon size={15} className="shrink-0 text-app-text-secondary" aria-hidden="true" />
                <span className="min-w-[160px] flex-1 text-prose text-app-text">{o.title}</span>
                <Chip tone={o.tone}>{o.state}</Chip>
                <Button size="sm" onClick={o.onAction}>{o.actionLabel}</Button>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
