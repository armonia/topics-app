import clsx from 'clsx';
import { Check, Clock, Sparkles, X } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import type { Action, SourceModel } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { RichText } from '../primitives/RichText';
import { Source } from '../primitives/Source';
import type { ValueOriginModel } from './model';

/**
 * Where a value comes from, opened from the value itself: the original's own
 * words with the passage marked, then the rule that turned them into the
 * value, then the way to apply it or to open the whole document. Positioned
 * under its field by the field's own box (`absolute`, `top-full`). `onClose`
 * adds the way to dismiss it; `onOpenSource` makes the cited page open.
 */
export function ValueOrigin({ origin, copy, onUse, onEdit, applied, onOpenDocument, onOpenSource, onClose, inline }: {
  origin: ValueOriginModel;
  copy: UiCopy;
  onUse?: Action;
  /** Opens the field for typing over the value. */
  onEdit?: Action;
  /** The value is already the one on the record: «use» is a fact, not a button. */
  applied?: boolean;
  onOpenDocument?: Action;
  onOpenSource?: (source: SourceModel) => void;
  onClose?: () => void;
  /** In the flow of the page (the phone), not hanging under a field. */
  inline?: boolean;
}) {
  return (
    <div role="dialog" aria-label={copy.inbox.why(origin.value)} ref={inline ? (el) => el?.scrollIntoView?.({ block: 'nearest' }) : undefined} className={inline ? 'relative w-full overflow-hidden rounded-xl border border-app-border bg-surface' : 'absolute left-0 top-full z-20 mt-3 w-[520px] overflow-hidden rounded-xl border border-app-border bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.16)]'}>
      {!inline && <span aria-hidden="true" className="absolute -top-[7px] left-10 h-3 w-3 rotate-45 border-l border-t border-app-border bg-surface" />}
      <div className={clsx('flex items-center gap-2 border-b border-app-border px-4 py-2.5', inline && 'flex-wrap')}>
        <Chip tone="pink" icon={Sparkles} strong>{copy.common.ai}</Chip>
        <span className={clsx('text-prose font-semibold text-app-text', inline ? 'min-w-0 basis-[calc(100%-5rem)]' : 'flex-1')}>{copy.inbox.why(origin.value)}</span>
        <Source source={origin.source} pageLabel={copy.common.page} onOpen={onOpenSource} />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={copy.common.close}
            data-tip={copy.common.close}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.08]"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <blockquote className="border-b border-app-border px-4 py-3 font-serif text-body-lg leading-7 text-app-text-secondary">
        {origin.before}
        <mark className="rounded-sm bg-amber-300/50 px-0.5 text-app-text dark:bg-amber-400/30">{origin.highlight}</mark>
        {origin.after}
      </blockquote>
      <div className="flex gap-2.5 bg-amber-500/10 px-4 py-3 text-compact leading-5 text-app-text-body">
        <Clock size={14} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
        <p><RichText text={origin.reasoning} pageLabel={copy.common.page} /></p>
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-app-border px-3 py-2">
        {applied ? (
          <Chip tone="green" icon={Check} className="mx-1">{copy.work.inbox.valueUsed(origin.shortValue)}</Chip>
        ) : (
          <Button onClick={onUse}>{copy.inbox.use(origin.shortValue)}</Button>
        )}
        {onEdit !== undefined && <Button variant="ghost" onClick={onEdit}>{copy.work.inbox.correct}</Button>}
        <Button variant="ghost" onClick={onOpenDocument}>{copy.inbox.openDocument}</Button>
        <span className="ml-auto whitespace-nowrap text-compact text-app-text-tertiary">{copy.inbox.sourcesConsulted(origin.consulted)}</span>
      </div>
    </div>
  );
}

/**
 * The same popover for a value whose origin is not known here: it opens where
 * the reader asked and says so plainly, instead of not opening at all.
 */
export function OriginUnknown({ value, copy, onClose }: { value: string; copy: UiCopy; onClose?: () => void }) {
  return (
    <div role="dialog" aria-label={copy.inbox.why(value)} className="absolute left-0 top-full z-20 mt-3 w-[420px] overflow-hidden rounded-xl border border-app-border bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.16)]">
      <span aria-hidden="true" className="absolute -top-[7px] left-10 h-3 w-3 rotate-45 border-l border-t border-app-border bg-surface" />
      <div className="flex items-center gap-2 border-b border-app-border px-4 py-2.5">
        <span className="flex-1 truncate text-prose font-semibold text-app-text">{copy.inbox.why(value)}</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={copy.common.close}
            data-tip={copy.common.close}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 dark:hover:bg-white/[0.08]"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="px-4 py-3 text-prose leading-6 text-app-text-secondary">{copy.preview.originNotLoaded}</p>
    </div>
  );
}
