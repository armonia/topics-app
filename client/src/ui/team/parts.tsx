import { useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, CircleCheck, Clock, ChevronDown, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { Action, Tone } from '../types';
import { Chip } from '../primitives/Chip';
import { Menu, type MenuItemModel } from '../primitives/Menu';
import { ProgressBar } from '../primitives/Progress';
import { ErrorState } from '../primitives/States';
import { Button } from '../primitives/Button';
import { FOCUS_RING } from '../shell/pressable';

/** A title over a table or a list, with a quiet line and actions on the right. */
export function SectionHead({ title, aside, actions, className }: { title: ReactNode; aside?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={clsx('mb-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1', className)}>
      <h3 className="text-body-lg font-semibold text-app-text">{title}</h3>
      {aside && <span className="min-w-0 text-prose text-app-text-tertiary">{aside}</span>}
      {actions && <span className="ml-auto flex shrink-0 items-center gap-2">{actions}</span>}
    </div>
  );
}

/** A state as a chip with its glyph: the glyph carries it as much as the colour. */
export type StateIcon = 'ok' | 'near' | 'bad' | 'todo';
const STATE_ICON: Record<StateIcon, LucideIcon> = { ok: CircleCheck, near: Clock, bad: CircleAlert, todo: Clock };
export function StateChip({ tone, icon, children, title }: { tone: Tone; icon?: StateIcon; children: ReactNode; title?: string }) {
  return <Chip tone={tone} icon={icon ? STATE_ICON[icon] : undefined} title={title}>{children}</Chip>;
}

/** A button that opens a menu of actions at its own corner, so a table cell never clips it. */
export function RowMenu({ label, items, onSelect, disabled, title }: {
  label: string;
  items: MenuItemModel[];
  onSelect: (id: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        disabled={disabled}
        data-tip={title}
        onClick={() => {
          const r = ref.current?.getBoundingClientRect();
          setAt({ x: r ? r.left : 0, y: r ? r.bottom + 4 : 0 });
        }}
        className={clsx(
          'inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-mini font-medium transition-colors',
          FOCUS_RING,
          disabled ? 'cursor-default bg-black/[0.04] text-app-text-tertiary dark:bg-white/[0.05]' : 'bg-black/[0.05] text-app-text hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]',
        )}
      >
        {label}
        <ChevronDown size={11} className="text-app-text-tertiary" aria-hidden="true" />
      </button>
      {at && <Menu x={at.x} y={at.y} items={items} ariaLabel={label} onSelect={onSelect} onClose={() => setAt(null)} />}
    </>
  );
}

/** The name of something that opens, drawn as text: the row's way in when the row also has buttons. */
export function TitleButton({ onClick, children, title, className }: { onClick?: () => void; children: ReactNode; title?: string; className?: string }) {
  if (!onClick) return <span className={clsx('[overflow-wrap:break-word]', className)} data-tip={title}>{children}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      data-tip={title}
      className={clsx('min-w-0 max-w-full rounded text-left [overflow-wrap:break-word] font-medium text-app-text underline-offset-2 hover:underline', FOCUS_RING, className)}
    >
      {children}
    </button>
  );
}

export interface JobCardModel {
  title: string;
  status: 'running' | 'done' | 'failed';
  /** 0 to 1 */
  progress: number;
  current?: string;
  detail?: string;
  done: string[];
  failedTitle?: string;
  failedBody?: string;
  retryLabel?: string;
  onRetry?: Action;
}

/** A job in progress, as every page of the area shows it: a bar, the step now, the steps done; a failure says so and offers a retry. */
export function JobCard({ job }: { job: JobCardModel }) {
  const failed = job.status === 'failed';
  return (
    <section aria-live="polite" data-job={job.status} className={clsx('rounded-lg border bg-surface px-4 py-3', failed ? 'border-rose-500/40' : 'border-app-border')}>
      {failed ? (
        <ErrorState
          className="min-h-0 py-2"
          title={job.failedTitle ?? job.title}
          body={job.failedBody}
          action={job.retryLabel && job.onRetry !== undefined ? <Button variant="primary" onClick={job.onRetry}>{job.retryLabel}</Button> : undefined}
        />
      ) : (
        <>
          <ProgressBar value={job.progress} tone={job.status === 'done' ? 'green' : 'blue'} label={job.current ?? job.title} detail={job.detail} />
          {job.done.length > 0 && (
            <ul className="mt-2.5 flex flex-col gap-0.5">
              {job.done.slice(-4).map((d, i) => (
                <li key={`${d}-${i}`} className="flex items-center gap-1.5 text-mini leading-4 text-app-text-secondary">
                  <Check size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  <span className="truncate">{d}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
