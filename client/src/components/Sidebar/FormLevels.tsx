/**
 * THE FIVE FORM LEVELS OF THE USER MENU, and what each row says closed.
 *
 * Plan, nodes, AI providers, tools and calendar (USERMENU-06, USERMENU-10). Each
 * row reads its fact when the menu opens (the menu is mounted only while open,
 * so mounting IS opening and nothing polls while it is closed), and reads it
 * again when its level closes, so a change made inside shows in the tail at
 * once. The words are `formLevelTails.ts`; the frame is `FormLevel`.
 *
 * Where they sit is the host's decision (`IdentityMenuItems` for the plan and
 * the nodes, `TopicsMenuItems` for the engine): this file only says what each
 * level holds.
 */
import { lazy, useCallback, useEffect, useState } from 'react';
import { CalendarDays, Cpu, CreditCard, Plug, Server } from 'lucide-react';
import { FormLevel } from './FormLevel';
import { calendarTail, nodesTail, planTail, providersTail, toolsTail, type Tail } from './formLevelTails';
import { SEGNALE_ATTESA } from './chromeSignals';
import { NotificationBadge } from '../Shared/NotificationBadge';
import type { StatoPiano } from '../Settings/pianoState';
import { useProvidersSnapshot } from '@/hooks/useProvidersSnapshot';
import { appSettingsApi, mcpApi, type AppBehaviorSettings, type McpFleetStatus } from '@/lib/api';
import { apiFetch } from '@/lib/shell/net';
import { pendingRemoteRequests } from '@/lib/remoteNodeRequests';
import { nodesOf, useMachines } from '@/state/machinesStore';
import type { UserMenuLevel } from '@/lib/openUserMenu';
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
const ProvidersLevelBody = lazy(async () => {
  const { ProvidersLevelBody: Body } = await import('./ProvidersLevelBody');
  return { default: Body };
});
const ToolsSection = lazy(async () => {
  const { ToolsSection: Body } = await import('../Settings/ToolsSection');
  return { default: Body };
});
const CalendarSection = lazy(async () => {
  const { CalendarSection: Body } = await import('../Settings/CalendarSection');
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
  return { plan: await r.json() as StatoPiano, at: Date.now() };
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

/** The machines this board spans, beside the devices; a request from another
 *  computer needs an answer, so it is a badge and not a word. */
export function NodesLevel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const tr = useT();
  const machines = useMachines();
  const [pending, again] = useMenuRead(pendingRemoteRequests);
  const onOpenChange = useReadOnClose(again);
  const requests = pending ?? 0;
  return (
    <FormLevel
      icon={Server}
      label={tr('settings.section.nodes')}
      testId="topics-menu-nodes"
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      tail={
        <>
          <TailText testId="topics-menu-nodes-tail" tail={machines ? nodesTail(nodesOf(machines).length, tr) : null} />
          {requests > 0 && (
            <NotificationBadge
              count={requests}
              testId="topics-menu-nodes-requests"
              ariaLabel={tr('userMenu.nodes.requests', { n: requests })}
              title={tr('userMenu.nodes.requests', { n: requests })}
            />
          )}
        </>
      }
    >
      <NodesSection />
    </FormLevel>
  );
}

const readFleet = (signal: AbortSignal): Promise<McpFleetStatus> => mcpApi.peek(signal);
const readCalendar = (): Promise<AppBehaviorSettings> => appSettingsApi.get();

/**
 * WHAT THE APP RUNS ON AND WHAT IT REACHES: AI providers, tools, calendar.
 * One group, hairline above and below in the host.
 */
export function EngineLevels({ openLevel = null }: { openLevel?: UserMenuLevel | null }) {
  const tr = useT();
  // The snapshot is a shared store fed by the socket: reading it here costs no
  // request when the picker has already asked.
  const { snapshot } = useProvidersSnapshot();
  const [fleet, againFleet] = useMenuRead(readFleet);
  const [calendar, againCalendar] = useMenuRead(readCalendar);
  const onToolsOpenChange = useReadOnClose(againFleet);
  const onCalendarOpenChange = useReadOnClose(againCalendar);
  return (
    <>
      <FormLevel
        icon={Cpu}
        label={tr('settings.section.providers')}
        testId="topics-menu-providers"
        defaultOpen={openLevel === 'providers'}
        tail={<TailText testId="topics-menu-providers-tail" tail={providersTail(snapshot, tr)} />}
      >
        <ProvidersLevelBody />
      </FormLevel>
      <FormLevel
        icon={Plug}
        label={tr('settings.section.tools')}
        testId="topics-menu-tools"
        defaultOpen={openLevel === 'tools'}
        onOpenChange={onToolsOpenChange}
        tail={<TailText testId="topics-menu-tools-tail" tail={toolsTail(fleet, tr)} />}
      >
        <ToolsSection />
      </FormLevel>
      <FormLevel
        icon={CalendarDays}
        label={tr('settings.section.calendar')}
        testId="topics-menu-calendar"
        defaultOpen={openLevel === 'calendar'}
        onOpenChange={onCalendarOpenChange}
        tail={<TailText testId="topics-menu-calendar-tail" tail={calendarTail(calendar, tr)} />}
      >
        <CalendarSection />
      </FormLevel>
    </>
  );
}
