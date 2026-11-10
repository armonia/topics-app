import { Bot, KeyRound, Lock } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip, FieldChip } from '../primitives/Chip';
import { Select, TextField, Toggle } from '../primitives/Field';
import { PanelHeading, PanelSection, SectionLabel, SidePanel } from '../primitives/Panel';
import { FOCUS_RING } from '../shell/pressable';
import type { RobotStepModel, RunBars } from './model';
import { FactRow, SettingRow } from './common';

export interface RobotView {
  program: string;
  title: string;
  intro: string;
  steps: RobotStepModel[];
  selectedStep: string | null;
  checks: string;
  user: string;
  vault: string;
  /** The password in the vault: `valid`, or `expired` after the program asked for a new one. */
  credential: 'valid' | 'expired';
  credentialNote?: string;
  recordedNote?: string;
  where: string;
  hours: string;
  offHours: 'wait' | 'run';
  oneAtATime: boolean;
  retries: number;
  everyMin: number;
  then: string;
  notify: string;
  runs: RunBars;
}

export interface RobotHandlers {
  onSelectStep: (id: string) => void;
  onHours: (v: string) => void;
  onOffHours: (v: 'wait' | 'run') => void;
  onOneAtATime: (v: boolean) => void;
  onRetries: (n: number) => void;
  onEvery: (n: number) => void;
  onThen: (v: string) => void;
  onNotify: (v: string) => void;
  onUpdatePassword: () => void;
  onOpenRuns: () => void;
}

/** The picture of the page the robot sees at one step: a title bar and the fields it touches. */
function SmallScreen({ step }: { step: RobotStepModel }) {
  return (
    <div className="overflow-hidden rounded-md border border-app-border bg-white text-[10.5px] text-slate-700">
      <div className="flex h-[18px] items-center bg-blue-700 px-2 text-[9.5px] font-bold tracking-wide text-white"><span className="min-w-0 truncate">{step.page}</span></div>
      <div className="flex min-h-[64px] flex-col gap-1 p-2">
        {step.fields.map((f, i) => (
          <div key={`${f.label}-${i}`} className="flex items-center gap-1.5">
            {f.label && <span className="w-14 shrink-0 truncate text-slate-400">{f.label}</span>}
            <span className="h-4 min-w-0 flex-1 truncate rounded-[3px] border border-slate-300 bg-white px-1 leading-[14px]">{f.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RobotPanel({ copy, view, handlers, editable, deniedTitle }: {
  copy: UiCopy;
  view: RobotView;
  handlers: RobotHandlers;
  editable: boolean;
  deniedTitle?: string;
}) {
  const c = copy.flowRun.robot;
  const off = editable ? undefined : deniedTitle;
  const selected = view.steps.find((s) => s.id === view.selectedStep);
  const maxBar = 36;
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="min-w-0 flex-1 space-y-4 p-5 md:overflow-y-auto">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="green" icon={Bot} strong>{c.tag}</Chip>
          <h2 className="min-w-0 text-title font-semibold text-app-text">{view.title}</h2>
          <span className="flex-1" />
          <Chip tone="green">{c.succeeded(view.runs.ok, view.runs.total)}</Chip>
        </div>
        <p className="max-w-[760px] text-prose leading-6 text-app-text-secondary">{view.intro}</p>
        {view.recordedNote && <p className="text-compact font-medium text-emerald-700 dark:text-emerald-400">{view.recordedNote}</p>}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
          {view.steps.map((s) => {
            const on = s.id === view.selectedStep;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => handlers.onSelectStep(s.id)}
                aria-pressed={on}
                className={clsx(
                  'flex min-w-0 flex-col gap-2 rounded-lg border bg-surface p-2.5 text-left transition-colors',
                  on ? 'border-emerald-600/70 shadow-[0_0_0_3px_rgba(5,150,105,0.14)]' : 'border-app-border hover:border-app-border-light',
                  FOCUS_RING,
                )}
              >
                {s.result ? (
                  <div className="grid h-[82px] place-items-center rounded-md bg-emerald-500/10 text-compact font-semibold text-emerald-700 dark:text-emerald-300">{s.result}</div>
                ) : (
                  <SmallScreen step={s} />
                )}
                <div className="min-w-0">
                  <div className="text-compact font-semibold leading-snug text-app-text">{s.title}</div>
                  {s.detail && <div className="text-compact text-app-text-tertiary">{s.detail}</div>}
                  {s.sources && (
                    <div className="mt-1 flex flex-wrap gap-1">{s.sources.map((f) => <FieldChip key={f.name} field={f} />)}</div>
                  )}
                </div>
              </button>
            );
          })}
          <Card title={c.checksTitle} className="col-span-full">{view.checks}</Card>
        </div>
        {selected && (
          <Card title={c.stepTitle(selected.title)}>
            <FactRow label={c.stepPage} value={selected.page} />
            {selected.fields.filter((f) => f.label).map((f) => <FactRow key={f.label} label={f.label} value={f.value || c.empty} />)}
            {selected.sources && <FactRow label={c.stepSources} value={selected.sources.map((f) => f.name).join(', ')} />}
          </Card>
        )}
      </div>
      <SidePanel width={360} className="w-full border-t md:w-[360px] md:border-t-0">
        <PanelHeading tag={c.settingsTag} title={view.program}>{null}</PanelHeading>
        <PanelSection label={c.access}>
          <FactRow label={c.user} value={view.user} />
          <FactRow
            label={c.password}
            value={<span className="inline-flex items-center gap-1.5"><Lock size={13} aria-hidden="true" />{view.credential === 'valid' ? c.inVault : c.expired}</span>}
            tone={view.credential === 'valid' ? undefined : 'red'}
          />
          {view.credentialNote && <p className="text-compact text-app-text-tertiary">{view.credentialNote}</p>}
          <FactRow label={c.where} value={view.where} />
          <div className="mt-2">
            <Button icon={KeyRound} size="sm" onClick={editable ? handlers.onUpdatePassword : false} title={off}>{c.changePassword}</Button>
          </div>
        </PanelSection>
        <PanelSection label={c.when}>
          <SettingRow label={c.hours}>
            <TextField size="sm" value={view.hours} onChange={handlers.onHours} disabled={!editable} title={off ?? c.hours} />
          </SettingRow>
          <SettingRow label={c.offHours}>
            <Select
              size="sm"
              value={view.offHours}
              options={[{ value: 'wait', label: c.offWait }, { value: 'run', label: c.offRun }]}
              onChange={(v) => handlers.onOffHours(v === 'run' ? 'run' : 'wait')}
              disabled={!editable}
              title={off ?? c.offHours}
            />
          </SettingRow>
          <SettingRow label={c.oneAtATime}>
            <Toggle checked={view.oneAtATime} onChange={handlers.onOneAtATime} disabled={!editable} title={off ?? c.oneAtATime} />
          </SettingRow>
        </PanelSection>
        <PanelSection label={c.ifWrong}>
          <SettingRow label={c.retries}>
            <TextField size="sm" type="number" value={String(view.retries)} onChange={(v) => handlers.onRetries(Math.max(0, Math.min(9, Number(v) || 0)))} disabled={!editable} title={off ?? c.retries} />
          </SettingRow>
          <SettingRow label={c.every}>
            <TextField size="sm" type="number" value={String(view.everyMin)} onChange={(v) => handlers.onEvery(Math.max(1, Math.min(60, Number(v) || 1)))} disabled={!editable} title={off ?? c.every} />
          </SettingRow>
          <SettingRow label={c.then}>
            <TextField size="sm" value={view.then} onChange={handlers.onThen} disabled={!editable} title={off ?? c.then} />
          </SettingRow>
          <SettingRow label={c.notify}>
            <TextField size="sm" value={view.notify} onChange={handlers.onNotify} disabled={!editable} title={off ?? c.notify} />
          </SettingRow>
        </PanelSection>
        <PanelSection>
          <SectionLabel className="mb-2.5">{c.lastRuns}</SectionLabel>
          <button
            type="button"
            onClick={handlers.onOpenRuns}
            data-tip={c.openRuns}
            className={clsx('flex h-9 w-full items-end gap-0.5 rounded', FOCUS_RING)}
          >
            {view.runs.days.map((d, i) => (
              <span
                key={i}
                style={{ height: Math.max(6, Math.round(d.value * maxBar)) }}
                className={clsx('block flex-1 rounded-[2px]', d.failed ? 'bg-rose-500' : 'bg-emerald-500/80')}
              />
            ))}
          </button>
          <p className="mt-1.5 text-compact text-app-text-tertiary">{c.runsSummary(view.runs.ok, view.runs.total, view.runs.medianSec)}</p>
        </PanelSection>
      </SidePanel>
    </div>
  );
}
