import { CircleAlert, CircleCheck, Clock, Info, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { Tone } from '../types';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { PanelSection } from '../primitives/Panel';
import { ProgressBar, Spinner } from '../primitives/Progress';
import { FactRow } from './common';
import type { JobView } from './model';

export interface RunAction {
  id: string;
  label: string;
  variant: 'primary' | 'secondary' | 'ghost';
  icon?: LucideIcon;
  onClick: (() => void) | false;
  title?: string;
}

export interface RunSideView {
  tag: { label: string; tone: Tone; kind: 'error' | 'ok' | 'wait' | 'info' };
  title: string;
  body?: string;
  /** What the robot saw, drawn as the page it stopped on. */
  page?: { program: string; title: string; time: string; userLabel: string; user: string; passwordLabel: string; warning: string; button: string };
  attempts?: { label: string; times: string; same: string; causeLabel: string; cause: string };
  facts?: Array<{ label: string; value: string; onOpen?: () => void }>;
  actions: RunAction[];
  notified: Array<{ who: string; when: string }>;
  job?: JobView;
  /** A receipt of what was done on this run since it stopped. */
  log?: Array<{ at: string; text: string }>;
}

const TAG_ICON: Record<RunSideView['tag']['kind'], LucideIcon> = { error: CircleAlert, ok: CircleCheck, wait: Clock, info: Info };

/** The banner over the steps: other runs wait on the same step, and one control frees them all. */
export function RunBanner({ strong, rest, actionLabel, onAction, tone = 'red' }: { strong: string; rest: string; actionLabel?: string; onAction?: (() => void) | false; tone?: 'red' | 'green' }) {
  return (
    <div
      role="status"
      className={clsx(
        'mb-3 flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-2.5 text-prose',
        tone === 'red' ? 'border-rose-500/35 bg-rose-500/10' : 'border-emerald-500/35 bg-emerald-500/10',
      )}
    >
      {tone === 'red' ? <CircleAlert size={16} className="shrink-0 text-rose-600 dark:text-rose-400" aria-hidden="true" /> : <CircleCheck size={16} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
      <span className="min-w-0 flex-1 basis-56 text-app-text"><strong>{strong}</strong> {rest}</span>
      {actionLabel && <Button onClick={onAction ?? false}>{actionLabel}</Button>}
    </div>
  );
}

/** The page the robot found, as a small picture: the program's title bar, the login it showed, the warning. */
function SeenPage({ page }: { page: NonNullable<RunSideView['page']> }) {
  return (
    <div className="overflow-hidden rounded-lg border border-app-border-input bg-white text-slate-700">
      <div className="flex h-[22px] items-center gap-1.5 bg-blue-700 px-2 text-[10.5px] font-bold text-white">
        {page.program}<span className="font-medium opacity-75">· {page.title}</span><span className="flex-1" /><span className="font-medium opacity-75">{page.time}</span>
      </div>
      <div className="grid grid-cols-[70px_minmax(0,1fr)] items-center gap-2 px-4 py-3 text-[11px]">
        <span className="text-slate-400">{page.userLabel}</span>
        <span className="h-6 truncate rounded-md border border-slate-300 px-2 leading-[22px]">{page.user}</span>
        <span className="text-slate-400">{page.passwordLabel}</span>
        <span className="h-6 rounded-md border border-slate-300 px-2 leading-[22px] tracking-widest">••••••••</span>
        <span />
        <span className="font-semibold text-rose-600">{page.warning}</span>
        <span />
        <span className="w-fit rounded-md bg-blue-700 px-2.5 py-1 font-semibold text-white">{page.button}</span>
      </div>
    </div>
  );
}

/** The column on the right of a run: what happened, what the robot saw, what was tried, what to do, who was told. */
export function RunSide({ copy, view }: { copy: UiCopy; view: RunSideView }) {
  const c = copy.flowRun.run;
  const Icon = TAG_ICON[view.tag.kind];
  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b border-app-border px-4 pb-4 pt-4">
        <Chip tone={view.tag.tone} icon={Icon} strong>{view.tag.label}</Chip>
        <h3 className="mt-2 text-body-lg font-semibold leading-5 text-app-text">{view.title}</h3>
        {view.body && <p className="mt-1 text-prose leading-5 text-app-text-secondary">{view.body}</p>}
      </div>
      {view.job && view.job.status === 'running' && (
        <PanelSection>
          <ProgressBar value={view.job.progress} label={view.job.current ?? view.job.title} detail={c.progress(Math.round(view.job.progress * 100))} />
          <ul className="mt-2 flex flex-col gap-0.5 text-compact text-app-text-tertiary">
            {view.job.done.map((d) => <li key={d}>{d}</li>)}
            <li className="flex items-center gap-1.5 text-app-text-secondary"><Spinner size={11} />{view.job.current}</li>
          </ul>
        </PanelSection>
      )}
      {view.page && (
        <PanelSection label={c.seen}>
          <SeenPage page={view.page} />
        </PanelSection>
      )}
      {view.attempts && (
        <PanelSection label={view.attempts.label}>
          <FactRow label={view.attempts.times} value={view.attempts.same} tone="red" />
          <FactRow label={view.attempts.causeLabel} value={view.attempts.cause} />
        </PanelSection>
      )}
      {view.facts && view.facts.length > 0 && (
        <PanelSection label={c.facts}>
          {view.facts.map((f) => <FactRow key={f.label} label={f.label} value={f.value} onOpen={f.onOpen} />)}
        </PanelSection>
      )}
      {view.actions.length > 0 && (
        <PanelSection label={c.whatToDo}>
          <div className="flex flex-col gap-2">
            {view.actions.map((a) => (
              <Button key={a.id} variant={a.variant} size="lg" icon={a.icon} onClick={a.onClick} title={a.title} className="w-full">{a.label}</Button>
            ))}
          </div>
        </PanelSection>
      )}
      {view.log && view.log.length > 0 && (
        <PanelSection label={c.logTitle}>
          {view.log.map((l, i) => <FactRow key={`${l.at}-${i}`} label={l.text} value={l.at} />)}
        </PanelSection>
      )}
      <PanelSection label={c.notified} className="mt-auto border-b-0">
        {view.notified.length === 0 && <p className="text-prose text-app-text-tertiary">{c.nobody}</p>}
        {view.notified.map((n) => <FactRow key={n.who} label={n.who} value={n.when} />)}
      </PanelSection>
    </div>
  );
}
