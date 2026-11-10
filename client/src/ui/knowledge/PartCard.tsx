import { ExternalLink, FileText, ListChecks, ScrollText } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Chip } from '../primitives/Chip';
import { FOCUS_RING } from '../shell/pressable';

/** One part of a document (an article, a paragraph, a step of a procedure) as the SARIM edition shows it. */
export interface PartCardModel {
  id: string;
  heading: string;
  /** A short passage of the official text, shown as quoted. */
  quote?: string;
  /** What the part means for the work, in plain words. */
  summary: string;
  /** What a step rests on: parts of laws, clauses of contracts. */
  rests: Array<{ id: string; label: string }>;
  /** What the agents check because of it, each opening the step that applies it. */
  checks: Array<{ id: string; label: string }>;
  /** How many cards, flow steps and clauses cite it. */
  cited: number;
  /** It can be opened in the official text. */
  official?: boolean;
}

/**
 * A part of a document: the heading (pressing it makes the part the current
 * one, so the address and the side panel follow), the official words when
 * there are some, what they mean in practice, what the part rests on and
 * what the agents check because of it. Every chip opens what it names.
 */
export function PartCard({ part, copy, focused, onFocus, onOpenRest, onOpenCheck, onOpenOfficial }: {
  part: PartCardModel;
  copy: UiCopy;
  focused?: boolean;
  onFocus?: (id: string) => void;
  onOpenRest?: (id: string) => void;
  onOpenCheck?: (id: string) => void;
  onOpenOfficial?: (id: string) => void;
}) {
  const k = copy.sarimData.knowledge.doc;
  const chipButton = clsx('max-w-full rounded hover:opacity-80', FOCUS_RING);
  return (
    <article
      data-part={part.id}
      aria-current={focused || undefined}
      className={clsx('rounded-lg border bg-surface px-4 py-3.5', focused ? 'border-primary shadow-[0_0_0_3px_rgba(0,102,255,0.15)]' : 'border-app-border')}
    >
      <header className="mb-2 flex flex-wrap items-start gap-x-3 gap-y-1">
        {onFocus ? (
          <button type="button" onClick={() => onFocus(part.id)} className={clsx('min-w-0 flex-1 basis-48 rounded text-left text-prose font-semibold text-app-text hover:underline underline-offset-2', FOCUS_RING)}>
            {part.heading}
          </button>
        ) : <h3 className="min-w-0 flex-1 basis-48 text-prose font-semibold text-app-text">{part.heading}</h3>}
        <Chip icon={ScrollText} tone={part.cited ? 'blue' : 'neutral'}>{k.cited(part.cited)}</Chip>
      </header>
      {part.quote && (
        <div className="mb-2.5">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{k.quoteTag}</span>
            {part.official && onOpenOfficial && (
              <button type="button" onClick={() => onOpenOfficial(part.id)} data-tip={k.officialPart} aria-label={k.officialPart} className={clsx('inline-flex h-5 w-5 items-center justify-center rounded text-app-text-tertiary hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]', FOCUS_RING)}>
                <ExternalLink size={12} aria-hidden="true" />
              </button>
            )}
          </div>
          <blockquote className="border-l-2 border-sky-500/50 pl-3 text-body-lg leading-7 text-app-text-body">«{part.quote}»</blockquote>
        </div>
      )}
      <div>
        {part.quote && <span className="mb-1 block text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{k.summaryTag}</span>}
        <p className={clsx('leading-6 text-app-text', part.quote ? 'text-prose' : 'text-body-lg leading-7')}>{part.summary}</p>
      </div>
      {part.rests.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-compact text-app-text-tertiary">{k.rests}</span>
          {part.rests.map((r) => (onOpenRest ? (
            <button key={r.id} type="button" onClick={() => onOpenRest(r.id)} className={chipButton}><Chip tone="violet" icon={FileText}>{r.label}</Chip></button>
          ) : <Chip key={r.id} tone="violet" icon={FileText}>{r.label}</Chip>))}
        </div>
      )}
      {part.checks.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-compact text-app-text-tertiary">{k.checksInline}</span>
          {part.checks.map((c) => (onOpenCheck ? (
            <button key={c.id} type="button" onClick={() => onOpenCheck(c.id)} className={chipButton}><Chip tone="blue" icon={ListChecks}>{c.label}</Chip></button>
          ) : <Chip key={c.id} tone="blue" icon={ListChecks}>{c.label}</Chip>))}
        </div>
      )}
    </article>
  );
}
