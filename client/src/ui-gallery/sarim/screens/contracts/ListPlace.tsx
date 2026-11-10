/**
 * «Contratti» of the SARIM edition (sarim-contracts): every contract as a (allow-italian: quotes the Italian interface)
 * table, with four numbers on top (in force, value in force, open alerts,
 * variations under way) and the filter bar: kind, state, team, counterparty,
 * end, next notice and the situation of the contract. The saved filters that
 * come with it are the old views (expiring within 180 days, late obligations
 * or penalties, variations under way, expired). The way to the deadlines
 * of all of them is in the header. A row opens the contract. Every number
 * comes from the live world.
 */
import { useMemo, type ReactNode } from 'react';
import clsx from 'clsx';
import { CalendarClock, CalendarDays, CircleDot, FileText, Gauge, Handshake, Users } from 'lucide-react';
import type { Contract, ContractKind, ContractStatus, SarimCard } from '../../../../ui/fixtures/sarim-org/types';
import { world } from '../../world';
import { FilterBar } from '../../../../ui/filters/FilterBar';
import { Button } from '../../../../ui/primitives/Button';
import { StatCard } from '../../../../ui/primitives/Card';
import { PaneHeader } from '../../../../ui/shell/PaneHeader';
import { ContractList } from '../../../../ui/contracts/ContractList';
import type { ScreenCtx } from '../../../app/kit';
import { useListFilters, type FilterSchema, type SavedFilter } from '../../../app/filters';
import { liveCards, liveContracts } from '../../model/live';
import { contractAlerts, currentValue, formatMoney, kindLabel, noticeDate, statusLabel } from '../../model/contracts';
import { orgCrumbs } from '../../crumbs';
import { SP } from '../../paths';
import { KnowledgeNav } from '../knowledge/KnowledgeNav';
import { row } from './rows';
import { today } from './view';
import { expiringSoon, hasLateWork, inForce, isExpired, runningVariant, type SavedView } from './model';
import { PAGE_GUTTER } from '../../../../ui/shell/layout';
import { FOCUS_RING } from '../../../../ui/shell/pressable';
import { TONE_TEXT } from '../../../../ui/tone';
import type { Tone } from '../../../../ui/types';

/** A contract with the situations it is in today: what the saved filters are made of. */
interface Item {
  c: Contract;
  situations: Array<Exclude<SavedView, 'all'>>;
}

const SITUATIONS: Array<Exclude<SavedView, 'all'>> = ['expiring', 'late', 'variants', 'expired'];
const STATUS_ORDER: ContractStatus[] = ['bozza', 'revisione', 'approvazione', 'firma', 'attivo', 'rinnovo', 'scaduto']; // allow-italian: data codes in their order

/** A year of a contract's value: yearly as it is, monthly times twelve. */
const yearly = (c: Contract) => (c.valuePeriod === 'anno' ? currentValue(c) : c.valuePeriod === 'mese' ? currentValue(c) * 12 : 0); // allow-italian: data codes compared by value

/** Millions with three figures at most, so the tile holds them on one line, a phone too: 9,4 · 17,5 · 170. */
const millions = (value: number) => {
  const m = value / 1_000_000;
  return m >= 100 ? String(Math.round(m)) : (Math.round(m * 10) / 10).toFixed(1).replace('.', ',');
};

/** Whole euros without the cents a summary does not need: 418.000 rather than 418.000,00. */
const wholeMoney = (value: number) => formatMoney(Math.round(value)).replace(/,00$/, '');

/** One number of the phone strip: the figure over its name; with an action it is a button. */
function Tile({ value, label, tone, onOpen }: { value: ReactNode; label: string; tone?: Tone; onOpen?: () => void }) {
  const body = (
    <>
      <div className={clsx('text-title font-semibold leading-7 tabular-nums', tone && tone !== 'neutral' ? TONE_TEXT[tone] : 'text-app-text')}>{value}</div>
      <div className="text-compact leading-4 text-app-text-secondary [overflow-wrap:break-word]">{label}</div>
    </>
  );
  // flex-col: a button centres its content by default, so the clickable cell sat lower than its neighbours.
  const cls = 'flex min-w-0 flex-col justify-start px-3 py-2.5 text-left';
  return onOpen ? <button type="button" onClick={onOpen} className={clsx(cls, 'transition-colors hover:bg-app-hover', FOCUS_RING)}>{body}</button> : <div className={cls}>{body}</div>;
}

export function ListPlace({ ctx }: { ctx: ScreenCtx }) {
  const t = ctx.copy.contracts;
  const l = t.list;
  const day = today(ctx);
  const cards: SarimCard[] = liveCards(ctx.state);
  const all = liveContracts(ctx.state);
  const items = all.map((c): Item => ({
    c,
    situations: SITUATIONS.filter((v) => (v === 'expiring' ? expiringSoon(c, day) : v === 'late' ? hasLateWork(c, day, cards) : v === 'variants' ? Boolean(runningVariant(c)) : isExpired(c, day))),
  }));

  const schema = useMemo<FilterSchema<Item>>(() => ({
    text: ({ c }) => [c.title, c.counterparty, c.counterpartyKind, c.object, c.cig ?? '', kindLabel[c.kind], ...(c.tags ?? [])].join(' '),
    fields: [
      { id: 'tipo', label: l.fields.kind, icon: FileText, kind: 'choice', get: (i) => i.c.kind, valueLabel: (v) => kindLabel[v as ContractKind] },
      { id: 'stato', label: l.fields.status, icon: CircleDot, kind: 'choice', get: (i) => i.c.status, valueLabel: (v) => statusLabel[v as ContractStatus], order: STATUS_ORDER },
      { id: 'team', label: l.fields.team, icon: Users, kind: 'choice', get: (i) => i.c.area, valueLabel: (v) => world().people.areaLabel[v as Contract['area']] },
      { id: 'controparte', label: l.fields.counterparty, icon: Handshake, kind: 'choice', get: (i) => i.c.counterparty },
      { id: 'scadenza', label: l.fields.end, icon: CalendarDays, kind: 'date', get: (i) => i.c.end },
      { id: 'preavviso', label: l.fields.notice, icon: CalendarClock, kind: 'date', get: (i) => noticeDate(i.c) },
      { id: 'situazione', label: l.fields.situation, icon: Gauge, kind: 'choice', ops: ['is'], get: (i) => i.situations, valueLabel: (v) => l.views[v as SavedView], order: SITUATIONS, values: SITUATIONS },
    ],
  }), [l]);
  const presets = useMemo<SavedFilter[]>(() => SITUATIONS.map((v, i) => ({ id: v, name: l.views[v], tokens: [{ id: `p${i + 1}`, field: 'situazione', op: 'is', value: v }] })), [l]);
  const list = useListFilters(ctx, { key: 'sarim.contracts.filters', items, schema, presets });
  const shown = list.items;

  // In force by the same test that lets a variation start, so the tile and the contract page agree.
  const active = all.filter((c) => inForce(c, day));
  const totalValue = active.filter((c) => c.valuePeriod === 'totale').reduce((sum, c) => sum + currentValue(c), 0); // allow-italian: data code compared by value
  const yearlyValue = active.reduce((sum, c) => sum + yearly(c), 0);
  const alerts = all.flatMap((c) => contractAlerts(c, day, cards));
  const alertTone: Tone | undefined = alerts.some((a) => a.tone === 'error') ? 'red' : alerts.length ? 'amber' : undefined;
  const apply = (id: SavedView) => (list.state.saved === id ? undefined : () => list.bar.onApplySaved(id));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* On a phone the top bar already names the page, so the header keeps only the count; on a desktop the count is in the tab, the tile and the filter bar. */}
      <PaneHeader crumbs={orgCrumbs(ctx, [{ label: ctx.copy.sarimData.knowledge.title, to: SP.knowledge() }, ctx.phone ? { label: l.subtitle(all.length) } : { label: t.title }])}>
        <Button icon={CalendarClock} onClick={() => ctx.go(SP.contractDeadlines())}>{l.deadlines}</Button>
      </PaneHeader>
      <KnowledgeNav ctx={ctx} active="contracts" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ctx.phone ? (
          /* On a phone the three numbers share one strip, so the list starts in the first screen. */
          <div className={`${PAGE_GUTTER} pt-3`}>
            <div className="grid grid-cols-3 divide-x divide-app-border overflow-hidden rounded-lg border border-app-border bg-surface">
              <Tile value={active.length} label={l.tiles.active} />
              <Tile value={l.tiles.valueText(millions(totalValue))} label={l.tiles.value} />
              <Tile value={alerts.length} label={l.tiles.alerts} tone={alertTone} onOpen={apply('late')} />
            </div>
          </div>
        ) : (
          <div className={`grid grid-cols-2 gap-2.5 ${PAGE_GUTTER} pt-4 lg:grid-cols-3`}>
            <StatCard label={l.tiles.active} value={active.length} detail={l.tiles.activeDetail(all.length)} />
            <StatCard label={l.tiles.value} value={l.tiles.valueText(millions(totalValue))} detail={l.tiles.valueDetail(t.common.euro(wholeMoney(yearlyValue)))} />
            <StatCard
              label={l.tiles.alerts}
              value={alerts.length}
              detail={l.tiles.alertsDetail(alerts.filter((a) => a.tone === 'error').length)}
              tone={alertTone}
              onOpen={apply('late')}
              className="col-span-2 lg:col-span-1"
            />
          </div>
        )}
        <div className={`${PAGE_GUTTER} pt-3`}>
          <FilterBar copy={ctx.copy} {...list.bar} placeholder={ctx.copy.filters.on.contracts} phone={ctx.phone} />
        </div>
        <div className="p-4">
          <ContractList rows={shown.map((i) => row(ctx, i.c))} onOpen={(id) => ctx.go(SP.contract(id))} copy={ctx.copy} phone={ctx.phone} />
        </div>
      </div>
    </div>
  );
}
