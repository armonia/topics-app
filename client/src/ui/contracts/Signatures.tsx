import type { ReactNode } from 'react';
import { Check, FileSignature, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Chip } from '../primitives/Chip';
import { READING_COLUMN } from '../shell/layout';
import type { ApprovalStepModel, PaperModel, PermissionRowModel } from './model';
import { Actor } from './SidePanels';
import { StateChip } from './StateChip';

/**
 * The approval chain of a version: one step after the other, each with who
 * (avatar and role), what they do, why they are in the chain, the state, the
 * date and the note. The current step carries the caller's controls.
 */
export function ApprovalChain({ steps, ariaLabel, currentActions, compact }: {
  steps: ApprovalStepModel[];
  /** The name of the list: «Catena di approvazione della v3». (allow-italian: quotes the Italian interface) */
  ariaLabel: string;
  currentActions?: ReactNode;
  /** The side-panel form: no reasons, no controls. */
  compact?: boolean;
}) {
  return (
    <ol aria-label={ariaLabel} className="flex flex-col">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const done = s.stateTone === 'green';
        return (
          <li key={s.id} data-step={s.id} className={clsx('relative flex gap-3', !last && 'pb-3')}>
            {!last && <span aria-hidden="true" className={clsx('absolute bottom-0 left-[13px] top-8 w-px', done ? 'bg-emerald-500/50' : 'bg-app-border-light')} />}
            <span
              className={clsx(
                'relative mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-compact font-semibold tabular-nums',
                done ? 'bg-emerald-600 text-white' : s.current ? 'bg-primary text-white ring-4 ring-primary/20' : 'bg-black/[0.06] text-app-text-secondary dark:bg-white/[0.1]',
              )}
            >
              {done ? <Check size={14} aria-hidden="true" /> : s.order}
            </span>
            <div className={clsx('min-w-0 flex-1 rounded-lg border px-3 py-2.5', s.current ? 'border-primary/40 bg-sky-500/[0.04]' : 'border-app-border bg-surface')}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-prose font-semibold text-app-text">{s.actionText}</span>
                <StateChip tone={s.stateTone}>{s.stateText}</StateChip>
                <span className="flex-1" />
                {s.at && <span className="text-mini tabular-nums text-app-text-tertiary">{s.at}</span>}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-compact">
                <Actor actor={s.who} size={18} />
                {s.who.detail && <span className="truncate text-app-text-tertiary">· {s.who.detail}</span>}
              </div>
              {!compact && s.why && <p className="mt-1 text-compact leading-4 text-app-text-tertiary">{s.why}</p>}
              {s.note && <p className="mt-1 text-prose leading-5 text-app-text-secondary">{s.note}</p>}
              {s.request && <p className="mt-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-compact leading-4 text-amber-800 dark:text-amber-300">{s.request}</p>}
              {!compact && s.current && currentActions && <div className="mt-2.5 border-t border-app-border pt-2.5">{currentActions}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Who may do what on this contract, by team: the team's level on Contratti
 * (the one «Squadra › Permessi» sets), what it may also do (approve, sign),
 * the people who have another level, and what its people do in this chain.
 * The reader's own team is marked. On a phone each team is a block, not a row
 * of a wide table: nothing scrolls sideways.
 */
export function PermissionTable({ rows, copy }: { rows: PermissionRowModel[]; copy: UiCopy }) {
  const t = copy.contracts.signatures;
  const m = t.matrix;
  /* the label of a cell, written only where the head row is not on show */
  const label = (text: string) => <span className="mr-1.5 text-compact text-app-text-tertiary md:hidden">{text}</span>;
  return (
    <div className="w-full min-w-0 overflow-hidden rounded-lg border border-app-border bg-surface">
      <table className="block w-full border-collapse text-prose md:table">
        <caption className="sr-only">{t.matrixTitle}</caption>
        <thead className="hidden md:table-header-group">
          <tr className="border-b border-app-border bg-app-inset text-compact font-medium text-app-text-secondary">
            <th scope="col" className="px-3 py-2 text-left font-medium">{m.team}</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">{m.people}</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">{m.level}</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">{m.can}</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">{m.chain}</th>
          </tr>
        </thead>
        <tbody className="block md:table-row-group">
          {rows.map((r) => (
            <tr key={r.id} data-team={r.id} className={clsx('block border-b border-app-border px-3 py-2.5 last:border-b-0 md:table-row md:px-0 md:py-0', r.you && 'bg-sky-500/[0.06]')}>
              <th scope="row" className="block text-left font-medium text-app-text md:table-cell md:px-3 md:py-2">
                {r.team}
                {r.you && <Chip tone="blue" className="ml-1.5">{t.you}</Chip>}
              </th>
              <td className="mt-1 block md:table-cell md:px-3 md:py-2">
                <span className="flex flex-wrap items-center gap-1">
                  {r.people.map((p) => <span key={p.name} data-tip={p.name}><Actor actor={p} size={18} showName={false} /></span>)}
                </span>
              </td>
              <td className="mt-1 block md:table-cell md:px-3 md:py-2">
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  {label(m.level)}
                  <Chip tone={r.levelTone} strong>{r.level}</Chip>
                </span>
                {r.exceptions.map((e) => <span key={e} className="mt-0.5 block text-compact leading-4 text-app-text-tertiary">{m.exception}: {e}</span>)}
              </td>
              <td className="mt-1 block text-compact leading-4 text-app-text-secondary md:table-cell md:px-3 md:py-2">
                {r.can.length > 0 && <>{label(m.can)}{r.can.join(', ')}</>}
              </td>
              <td className="mt-1 block text-compact leading-4 text-app-text-secondary md:table-cell md:px-3 md:py-2">
                {r.inChain && <>{label(m.chain)}{r.inChain}</>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A document as paper, like the original: its lines in a serif face, and for
 * a signed copy the block of the digital signatures with the fingerprint.
 */
export function PaperDocument({ paper, copy }: { paper: PaperModel; copy: UiCopy }) {
  const t = copy.contracts.attachment;
  return (
    <article data-paper="true" className={clsx(READING_COLUMN, 'rounded-lg bg-white px-5 py-8 font-serif text-[15px] leading-7 text-neutral-900 shadow-[0_1px_3px_rgba(0,0,0,0.12)] ring-1 ring-black/5 md:px-14')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 pb-3 font-sans text-mini text-neutral-500">
        <span className="font-medium uppercase tracking-[0.08em]">{paper.kindText}</span>
        {paper.versionText && <span>· {paper.versionText}</span>}
        <span className="flex-1" />
        <span className="tabular-nums">{paper.at}</span>
      </div>
      <h2 className="mt-4 text-center text-[17px] font-bold leading-6">{paper.title}</h2>
      <div className="mt-4 space-y-2.5">
        {paper.lines.map((l, i) => <p key={i}>{l}</p>)}
      </div>
      {paper.signature && (
        <section aria-label={t.signatureTitle} className="mt-8 rounded-md border border-emerald-700/30 bg-emerald-50 px-4 py-3 font-sans text-compact leading-5 text-emerald-950">
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold"><FileSignature size={14} aria-hidden="true" />{t.signatureTitle}</div>
          <ul className="space-y-0.5">
            {paper.signature.lines.map((l) => <li key={l} className="flex items-start gap-1.5"><ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{l}</li>)}
          </ul>
          <div className="mt-2 border-t border-emerald-700/20 pt-2 text-mini text-emerald-900">
            {t.hash}: <span className="break-all font-mono">{paper.signature.hash}</span>
          </div>
        </section>
      )}
    </article>
  );
}
