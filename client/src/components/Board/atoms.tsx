import { useState } from 'react';
import type { TaskStatus } from '../../lib/board';
import { STATUS_ICON_COLOR, DISPATCH_CHIP } from './constants';
import { memorableId } from '../../lib/memorableId';

/**
 * Memorable, click-to-copy task id chip — shown in the card eyebrow AND the
 * drawer, after the project. Displays a stable adjective-noun slug (e.g.
 * "brave-otter") so a task is recognisable at a glance; clicking copies the
 * FULL UUID (the actionable key for the API / deep links). stopPropagation so
 * copying never opens/navigates the card.
 */
export function TaskIdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        try { void navigator.clipboard?.writeText(id); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* clipboard blocked */ }
      }}
      title={copied ? 'ID copiato' : `${memorableId(id)} · clicca per copiare l'ID pieno (${id})`}
      className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-xs leading-none text-app-text-muted hover:bg-white/10 hover:text-app-text-heading md:text-[10px]"
    >{copied ? 'copiato ✓' : memorableId(id)}</button>
  );
}

/**
 * Linear-style status glyph — the segmented progress circle that became the
 * de-facto standard for issue states (dashed ring → empty ring → half pie →
 * ¾ pie → checked disc). One shape family, color + fill carry the state, so
 * the eye reads progress at a glance even at 12px.
 */
export function StatusIcon({ status, className = 'h-3.5 w-3.5' }: { status: TaskStatus; className?: string }) {
  // Inner pie: a fat-stroked circle with pathLength=100 — dasharray N = N% of
  // the disc filled, rotated so the fill grows clockwise from 12 o'clock.
  const pie = (pct: number) => (
    <circle
      cx="7" cy="7" r="2.4" fill="none" stroke="currentColor" strokeWidth="4.8"
      pathLength={100} strokeDasharray={`${pct} 100`} transform="rotate(-90 7 7)"
    />
  );
  return (
    <svg viewBox="0 0 14 14" aria-hidden className={`${className} shrink-0 ${STATUS_ICON_COLOR[status]}`}>
      {status === 'done' ? (
        <>
          <circle cx="7" cy="7" r="6.4" fill="currentColor" />
          <path d="M4.3 7.3l1.8 1.8 3.6-3.9" fill="none" stroke="#171717" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <circle
            cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.6"
            {...(status === 'backlog' ? { strokeDasharray: '2.4 2.6', strokeLinecap: 'round' as const } : {})}
          />
          {status === 'in_progress' && pie(50)}
          {status === 'review' && pie(75)}
        </>
      )}
    </svg>
  );
}

/** Dispatch-state chip: state label + (optional) icon. DRYs the card + drawer
 *  render sites so both stay in lockstep. 'delivered' carries a PackageCheck
 *  glyph so "consegnato" reads at a glance, not just as colored text. */
export function DispatchChip({ state, error }: { state: string; error?: string | null }) {
  const chip = DISPATCH_CHIP[state];
  if (!chip) return null;
  const Icon = chip.Icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs md:text-[11px] ${chip.cls}`}
      title={chip.title ?? error ?? undefined}
    >
      {Icon && <Icon className="h-3 w-3" aria-hidden />}
      {chip.text}
    </span>
  );
}
