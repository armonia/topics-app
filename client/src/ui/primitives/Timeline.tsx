import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { Tone } from '../types';
import { TONE_CHIP } from '../tone';
import { FOCUS_RING, pressable } from '../shell/pressable';

export interface TimelineItemModel {
  id: string;
  /** When, already formatted: `oggi 9:40`, `12 mar`. */
  at: string;
  title: string;
  detail?: string;
  /** Who did it, a person or a step. */
  who?: string;
  tone?: Tone;
  icon?: LucideIcon;
  onOpen?: () => void;
}

/**
 * What happened, in order: a glyph in the tone of each event on a thin line,
 * the event on the right with its time, a sentence and who did it. An event
 * with `onOpen` is pressable and says so on hover; the rest is plain text.
 */
export function Timeline({ items, ariaLabel, className }: { items: TimelineItemModel[]; ariaLabel?: string; className?: string }) {
  return (
    <ol aria-label={ariaLabel} className={clsx('flex flex-col', className)}>
      {items.map((it, i) => {
        const Icon = it.icon;
        const last = i === items.length - 1;
        return (
          <li key={it.id} className={clsx('relative flex gap-3', !last && 'pb-3')}>
            {!last && <span aria-hidden="true" className="absolute bottom-0 left-[11.5px] top-7 w-px bg-app-border-light" />}
            <span className={clsx('relative mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full', TONE_CHIP[it.tone ?? 'neutral'])}>
              {Icon ? <Icon size={13} aria-hidden="true" /> : <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />}
            </span>
            <div
              {...pressable(it.onOpen)}
              role={it.onOpen ? 'button' : undefined}
              className={clsx(
                'min-w-0 flex-1 rounded-lg px-2 py-1',
                it.onOpen && `cursor-pointer transition-colors hover:bg-app-hover ${FOCUS_RING}`,
              )}
            >
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 text-prose font-medium leading-5 text-app-text">{it.title}</span>
                <span className="shrink-0 text-mini tabular-nums text-app-text-tertiary">{it.at}</span>
              </div>
              {it.detail && <p className="mt-0.5 break-words text-prose leading-5 text-app-text-secondary [overflow-wrap:anywhere]">{it.detail}</p>}
              {it.who && <p className="mt-0.5 text-mini leading-4 text-app-text-tertiary">{it.who}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
