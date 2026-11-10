import { CircleAlert, CircleCheck, CircleDashed, FlaskConical, GitCompare, History, RotateCcw } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Chip } from '../primitives/Chip';
import { Table } from '../primitives/Table';
import { Tabs } from '../primitives/Tabs';
import { EmptyState } from '../primitives/EmptyState';
import { Button } from '../primitives/Button';
import { FOCUS_RING } from '../shell/pressable';
import type { CaseFilter, CaseOutcomeKind, CriterionRowModel, DiffRowModel, FlowTestModel, HistoryRowModel, TestCaseRowModel } from './model';
import { RowMenu, SectionHead, StateChip, TitleButton } from './parts';

/** The criteria a version has to pass, one row each, with where it stands. */
export function CriteriaTable({ criteria, copy }: { criteria: FlowTestModel['criteria']; copy: UiCopy }) {
  const t = copy.team.test.criteria;
  return (
    <section>
      <SectionHead title={t.title} aside={t.agreedWith(criteria.agreedWith)} />
      <Table
        ariaLabel={t.title}
        columns={[
          { id: 'criterion', label: t.columns.criterion },
          { id: 'required', label: t.columns.required, width: 120 },
          { id: 'now', label: t.columns.now, width: 110, align: 'right' },
          { id: 'state', label: t.columns.state, width: 170 },
        ]}
        rows={criteria.rows.map((r: CriterionRowModel) => ({
          id: r.id,
          cells: {
            criterion: (
              <span className="block">
                <span className="font-medium">{r.label}</span>
                {r.detail && <span className="text-app-text-secondary"> {r.detail}</span>}
              </span>
            ),
            required: <span className="text-app-text-secondary">{r.required}</span>,
            now: (
              <span data-tip={r.estimate ? copy.team.common.estimate : undefined}>
                {r.now}
                {r.estimate && <sup className="ml-0.5 text-nano text-app-text-faint">*</sup>}
              </span>
            ),
            state: <StateChip tone={r.tone} icon={r.icon}>{r.stateText}</StateChip>,
          },
        }))}
      />
      <p className="mt-1.5 text-mini text-app-text-tertiary"><span aria-hidden="true">* </span>{criteria.estimateNote}</p>
    </section>
  );
}

const OUTCOME: Record<CaseOutcomeKind, { tone: 'green' | 'red' | 'amber'; icon: typeof CircleCheck }> = {
  pass: { tone: 'green', icon: CircleCheck },
  resolved: { tone: 'green', icon: CircleCheck },
  fail: { tone: 'red', icon: CircleAlert },
  unstable: { tone: 'red', icon: CircleAlert },
};

/** Every fixed case of the flow with what the people decided and what the flow gave. */
export function CasesTable({ cases, copy, onFilter, onBackToLast }: {
  cases: FlowTestModel['cases'];
  copy: UiCopy;
  onFilter: (f: CaseFilter) => void;
  onBackToLast: () => void;
}) {
  const c = copy.team.test.cases;
  const word = (o: CaseOutcomeKind) => (o === 'pass' ? c.pass : o === 'resolved' ? c.resolved : o === 'unstable' ? c.unstable : c.fail);
  return (
    <section>
      <SectionHead title={c.title} aside={c.count(cases.shown, cases.total)} />
      {cases.older && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-sky-500/10 px-3 py-2 text-prose text-sky-800 dark:text-sky-300">
          <History size={14} aria-hidden="true" />
          <span>{cases.older}</span>
          <button type="button" onClick={onBackToLast} className={clsx('ml-auto rounded font-medium underline underline-offset-2', FOCUS_RING)}>{c.backToLast}</button>
        </div>
      )}
      <Tabs<CaseFilter>
        ariaLabel={c.filterLabel}
        value={cases.filter}
        onChange={onFilter}
        options={[
          { value: 'all', label: c.filters.all, count: cases.counts.all },
          { value: 'fail', label: c.filters.fail, count: cases.counts.fail },
          { value: 'pass', label: c.filters.pass, count: cases.counts.pass },
        ]}
        className="mb-2"
      />
      <Table
        ariaLabel={c.title}
        columns={[
          { id: 'case', label: c.columns.case },
          { id: 'people', label: c.columns.people, width: 200 },
          { id: 'flow', label: c.columns.flow, width: 200 },
          { id: 'outcome', label: c.columns.outcome, width: 120 },
        ]}
        rows={cases.rows.map((r: TestCaseRowModel) => ({
          id: r.id,
          onOpen: r.onOpen,
          cells: {
            case: (
              <span className="block">
                <span className="font-medium">{r.title}</span>
                <span className="ml-1.5 font-mono text-mini text-app-text-faint">{r.ref}</span>
              </span>
            ),
            people: <span className="text-app-text-secondary">{r.people}</span>,
            flow: <span className={r.differs ? 'font-medium text-rose-700 dark:text-rose-400' : 'text-app-text-secondary'}>{r.flow}</span>,
            outcome: <Chip tone={OUTCOME[r.outcome].tone} icon={OUTCOME[r.outcome].icon}>{word(r.outcome)}</Chip>,
          },
        }))}
        empty={
          cases.total === 0 ? (
            <EmptyState icon={FlaskConical} title={c.emptyTitle} className="min-h-0 py-4">{cases.emptyBody}</EmptyState>
          ) : (
            <span className="inline-flex flex-wrap items-center justify-center gap-2">
              {c.noMatch}
              <Button size="sm" onClick={() => onFilter('all')}>{c.showAll}</Button>
            </span>
          )
        }
      />
    </section>
  );
}

/** The cases where the flow and the people disagree, and who is right. */
export function DiffTable({ diffs, copy, onSelect }: {
  diffs: FlowTestModel['diffs'];
  copy: UiCopy;
  onSelect: (id: string, item: string) => void;
}) {
  const d = copy.team.test.diff;
  return (
    <section>
      <SectionHead title={d.title} aside={d.count(diffs.rows.length, diffs.total)} />
      <Table
        ariaLabel={d.title}
        columns={[
          { id: 'case', label: d.columns.case },
          { id: 'flow', label: d.columns.flow, width: 180 },
          { id: 'people', label: d.columns.people, width: 160 },
          { id: 'right', label: d.columns.right, width: 170 },
          { id: 'act', label: '', width: 92 },
        ]}
        rows={diffs.rows.map((r: DiffRowModel) => ({
          id: r.id,
          cells: {
            case: (
              <span className="block">
                <TitleButton onClick={r.onOpen}>{r.title}</TitleButton>
                <span className="ml-1.5 font-mono text-mini text-app-text-faint">{r.ref}</span>
              </span>
            ),
            flow: (
              <span className="block">
                <span className="font-medium text-rose-700 dark:text-rose-400">{r.flow}</span>
                {r.rounds && <span className="ml-1.5 text-mini text-app-text-tertiary">{r.rounds}</span>}
              </span>
            ),
            people: <span className="text-app-text-secondary">{r.people}</span>,
            right: <StateChip tone={r.right.tone} icon={r.right.tone === 'green' ? 'ok' : r.right.tone === 'red' ? 'bad' : 'near'}>{r.right.text}</StateChip>,
            act: <RowMenu label={d.decide} items={r.items} onSelect={(item) => onSelect(r.id, item)} />,
          },
        }))}
        empty={
          <EmptyState icon={diffs.ran ? GitCompare : CircleDashed} title={diffs.ran ? d.emptyTitle : d.noRun} className="min-h-0 py-4">
            {diffs.ran ? d.emptyBody : undefined}
          </EmptyState>
        }
      />
    </section>
  );
}

/** The tests this version had: a click shows that run's results. */
export function HistoryList({ rows, copy }: { rows: HistoryRowModel[]; copy: UiCopy }) {
  const h = copy.team.test.history;
  return (
    <section>
      <SectionHead title={h.title} />
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-app-border px-3 py-3 text-prose text-app-text-tertiary">{h.empty}</p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-app-border bg-surface">
          {rows.map((r) => (
            <li key={r.id} className="border-b border-app-border last:border-b-0">
              <button
                type="button"
                onClick={r.onSelect}
                aria-current={r.selected ? 'true' : undefined}
                className={clsx('flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors', FOCUS_RING, r.selected ? 'bg-sky-500/[0.08]' : 'hover:bg-app-hover')}
              >
                {r.ok ? (
                  <CircleCheck size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                ) : (
                  <RotateCcw size={14} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate text-prose font-medium text-app-text">{r.title}</span>
                <span className="shrink-0 text-mini text-app-text-tertiary">{r.detail}</span>
                {r.selected && <Chip tone="blue">{h.current}</Chip>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
