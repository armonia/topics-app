import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { Tone } from '../types';
import { TONE_CHIP } from '../tone';
import { Chip } from '../primitives/Chip';

/**
 * The block every settings page is made of: a surface with a title, a line
 * that says what it is for, optional actions on the right, and the content.
 */
export function Block({ title, description, actions, children, className, bodyClassName }: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx('min-w-0 rounded-lg border border-app-border bg-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3.5">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-body-lg font-semibold leading-6 text-app-text">{title}</h2>}
            {description && <p className="mt-0.5 text-prose leading-5 text-app-text-secondary">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx('min-w-0 px-4 pb-4', title || actions ? 'pt-3' : 'pt-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** One setting: its words on the left, its control on the right; the rows of a block are divided by hairlines. */
export function SettingRow({ label, description, control, className }: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-app-border py-2.5 first:border-t-0 first:pt-0 last:pb-0', className)}>
      <div className="min-w-[180px] flex-1">
        <div className="text-prose leading-5 text-app-text">{label}</div>
        {description && <p className="text-mini leading-4 text-app-text-tertiary">{description}</p>}
      </div>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">{control}</div>
    </div>
  );
}

/** A line of a list with a glyph tile, two lines of words and an action: a device, a passkey, an address. */
export function ListRow({ icon: Icon, title, detail, trailing, tone = 'neutral' }: {
  icon: LucideIcon;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-app-border py-2.5 first:border-t-0 first:pt-0 last:pb-0">
      <span className={clsx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', TONE_CHIP[tone])}>
        <Icon size={16} aria-hidden="true" />
      </span>
      <div className="min-w-[140px] flex-1">
        <div className="truncate text-prose font-medium leading-5 text-app-text">{title}</div>
        {detail && <div className="truncate text-mini leading-4 text-app-text-tertiary">{detail}</div>}
      </div>
      {trailing && <div className="flex shrink-0 flex-wrap items-center gap-2">{trailing}</div>}
    </div>
  );
}

/** A passage the page wants noticed: a state it is in, a limit, a warning. */
export function Callout({ icon: Icon, tone = 'neutral', children }: { icon?: LucideIcon; tone?: Tone; children: ReactNode }) {
  return (
    <div className={clsx('flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-prose leading-5', TONE_CHIP[tone])}>
      {Icon && <Icon size={15} className="mt-0.5 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1 text-app-text">{children}</div>
    </div>
  );
}

/** The kind of a number the product prints: a goal, an estimate or an example. */
export function KindChip({ kind, label }: { kind: 'goal' | 'estimate' | 'example'; label: string }) {
  return <Chip tone={kind === 'goal' ? 'green' : kind === 'estimate' ? 'amber' : 'neutral'}>{label}</Chip>;
}

/** A row of short notes under a page: how it works, what is not promised. */
export function Notes({ items }: { items: Array<{ title: string; text: ReactNode }> }) {
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((n) => (
        <div key={n.title} className="min-w-0 rounded-lg border border-app-border bg-surface px-3.5 py-3">
          <h3 className="text-prose font-semibold leading-5 text-app-text">{n.title}</h3>
          <div className="mt-1 text-prose leading-5 text-app-text-secondary">{n.text}</div>
        </div>
      ))}
    </div>
  );
}

/** A number that matters, with its words in full: the tile of a strip of measures. */
export function KpiTile({ label, value, detail, good }: { label: string; value: string; detail?: string; good?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-app-border bg-surface px-4 py-3.5">
      <div className={clsx('text-display font-semibold leading-9 tabular-nums', good ? 'text-emerald-700 dark:text-emerald-400' : 'text-app-text')}>{value}</div>
      <div className="text-prose leading-5 text-app-text-secondary">{label}</div>
      {detail && <div className="mt-0.5 text-compact leading-4 text-app-text-tertiary">{detail}</div>}
    </div>
  );
}
