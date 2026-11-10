/**
 * Every deadline of every case a person can see, plus the ones that no case
 * writes, as one list: the schedule (n14) and the calendar of the Pratiche
 * table (x01) draw from it, so they always agree.
 */
import type { Office } from '../../../../ui/fixtures/org/types';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { daysFromToday, formatDay, parseDay } from '../../../../ui/fixtures/org/clock';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import type { Persona } from '../../../../ui/fixtures/org/people';
import { EXTRA_DEADLINES } from '../../../../ui/fixtures/data';
import type { DemoState } from '../../store/state';
import { visibleCases } from '../../store/cases';

export type DeadlineStatus = 'done' | 'overdue' | 'soon' | 'open' | 'scheduled';

export interface DeadlineItem {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  label: string;
  office: Office;
  caseId?: string;
  /** The case title, or what an extra deadline concerns. */
  about: string;
  /** Who wrote it: a flow name, «a mano», «scadenzario». */
  writer: string;
  writerKind: 'flow' | 'schedule' | 'person' | 'knowledge';
  status: DeadlineStatus;
  rule?: string;
  calc?: string;
  note?: string;
  example?: boolean;
}

/** Reminders to an office are not terms: they stay out of the schedule. */
const isReminder = (id: string) => id.startsWith('avviso');  // allow-italian: id of the fixture data, not shown

/** A scheduled deadline stays scheduled until its day passes: it is not «soon» even a week before, the act is already arranged. */
export function statusOf(date: string, closed: boolean, scheduled = false): DeadlineStatus {
  if (closed) return 'done';
  const d = daysFromToday(date);
  if (d < 0) return 'overdue';
  if (scheduled) return 'scheduled';
  return d <= 7 ? 'soon' : 'open';
}

export function allDeadlines(state: DemoState, persona: Persona): DeadlineItem[] {
  const out: DeadlineItem[] = [];
  for (const c of visibleCases(state, persona, 'nocera')) {
    const flow = FLOWS.find((f) => f.id === c.flow);
    for (const d of c.deadlines) {
      if (isReminder(d.id)) continue;
      out.push({
        id: `${c.id}:${d.id}`,
        date: d.date,
        label: d.label,
        office: d.office,
        caseId: c.id,
        about: c.title,
        writer: flow?.name ?? c.flow,
        writerKind: 'flow',
        status: statusOf(d.date, c.status === 'chiusa'),  // allow-italian: id of the fixture data, not shown
        rule: d.rule,
        calc: d.calc,
      });
    }
  }
  for (const x of EXTRA_DEADLINES) {
    if (persona.offices.length && !persona.offices.includes(x.office)) continue;
    out.push({
      id: x.id,
      date: x.date,
      label: x.label,
      office: x.office,
      about: x.about,
      writer: x.writerLabel,
      writerKind: x.writer,
      status: statusOf(x.date, false, x.state === 'scheduled'),
      note: x.note,
      example: x.example,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

export function officesOf(items: DeadlineItem[]): Array<{ value: string; label: string }> {
  const seen = [...new Set(items.map((i) => i.office))];
  return seen.map((o) => ({ value: o, label: OFFICE_LABEL[o] }));
}

/** An iCalendar file with one all-day event per deadline. */
export function toIcs(items: DeadlineItem[], product: string): string {
  const stamp = '20261106T093000Z';
  const day = (d: string) => d.replace(/-/g, '');
  const next = (d: string) => {
    const x = parseDay(d);
    x.setUTCDate(x.getUTCDate() + 1);
    return x.toISOString().slice(0, 10).replace(/-/g, '');
  };
  const escapeIcs = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${product}//deadlines//IT`, 'CALSCALE:GREGORIAN'];
  for (const i of items) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${i.id.replace(/[^a-z0-9]/gi, '')}@topics-preview`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day(i.date)}`,
      `DTEND;VALUE=DATE:${next(i.date)}`,
      `SUMMARY:${escapeIcs(i.label)}`,
      `DESCRIPTION:${escapeIcs([OFFICE_LABEL[i.office], i.about, i.rule ?? '', formatDay(i.date)].filter(Boolean).join(' · '))}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
