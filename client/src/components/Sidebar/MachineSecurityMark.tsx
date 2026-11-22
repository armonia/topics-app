/**
 * The security mark of one machine row (MACHINE-09): a lucide shield beside the
 * name, coloured by the worst check (`info` weighs nothing), and under the row
 * the four checks with their sentence. A machine with no measurement is
 * `unknown`, never a green shield. The panel opens inline, not as a popover:
 * the devices list scrolls and would clip a floating one.
 */
import { useState, type ReactNode } from 'react';
import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from 'lucide-react';
import type { MachineHealthEntry, SecurityCheck, SecurityStatus } from '../../../../shared/machine-health';
import { STATUS_INK } from '@/lib/statusVisual';
import { deviceWhen } from '@/lib/deviceAudit';
import { useActiveLocale, useT } from '@/hooks/useT';

const STALE_MS = 60 * 60 * 1000;

// The colour comes from the one status table (`lib/statusVisual.ts`), the same as the dot beside it.
const VIEW: Record<SecurityStatus, { Icon: typeof ShieldCheck; tone: string }> = {
  ok: { Icon: ShieldCheck, tone: STATUS_INK.ok },
  warn: { Icon: ShieldAlert, tone: STATUS_INK.wait },
  problem: { Icon: ShieldX, tone: STATUS_INK.danger },
  unknown: { Icon: ShieldQuestion, tone: 'text-app-text-muted' },
};

/** The sentence of one check in the active language; a file with no codes (written before them) shows its own text. */
function checkSentence(c: SecurityCheck, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (!c.msgs?.length) return c.detail;
  const text = c.msgs.map((m) => {
    const params: Record<string, string | number> = { ...m.params };
    if (m.code === 'unknown') {
      params.what = t(`security.check.${c.key}`);
      params.why = t(`security.why.${String(m.params?.why ?? 'failed')}`);
    }
    const count = Number(m.params?.n ?? m.params?.days);
    const one = count === 1 ? `security.msg.${m.code}.one` : null;
    const oneText = one ? t(one, params) : null;
    return oneText && oneText !== one ? oneText : t(`security.msg.${m.code}`, params);
  }).join(', ');
  return c.key === 'access' ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** A row of a machine: `children` draws the row's content and receives the mark to place beside the name. */
export function SecurityRow({ entry, name, measured = true, className, rowProps, children }: {
  entry: MachineHealthEntry | null;
  /** The machine's name: the mark's accessible name carries it, so two rows never read the same. */
  name: string;
  /** False for a machine the round never measures (the cloud node): no mark at all, not a `?`. */
  measured?: boolean;
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
  const state = t(`security.status.${status}`);
  const label = at !== null ? t('security.mark', { name, status: state, age: deviceWhen(at, t, locale) }) : t('security.markNever', { name, status: state });
  const mark = !measured ? null : (
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
      {open && measured && (
        <ul data-testid="machine-security-checks" className="space-y-0.5 px-3 pb-1.5 pl-8 text-mini leading-snug text-app-text-secondary">
          {(entry?.security.checks ?? []).length === 0 && <li>{t('security.noRound')}</li>}
          {(entry?.security.checks ?? []).map((c) => (
            <li key={c.key} data-testid="machine-security-check" data-check={c.key} data-status={c.status}>
              <span className="text-app-text">{t(`security.check.${c.key}`)}</span>: {checkSentence(c, t)}
            </li>
          ))}
          {at !== null && <li className="text-app-text-muted">{deviceWhen(at, t, locale)}</li>}
        </ul>
      )}
    </div>
  );
}
