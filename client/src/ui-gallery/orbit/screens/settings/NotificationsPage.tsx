/**
 * Preferences · Notifications: when Topics warns the reader (each person has their own
 * choices, under `sarim.alerts.<persona>`). Notices of the contracts at 180,
 * 90 and 30 days, stopped cards with the hours of each flow, obligations of
 * the contracts, and the channels. Every block says what would arrive today
 * with the choices as they are, from the live cards and contracts; a test
 * alert lands in the bell.
 */
import { FileSignature, Send } from 'lucide-react';
import clsx from 'clsx';
import { personaById, world } from '../../world';
import type { SarimAlertWindow, SarimStuckScope } from '../../../../ui/copy/sarim-admin';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { Select, Toggle } from '../../../../ui/primitives/Field';
import { Table } from '../../../../ui/primitives/Table';
import { Block, SettingRow } from '../../../../ui/settings/Block';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import type { Tone } from '../../../../ui/types';
import type { ScreenCtx } from '../../../app/kit';
import { dayLabel, daysTo, noticeDate } from '../../model/contracts';
import { stuckCards } from '../../model/stages';
import { flowLabel } from '../../model/flows';
import { openDaFare } from '../../model/dafare';
import { liveCards, liveContracts } from '../../model/live';
import { openObligations } from '../../model/team';
import { SP } from '../../paths';
import { SettingsFrame } from './frame';

interface AlertChoices {
  windows: Record<SarimAlertWindow, boolean>;
  stuck: boolean;
  scope: SarimStuckScope;
  obligations: boolean;
  obligationsDays: number;
  mail: boolean;
  phone: boolean;
}

const INITIAL: AlertChoices = { windows: { d180: true, d90: true, d30: true }, stuck: true, scope: 'mine', obligations: true, obligationsDays: 30, mail: true, phone: false };

const WINDOWS: Array<[SarimAlertWindow, number, Tone]> = [['d180', 180, 'blue'], ['d90', 90, 'amber'], ['d30', 30, 'red']];
const SCOPES: SarimStuckScope[] = ['mine', 'area', 'all'];
const OBLIGATION_DAYS = [7, 15, 30, 60];

export function NotificationsPage({ ctx }: { ctx: ScreenCtx }) {
  const s = ctx.copy.sarimAdmin.settings;
  const a = s.alerts;
  const [raw, setChoices] = ctx.ui<AlertChoices>(`sarim.alerts.${ctx.persona.id}`, INITIAL);
  const choices: AlertChoices = { ...INITIAL, ...raw, windows: { ...INITIAL.windows, ...raw.windows } };
  const me = personaById(ctx.persona.id);
  const cards = liveCards(ctx.state);
  const contracts = liveContracts(ctx.state);

  const set = (patch: Partial<AlertChoices>, label: string, shown: string) => {
    setChoices((prev) => ({ ...INITIAL, ...prev, ...patch }));
    ctx.log(s.common.changedTo(label, shown), 'setting', ctx.path);
  };
  const onOff = (on: boolean) => (on ? s.common.on : s.common.off);

  /* Contracts: the notices that fall inside the longest window switched on, each with the narrowest window that holds it. */
  const maxDays = Math.max(0, ...WINDOWS.filter(([k]) => choices.windows[k]).map(([, d]) => d));
  const notices = contracts
    .flatMap((c) => {
      const day = noticeDate(c);
      return day ? [{ c, day, days: daysTo(day) }] : [];
    })
    .filter((x) => x.days >= 0 && x.days <= maxDays)
    .sort((x, y) => x.days - y.days)
    .map((x) => ({ ...x, window: [...WINDOWS].reverse().find(([k, d]) => choices.windows[k] && x.days <= d) }));

  /* Stopped cards in the scope chosen. */
  const inScope = (flowArea: string, reviewer: string, workerId: string) =>
    choices.scope === 'all' || (choices.scope === 'area' ? flowArea === me?.area : reviewer === ctx.persona.id || workerId === ctx.persona.id);
  const stopped = stuckCards(cards, ctx.now).filter((c) => {
    const f = world().opsFlows.find((x) => x.id === c.flow);
    return f && inScope(f.area, c.reviewer, c.worker.id);
  });

  /* Obligations due inside the window, or already past. */
  const due = openObligations(contracts).filter(({ o }) => o.due !== undefined && daysTo(o.due) <= choices.obligationsDays);
  const dueMine = due.filter(({ o }) => o.owner === ctx.persona.id);

  const test = () => {
    ctx.notify({ title: a.testTitle, body: a.testBody, path: SP.prefs('notifiche'), tone: 'info', to: [ctx.persona.id] }); // allow-italian: section id, an address segment
    ctx.toast({ tone: 'ok', title: a.testToast });
  };

  return (
    <SettingsFrame ctx={ctx} section="notifiche" actions={<Button icon={Send} onClick={test}>{a.test}</Button>}>
      <div className="flex flex-col gap-4">
        <Block title={a.contractsTitle} description={a.contractsBody}>
          {WINDOWS.map(([k]) => (
            <SettingRow
              key={k}
              label={a.windows[k].label}
              description={a.windows[k].hint}
              control={<Toggle checked={choices.windows[k]} onChange={(on) => set({ windows: { ...choices.windows, [k]: on } }, a.windows[k].label, onOff(on))} title={a.windows[k].label} />}
            />
          ))}
          <div className="mt-3 rounded-lg bg-black/[0.03] px-3 py-2.5 dark:bg-white/[0.04]">
            <p className="text-prose leading-5 text-app-text">{notices.length ? a.todaySome(notices.length) : a.todayNone}</p>
            {notices.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-1">
                {notices.map(({ c, day, days, window }) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => ctx.go(SP.contract(c.id))}
                      className={clsx('flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-1 py-0.5 text-left hover:bg-app-hover', FOCUS_RING)}
                    >
                      <FileSignature size={13} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-prose text-app-text">{c.title}</span>
                      <span className="text-mini text-app-text-tertiary">{a.noticeLine(dayLabel(day), days)}</span>
                      {window && <Chip tone={window[2]}>{a.windows[window[0]].label}</Chip>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Block>

        <Block title={a.stuckTitle} description={a.stuckBody}>
          <SettingRow label={a.stuckToggle} control={<Toggle checked={choices.stuck} onChange={(on) => set({ stuck: on }, a.stuckToggle, onOff(on))} title={a.stuckToggle} />} />
          <SettingRow
            label={a.stuckScope}
            control={
              <Select
                value={choices.scope}
                onChange={(v) => set({ scope: v as SarimStuckScope }, a.stuckScope, a.scopes[v as SarimStuckScope])}
                options={SCOPES.map((x) => ({ value: x, label: a.scopes[x] }))}
                disabled={!choices.stuck}
                title={a.stuckScope}
                className="w-60"
              />
            }
          />
          <Table
            className="mt-3"
            ariaLabel={a.stuckTitle}
            dense
            columns={[
              { id: 'flow', label: a.stuckColumns.flow, width: 220 },
              { id: 'after', label: a.stuckColumns.after, width: 120 },
              { id: 'now', label: a.stuckColumns.now, width: 110, align: 'right' },
            ]}
            rows={world().opsFlows.map((f) => {
              const n = stopped.filter((c) => c.flow === f.id).length;
              return {
                id: f.id,
                onOpen: () => openDaFare(ctx, { view: 'list', flow: f.id }),
                cells: {
                  flow: flowLabel(f.id),
                  after: <span className="text-app-text-secondary">{a.stuckAfter(f.stuckAfterHours)}</span>,
                  now: n ? <span className="font-medium text-amber-700 dark:text-amber-400">{n}</span> : ctx.copy.sarimAdmin.common.blank,
                },
              };
            })}
          />
          <p className="mt-2 text-prose leading-5 text-app-text-secondary">{a.stuckNow(choices.stuck ? stopped.length : 0)}</p>
        </Block>

        <Block title={a.obligationsTitle} description={a.obligationsBody}>
          <SettingRow label={a.obligationsToggle} control={<Toggle checked={choices.obligations} onChange={(on) => set({ obligations: on }, a.obligationsToggle, onOff(on))} title={a.obligationsToggle} />} />
          <SettingRow
            label={a.obligationsWindow}
            description={choices.obligations ? a.obligationsNow(dueMine.length, due.length, choices.obligationsDays) : undefined}
            control={
              <Select
                value={String(choices.obligationsDays)}
                onChange={(v) => set({ obligationsDays: Number(v) }, a.obligationsWindow, a.obligationsDays(Number(v)))}
                options={OBLIGATION_DAYS.map((d) => ({ value: String(d), label: a.obligationsDays(d) }))}
                disabled={!choices.obligations}
                title={a.obligationsWindow}
                className="w-40"
              />
            }
          />
        </Block>

        <Block title={a.channelsTitle}>
          <SettingRow label={a.channels.bell.label} description={a.channels.bell.hint} control={<Toggle checked onChange={() => undefined} disabled title={a.channels.bell.hint} />} />
          <SettingRow label={a.channels.mail.label} description={a.channels.mail.hint} control={<Toggle checked={choices.mail} onChange={(on) => set({ mail: on }, a.channels.mail.label, onOff(on))} title={a.channels.mail.label} />} />
          <SettingRow label={a.channels.phone.label} description={a.channels.phone.hint} control={<Toggle checked={choices.phone} onChange={(on) => set({ phone: on }, a.channels.phone.label, onOff(on))} title={a.channels.phone.label} />} />
        </Block>
      </div>
    </SettingsFrame>
  );
}
