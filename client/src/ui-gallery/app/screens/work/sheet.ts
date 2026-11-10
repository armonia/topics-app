/** The model of the full sheet of a case (w05), from the case and what the reader did to it. */
import type { UiCopy } from '../../../../ui/copy/types';
import type { SheetModel, SheetHistoryModel } from '../../../../ui/work/model';
import { PERSONAS, OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { CHANNEL_LABEL, KIND_LABEL, SECTOR_WORK, counterpartProgram, protocolProgram, recordName, systemsOf } from '../../../../ui/fixtures/work';
import type { LiveCase } from '../../store/cases';
import { caseSeed } from '../../store/cases';
import { canDo } from '../../store/permissions';
import type { DemoState } from '../../store/state';
import { FLOW_NAME, mainDeadline, phasesOf, receiptsOf } from './adapters';
import { daysFromToday, distanceLabel, distanceTone, formatAmount, formatDay, formatShortDay, historyAt, CLOSED } from './format';

const PROGRAMS = ['Halley', 'Prunes', 'QGIS', 'TeamSystem', 'WinWaste', 'SharePoint'];

export function kindOfWho(who: string, copy: UiCopy): SheetHistoryModel['kind'] {
  const w = copy.work.sheet;
  if (who === 'AI' || who.startsWith(w.assistantWord)) return 'ai';
  if (PROGRAMS.some((p) => who.startsWith(p))) return 'program';
  if (who.startsWith(w.flowWord) || who.startsWith(w.ruleWord)) return 'flow';
  return 'person';
}

/** How many people of the example can see the case and work on it. */
export function viewersOf(state: DemoState, c: LiveCase): number {
  return PERSONAS.filter((p) => p.orgs.includes(c.org)
    && canDo(state, p, 'view:data')
    && (!p.offices.length || p.offices.includes(c.office) || c.assignee === p.id)).length;
}

export function sheetOf(c: LiveCase, state: DemoState, copy: UiCopy): SheetModel {
  const s = copy.work.sheet;
  const main = mainDeadline(c);
  const mainDays = main ? daysFromToday(main.date) : undefined;
  const current = c.steps.find((x) => x.state === 'current');
  const next = c.steps.find((x) => x.state === 'todo');
  const assignee = PERSONAS.find((p) => p.id === c.assignee);
  const folderField = c.fields.find((f) => f.id === 'fascicolo');
  const receipts = receiptsOf(c);
  const history: SheetHistoryModel[] = c.history.map((e, i) => ({
    id: `h-${i}`,
    at: historyAt(e.at),
    who: e.who,
    what: e.what,
    kind: receipts.some((r) => r.title === e.what) ? 'receipt' : kindOfWho(e.who, copy),
    kindLabel: '',
    linked: Boolean(e.doc && c.documents.some((d) => d.id === e.doc)),
  }));
  if (current) {
    history.push({ id: 'h-pending', at: s.pending, who: s.pendingWho(OFFICE_LABEL[c.office]), what: current.label, kind: 'person', kindLabel: '', pending: true });
  }
  const phases = phasesOf(c, copy);
  return {
    crumbs: [{ label: copy.data.root }, { label: SECTOR_WORK.myRecords }, { label: c.id }],
    kindLabel: KIND_LABEL[c.kind],
    title: c.title,
    exampleTag: SECTOR_WORK.exampleTag,
    facts: [
      {
        id: 'term',
        label: s.term,
        value: main && mainDays !== undefined ? `${formatShortDay(main.date)} · ${distanceLabel(mainDays, copy)}` : s.noTerm,
        detail: main ? `${main.label} · ${main.rule}` : undefined,
        tone: mainDays !== undefined && mainDays <= 7 ? 'urgent' : undefined,
        linked: Boolean(main),
      },
      {
        id: 'counterpart',
        label: s.counterpartOf(counterpartProgram(c.kind)),
        value: c.counterpart,
        detail: [c.comune, c.amount !== undefined ? formatAmount(c.amount) : undefined, CHANNEL_LABEL[c.channel]].filter(Boolean).join(' · '),
      },
      {
        id: 'protocol',
        label: s.protocolOf(protocolProgram(c.kind)),
        value: c.protocol ? c.protocol.number : s.notProtocolled,
        detail: c.protocol ? `${s.protocolDate(formatDay(c.protocol.date))}${folderField ? ` · ${folderField.value}` : ''}` : undefined,
        linked: c.status === 'da-confermare',
      },
    ],
    fields: c.fields.map((f) => {
      const doc = c.documents.find((d) => d.id === f.source.doc);
      const typed = c.live.values?.[f.id] !== undefined;
      return {
        id: f.id,
        label: f.label,
        value: f.value,
        source: `${doc?.name ?? f.source.doc} · ${copy.common.page(f.source.page)}`,
        confidence: `${f.confidence}%`,
        corrected: typed,
      };
    }),
    deadlines: c.deadlines.map((d) => {
      const days = daysFromToday(d.date);
      return {
        id: d.id,
        label: d.label,
        date: formatDay(d.date),
        distance: distanceLabel(days, copy),
        tone: distanceTone(days),
        calc: d.calc,
        rule: d.rule,
        rollsOver: d.rollsOver ? s.rollsOver : undefined,
      };
    }),
    history,
    documents: c.documents.map((d) => ({
      id: d.id,
      name: d.name,
      detail: d.detail,
      badge: d.draft ? { text: copy.record.draft, tone: 'pink' as const } : d.signed ? { text: copy.record.signed, tone: 'green' as const } : undefined,
    })),
    related: (c.related ?? []).flatMap((id) => {
      const r = caseSeed(id);
      return r ? [{ id: r.id, title: r.title, detail: `${recordName(r.id)} · ${copy.work.record.statusOf[r.status]}` }] : [];
    }),
    phasesLabel: copy.work.record.stepsOf(FLOW_NAME(c.flow) ?? ''),
    phases,
    whoLabel: s.whoLabel,
    who: {
      headline: c.status === 'da-confermare'
        ? s.waitsForConfirm
        : c.status === CLOSED ? s.closed : s.nowOn(OFFICE_LABEL[c.office]),
      detail: c.status === 'da-confermare' ? s.waitsForConfirmBody : s.stepNow(current?.label ?? '', next?.label),
      rows: [
        { id: 'office', label: s.office, value: OFFICE_LABEL[c.office] },
        { id: 'assignee', label: s.assignee, value: assignee?.name ?? c.assignee },
        { id: 'viewers', label: s.viewers, value: copy.work.sheet.people(viewersOf(state, c)) },
      ],
    },
    systems: systemsOf(c.kind).map((x, i) => ({ id: String(i), what: x.what, where: x.where })),
    programName: protocolProgram(c.kind),
    primaryLabel: receipts.length ? copy.work.record.receiptButton : c.primaryAction.label,
  };
}

