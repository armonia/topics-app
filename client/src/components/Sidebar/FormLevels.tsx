/**
 * THE TWO FORMS LEFT IN THE USER MENU, and what each row says closed.
 *
 * The plan and the machines (USERMENU-06, USERMENU-10, SETHOME-01): they stay in
 * the menu because they ARE the account and its computers. Every other form
 * lives where it is used (providers in the model selector, tools in the
 * composer, calendar in its tile) and is drawn by `Settings/HomePanelHost`.
 * Each row reads its fact when the menu opens (the menu is mounted only while
 * open, so mounting IS opening and nothing polls while it is closed), and reads
 * it again when its level closes, so a change made inside shows in the tail at
 * once. The words are `formLevelTails.ts`; the frame is `FormLevel`.
 */
import { lazy, useCallback, useEffect, useState } from 'react';
import { CreditCard, Server } from 'lucide-react';
import { FormLevel } from './FormLevel';
import { nodeRequestsLabel, nodesTail, planTail, type LicensePlan, type Tail } from './formLevelTails';
import { SEGNALE_ATTESA } from './chromeSignals';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { apiFetch } from '@/lib/shell/net';
import { pendingRemoteRequests } from '@/lib/remoteNodeRequests';
import { nodesOf, useMachines } from '@/state/machinesStore';
import { useT } from '@/hooks/useT';

// The forms load the first time their level opens. Destructured on purpose: a
// bare `import()` is opaque to knip (`check:deadcode-blindspots`).
const PlanSection = lazy(async () => {
  const { PlanSection: Body } = await import('../Settings/PlanSection');
  return { default: Body };
});
const NodesSection = lazy(async () => {
  const { NodesSection: Body } = await import('../Settings/NodesSection');
  return { default: Body };
});

/** The tail's box: short, tabular, quiet unless it asks for attention. */
function TailText({ testId, tail }: { testId: string; tail: Tail | string | null }) {
  if (tail === null) return null;
  const { text, warn } = typeof tail === 'string' ? { text: tail, warn: false } : tail;
  return (
    <span
      data-testid={testId}
      data-warn={warn ? 'true' : undefined}
      className={`max-w-[55%] flex-shrink-0 truncate text-mini tabular-nums ${warn ? SEGNALE_ATTESA : 'text-app-text-tertiary'}`}
    >
      {text}
    </span>
  );
}

/**
 * Read a fact now and again on demand, never after unmount. The menu is the
 * mount: nothing here runs while it is closed.
 */
function useMenuRead<T>(read: (signal: AbortSignal) => Promise<T>): [T | null, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    read(ctrl.signal)
      .then((v) => { if (!ctrl.signal.aborted) setValue(v); })
      .catch(() => { /* a fact not read is a tail not shown, never a made-up one */ });
    return () => ctrl.abort();
  }, [read, round]);
  const again = useCallback(() => setRound((n) => n + 1), []);
  return [value, again];
}

/** Read again when the level closes: what was changed inside shows at once. */
function useReadOnClose(again: () => void): (open: boolean) => void {
  return useCallback((open: boolean) => { if (!open) again(); }, [again]);
}

const readPlan = async (signal: AbortSignal) => {
  const r = await apiFetch('/api/license', { credentials: 'same-origin', signal });
  if (!r.ok) throw new Error(String(r.status));
  return { plan: await r.json() as LicensePlan, at: Date.now() };
};

/** WHAT YOU PAY FOR, right under who you are: «Gratuito», «Team · 5 posti». */
export function PlanLevel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const tr = useT();
  const [read, again] = useMenuRead(readPlan);
  const onOpenChange = useReadOnClose(again);
  return (
    <FormLevel
      icon={CreditCard}
      label={tr('settings.section.plan')}
      testId="topics-menu-plan"
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      tail={<TailText testId="topics-menu-plan-tail" tail={read ? planTail(read.plan, read.at, tr) : null} />}
    >
      <PlanSection />
    </FormLevel>
  );
}

/**
 * THE MACHINES THIS BOARD SPANS, inside the Devices level: both are computers.
 * Pair a node (an address and a code) and answer the requests from other
 * computers. A request needs an answer, so it is a badge and not a word.
 */
export function MachinesLevel({ defaultOpen = false, onRequestsRead }: {
  defaultOpen?: boolean;
  /** Told how many requests wait, every time they are read: the Devices row
   *  carries the same badge. */
  onRequestsRead?: (n: number) => void;
}) {
  const tr = useT();
  const machines = useMachines();
  const [pending, again] = useMenuRead(pendingRemoteRequests);
  const onOpenChange = useReadOnClose(again);
  const requests = pending ?? 0;
  useEffect(() => { if (pending !== null) onRequestsRead?.(pending); }, [pending, onRequestsRead]);
  return (
    <FormLevel
      icon={Server}
      label={tr('home.machines')}
      testId="devices-machines"
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      tail={
        <>
          <TailText testId="devices-machines-tail" tail={machines ? nodesTail(nodesOf(machines).length, tr) : null} />
          {requests > 0 && (
            <NotificationBadge
              count={requests}
              testId="devices-machines-requests"
              ariaLabel={nodeRequestsLabel(requests, tr)}
              title={nodeRequestsLabel(requests, tr)}
            />
          )}
        </>
      }
    >
      <NodesSection />
    </FormLevel>
  );
}
