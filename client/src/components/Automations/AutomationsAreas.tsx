/**
 * The automations by what they do for you, the hub's own grouping: six areas
 * (mail and alerts, clients, development, Jarvis and agents, maintenance,
 * backup and safety), the ones with a problem first, each counting its rows
 * in order, to look at and broken. The same table as the systems' sections.
 *
 * And «Computer e app»: the Mac, the PC and the apps (Topics, darkroom…),
 * shown with their runs and strip but outside the problems, the verdict and
 * the bell, as the hub keeps them.
 */
import { Bot, BriefcaseBusiness, CodeXml, Inbox, MonitorSmartphone, ShieldCheck, Wrench } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { DANGER_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { areaGroups, sortRows, type AutomationArea, type AutomationRow, type JobCommand } from '../../lib/automations';
import { AutomationTable } from './AutomationTable';
import { SECTION, SECTION_COUNT, SECTION_REST, type Clock } from './automationsUi';

const AREA_ICON: Record<AutomationArea, typeof Bot> = {
  'posta-avvisi': Inbox,
  clienti: BriefcaseBusiness,
  'sviluppo-topics': CodeXml,
  'jarvis-agenti': Bot,
  manutenzione: Wrench,
  'backup-sicurezza': ShieldCheck,
};

export interface SectionTableProps {
  now: number;
  clock: Clock;
  selectedKey: string | null;
  gatewayDown: boolean;
  ranAt: Readonly<Record<string, number>>;
  brakes: Readonly<Record<string, { text: string }>>;
  flowOpen: ReadonlySet<string>;
  onFlow(key: string): void;
  onSelect(row: AutomationRow): void;
  onCommand(row: AutomationRow, c: JobCommand): void;
}

export function AreaSections({ rows, table }: { rows: AutomationRow[]; table: SectionTableProps }) {
  const tr = useT();
  return (
    <>
      {areaGroups(rows).map((g) => {
        const I = AREA_ICON[g.area];
        return (
          <div key={g.area} data-testid="automations-area-group" data-area={g.area}>
            <h2 className={SECTION}>
              <I size={13} aria-hidden="true" />{tr(`auto.area.${g.area}`)}
              <span className={SECTION_COUNT}>{g.rows.length}</span>
              <span className="ml-auto flex gap-2 font-normal normal-case tracking-normal tabular-nums" data-testid="automations-area-counts">
                <span className="text-app-text-muted">{tr('auto.area.ok', { n: g.ok })}</span>
                {g.decide > 0 && <span className={WARNING_TEXT}>{tr('auto.area.decide', { n: g.decide })}</span>}
                {g.broken > 0 && <span className={DANGER_TEXT}>{tr(g.broken === 1 ? 'auto.area.brokenOne' : 'auto.area.broken', { n: g.broken })}</span>}
              </span>
            </h2>
            <AutomationTable rows={g.rows} limit={null} {...table} />
          </div>
        );
      })}
    </>
  );
}

export function OwnSection({ rows, table }: { rows: AutomationRow[]; table: SectionTableProps }) {
  const tr = useT();
  if (rows.length === 0) return null;
  const off = rows.filter((r) => r.level !== 'va').length;
  return (
    <div data-testid="automations-own">
      <h2 className={SECTION}>
        <MonitorSmartphone size={13} aria-hidden="true" />{tr('auto.own.title')}
        <span className={SECTION_COUNT}>{rows.length}</span>
        {off > 0 && <span className={`${SECTION_COUNT} ${WARNING_TEXT}`}>{tr(off === 1 ? 'auto.own.stoppedOne' : 'auto.own.stopped', { n: off })}</span>}
        <span className={SECTION_REST}>{tr('auto.own.note')}</span>
      </h2>
      <AutomationTable rows={sortRows(rows)} limit={null} {...table} />
    </div>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
