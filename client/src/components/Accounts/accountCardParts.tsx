/**
 * The parts every card of «Account e quote» is built from (hub-smistamento,
 * HUBBR-10): the buttons and chips, the window bar with its cap and its tick,
 * and the card's frame and head. Shared by
 * the Claude cards, the Codex and Muse ones and the hub's extras under them.
 */
import type { ReactNode } from 'react';
import type { Power } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { DANGER_TEXT, POPOVER_ITEM, POPOVER_ITEM_DANGER, WARNING_TEXT } from '../../lib/popoverStyles';
import { HOT_QUOTA_AT } from '../Sidebar/hotQuota';
import type { AccountCommand } from '../../lib/accountQuotas';

export type Tr = ReturnType<typeof useT>;
export type Run = (c: AccountCommand) => Promise<boolean>;

export const BUTTON = 'inline-flex h-[26px] flex-none items-center gap-[5px] whitespace-nowrap rounded-sm border border-app-border-light bg-elevated px-[9px] text-compact text-app-text hover:bg-app-hover disabled:opacity-50 @max-2xl:h-9 @max-2xl:px-3 @max-2xl:text-prose';
export const ICON_BUTTON = 'inline-flex h-[26px] w-[26px] flex-none items-center justify-center rounded-sm border border-app-border-light bg-elevated text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:opacity-50 @max-2xl:h-9 @max-2xl:w-9';
export const CHIP = 'ml-auto inline-flex h-5 flex-none items-center gap-1 whitespace-nowrap rounded-xs px-1.5 text-mini font-semibold';
export const CHIP_TONE = {
  use: 'bg-primary/10 text-blue-800 dark:text-primary',
  quiet: 'bg-app-hover text-app-text-secondary',
  warn: `bg-amber-500/15 ${WARNING_TEXT}`,
  bad: `bg-red-500/10 ${DANGER_TEXT}`,
} as const;


/** A window of a plan: label, the share used, the cap in force and the tick of where you should be (the week gone, or the daily share). */
export function Bar({ label, pct, cap = null, mark = null, markTitle, testId }: { label: string; pct: number | null; cap?: number | null; mark?: number | null; markTitle?: string; testId: string }) {
  const tr = useT();
  const warn = pct !== null && pct >= HOT_QUOTA_AT;
  // Ahead of the week gone is too fast: the bar says it at a glance, as the hub's did.
  const ahead = pct !== null && mark !== null && pct > mark + 5;
  return (
    <div className="grid h-[18px] grid-cols-[36px_minmax(0,1fr)_36px] items-center gap-1.5 text-compact tabular-nums text-app-text-secondary" data-testid={testId} data-pct={pct ?? ''}>
      <span>{label}</span>
      <span className="relative h-[5px] rounded-[3px] bg-black/[0.08] dark:bg-white/[0.1]">
        {pct !== null && <i className={`block h-full rounded-[3px] ${warn ? 'bg-amber-500' : 'bg-app-text-tertiary'}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />}
        {cap !== null && <span title={tr('accounts.bar.cap', { pct: cap })} className="absolute -bottom-px -top-px w-0.5 rounded-[1px] bg-amber-500" style={{ left: `${Math.min(99, cap)}%` }} />}
        {mark !== null && (
          <span
            title={markTitle ?? tr(ahead ? 'accounts.bar.markAhead' : 'accounts.bar.mark', { pct: mark })}
            data-testid="account-bar-mark"
            data-mark={mark}
            className={`absolute -bottom-[3px] -top-[3px] w-px ${ahead ? 'bg-red-500' : 'bg-app-text'}`}
            style={{ left: `${Math.min(99.5, Math.max(0, mark))}%` }}
          />
        )}
      </span>
      <span className={`text-right ${warn ? `font-semibold ${WARNING_TEXT}` : 'text-app-text'}`}>{pct === null ? '-' : `${pct}%`}</span>
    </div>
  );
}

export function CardShell({ current, testId, data, children }: { current: boolean; testId: string; data: Record<string, string>; children: ReactNode }) {
  const attrs = Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v]));
  return (
    <div data-testid={testId} {...attrs} className={`relative flex min-w-0 flex-col rounded border bg-app-inset px-2.5 pb-2.5 pt-[9px] text-compact ${current ? 'border-primary/55' : 'border-app-border'}`}>
      {children}
    </div>
  );
}

export function CardHead({ name, plan, chip }: { name: string; plan: string | null; chip: ReactNode }) {
  return (
    <div className="mb-[7px] flex min-w-0 items-center gap-1.5">
      <b className="min-w-0 truncate text-prose font-semibold text-app-text" title={name}>{name}</b>
      {plan && <span className="flex-none whitespace-nowrap text-app-text-secondary">{plan}</span>}
      {chip}
    </div>
  );
}

export function MenuItem({ icon: Icon, testId, danger = false, onClick, children }: { icon: typeof Power; testId: string; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" data-testid={testId} className={danger ? POPOVER_ITEM_DANGER : POPOVER_ITEM} onClick={onClick}>
      <Icon size={14} className="flex-none" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
    </button>
  );
}
