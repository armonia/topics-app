import { useMemo, useState } from 'react';
import { CalendarDays, CircleDot, FileText, List, MapPin, SquareKanban, User, Workflow } from 'lucide-react';
import type { UiCopy } from '../ui/copy/types';
import { Button } from '../ui/primitives/Button';
import { Chip } from '../ui/primitives/Chip';
import { FilterBar } from '../ui/filters/FilterBar';
import { SubNav } from '../ui/shell/SubNav';
import { useListFilters, type FilterSchema, type SavedFilter } from './app/filters';

/** The demo's clock, so «within 7 days» gives the same list every day. */
const NOW = '2026-11-08T10:00:00';

interface DemoCard {
  id: string;
  title: string;
  flow: 'waste' | 'invoices' | 'tenders';
  state: 'open' | 'working' | 'check' | 'done';
  person: string;
  due: string;
  place: string;
}

const CARDS: DemoCard[] = [
  { id: 'FIR-0931', title: 'Formulario 0931', flow: 'waste', state: 'check', person: 'Marta Greco', due: '2026-11-09', place: 'Salerno' },
  { id: 'FIR-0932', title: 'Formulario 0932', flow: 'waste', state: 'working', person: 'Luca Ferri', due: '2026-11-12', place: 'Battipaglia' },
  { id: 'FIR-0933', title: 'Formulario 0933', flow: 'waste', state: 'open', person: 'Marta Greco', due: '2026-11-20', place: 'Salerno' },
  { id: 'FP-2210', title: 'Fattura Eco Sud', flow: 'invoices', state: 'check', person: 'Anna Conti', due: '2026-11-07', place: 'Eboli' },
  { id: 'FP-2211', title: 'Fattura Metalli Rossi', flow: 'invoices', state: 'working', person: 'Anna Conti', due: '2026-11-14', place: 'Salerno' },
  { id: 'FP-2212', title: 'Fattura Autoparco', flow: 'invoices', state: 'done', person: 'Luca Ferri', due: '2026-10-30', place: 'Battipaglia' },
  { id: 'GA-0412', title: 'Gara raccolta Castellabate', flow: 'tenders', state: 'working', person: 'Paola Neri', due: '2026-11-15', place: 'Castellabate' },
  { id: 'GA-0413', title: 'Gara spazzamento Eboli', flow: 'tenders', state: 'open', person: 'Paola Neri', due: '2026-12-02', place: 'Eboli' },
  { id: 'GA-0414', title: 'Gara ingombranti Salerno', flow: 'tenders', state: 'check', person: 'Marta Greco', due: '2026-11-10', place: 'Salerno' },
  { id: 'FIR-0934', title: 'Formulario 0934', flow: 'waste', state: 'done', person: 'Luca Ferri', due: '2026-11-02', place: 'Eboli' },
];

/** The demo's own `ui`: the same shape as the container's, kept in the page. */
function useDemoState<T>(_key: string, initial: T) {
  return useState<T>(initial);
}

function schemaFor(copy: UiCopy): FilterSchema<DemoCard> {
  const d = copy.filters.demo;
  return {
    text: (c) => `${c.id} ${c.title} ${c.person} ${c.place}`,
    fields: [
      { id: 'card', label: d.fields.card, icon: FileText, kind: 'text', get: (c) => c.id, suggest: true },
      { id: 'flusso', label: d.fields.flow, icon: Workflow, kind: 'choice', get: (c) => c.flow, valueLabel: (v) => d.flows[v as DemoCard['flow']], order: ['waste', 'invoices', 'tenders'] },
      { id: 'stato', label: d.fields.state, icon: CircleDot, kind: 'choice', get: (c) => c.state, valueLabel: (v) => d.states[v as DemoCard['state']], order: ['open', 'working', 'check', 'done'] },
      { id: 'persona', label: d.fields.person, icon: User, kind: 'choice', get: (c) => c.person, valueIcon: () => User },
      { id: 'comune', label: d.fields.place, icon: MapPin, kind: 'choice', get: (c) => c.place },
      { id: 'scadenza', label: d.fields.due, icon: CalendarDays, kind: 'date', get: (c) => c.due },
    ],
  };
}

/** A live filter bar over ten demo cards, and the section strip above it. */
export function FiltersDemo({ copy }: { copy: UiCopy }) {
  const d = copy.filters.demo;
  const [section, setSection] = useState(1);
  const [view, setView] = useState<'list' | 'board'>('list');
  const schema = useMemo(() => schemaFor(copy), [copy]);
  const presets = useMemo<SavedFilter[]>(() => [
    { id: 'check', name: d.savedBlocked, tokens: [{ id: 'p1', field: 'stato', op: 'is', value: 'check' }] }, // allow-italian: field ids compared by value
    { id: 'soon', name: d.savedMine, tokens: [{ id: 'p2', field: 'scadenza', op: 'within', value: '7' }] },
  ], [d]);
  const list = useListFilters({ ui: useDemoState, copy, now: NOW }, { key: 'kit.filters', items: CARDS, schema, presets });
  const shown = list.items;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SubNav
        label={d.subNavLabel}
        items={d.sections.map((label, i) => ({ id: String(i), label, active: i === section, count: i === 1 ? 3 : undefined }))}
        onSelect={(id) => setSection(Number(id))}
      />
      <FilterBar
        copy={copy}
        {...list.bar}
        trailing={(
          <span className="flex items-center gap-1" role="group" aria-label={d.viewLabel}>
            <Button size="md" variant={view === 'list' ? 'secondary' : 'ghost'} icon={List} onClick={() => setView('list')}>{d.viewList}</Button>
            <Button size="md" variant={view === 'board' ? 'secondary' : 'ghost'} icon={SquareKanban} onClick={() => setView('board')}>{d.viewBoard}</Button>
          </span>
        )}
      />
      <ul className="flex min-h-[8rem] flex-col divide-y divide-app-border rounded-lg border border-app-border">
        {shown.length === 0 && <li className="px-3 py-6 text-center text-compact text-app-text-tertiary">{d.empty}</li>}
        {shown.map((c) => (
          <li key={c.id} className="flex min-w-0 items-center gap-3 px-3 py-1.5 text-compact">
            <span className="w-16 shrink-0 font-medium tabular-nums text-app-text-secondary">{c.id}</span>
            <span className="min-w-0 flex-1 truncate text-app-text">{c.title}</span>
            <Chip tone={c.state === 'done' ? 'green' : c.state === 'check' ? 'amber' : 'neutral'}>{d.states[c.state]}</Chip>
            <span className="hidden w-24 shrink-0 truncate text-app-text-tertiary sm:inline">{c.person}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
