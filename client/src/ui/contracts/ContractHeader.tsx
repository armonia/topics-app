import type { ReactNode } from 'react';
import { CircleAlert, CornerDownRight, GitBranch, Info, TriangleAlert } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Tone } from '../types';
import { Chip } from '../primitives/Chip';
import { StateChip } from './StateChip';
import { FOCUS_RING } from '../shell/pressable';
import { TONE_CHIP } from '../tone';
import type { AlertModel, FactModel, FamilyNodeModel } from './model';

const ALERT_ICON: Partial<Record<Tone, typeof Info>> = { red: CircleAlert, amber: TriangleAlert, blue: Info };

/** The open alerts of a contract, most urgent first; one with a clause opens it, unless that clause is already on show. */
export function AlertStrip({ alerts, onOpen, copy, compact }: {
  alerts: AlertModel[];
  onOpen: (id: string) => void;
  copy: UiCopy;
  /** One line per alert, for the side of a page. */
  compact?: boolean;
}) {
  const t = copy.contracts.page;
  if (!alerts.length) {
    return <p className="rounded-lg border border-app-border bg-surface px-3 py-2 text-compact text-app-text-tertiary">{t.noAlerts}</p>;
  }
  return (
    <ul aria-label={t.alertsLabel} className={clsx('grid gap-2', !compact && 'md:grid-cols-2')}>
      {alerts.map((a) => {
        const Icon = ALERT_ICON[a.tone] ?? Info;
        const body = (
          <>
            <span className={clsx('mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded', TONE_CHIP[a.tone])}>
              <Icon size={12} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-prose font-medium leading-5 text-app-text">{a.title}</span>
              <span className="block text-compact leading-4 text-app-text-secondary">{a.body}</span>
            </span>
            {a.clauseLabel && <Chip className="mt-0.5">{a.clauseLabel}</Chip>}
          </>
        );
        return (
          <li key={a.id}>
            {a.clauseLabel && !a.here ? (
              <button type="button" onClick={() => onOpen(a.id)} className={clsx('flex w-full items-start gap-2 rounded-lg border border-app-border bg-surface px-3 py-2 text-left transition-colors hover:bg-app-hover', FOCUS_RING)}>
                {body}
              </button>
            ) : (
              <div aria-current={a.here ? 'true' : undefined} className="flex items-start gap-2 rounded-lg border border-app-border bg-surface px-3 py-2">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The family of a contract: the main contract above, this one, and what hangs
 * from it (subcontracts, the people hired for it, agreements, variations),
 * each with what it is to this one. A node other than this opens it.
 */
export function ContractFamily({ nodes, onOpen, copy }: {
  nodes: FamilyNodeModel[];
  onOpen: (id: string) => void;
  copy: UiCopy;
}) {
  const t = copy.contracts.page;
  const current = nodes.findIndex((n) => n.current);
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">
        <GitBranch size={12} aria-hidden="true" />{t.family}
      </div>
      <ol className="flex min-w-0 flex-col gap-1">
        {nodes.map((n, i) => {
          const child = current >= 0 && i > current;
          const inner = (
            <>
              {child && <CornerDownRight size={13} className="shrink-0 text-app-text-faint" aria-hidden="true" />}
              <span className="shrink-0 text-mini text-app-text-tertiary">{n.relation}</span>
              <span className={clsx('min-w-0 flex-1 truncate text-compact', n.current ? 'font-semibold text-app-text' : 'text-app-text')}>{n.title}</span>
              {n.statusText && <StateChip tone={n.statusTone}>{n.statusText}</StateChip>}
            </>
          );
          return (
            <li key={n.id} className={clsx(child && 'pl-3')}>
              {n.current ? (
                <div aria-current="true" className="flex min-h-7 items-center gap-2 rounded-md bg-black/[0.04] px-2 dark:bg-white/[0.06]">{inner}</div>
              ) : (
                <button type="button" onClick={() => onOpen(n.id)} className={clsx('flex min-h-7 w-full items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-app-hover', FOCUS_RING)}>{inner}</button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The head of a contract: kind and state, the title, the facts that matter
 * (counterparty, value, dates, CIG, who owns it), its family and its alerts.
 * The buttons on the right are the caller's. `compact` is the head of a page
 * inside the contract (versions, compare, signatures, an attachment): the
 * title and the facts on two short lines, so the page's own work starts in
 * the first screen; the family and the alerts stay on the contract page.
 */
export function ContractHeader({ title, kindText, statusText, statusTone, facts, family, onFamily, alerts, onAlert, actions, copy, phone, compact }: {
  title: string;
  kindText: string;
  statusText: string;
  statusTone: Tone;
  facts: FactModel[];
  family: FamilyNodeModel[];
  onFamily: (id: string) => void;
  alerts: AlertModel[];
  onAlert: (id: string) => void;
  actions?: ReactNode;
  copy: UiCopy;
  phone: boolean;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <section className="border-b border-app-border px-4 py-3">
        <div className={clsx('flex gap-3', phone ? 'flex-col' : 'items-center')}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Chip>{kindText}</Chip>
              <StateChip tone={statusTone} strong>{statusText}</StateChip>
              <h1 className="min-w-0 text-body-lg font-semibold leading-6 text-app-text [overflow-wrap:break-word]">{title}</h1>
            </div>
            <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-compact leading-5">
              {facts.map((f) => (
                <div key={f.label} className="flex min-w-0 items-baseline gap-1.5">
                  <dt className="shrink-0 text-app-text-tertiary">{f.label}</dt>
                  <dd className={clsx('min-w-0 text-app-text [overflow-wrap:break-word]', f.mono ? 'font-mono' : 'tabular-nums')}>{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </section>
    );
  }
  return (
    <section className="border-b border-app-border px-4 pb-4 pt-3.5">
      <div className={clsx('flex gap-3', phone ? 'flex-col' : 'items-start')}>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Chip>{kindText}</Chip>
            <StateChip tone={statusTone} strong>{statusText}</StateChip>
          </div>
          <h1 className="text-title font-semibold leading-7 text-app-text [overflow-wrap:break-word]">{title}</h1>
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-3 xl:grid-cols-7">
        {facts.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-mini text-app-text-tertiary">{f.label}</dt>
            <dd className={clsx('text-prose leading-5 text-app-text [overflow-wrap:break-word]', f.mono ? 'font-mono text-compact' : 'tabular-nums')}>{f.value}</dd>
            {f.detail && <dd className="text-mini leading-4 text-app-text-tertiary">{f.detail}</dd>}
          </div>
        ))}
      </dl>
      <div className={clsx('mt-3.5 grid gap-4', !phone && 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]')}>
        {family.length > 1 && <ContractFamily nodes={family} onOpen={onFamily} copy={copy} />}
        <div className={clsx('min-w-0', family.length <= 1 && 'lg:col-span-2')}>
          <div className="mb-1.5 text-mini font-semibold uppercase tracking-[0.08em] text-app-text-tertiary">{copy.contracts.page.alertsLabel}</div>
          <AlertStrip alerts={alerts} onOpen={onAlert} copy={copy} compact={family.length > 1} />
        </div>
      </div>
    </section>
  );
}
