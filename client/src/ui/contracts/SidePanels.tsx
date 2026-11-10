import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Bot, CircleCheck, FileSignature, FileText, GitCompareArrows, Kanban, MessageSquare, Paperclip, ShieldCheck, Workflow } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { EmptyState } from '../primitives/EmptyState';
import { Checkbox, TextArea } from '../primitives/Field';
import { Avatar } from '../shell/SidebarRows';
import { FOCUS_RING, pressable } from '../shell/pressable';
import { TONE_TEXT } from '../tone';
import { StateChip } from './StateChip';
import type { ActorModel, AttachmentModel, CommentModel, LinkModel, ObligationModel, VersionModel } from './model';

/** A person (initials in a colour) or an agent (the bot glyph), with the name. */
export function Actor({ actor, size = 18, showName = true }: { actor: ActorModel; size?: number; showName?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {actor.agent ? (
        <span aria-hidden="true" style={{ width: size, height: size }} className="inline-flex shrink-0 items-center justify-center rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-300">
          <Bot size={Math.round(size * 0.65)} />
        </span>
      ) : (
        <Avatar text={actor.monogram} color={actor.color} size={size} />
      )}
      {showName && <span className="min-w-0 truncate text-app-text">{actor.name}</span>}
    </span>
  );
}

/* ---------- obligations ---------- */

function ObligationItem({ o, onFocus, onClose, closeDenied, onOpenCard, copy }: {
  o: ObligationModel;
  onFocus: (id: string) => void;
  onClose: ((id: string, proof: string) => void) | false;
  closeDenied?: string;
  onOpenCard: (cardId: string) => void;
  copy: UiCopy;
}) {
  const t = copy.contracts.side.obligations;
  const [closing, setClosing] = useState(false);
  const [proof, setProof] = useState('');
  return (
    <li
      data-obligation={o.id}
      className={clsx('rounded-lg border px-3 py-2.5 transition-colors', o.focused ? 'border-amber-500/60 bg-amber-500/[0.06]' : 'border-app-border bg-surface')}
    >
      <div
        role="button"
        aria-pressed={o.focused}
        {...pressable(() => onFocus(o.id))}
        className={clsx('-mx-1 -mt-0.5 cursor-pointer rounded-md px-1 py-0.5 hover:bg-app-hover', FOCUS_RING)}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={o.kindTone}>{o.kindText}</Chip>
          <Chip>{o.clauseLabel}</Chip>
          {o.done && <Chip tone="green" icon={CircleCheck}>{t.done}</Chip>}
        </div>
        <p className={clsx('mt-1 text-prose font-medium leading-5', o.done ? 'text-app-text-secondary line-through decoration-app-text-faint' : 'text-app-text')}>{o.what}</p>
        <p className={clsx('text-compact leading-4', o.whenTone ? TONE_TEXT[o.whenTone] : 'text-app-text-secondary')}>{o.whenText}</p>
        {o.every && <p className="text-mini leading-4 text-app-text-tertiary">{o.every}</p>}
        <div className="mt-1.5 flex items-center gap-1.5 text-compact text-app-text-secondary"><Actor actor={o.owner} size={16} /></div>
        {o.focused && (
          <blockquote className="mt-2 border-l-2 border-amber-500 pl-2 font-serif text-compact italic leading-5 text-app-text-secondary">«{o.quote}»</blockquote>
        )}
        {o.focused && o.versionNote && <p className="mt-1 text-mini leading-4 text-amber-700 dark:text-amber-400">{o.versionNote}</p>}
      </div>
      {o.proof && <p className="mt-1.5 rounded-md bg-emerald-500/[0.08] px-2 py-1 text-compact leading-4 text-emerald-800 dark:text-emerald-300">{o.proof}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {!o.focused && <Button size="sm" variant="ghost" onClick={() => onFocus(o.id)}>{t.highlight}</Button>}
        {o.card && <Button size="sm" variant="ghost" icon={Kanban} onClick={() => onOpenCard(o.card?.id ?? '')}>{o.card.label}</Button>}
        {!o.done && !closing && (
          <Button size="sm" icon={CircleCheck} onClick={onClose === false ? false : () => setClosing(true)} title={closeDenied}>{t.close}</Button>
        )}
      </div>
      {closing && onClose !== false && (
        <div className="mt-2 space-y-2">
          <TextArea label={t.proofLabel} value={proof} onChange={setProof} placeholder={t.proofPlaceholder} rows={2} hint={proof.trim() ? undefined : t.proofNeeded} />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => { setClosing(false); setProof(''); }}>{copy.contracts.common.cancel}</Button>
            <Button size="sm" variant="confirm" onClick={proof.trim() ? () => { onClose(o.id, proof.trim()); setClosing(false); setProof(''); } : false}>{t.closeWithProof}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function ObligationList({ items, onFocus, onClose, closeDenied, onOpenCard, copy, emptyText }: {
  items: ObligationModel[];
  onFocus: (id: string) => void;
  /** Closes one with its proof; `false` when this person may not, per obligation id. */
  onClose: (id: string) => ((id: string, proof: string) => void) | false;
  closeDenied: (id: string) => string | undefined;
  onOpenCard: (cardId: string) => void;
  copy: UiCopy;
  emptyText: string;
}) {
  if (!items.length) return <EmptyState icon={ShieldCheck} title={emptyText} className="min-h-0 py-6" />;
  return (
    <ul className="space-y-2">
      {items.map((o) => <ObligationItem key={o.id} o={o} onFocus={onFocus} onClose={onClose(o.id)} closeDenied={closeDenied(o.id)} onOpenCard={onOpenCard} copy={copy} />)}
    </ul>
  );
}

/* ---------- comments ---------- */

function CommentThread({ c, onReply, onResolve, denied, onOpenClause, copy }: {
  c: CommentModel;
  onReply: ((id: string, text: string) => void) | false;
  onResolve: ((id: string) => void) | false;
  denied?: string;
  onOpenClause: (id: string) => void;
  copy: UiCopy;
}) {
  const t = copy.contracts.side.comments;
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  return (
    <li data-comment={c.id} className={clsx('rounded-lg border px-3 py-2.5', c.resolved ? 'border-app-border bg-black/[0.015] dark:bg-white/[0.02]' : 'border-amber-500/40 bg-surface')}>
      <div className="flex items-center gap-2 text-compact">
        <Actor actor={c.author} size={16} />
        <span className="shrink-0 text-mini text-app-text-tertiary">{c.at}</span>
        <span className="flex-1" />
        {c.here ? (
          <span aria-current="true" className="shrink-0"><Chip>{c.clauseLabel}</Chip></span>
        ) : (
          <button type="button" onClick={() => onOpenClause(c.id)} className={clsx('shrink-0 rounded', FOCUS_RING)}><Chip>{c.clauseLabel}</Chip></button>
        )}
      </div>
      {c.changedNote && <p className="mt-1.5 flex items-start gap-1 text-mini leading-4 text-amber-700 dark:text-amber-400"><GitCompareArrows size={12} className="mt-0.5 shrink-0" aria-hidden="true" />{c.changedNote}</p>}
      <p className="mt-1.5 text-prose leading-5 text-app-text">{c.text}</p>
      {c.replies.length > 0 && (
        <ul className="mt-2 space-y-1.5 border-l-2 border-app-border-light pl-2.5">
          {c.replies.map((r) => (
            <li key={r.id}>
              <div className="flex items-center gap-2 text-compact"><Actor actor={r.author} size={14} /><span className="text-mini text-app-text-tertiary">{r.at}</span></div>
              <p className="text-prose leading-5 text-app-text-secondary">{r.text}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {c.resolved ? (
          <Chip tone="green" icon={CircleCheck}>{t.resolved}</Chip>
        ) : (
          <>
            {!replying && <Button size="sm" variant="ghost" icon={MessageSquare} onClick={onReply === false ? false : () => setReplying(true)} title={denied}>{t.reply}</Button>}
            <Button size="sm" variant="ghost" icon={CircleCheck} onClick={onResolve === false ? false : () => onResolve(c.id)} title={denied}>{t.resolve}</Button>
          </>
        )}
      </div>
      {replying && onReply !== false && (
        <div className="mt-2 space-y-2">
          <TextArea value={text} onChange={setText} placeholder={t.replyPlaceholder} rows={2} />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => { setReplying(false); setText(''); }}>{copy.contracts.common.cancel}</Button>
            <Button size="sm" variant="primary" onClick={text.trim() ? () => { onReply(c.id, text.trim()); setReplying(false); setText(''); } : false}>{t.sendReply}</Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function CommentList({ items, onReply, onResolve, denied, onOpenClause, showResolved, onShowResolved, copy, emptyText }: {
  items: CommentModel[];
  onReply: ((id: string, text: string) => void) | false;
  onResolve: ((id: string) => void) | false;
  denied?: string;
  onOpenClause: (commentId: string) => void;
  showResolved: boolean;
  onShowResolved: (v: boolean) => void;
  copy: UiCopy;
  emptyText: string;
}) {
  const t = copy.contracts.side.comments;
  const shown = showResolved ? items : items.filter((c) => !c.resolved);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-mini leading-4 text-app-text-tertiary">{t.internal}</p>
        <Checkbox checked={showResolved} onChange={onShowResolved} label={t.showResolved(items.filter((c) => c.resolved).length)} />
      </div>
      {shown.length ? (
        <ul className="space-y-2">
          {shown.map((c) => <CommentThread key={c.id} c={c} onReply={onReply} onResolve={onResolve} denied={denied} onOpenClause={onOpenClause} copy={copy} />)}
        </ul>
      ) : (
        <EmptyState icon={MessageSquare} title={emptyText} className="min-h-0 py-6" />
      )}
    </div>
  );
}

/* ---------- versions ---------- */

export function VersionList({ items, comparing, picked, onToggleCompare, onPick, onShow, onCompare, copy }: {
  items: VersionModel[];
  comparing: boolean;
  picked: number[];
  onToggleCompare: () => void;
  onPick: (n: number) => void;
  onShow: (n: number) => void;
  /** Opens the comparison of the two picked; `false` until two are picked. */
  onCompare: Action;
  copy: UiCopy;
}) {
  const t = copy.contracts.side.versions;
  const [a, b] = [...picked].sort((x, y) => x - y);
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-pressed={comparing}
          onClick={onToggleCompare}
          className={clsx(
            'inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-prose font-medium transition-colors',
            comparing ? 'bg-primary text-white hover:bg-primary-hover' : 'bg-black/[0.05] text-app-text hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]',
            FOCUS_RING,
          )}
        >
          <GitCompareArrows size={14} aria-hidden="true" />{t.compareToggle}
        </button>
        {comparing && (
          <Button variant="primary" onClick={onCompare}>{picked.length === 2 ? t.openCompare(a, b) : t.pickTwo}</Button>
        )}
      </div>
      {comparing && <p className="text-mini leading-4 text-app-text-tertiary">{t.compareHint}</p>}
      <ol className="relative">
        {items.map((v, i) => {
          const last = i === items.length - 1;
          return (
            <li key={v.n} data-version={v.n} className={clsx('relative flex gap-3', !last && 'pb-3')}>
              {!last && <span aria-hidden="true" className="absolute bottom-0 left-[11.5px] top-7 w-px bg-app-border-light" />}
              <span className={clsx('relative mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-mini font-semibold', v.signed ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300' : 'bg-amber-500/15 text-amber-800 dark:text-amber-300')}>
                {v.signed ? <FileSignature size={13} aria-hidden="true" /> : v.n}
              </span>
              <div className={clsx('min-w-0 flex-1 rounded-lg px-2 py-1', v.onShow && 'bg-black/[0.04] dark:bg-white/[0.06]')}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-prose font-semibold text-app-text">{v.label}</span>
                  {v.inForce && <StateChip tone="green">{t.inForce}</StateChip>}
                  {v.signed && !v.inForce && <StateChip tone="green">{t.signedSeal}</StateChip>}
                  {v.draft && <StateChip tone={v.toApprove ? 'amber' : 'neutral'}>{v.toApprove ? t.toApprove : t.draft}</StateChip>}
                  <span className="flex-1" />
                  <span className="text-mini tabular-nums text-app-text-tertiary">{v.at}</span>
                </div>
                <p className="mt-0.5 text-prose leading-5 text-app-text-secondary">{v.reason}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-compact text-app-text-secondary">
                  <Actor actor={v.author} size={16} />
                  <Chip>{v.originText}</Chip>
                  {v.valueText && <span className="tabular-nums">{v.valueText}</span>}
                </div>
                {v.draftedBy && <p className="mt-0.5 flex items-center gap-1 text-mini text-violet-700 dark:text-violet-300"><Bot size={12} aria-hidden="true" />{v.draftedBy}</p>}
                <div className="mt-1.5 flex items-center gap-2">
                  {comparing ? (
                    <Checkbox checked={picked.includes(v.n)} onChange={() => onPick(v.n)} label={t.pick(v.n)} />
                  ) : (
                    <Button size="sm" variant={v.onShow ? 'secondary' : 'ghost'} icon={FileText} onClick={v.onShow ? false : () => onShow(v.n)}>{v.onShow ? t.onShow : t.show}</Button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ---------- attachments and links ---------- */

export function AttachmentList({ items, onOpen, copy }: { items: AttachmentModel[]; onOpen: (id: string) => void; copy: UiCopy }) {
  if (!items.length) return <EmptyState icon={Paperclip} title={copy.contracts.side.attachments.empty} className="min-h-0 py-6" />;
  return (
    <ul className="space-y-1.5">
      {items.map((a) => (
        <li key={a.id}>
          <button type="button" onClick={() => onOpen(a.id)} className={clsx('flex w-full items-start gap-2.5 rounded-lg border border-app-border bg-surface px-3 py-2 text-left transition-colors hover:bg-app-hover', FOCUS_RING)}>
            <FileText size={15} className="mt-0.5 shrink-0 text-app-text-tertiary" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-prose font-medium leading-5 text-app-text">{a.name}</span>
              <span className="block text-compact leading-4 text-app-text-tertiary">{a.detail}</span>
            </span>
            <Chip tone={a.kindTone}>{a.kindText}</Chip>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function LinkList({ flows, cards, onOpen, copy }: { flows: LinkModel[]; cards: LinkModel[]; onOpen: (l: LinkModel) => void; copy: UiCopy }) {
  const t = copy.contracts.side.links;
  if (!flows.length && !cards.length) return <EmptyState icon={Workflow} title={t.empty} className="min-h-0 py-6" />;
  const group = (label: string, items: LinkModel[], Icon: LucideIcon) => items.length > 0 && (
    <div>
      <div className="mb-1.5 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{label}</div>
      <ul className="space-y-1.5">
        {items.map((l) => {
          const RowIcon = l.icon ?? Icon;
          return (
          <li key={`${l.kind}:${l.id}`}>
            <button type="button" onClick={() => onOpen(l)} className={clsx('flex w-full items-start gap-2.5 rounded-lg border border-app-border bg-surface px-3 py-2 text-left transition-colors hover:bg-app-hover', FOCUS_RING)}>
              <RowIcon size={15} className="mt-0.5 shrink-0 text-app-text-tertiary" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-prose font-medium leading-5 text-app-text">{l.title}</span>
                <span className="block text-compact leading-4 text-app-text-tertiary">{l.detail}</span>
              </span>
              {l.statusText && <StateChip tone={l.statusTone}>{l.statusText}</StateChip>}
            </button>
          </li>
          );
        })}
      </ul>
    </div>
  );
  return (
    <div className="space-y-3">
      {group(t.flows, flows, Workflow)}
      {group(t.cards, cards, Kanban)}
    </div>
  );
}
