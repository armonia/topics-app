import { Check, MoreHorizontal } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Tone } from '../types';
import { Button } from '../primitives/Button';
import { Card, StatCard } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { MenuButton } from '../primitives/Menu';
import { PanelSection } from '../primitives/Panel';
import { ProgressBar, Spinner } from '../primitives/Progress';
import { Table, type TableColumnModel } from '../primitives/Table';
import { Tabs } from '../primitives/Tabs';
import { EmptyState } from '../primitives/EmptyState';
import { FOCUS_RING } from '../shell/pressable';
import type { DiffRow, JobView, TestCaseRow, VersionRow } from './model';
import { FactRow, StepRail } from './common';

const STATUS_TONE: Record<VersionRow['status'], Tone> = { active: 'green', testing: 'amber', draft: 'neutral', old: 'neutral' };

/** The versions of a flow, newest first: pick one to compare it with the active one. */
export function VersionList({ copy, versions, onMenu }: { copy: UiCopy; versions: VersionRow[]; onMenu: (n: number, id: string) => void }) {
  const c = copy.flowRun.versions;
  return (
    <ul aria-label={c.listLabel} className="flex flex-col gap-1.5">
      {versions.map((v) => (
        <li key={v.id} className="flex items-stretch gap-1">
          <button
            type="button"
            onClick={v.onSelect}
            aria-current={v.selected ? 'true' : undefined}
            className={clsx(
              'flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border bg-surface px-3 py-2 text-left transition-colors',
              v.selected ? 'border-primary shadow-[0_0_0_3px_rgba(0,102,255,0.15)]' : 'border-app-border hover:border-primary/50',
              FOCUS_RING,
            )}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-prose font-semibold text-app-text">{c.version(v.n)}</span>
              <Chip tone={STATUS_TONE[v.status]}>{c.status[v.status]}</Chip>
              <span className="ml-auto text-compact text-app-text-tertiary">{v.at}</span>
            </span>
            <span className="text-compact leading-5 text-app-text-secondary">{v.summary}</span>
            <span className="text-mini text-app-text-tertiary">{v.who}</span>
          </button>
          <MenuButton
            label={c.menu(v.n)}
            icon={MoreHorizontal}
            iconOnly
            variant="ghost"
            align="right"
            items={v.menu.map((m) => ({ id: m.id, label: m.label, danger: m.danger, disabled: m.disabled, title: m.title }))}
            onSelect={(id) => onMenu(v.n, id)}
          />
        </li>
      ))}
    </ul>
  );
}

export interface TestView {
  state: 'none' | 'running' | 'done';
  job?: JobView;
  at: string;
  total: number;
  same: number;
  fewer: number;
  newFlow: number;
  worse: number;
  morePerson: number;
  rows: TestCaseRow[];
  filter: 'all' | 'changed';
}

const CHANGE_TONE: Record<TestCaseRow['change'], Tone> = { same: 'neutral', better: 'green', risky: 'red', 'more-person': 'amber', 'new-flow': 'blue' };

/** The comparison of two versions: what changed, step by step, with the detail of the one selected. */
export function DiffColumn({ copy, chips, diff }: { copy: UiCopy; chips: Array<{ label: string; tone: Tone }>; diff: DiffRow[] }) {
  const c = copy.flowRun.versions;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">{chips.map((x) => <Chip key={x.label} tone={x.tone}>{x.label}</Chip>)}</div>
      {diff.length === 0 ? (
        <p className="text-prose text-app-text-tertiary">{c.noDiff}</p>
      ) : (
        <StepRail
          copy={copy}
          label={c.diffLabel}
          items={diff.map((d) => ({
            id: d.id, marker: d.marker, kind: d.kind, program: d.program, title: d.title, note: d.note, badges: d.badges,
            selected: d.selected, onSelect: d.onSelect,
          }))}
        />
      )}
    </div>
  );
}

export function DiffDetail({ copy, row, fromN, toN }: { copy: UiCopy; row: DiffRow | undefined; fromN: number; toN: number }) {
  const c = copy.flowRun.versions;
  if (!row) return <EmptyState title={c.pickStep} />;
  return (
    <Card title={row.title}>
      <div className="flex flex-col gap-1.5">
        <p className="text-compact text-app-text-tertiary">{c.changeKind[row.change](fromN, toN)}</p>
        {(row.detail ?? []).map((d) => (
          <div key={d.label} className="grid grid-cols-[minmax(0,1fr)] gap-0.5 border-t border-app-border pt-1.5 sm:grid-cols-[160px_minmax(0,1fr)_minmax(0,1fr)] sm:gap-3">
            <span className="text-prose font-medium text-app-text">{d.label}</span>
            <span className="text-prose text-app-text-secondary">{d.before ? <><span className="text-app-text-tertiary">{c.before(fromN)} </span>{d.before}</> : null}</span>
            <span className="text-prose text-app-text">{d.after ? <><span className="text-app-text-tertiary">{c.after(toN)} </span>{d.after}</> : null}</span>
          </div>
        ))}
        {!(row.detail ?? []).length && <p className="text-prose text-app-text-secondary">{c.nothingChanged(fromN)}</p>}
      </div>
    </Card>
  );
}

/** The cases of the test one by one: what the active version did, what the other does, and the way to the case. */
export function TestCases({ copy, test, onFilter }: { copy: UiCopy; test: TestView; onFilter: (f: 'all' | 'changed') => void }) {
  const c = copy.flowRun.versions;
  // The card sits between the list of versions and the side panel (about 350 px), so the table keeps only what a row needs:
  // all cases show the confidence, the changed ones show the verdict instead. Sized columns still give back room, never below their longest word.
  const changedOnly = test.filter === 'changed';
  const columns: TableColumnModel[] = [
    { id: 'case', label: c.colCase, width: 190 },
    ...(changedOnly ? [] : [{ id: 'conf', label: c.colConfidence, width: 84, align: 'right' as const }]),
    { id: 'before', label: c.colBefore, width: 84 },
    { id: 'after', label: c.colAfter, width: 84 },
    ...(changedOnly ? [{ id: 'result', label: c.colResult, width: 130 }] : []),
  ];
  const shown = test.filter === 'changed' ? test.rows.filter((r) => r.change !== 'same') : test.rows;
  const rows = shown.map((r) => ({
    id: r.id,
    onOpen: r.onOpen,
    cells: {
      case: r.label,
      ...(changedOnly ? {} : { conf: `${r.confidence}%` }),
      before: r.before,
      after: r.after,
      ...(changedOnly ? { result: <Chip tone={CHANGE_TONE[r.change]}>{c.result[r.change]}</Chip> } : {}),
    },
  }));
  return (
    <Card title={c.casesTitle(test.rows.length)}>
      <Tabs
        ariaLabel={c.casesFilter}
        value={test.filter}
        onChange={onFilter}
        options={[{ value: 'all', label: c.filterAll, count: test.rows.length }, { value: 'changed', label: c.filterChanged, count: test.rows.filter((r) => r.change !== 'same').length }]}
        className="mb-3"
      />
      <Table ariaLabel={c.casesTitle(test.rows.length)} columns={columns} rows={rows} empty={c.noChanged} dense />
    </Card>
  );
}

/** The column on the right: the test on real cases, what changes, and how it gets published. */
export function TestColumn({ copy, test, compare, publish, onRun, onActivate, runDisabled, activateTitle, activateLabel, activate, changes }: {
  copy: UiCopy;
  test: TestView;
  compare: { from: number; to: number };
  publish: { approver: string; rollbackTo: number; activeN: number; testing: boolean; day?: { day: number; of: number } };
  onRun: (() => void) | false;
  onActivate: (() => void) | false;
  runDisabled?: string;
  activateTitle?: string;
  activateLabel: string;
  activate: 'enabled' | 'active';
  changes: Array<{ id: string; label: string; value: string; onOpen?: () => void }>;
}) {
  const c = copy.flowRun.versions;
  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-app-border px-4 pb-4 pt-4">
        <Chip>{c.testTag}</Chip>
        <h3 className="mt-2 text-body-lg font-semibold text-app-text">{c.testTitle(test.total, compare.from, compare.to)}</h3>
        <p className="mt-1 text-prose leading-5 text-app-text-secondary">{c.testLead}</p>
      </div>
      {test.state === 'none' && (
        <PanelSection>
          <p className="mb-3 text-prose text-app-text-secondary">{c.notRun}</p>
          <Button variant="primary" onClick={onRun} title={runDisabled}>{c.runTest}</Button>
        </PanelSection>
      )}
      {test.state === 'running' && test.job && (
        <PanelSection>
          <ProgressBar value={test.job.progress} label={test.job.current ?? test.job.title} detail={c.progress(Math.round(test.job.progress * 100))} />
          <ul className="mt-2 flex flex-col gap-0.5 text-compact text-app-text-tertiary">
            {test.job.done.map((d) => <li key={d} className="flex items-center gap-1.5"><Check size={11} aria-hidden="true" />{d}</li>)}
            <li className="flex items-center gap-1.5 text-app-text-secondary"><Spinner size={11} />{test.job.current}</li>
          </ul>
        </PanelSection>
      )}
      {test.state === 'done' && (
        <>
          <PanelSection>
            <div className="grid grid-cols-3 gap-2">
              <StatCard label={c.same} value={test.same} />
              <StatCard label={c.fewer} value={test.fewer ? `−${test.fewer}` : 0} tone={test.fewer ? 'green' : undefined} />
              <StatCard label={c.newFlow} value={test.newFlow} tone={test.newFlow ? 'blue' : undefined} />
            </div>
            {test.worse > 0 && <p className="mt-2 text-prose font-medium text-rose-600 dark:text-rose-400">{c.worse(test.worse)}</p>}
            {test.morePerson > 0 && <p className="mt-2 text-prose text-amber-700 dark:text-amber-400">{c.morePerson(test.morePerson)}</p>}
            <p className="mt-2 text-compact text-app-text-tertiary">{c.tested(test.total, test.at)}</p>
          </PanelSection>
          <PanelSection label={c.whatChanges}>
            {changes.length === 0 && <p className="text-prose text-app-text-tertiary">{c.noChanges}</p>}
            {changes.map((x) => <FactRow key={x.id} label={x.label} value={x.value} onOpen={x.onOpen} />)}
          </PanelSection>
        </>
      )}
      <PanelSection label={c.publication}>
        <FactRow label={c.whoApproves} value={publish.approver} />
        <FactRow label={c.goBack(publish.rollbackTo)} value={c.oneClick} />
        <FactRow label={c.ongoing} value={c.ongoingValue(publish.activeN)} />
        {publish.testing && publish.day && <FactRow label={c.collaudo} value={c.collaudoDay(publish.day.day, publish.day.of)} />}
      </PanelSection>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-app-border px-4 py-3">
        <Button onClick={onRun} title={runDisabled}>{test.state === 'done' ? c.runAgain : c.runTest}</Button>
        <span className="flex-1" />
        {activate === 'active' ? (
          <Chip tone="green">{c.alreadyActive}</Chip>
        ) : (
          <Button variant="primary" onClick={onActivate} title={activateTitle}>{activateLabel}</Button>
        )}
      </div>
    </div>
  );
}
