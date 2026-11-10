import type { ReactNode } from 'react';
import { ListChecks, Lock, MessageSquare, PenLine, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { READING_COLUMN } from '../shell/layout';
import { FOCUS_RING } from '../shell/pressable';
import type { Tone } from '../types';
import type { ClauseBlockModel } from './model';

/** Chips on paper: the paper stays white in the dark theme too, so the ink stays dark. */
const PAPER_CHIP: Record<Tone, string> = {
  neutral: 'bg-black/[0.05] text-neutral-700',
  blue: 'bg-sky-500/15 text-sky-800',
  green: 'bg-emerald-500/15 text-emerald-800',
  amber: 'bg-amber-500/20 text-amber-900',
  red: 'bg-rose-500/15 text-rose-800',
  violet: 'bg-violet-500/15 text-violet-800',
  pink: 'bg-fuchsia-500/15 text-fuchsia-800',
};

/** The text with the marked words lit, when they are in it; the rest as printed. */
function Marked({ text, mark }: { text: string; mark?: string }) {
  const at = mark ? text.indexOf(mark) : -1;
  if (!mark || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark data-quote="true" className="rounded-sm bg-amber-300/60 px-0.5 text-inherit ring-1 ring-amber-500/50">{text.slice(at, at + mark.length)}</mark>
      {text.slice(at + mark.length)}
    </>
  );
}

/** A small count under a clause that opens its list on the side; with none yet, only the glyph. */
function CountButton({ icon: Icon, label, aria, onClick, tone, current }: { icon: typeof ListChecks; label: string; aria: string; onClick: () => void; tone?: 'amber'; current?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={aria}
      aria-pressed={current ?? false}
      data-tip={aria}
      className={clsx(
        'inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-sans text-mini transition-colors',
        tone === 'amber' ? 'text-amber-800 hover:bg-amber-500/15' : 'text-neutral-500 hover:bg-black/[0.05] hover:text-neutral-800',
        current && 'bg-black/[0.06]',
        FOCUS_RING,
      )}
    >
      <Icon size={12} aria-hidden="true" />{label}
    </button>
  );
}

/**
 * A version of a contract as paper: its heading, the state of the version
 * (signed and sealed, or a draft), then every clause with its stable number.
 * Each clause carries `data-clause`, says how many comments and obligations
 * point at it, and the marks of what changed it; the focused one is ringed and
 * brought into view each time it is asked for. The words of an obligation
 * light up inside it.
 */
export function ContractText({ heading, subheading, stamp, stampTone, clauses, focusKey, onClause, onComments, onObligations, onBadge, copy, footer }: {
  heading: string;
  subheading: string;
  /** The state of the version on show: «Firmata il 29/01/2026: testo bloccato», «Bozza in lavorazione». (allow-italian: quotes the Italian interface) */
  stamp: string;
  stampTone: 'sealed' | 'draft' | 'locked';
  clauses: ClauseBlockModel[];
  /** Changes every time the focus is asked again (another clause, another obligation), so the focused clause is scrolled to again. */
  focusKey?: string;
  onClause: (id: string) => void;
  onComments: (id: string) => void;
  onObligations: (id: string) => void;
  onBadge: (clauseId: string, badgeId: string) => void;
  copy: UiCopy;
  footer?: ReactNode;
}) {
  const t = copy.contracts.page;
  const StampIcon = stampTone === 'sealed' ? ShieldCheck : stampTone === 'locked' ? Lock : PenLine;
  return (
    <article data-paper="true" className={clsx(READING_COLUMN, 'rounded-lg bg-white px-5 py-7 font-serif text-[15px] leading-7 text-neutral-900 shadow-[0_1px_3px_rgba(0,0,0,0.12)] ring-1 ring-black/5 md:px-12')}>
      <header className="mb-5 border-b border-neutral-200 pb-4 text-center">
        <div className="font-sans text-mini font-medium uppercase tracking-[0.08em] text-neutral-500">{subheading}</div>
        <h2 className="mt-1 text-[17px] font-bold leading-6">{heading}</h2>
        <div
          className={clsx(
            'mt-2.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-sans text-mini font-medium',
            stampTone === 'sealed' ? 'bg-emerald-600/10 text-emerald-800 ring-1 ring-emerald-600/30' : stampTone === 'locked' ? 'bg-sky-600/10 text-sky-800 ring-1 ring-sky-600/30' : 'bg-amber-500/15 text-amber-900 ring-1 ring-amber-600/30',
          )}
        >
          <StampIcon size={12} aria-hidden="true" />{stamp}
        </div>
      </header>
      <ol className="space-y-1">
        {clauses.map((c) => (
          <li
            key={c.id}
            id={`clause-${c.id}`}
            data-clause={c.id}
            data-focused={c.focused ? 'true' : undefined}
            ref={(el) => {
              // Brings the focused clause into view once per focus asked, not on every render.
              const key = focusKey ?? '1';
              if (el && c.focused && el.dataset.seen !== key) {
                el.dataset.seen = key;
                el.scrollIntoView?.({ block: 'center' });
              }
            }}
            className={clsx('-mx-3 rounded-lg px-3 py-2 transition-colors', c.focused ? 'bg-sky-500/[0.07] ring-2 ring-sky-500/50' : 'hover:bg-black/[0.02]')}
          >
            {c.focused ? (
              <h3 aria-current="true" className="font-bold leading-6">{t.clauseHeading(c.n, c.title)}</h3>
            ) : (
              <button type="button" onClick={() => onClause(c.id)} className={clsx('rounded text-left font-bold leading-6', FOCUS_RING)}>
                {t.clauseHeading(c.n, c.title)}
              </button>
            )}
            <p className="mt-0.5"><Marked text={c.text} mark={c.mark} /></p>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <CountButton icon={MessageSquare} label={c.comments ? String(c.comments) : ''} aria={t.commentsOf(c.n, c.comments, c.openComments)} onClick={() => onComments(c.id)} tone={c.openComments ? 'amber' : undefined} current={c.sideOpen === 'comments'} />
              <CountButton icon={ListChecks} label={c.obligations ? String(c.obligations) : ''} aria={t.obligationsOf(c.n, c.obligations)} onClick={() => onObligations(c.id)} current={c.sideOpen === 'obligations'} />
              {c.badges.map((b) => (
                b.opens ? (
                  <button key={b.id} type="button" onClick={() => onBadge(c.id, b.id)} className={clsx('inline-flex h-5 items-center rounded px-1.5 font-sans text-mini leading-4 transition-colors hover:brightness-95', PAPER_CHIP[b.tone], FOCUS_RING)}>
                    {b.label}
                  </button>
                ) : (
                  <span key={b.id} className={clsx('inline-flex h-5 items-center rounded px-1.5 font-sans text-mini leading-4', PAPER_CHIP[b.tone])}>{b.label}</span>
                )
              ))}
            </div>
          </li>
        ))}
      </ol>
      {footer && <footer className="mt-6 border-t border-neutral-200 pt-4 font-sans text-compact text-neutral-600">{footer}</footer>}
    </article>
  );
}

/**
 * Which version of the text is on show: one choice per version, the signed
 * ones with a seal, the open draft marked. One is chosen at a time.
 */
export function VersionPicker({ versions, value, onChange, ariaLabel }: {
  versions: Array<{ n: number; label: string; signed: boolean; draft: boolean; title: string }>;
  value: number;
  onChange: (n: number) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex flex-wrap gap-1 rounded-lg bg-black/[0.05] p-0.5 dark:bg-white/10">
      {versions.map((v) => {
        const on = v.n === value;
        const Icon = v.signed ? ShieldCheck : v.draft ? PenLine : null;
        return (
          <button
            key={v.n}
            type="button"
            role="radio"
            aria-checked={on}
            data-tip={v.title}
            onClick={() => onChange(v.n)}
            className={clsx(
              'inline-flex h-6 items-center gap-1 rounded-md px-2 text-compact font-medium transition-colors',
              on ? 'bg-app-bg text-app-text shadow-sm ring-1 ring-black/5 dark:bg-white/15 dark:ring-white/10' : 'text-app-text-secondary hover:text-app-text',
              FOCUS_RING,
            )}
          >
            {Icon && <Icon size={12} className={v.signed ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'} aria-hidden="true" />}
            {v.label}
          </button>
        );
      })}
    </div>
  );
}
