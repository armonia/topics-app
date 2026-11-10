/**
 * o03: the map of who knows what. The place for `/conoscenza/mappa`.
 */
import { BackButton } from '../../../../ui/shell/PaneHeader';
import { Button } from '../../../../ui/primitives/Button';
import { Select } from '../../../../ui/primitives/Field';
import { MapScreen } from '../../../../ui/knowledge/MapScreen';
import type { MapActivityModel, MapKpiModel, MapNextModel, MapOfficeModel, MapPersonModel, MapView } from '../../../../ui/knowledge/model';
import {
  MAP_BASE, MAP_HANDOVER, MAP_MOST_UNWRITTEN, MAP_OFFICES, MAP_PEOPLE, MAP_ROLES, MAP_SUBSTITUTES, type MapActivitySeed,
} from '../../../../ui/fixtures/knowledge-more-map';
import { PROCEDURES } from '../../../../ui/fixtures/knowledge-more';
import { addDays, DEMO_TODAY, formatDay } from '../../../../ui/fixtures/org/clock';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { liveProcedure, procedureStatus } from './engine';
import { reviewing } from './helpers';
import { MAP_INIT, MAP_SLICE, PROCEDURES_SLICE, type MapLive, type ProceduresState } from './state';

const roleLabel = (code: string) => MAP_ROLES.find((r) => r.code === code)?.label ?? code;

/** The Monday after the demo's Friday: the day an interview is scheduled for. */
function nextMonday(): string {
  let d = addDays(DEMO_TODAY, 1);
  for (let i = 0; i < 7; i += 1) {
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === 1) break;
    d = addDays(d, 1);
  }
  return d;
}

export function MapPlace({ ctx }: { ctx: ScreenCtx }) {
  const copy = ctx.copy;
  const m = copy.knowledgeMore.map;
  const [procs] = ctx.slice<ProceduresState>(PROCEDURES_SLICE, {});
  const [live, setLive] = ctx.slice<MapLive>(MAP_SLICE, MAP_INIT);
  const [view, setView] = ctx.ui<MapView>('kn.map.view', 'office');
  const [officeId, setOfficeId] = ctx.ui<string>('kn.map.office', 'personale');
  const [personId, setPersonId] = ctx.ui<string>('kn.map.person', 'RU');
  const [subPick, setSubPick] = ctx.ui<string>('kn.map.subPick', MAP_SUBSTITUTES[0]);
  const [, setSel] = ctx.ui<string>('kn.sel', 'procedure');
  const meetingDay = nextMonday();
  const meeting = `${formatDay(meetingDay).slice(0, 5)} ${m.meetingTime}`;

  const inReview = reviewing(procs).length;
  const proceduresOf = (id: string) => PROCEDURES.find((p) => p.id === id);

  /* ---- the activities, with the state of their procedure ---- */
  const modelOf = (a: MapActivitySeed, officeId: string): MapActivityModel => {
    const proc = a.procedure ? proceduresOf(a.procedure) : undefined;
    const st = proc ? procedureStatus(proc, liveProcedure(procs, proc.id)) : undefined;
    const state: MapActivityModel['state'] = st === 'approvata' ? 'written' : proc ? 'review' : a.norm ? 'written' : 'none';
    const action: MapActivityModel['action'] = proc ? 'procedure' : a.norm ? 'documents' : a.interview ? 'interview' : 'prepare';
    return { id: a.id, label: a.label, holders: a.holders, gap: a.holders.length === 1, state, action, office: officeId, prepared: !!live.prepared[a.id] };
  };
  const offices: MapOfficeModel[] = MAP_OFFICES.map((o) => ({
    id: o.id, label: o.label, activities: o.activities, written: o.written, singles: o.singles, riskiest: o.riskiest, holder: `${o.holder.label} (${o.holder.code})`,
    listed: o.listed.map((a) => modelOf(a, o.id)),
  }));
  const allListed = offices.flatMap((o) => o.listed);
  const people: MapPersonModel[] = [...MAP_PEOPLE]
    .sort((a, b) => b.activities - a.activities)
    .map((p) => ({ id: p.code, label: `${roleLabel(p.code)} (${p.code})`, activities: p.activities, only: p.only, nearRetirement: p.nearRetirement }));
  const retiring = new Set(MAP_PEOPLE.filter((p) => p.nearRetirement).map((p) => p.code));
  const riskActivities = allListed
    .filter((a) => a.gap)
    .sort((a, b) => Number(retiring.has(b.holders[0])) - Number(retiring.has(a.holders[0])) || a.label.localeCompare(b.label));

  /* ---- the numbers, all computed from the offices ---- */
  const found = MAP_OFFICES.reduce((n, o) => n + o.activities, 0);
  const writtenShare = Math.round(MAP_OFFICES.reduce((n, o) => n + o.activities * o.written, 0) / found);
  const singles = MAP_OFFICES.reduce((n, o) => n + o.singles, 0);
  const kpis: MapKpiModel[] = [
    { id: 'found', label: m.kpi.found.label, value: String(found), detail: m.kpi.found.detail(MAP_BASE.interviews, MAP_BASE.pecWeeks) },
    { id: 'written', label: m.kpi.written.label, value: `${writtenShare}%`, detail: m.kpi.written.detail(MAP_BASE.goal, MAP_BASE.goalBy) },
    { id: 'single', label: m.kpi.single.label, value: String(singles), detail: m.kpi.single.detail(MAP_BASE.nearRetirement), tone: 'red' },
    { id: 'review', label: m.kpi.review.label, value: String(inReview), detail: m.kpi.review.detail, tone: 'amber' },
  ];
  const biggestOffice = [...MAP_OFFICES].sort((a, b) => b.activities - a.activities)[0].id;
  const openKpi = (id: string) => {
    const kpi = kpis.find((k) => k.id === id);
    const stay = () => kpi && ctx.toast({ title: `${kpi.label}: ${kpi.value}`, body: kpi.detail });
    if (id === 'single') {
      if (view === 'risk') stay();
      else setView('risk');
    } else if (id === 'review' || id === 'written') {
      setSel('procedure');
      ctx.go(P.knowledge());
    } else if (view === 'office' && officeId === biggestOffice) stay();
    else {
      setView('office');
      setOfficeId(biggestOffice);
    }
  };

  /* ---- what an activity row opens ---- */
  const openActivity = (a: MapActivityModel) => {
    const seed = MAP_OFFICES.flatMap((o) => o.listed).find((x) => x.id === a.id);
    if (!seed) return;
    if (a.action === 'procedure' && seed.procedure) ctx.go(P.procedure(seed.procedure));
    else if (a.action === 'interview' && seed.interview) ctx.go(P.chat(seed.interview));
    else if (a.action === 'documents' && seed.norm) {
      const [item, article] = seed.norm.split('/');
      ctx.go(P.knowledgeDoc(item, article));
    } else if (a.action === 'prepare') {
      if (!ctx.can('edit:data')) {
        ctx.toast({ tone: 'warn', title: ctx.deniedTitle('edit:data') ?? '' });
        return;
      }
      setLive((l) => ({ ...l, prepared: { ...l.prepared, [a.id]: true } }));
      ctx.log(m.interviewLog(a.label), 'knowledge', P.knowledgeMap());
      ctx.toast({ tone: 'ok', title: m.interviewToast(a.label), body: m.interviewBody });
    }
  };

  /* ---- the next actions ---- */
  const schedule = ctx.can('edit:data');
  const scheduleAction = (id: string, label: string) => {
    if (!schedule) {
      ctx.toast({ tone: 'warn', title: ctx.deniedTitle('edit:data') ?? '' });
      return;
    }
    setLive((l) => ({ ...l, scheduled: { ...l.scheduled, [id]: meeting } }));
    ctx.log(m.scheduleLog(label, meeting), 'knowledge', P.knowledgeMap());
    ctx.notify({ title: m.scheduleNotify(label), body: meeting, path: P.knowledgeMap(), tone: 'info' });
    ctx.toast({ tone: 'ok', title: m.scheduleToast(meeting) });
  };
  const next: MapNextModel[] = [];
  const ruId = 'ru-handover';
  const ruLabel = m.nextInterview('RU');
  next.push({
    id: ruId,
    label: ruLabel,
    state: live.scheduled[ruId] ? { text: m.scheduled(live.scheduled[ruId]), tone: 'green' } : { text: m.toSchedule, tone: 'amber' },
    control: live.scheduled[ruId]
      ? <Button size="sm" onClick={() => ctx.go(P.chat('intervista-catasto'))}>{m.openInterviewChat}</Button>
      : <Button size="sm" variant="primary" onClick={() => scheduleAction(ruId, ruLabel)}>{m.scheduleButton}</Button>,
  });
  for (const a of allListed.filter((x) => x.prepared)) {
    const label = m.nextInterviewOn(a.label);
    next.push({
      id: `prep-${a.id}`,
      label,
      state: live.scheduled[`prep-${a.id}`] ? { text: m.scheduled(live.scheduled[`prep-${a.id}`]), tone: 'green' } : { text: m.toSchedule, tone: 'amber' },
      control: live.scheduled[`prep-${a.id}`] ? null : <Button size="sm" variant="primary" onClick={() => scheduleAction(`prep-${a.id}`, label)}>{m.scheduleButton}</Button>,
    });
  }
  const chosen = live.substitute;
  next.push({
    id: 'substitute',
    label: m.nextSubstitute(MAP_HANDOVER.activity),
    state: chosen ? { text: m.chosen(chosen), tone: 'green' } : { text: m.toChoose, tone: 'amber' },
    control: chosen ? (
      <Button size="sm" onClick={() => setLive((l) => ({ ...l, substitute: undefined }))}>{m.change}</Button>
    ) : (
      <span className="flex items-end gap-1.5">
        <Select size="sm" title={m.chooseLabel} value={subPick} options={MAP_SUBSTITUTES.map((c) => ({ value: c, label: `${roleLabel(c)} (${c})` }))} onChange={setSubPick} />
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            if (!schedule) {
              ctx.toast({ tone: 'warn', title: ctx.deniedTitle('edit:data') ?? '' });
              return;
            }
            setLive((l) => ({ ...l, substitute: subPick }));
            ctx.log(m.chooseLog(subPick), 'knowledge', P.knowledgeMap());
            ctx.toast({ tone: 'ok', title: m.chooseToast(subPick) });
          }}
        >
          {m.chooseConfirm}
        </Button>
      </span>
    ),
  });
  next.push({
    id: 'review',
    label: m.nextReview(inReview),
    state: inReview ? { text: m.openCards, tone: 'neutral' } : { text: m.done, tone: 'green' },
    control: inReview ? <Button size="sm" onClick={() => openKpi('review')}>{m.reviewOpen}</Button> : null,
  });

  const officeLabels: Record<string, string> = Object.fromEntries(MAP_OFFICES.map((o) => [o.id, o.label]));
  const person = MAP_PEOPLE.find((p) => p.code === personId) ?? MAP_PEOPLE[0];
  const personActivities = allListed.filter((a) => a.holders.includes(person.code));

  return (
    <MapScreen
      copy={copy}
      phone={ctx.phone}
      view={view}
      onView={setView}
      kpis={kpis}
      onOpenKpi={openKpi}
      offices={offices}
      selectedOffice={officeId}
      onSelectOffice={setOfficeId}
      people={people}
      selectedPerson={person.code}
      onSelectPerson={setPersonId}
      personActivities={personActivities}
      riskActivities={riskActivities}
      officeLabels={officeLabels}
      labelOf={roleLabel}
      onOpenActivity={openActivity}
      mostUnwritten={MAP_MOST_UNWRITTEN.flatMap((code) => people.filter((p) => p.id === code))}
      onOpenPerson={(code) => { setPersonId(code); setView('person'); }}
      next={next}
      backSlot={<BackButton label={copy.knowledge.root} onClick={() => ctx.go(P.knowledge())} copy={copy} />}
    />
  );
}
