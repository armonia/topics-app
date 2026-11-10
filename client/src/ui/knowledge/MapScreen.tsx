import type { ReactNode } from 'react';
import { ArrowRight, BookOpen, FileText, MessageSquareText, UserRoundSearch } from 'lucide-react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card, StatCard } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { Table } from '../primitives/Table';
import { PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import type { MapActivityModel, MapKpiModel, MapNextModel, MapOfficeModel, MapPersonModel, MapView } from './model';

/** The share of written activities as a thin bar and a number. */
function WrittenBar({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="h-1.5 w-[88px] shrink-0 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.12]" aria-hidden="true">
        <span className="block h-full rounded-full bg-primary dark:bg-primary-dark" style={{ width: `${value}%` }} />
      </span>
      <span className="tabular-nums">{value}%</span>
    </span>
  );
}

/** The role codes that know an activity; a lone one reads red. */
function Holders({ holders, gap, copy, labelOf }: { holders: string[]; gap: boolean; copy: UiCopy; labelOf: (code: string) => string }) {
  const m = copy.knowledgeMore.map;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {holders.map((h) => <Chip key={h} tone={gap ? 'red' : 'neutral'} title={labelOf(h)}>{h}</Chip>)}
      {gap && <span className="text-mini font-medium text-rose-600 dark:text-rose-400">{m.onlyOne(holders[0] ?? '')}</span>}
    </span>
  );
}

/** What a row of activities does: opens the procedure, the interview, the documents, or prepares an interview. */
function ActivityAction({ a, copy, onOpen }: { a: MapActivityModel; copy: UiCopy; onOpen: (a: MapActivityModel) => void }) {
  const m = copy.knowledgeMore.map;
  const label = a.action === 'procedure' ? m.openProcedure : a.action === 'interview' ? m.openInterview : a.action === 'documents' ? m.openDocuments : a.prepared ? m.interviewPrepared : m.prepareInterview;
  const Icon = a.action === 'procedure' ? FileText : a.action === 'documents' ? BookOpen : MessageSquareText;
  if (a.action === 'prepare' && a.prepared) return <Chip tone="blue">{label}</Chip>;
  return <Button size="sm" icon={Icon} onClick={() => onOpen(a)}>{label}</Button>;
}

/** The activities of one office, or of one person, or the lone-holder ones: who knows, is it written, what opens. */
function ActivitiesTable({ activities, copy, labelOf, onOpen, showOffice }: {
  activities: MapActivityModel[];
  copy: UiCopy;
  labelOf: (code: string) => string;
  onOpen: (a: MapActivityModel) => void;
  showOffice?: Record<string, string>;
}) {
  const m = copy.knowledgeMore.map;
  const state = (a: MapActivityModel) => (a.state === 'written' ? <Chip tone="green">{m.written}</Chip> : a.state === 'review' ? <Chip tone="amber">{m.inReview}</Chip> : <Chip tone={a.gap ? 'red' : 'neutral'}>{m.notWritten}</Chip>);
  return (
    <Table
      ariaLabel={m.columns.activity}
      columns={[
        { id: 'a', label: m.columns.activity, width: 280 },
        ...(showOffice ? [{ id: 'o', label: m.columns.office, width: 150 }] : []),
        { id: 'h', label: m.columns.holders, width: 200 },
        { id: 's', label: m.columns.state, width: 130 },
        { id: 'x', label: '', width: 190 },
      ]}
      rows={activities.map((a) => ({
        id: a.id,
        cells: {
          a: <span className="font-medium">{a.label}</span>,
          o: showOffice && a.office ? showOffice[a.office] : undefined,
          h: <Holders holders={a.holders} gap={a.gap} copy={copy} labelOf={labelOf} />,
          s: state(a),
          x: <ActivityAction a={a} copy={copy} onOpen={onOpen} />,
        },
      }))}
      dense
    />
  );
}

/**
 * The map of who knows what (o03): how many activities were found, how many
 * are written and approved, how many only one person knows, and which
 * procedures wait for review; then the offices (or the people, or only the
 * risky ones) with the activities listed for each, every one opening the
 * procedure, the interview or the documents behind it. All three views are
 * the same data, so a number in one agrees with the others.
 */
export function MapScreen({
  copy, phone, view, onView, kpis, onOpenKpi,
  offices, selectedOffice, onSelectOffice, people, selectedPerson, onSelectPerson,
  personActivities, riskActivities, officeLabels, labelOf, onOpenActivity,
  mostUnwritten, onOpenPerson, next, backSlot,
}: {
  copy: UiCopy;
  phone?: boolean;
  view: MapView;
  onView: (v: MapView) => void;
  kpis: MapKpiModel[];
  onOpenKpi: (id: string) => void;
  offices: MapOfficeModel[];
  selectedOffice: string;
  onSelectOffice: (id: string) => void;
  people: MapPersonModel[];
  selectedPerson: string;
  onSelectPerson: (code: string) => void;
  personActivities: MapActivityModel[];
  riskActivities: MapActivityModel[];
  officeLabels: Record<string, string>;
  labelOf: (code: string) => string;
  onOpenActivity: (a: MapActivityModel) => void;
  mostUnwritten: MapPersonModel[];
  onOpenPerson: (code: string) => void;
  next: MapNextModel[];
  backSlot?: ReactNode;
}) {
  const m = copy.knowledgeMore.map;
  const office = offices.find((o) => o.id === selectedOffice) ?? offices[0];
  const person = people.find((p) => p.id === selectedPerson) ?? people[0];
  const views = (
    <SegmentedControl
      value={view}
      onChange={onView}
      ariaLabel={m.viewsLabel}
      options={[{ value: 'office', label: m.views.office }, { value: 'person', label: m.views.person }, { value: 'risk', label: m.views.risk }]}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: copy.knowledge.root }, { label: m.title }]} leading={backSlot}>{!phone && views}</PaneHeader>
      {phone && <div className="flex flex-wrap gap-2 border-b border-app-border px-4 py-2">{views}</div>}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 md:px-7">
        <div className="flex flex-wrap items-center gap-2 text-compact text-app-text-tertiary">
          {m.subtitle} <Chip>{m.example}</Chip>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {kpis.map((k) => (
            <StatCard key={k.id} label={k.label} value={k.value} detail={k.detail} tone={k.tone === 'red' ? 'red' : k.tone === 'amber' ? 'amber' : undefined} onOpen={() => onOpenKpi(k.id)} />
          ))}
        </div>

        {view === 'office' && (
          <>
            <Table
              ariaLabel={m.tableOffices}
              columns={[
                { id: 'o', label: m.columns.office, width: 170 },
                { id: 'n', label: m.columns.activities, width: 90, align: 'right' },
                { id: 'w', label: m.columns.written, width: 170 },
                { id: 's', label: m.columns.single, width: 130, align: 'right' },
                { id: 'r', label: m.columns.riskiest, width: 250 },
                { id: 'h', label: m.columns.holder, width: 260 },
              ]}
              rows={offices.map((o) => ({
                id: o.id,
                selected: o.id === office.id,
                onOpen: o.id === office.id ? undefined : () => onSelectOffice(o.id),
                cells: {
                  o: <b className="font-semibold">{o.label}</b>,
                  n: o.activities,
                  w: <WrittenBar value={o.written} />,
                  s: <span className={o.singles >= 3 ? 'font-semibold text-rose-600 dark:text-rose-400' : undefined}>{o.singles}</span>,
                  r: o.riskiest,
                  h: o.holder,
                },
              }))}
            />
            <Card title={m.activitiesOf(office.label, office.listed.length, office.activities)}>
              <p className="mb-2.5 text-compact text-app-text-tertiary">{m.activitiesNote}</p>
              <ActivitiesTable activities={office.listed} copy={copy} labelOf={labelOf} onOpen={onOpenActivity} />
            </Card>
          </>
        )}

        {view === 'person' && (
          <>
            <Table
              ariaLabel={m.tablePeople}
              columns={[
                { id: 'p', label: m.columns.person, width: 300 },
                { id: 'n', label: m.columns.activities, width: 110, align: 'right' },
                { id: 'o', label: m.columns.only, width: 130, align: 'right' },
                { id: 'r', label: '', width: 200 },
              ]}
              rows={people.map((p) => ({
                id: p.id,
                selected: p.id === person.id,
                onOpen: p.id === person.id ? undefined : () => onSelectPerson(p.id),
                cells: {
                  p: <b className="font-semibold">{p.label}</b>,
                  n: p.activities,
                  o: <span className={p.only >= 3 ? 'font-semibold text-rose-600 dark:text-rose-400' : undefined}>{p.only}</span>,
                  r: p.nearRetirement ? <Chip tone="amber">{m.nearRetirement}</Chip> : undefined,
                },
              }))}
            />
            <Card title={person.label} icon={UserRoundSearch}>
              <p className="mb-2.5 text-compact text-app-text-tertiary">{m.perPersonNote}</p>
              {personActivities.length ? (
                <ActivitiesTable activities={personActivities} copy={copy} labelOf={labelOf} onOpen={onOpenActivity} showOffice={officeLabels} />
              ) : <p className="text-prose text-app-text-tertiary">{m.emptyOffice}</p>}
            </Card>
          </>
        )}

        {view === 'risk' && (
          <Card title={m.riskTitle} tone="red">
            {riskActivities.length ? (
              <ActivitiesTable activities={riskActivities} copy={copy} labelOf={labelOf} onOpen={onOpenActivity} showOffice={officeLabels} />
            ) : <p className="text-prose text-app-text-tertiary">{m.riskEmpty}</p>}
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Card title={m.whoMost}>
            <ul className="-mx-2 space-y-0.5">
              {mostUnwritten.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => onOpenPerson(p.id)} className={clsx('flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-prose text-app-text hover:bg-app-hover', FOCUS_RING)}>
                    <span className="min-w-0 flex-1 truncate">{p.label}</span>
                    <span className="shrink-0 tabular-nums font-semibold">{m.activitiesOnly(p.activities, p.only)}</span>
                    <ArrowRight size={13} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title={m.next}>
            <ul className="space-y-2.5">
              {next.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 basis-48 text-prose text-app-text">{n.label}</span>
                  <Chip tone={n.state.tone}>{n.state.text}</Chip>
                  {n.control}
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <div className="rounded-lg bg-black/[0.03] px-4 py-3 dark:bg-white/[0.04]">
          <div className="text-prose font-semibold text-app-text">{m.keepFresh}</div>
          <p className="mt-1 text-compact leading-6 text-app-text-secondary">{m.keepFreshText}</p>
        </div>
      </div>
    </div>
  );
}
