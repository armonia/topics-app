/**
 * THE HUB'S MACHINES AMONG THE DEVICES: the PC and the Hetzner server, under
 * "this computer" (see `lib/hubMachines.ts` for why they come from the hub).
 *
 * Split in two like `BrowserStoreReapRows`: `HubMachineRows` reads the hub and
 * holds the confirmation, `HubMachineList` is a function of its props with no
 * hooks, so a test can call it and read the tree.
 *
 * A MACHINE ACTION IS ASKED TWICE. "Switch off all" deletes servers (a job in
 * flight on them dies), so the first press only turns the row into the hub's
 * own sentence with a red button and Cancel, the same shape as revoking a
 * device. Cancel takes the focus.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, Monitor, Power } from 'lucide-react';
import { PALLINO_ATTESA, PALLINO_OK } from './chromeSignals';
import { formatMoney, readHubMachines, runHubMachineAction, type HubMachine, type HubMachineAction } from '../../lib/hubMachines';
import { useActiveLocale, useT } from '../../hooks/useT';

const ROW = 'flex items-center gap-2 px-3 py-1 text-mini coarse:min-h-11 coarse:text-compact';
const TEXT_BUTTON = 'flex-shrink-0 rounded px-1.5 py-0.5 text-mini coarse:min-h-11 coarse:px-3';

type Tr = (key: string, vars?: Record<string, string | number>) => string;

/** The dot: red over the cap or strained, amber busy, green on, grey off. */
export function hubMachineDot(m: HubMachine): string {
  if (m.level >= 2) return 'bg-red-600 dark:bg-red-400';
  const on = m.on ?? true;
  if (!on) return 'bg-app-text-muted/40';
  return m.level === 1 ? PALLINO_ATTESA : PALLINO_OK;
}

/** The second line: the spend on the cap when there is one, then what the hub says first. */
export function hubMachineDetail(m: HubMachine, tr: Tr, locale: string): string {
  const parts: string[] = [];
  if (m.spend) parts.push(tr('devices.hubSpend', { eur: formatMoney(m.spend.eur, locale), cap: Math.round(m.spend.cap) }));
  const first = m.lines?.[0] ?? m.caption ?? '';
  if (first) parts.push(first);
  return parts.join(' · ');
}

export function HubMachineList({ machines, confirming, busy, error, onAsk, onCancel, onRun, tr, locale, cancelRef }: {
  machines: HubMachine[];
  /** `<machine id>:<action id>` being confirmed, or null. */
  confirming: string | null;
  busy: boolean;
  error: string | null;
  onAsk: (key: string) => void;
  onCancel: () => void;
  onRun: (action: HubMachineAction) => void;
  tr: Tr;
  locale: string;
  cancelRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <>
      {machines.map((m) => {
        const asked = (m.actions ?? []).find((a) => confirming === `${m.id}:${a.id}`);
        if (asked) {
          return (
            <div key={m.id} data-testid="hub-machine-row" data-machine={m.id} data-confirming="true" className={ROW}>
              <span data-testid="hub-machine-confirm-text" className="min-w-0 flex-1 leading-snug text-app-text">{asked.confirm || asked.label}</span>
              <button
                type="button"
                disabled={busy}
                data-testid="hub-machine-confirm"
                onClick={() => onRun(asked)}
                className={`${TEXT_BUTTON} text-red-700 hover:bg-red-600/10 disabled:opacity-50 dark:text-red-400`}
              >
                {asked.label}
              </button>
              <button
                ref={cancelRef}
                type="button"
                data-testid="hub-machine-cancel"
                onClick={onCancel}
                className={`${TEXT_BUTTON} text-app-text-secondary hover:bg-app-hover`}
              >
                {tr('devices.cancelLabel')}
              </button>
            </div>
          );
        }
        const Icon = m.kind === 'cloud' ? Cloud : Monitor;
        const detail = hubMachineDetail(m, tr, locale);
        return (
          <div key={m.id} data-testid="hub-machine-row" data-machine={m.id} data-on={String(m.on ?? true)} data-level={m.level} className={ROW}>
            <Icon size={12} className="flex-shrink-0 text-app-text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-app-text">{m.name}</span>
              {detail && <span data-testid="hub-machine-detail" className="block truncate text-mini text-app-text-muted" title={(m.lines ?? []).join('\n') || undefined}>{detail}</span>}
            </span>
            <span data-testid="hub-machine-state" className={`flex-shrink-0 ${m.level >= 2 ? 'text-red-700 dark:text-red-400' : 'text-app-text-muted'}`}>{m.state}</span>
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${hubMachineDot(m)}`} />
            {(m.actions ?? []).map((a) => (
              <button
                key={a.id}
                type="button"
                data-testid="hub-machine-action"
                data-action={a.id}
                aria-label={`${a.label} · ${m.name}`}
                title={a.label}
                onClick={() => onAsk(`${m.id}:${a.id}`)}
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-app-text-tertiary hover:bg-app-hover hover:text-red-600 coarse:h-11 coarse:w-11"
              >
                <Power size={12} />
              </button>
            ))}
          </div>
        );
      })}
      {error && (
        <p data-testid="hub-machine-error" role="alert" className="px-3 py-1 text-mini leading-snug text-red-700 dark:text-red-400">
          {tr('devices.hubActionFailed', { why: error })}
        </p>
      )}
    </>
  );
}

/** Reads the hub on mount (the level mounts when it opens) and after an action. */
export function HubMachineRows() {
  const tr = useT();
  const locale = useActiveLocale();
  const [machines, setMachines] = useState<HubMachine[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const read = useCallback(async () => {
    const list = await readHubMachines();
    setMachines(list);
  }, []);
  useEffect(() => { void read(); }, [read]);
  useEffect(() => { if (confirming) cancelRef.current?.focus(); }, [confirming]);

  const run = useCallback(async (action: HubMachineAction) => {
    setBusy(true);
    const refused = await runHubMachineAction(action);
    setBusy(false);
    setError(refused);
    setConfirming(null);
    await read();
  }, [read]);

  if (!machines || machines.length === 0) return null;
  return (
    <HubMachineList
      machines={machines}
      confirming={confirming}
      busy={busy}
      error={error}
      onAsk={(k) => { setError(null); setConfirming(k); }}
      onCancel={() => setConfirming(null)}
      onRun={(a) => void run(a)}
      tr={tr}
      locale={locale}
      cancelRef={cancelRef}
    />
  );
}
