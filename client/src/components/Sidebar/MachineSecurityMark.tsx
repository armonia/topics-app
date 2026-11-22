/**
 * The security mark of one machine row (MACHINE-06): a lucide shield beside the
 * name, coloured by the worst check (`info` weighs nothing), and under the row
 * the four checks with their sentence. A machine with no measurement is
 * `unknown`, never a green shield. The panel opens inline, not as a popover:
 * the devices list scrolls and would clip a floating one.
 */
import { useState, type ReactNode } from 'react';
import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import type { MachineHealthEntry, SecurityStatus } from '../../../../shared/machine-health';
import { deviceWhen } from '@/lib/deviceAudit';
import { useActiveLocale, useT } from '@/hooks/useT';

const STALE_MS = 60 * 60 * 1000;

const VIEW: Record<SecurityStatus, { Icon: typeof ShieldCheck; tone: string }> = {
  ok: { Icon: ShieldCheck, tone: 'text-green-600 dark:text-green-400' },
  warn: { Icon: ShieldAlert, tone: 'text-amber-600 dark:text-amber-400' },
  problem: { Icon: ShieldX, tone: 'text-red-700 dark:text-red-400' },
  unknown: { Icon: ShieldQuestion, tone: 'text-app-text-muted' },
};

/** A row of a machine: `children` draws the row's content and receives the mark to place beside the name. */
export function SecurityRow({ entry, className, rowProps, children }: {
  entry: MachineHealthEntry | null;
  className: string;
  rowProps: Record<string, string>;
  children: (mark: ReactNode) => ReactNode;
}) {
  const t = useT();
  const locale = useActiveLocale();
  const [open, setOpen] = useState(false);
  // Read once per mount: the rows remount every time the menu opens, which is fresh enough for an age in hours.
  const [now] = useState(() => Date.now());
  const status: SecurityStatus = entry?.security.checked_at ? entry.security.status : 'unknown';
  const { Icon, tone } = VIEW[status];
  const at = entry?.security.checked_at ? entry.security.checked_at * 1000 : null;
  const stale = at !== null && now - at > STALE_MS;
  const label = t('security.mark', { status: t(`security.status.${status}`) });
  const mark = (
    <button
      type="button"
      data-testid="machine-security-mark"
      data-status={status}
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={() => setOpen((v) => !v)}
      className={`flex min-h-6 min-w-6 flex-shrink-0 items-center justify-center gap-1 rounded px-0.5 hover:bg-app-hover coarse:min-h-11 coarse:min-w-11 coarse:justify-center ${tone}`}
    >
      <Icon size={13} />
      {stale && <span data-testid="machine-security-age" className="text-mini text-app-text-muted">{deviceWhen(at, t, locale)}</span>}
    </button>
  );
  return (
    <div>
      <div {...rowProps} className={className}>{children(mark)}</div>
      {open && (
        <ul data-testid="machine-security-checks" className="space-y-0.5 px-3 pb-1.5 pl-8 text-mini leading-snug text-app-text-secondary">
          {(entry?.security.checks ?? []).length === 0 && <li>{t('security.noRound')}</li>}
          {(entry?.security.checks ?? []).map((c) => (
            <li key={c.key} data-testid="machine-security-check" data-check={c.key} data-status={c.status}>
              <span className="text-app-text">{t(`security.check.${c.key}`)}</span>: {c.detail}
            </li>
          ))}
          {at !== null && <li className="text-app-text-muted">{deviceWhen(at, t, locale)}</li>}
        </ul>
      )}
    </div>
  );
}
