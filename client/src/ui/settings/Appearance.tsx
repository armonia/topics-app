import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import clsx from 'clsx';
import { FOCUS_RING } from '../shell/pressable';

/** One choice among a few, drawn as a card with a picture of the result: a radio, so only one is on. */
export function ChoiceCard({ label, hint, checked, onSelect, children, disabled, title }: {
  label: string;
  hint?: string;
  checked: boolean;
  onSelect: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      data-tip={title}
      onClick={onSelect}
      className={clsx(
        'group flex min-w-0 flex-col gap-2 rounded-lg border p-2.5 text-left transition-colors',
        FOCUS_RING,
        checked ? 'border-primary bg-primary/[0.05] ring-1 ring-primary' : 'border-app-border bg-surface hover:border-app-border-light hover:bg-app-hover',
        disabled && 'cursor-default opacity-50',
      )}
    >
      <div className="overflow-hidden rounded-md">{children}</div>
      <div className="flex items-start gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <div className="text-prose font-medium leading-5 text-app-text">{label}</div>
          {hint && <div className="text-mini leading-4 text-app-text-tertiary">{hint}</div>}
        </div>
        <span
          aria-hidden="true"
          className={clsx('mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', checked ? 'border-primary bg-primary text-white' : 'border-black/25 dark:border-white/25')}
        >
          {checked && <Check size={10} strokeWidth={3} />}
        </span>
      </div>
    </button>
  );
}

/** The set of choice cards: a radio group with its name. */
export function ChoiceGroup({ ariaLabel, columns = 3, children }: { ariaLabel: string; columns?: 2 | 3; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={clsx('grid min-w-0 gap-3', columns === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2')}>
      {children}
    </div>
  );
}

type Palette = { bg: string; side: string; card: string; line: string; text: string; faint: string; accent: string };

/* Fixed colours: a picture of a theme must not follow the theme the page is in. */
const PALETTE: Record<'light' | 'dark', Palette> = {
  light: { bg: '#f5f5f7', side: '#ebebee', card: '#ffffff', line: '#d9d9de', text: '#1d1d1f', faint: '#a1a1a8', accent: '#0a84ff' },
  dark: { bg: '#1c1c1e', side: '#26262a', card: '#2c2c30', line: '#3d3d42', text: '#f2f2f4', faint: '#6e6e76', accent: '#3b9bff' },
};

/** A small picture of the app in one theme: a sidebar, a header and three rows, drawn with CSS. */
function SmallApp({ p, half }: { p: Palette; half?: boolean }) {
  return (
    <div className="flex h-[84px] w-full" style={{ background: p.bg, width: half ? '200%' : '100%' }} aria-hidden="true">
      <div className="flex w-[28%] flex-col gap-1.5 p-2" style={{ background: p.side }}>
        <span className="h-2 w-3/4 rounded-sm" style={{ background: p.accent }} />
        <span className="h-1.5 w-full rounded-sm" style={{ background: p.line }} />
        <span className="h-1.5 w-2/3 rounded-sm" style={{ background: p.line }} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <span className="h-2 w-1/3 rounded-sm" style={{ background: p.text }} />
        {[0, 1, 2].map((i) => (
          <span key={i} className="flex h-3.5 items-center gap-1.5 rounded px-1.5" style={{ background: p.card, border: `1px solid ${p.line}` }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: i === 0 ? p.accent : p.faint }} />
            <span className="h-1 flex-1 rounded-sm" style={{ background: p.line }} />
          </span>
        ))}
      </div>
    </div>
  );
}

/** The picture of a theme: light, dark, or the two cut in half for «like the system». */
export function ThemeThumb({ mode }: { mode: 'light' | 'dark' | 'system' }) {
  if (mode === 'system') {
    return (
      <div className="flex h-[84px] w-full overflow-hidden">
        <div className="w-1/2 overflow-hidden"><SmallApp p={PALETTE.light} half /></div>
        <div className="w-1/2 overflow-hidden"><div className="-translate-x-1/2"><SmallApp p={PALETTE.dark} half /></div></div>
      </div>
    );
  }
  return <SmallApp p={PALETTE[mode]} />;
}

/** The picture of a density: the sidebar rows of the app with the room each setting gives them, in words. */
export function DensityThumb({ rows, density }: { rows: string[]; density: 'compact' | 'comfortable' | 'spacious' }) {
  const height = density === 'compact' ? 'h-5' : density === 'comfortable' ? 'h-7' : 'h-9';
  return (
    <div className="flex flex-col gap-0.5 bg-black/[0.04] p-1.5 dark:bg-white/[0.05]" aria-hidden="true">
      {rows.map((r, i) => (
        <span key={r} className={clsx('flex items-center rounded px-2 text-mini text-app-text', height, i === 0 ? 'bg-black/[0.07] font-medium dark:bg-white/[0.12]' : 'text-app-text-secondary')}>{r}</span>
      ))}
    </div>
  );
}
