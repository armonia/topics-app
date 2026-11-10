import { CheckCircle2, CircleAlert, CircleDashed, Clock, Download, Eye, Globe, Hand, Monitor, Plus, SquareTerminal, Unplug, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action, Tone } from '../types';
import { TONE_CHIP } from '../tone';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Select, TextField } from '../primitives/Field';
import { PanelHeading, PanelSection, KeyValue, SidePanel } from '../primitives/Panel';
import { Spinner } from '../primitives/Progress';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import type { JobViewModel, PcDetailModel, PcRowModel, PcStateKind, PlaceCardModel } from './model';
import { DataGrid, JobProgress, StatePill } from './Shared';

const PLACE_ICON: Record<PlaceCardModel['kind'], LucideIcon> = { browser: Globe, pc: Monitor, remote: Eye };
const PC_TONE: Record<PcStateKind, Tone> = { working: 'green', ready: 'neutral', 'too-old': 'red', updating: 'blue', pending: 'amber', removed: 'neutral' };

function PcGlyph({ kind }: { kind: PcStateKind }) {
  if (kind === 'working') return <CheckCircle2 size={12} aria-hidden="true" />;
  if (kind === 'ready' || kind === 'removed') return <CircleDashed size={12} aria-hidden="true" />;
  if (kind === 'too-old') return <CircleAlert size={12} aria-hidden="true" />;
  if (kind === 'updating') return <Spinner size={11} />;
  return <Clock size={12} aria-hidden="true" />;
}

export type PcActionKind = 'update' | 'remove' | 'reinstall' | 'control' | 'agent';

const ACTION_ICON: Record<PcActionKind, LucideIcon> = { update: Download, remove: Unplug, reinstall: Plus, control: Hand, agent: SquareTerminal };

export interface PcActionModel {
  kind: PcActionKind;
  label: string;
  onClick: Action;
  title?: string;
}

export interface AddFormModel {
  open: boolean;
  name: string;
  office: string;
  system: string;
  offices: Array<{ value: string; label: string }>;
  nameError?: string;
  job?: JobViewModel;
  code?: string;
}

/**
 * Where the agents run (e01): the three places (the server for programs in a
 * browser, an agent on an office PC, remote control on request), the office
 * PCs with the state of each agent, and the lightness of the agent. A card
 * filters the table; a row opens its PC in the panel, with the actions that
 * PC allows. «Collega un PC» opens the form that links a new one. (allow-italian: quotes the Italian interface)
 */
export function AgentsScreen({
  copy, footprint, cards, rows, filterLabel, onClearFilter, detail, actions, detailJob, notes, form, onAdd, onForm, backLabel, onBack, addTitle, phone,
}: {
  copy: UiCopy;
  /** The figures of the agent's lightness: the same wherever they are printed. */
  footprint: { minWindows: number; minFreeGb: number; memoryMb: number; installerMb: number };
  cards: PlaceCardModel[];
  rows: PcRowModel[];
  /** Set: the table is filtered to one place and says which. */
  filterLabel?: string;
  onClearFilter: Action;
  detail?: PcDetailModel;
  actions: PcActionModel[];
  detailJob?: JobViewModel;
  notes: Array<{ id: string; title: string; text: string }>;
  form: AddFormModel;
  onAdd: Action;
  onForm: {
    name: (v: string) => void;
    office: (v: string) => void;
    system: (v: string) => void;
    submit: Action;
    cancel: () => void;
  };
  backLabel: string;
  onBack: () => void;
  addTitle?: string;
  phone?: boolean;
}) {
  const e = copy.programs.agents;
  const side = (
    <>
      <PanelHeading tag={e.side.tag} tagIcon={Monitor} title={e.side.title}>{e.side.body}</PanelHeading>
      {detail && (
        <PanelSection label={detail.name}>
          <div className="mb-2 flex items-center gap-2"><span className="text-compact text-app-text-tertiary">{detail.tag}</span></div>
          {detail.rows.map((r) => <KeyValue key={r.label} label={r.label} value={r.value} />)}
          {detail.note && <p className={clsx('mt-2 rounded-md px-2.5 py-2 text-prose leading-5', TONE_CHIP[detail.noteTone ?? 'neutral'])}>{detail.note}</p>}
          {actions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {actions.map((a) => {
                const Icon = ACTION_ICON[a.kind];
                return <Button key={a.kind} icon={Icon} variant={a.kind === 'remove' ? 'danger' : 'secondary'} onClick={a.onClick} title={a.title}>{a.label}</Button>;
              })}
            </div>
          )}
          {detailJob && <JobProgress job={detailJob} copy={copy} className="mt-3" />}
        </PanelSection>
      )}
      <PanelSection label={e.side.requirements}>
        <KeyValue label={e.side.windows} value={e.side.windowsValue(footprint.minWindows)} />
        <KeyValue label={e.side.memory} value={e.side.memoryValue(footprint.minFreeGb, footprint.memoryMb)} />
        <KeyValue label={e.side.network} value={e.side.networkValue} />
        <KeyValue label={e.side.install} value={e.side.installValue(footprint.installerMb)} />
      </PanelSection>
      <PanelSection label={e.side.rules}>
        <KeyValue label={e.side.personAtPc} value={<span className="font-semibold">{e.side.personAtPcValue}</span>} />
        <KeyValue label={e.side.hours} value={<span className="font-semibold">{e.side.hoursValue}</span>} />
        <KeyValue label={e.side.session} value={<span className="font-semibold">{e.side.sessionValue}</span>} />
      </PanelSection>
      {notes.map((n) => (
        <PanelSection key={n.id} label={n.title}>
          <p className="text-prose leading-6 text-app-text-secondary">{n.text}</p>
        </PanelSection>
      ))}
    </>
  );
  const main = (
    <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="grid gap-3 md:grid-cols-3" role="group" aria-label={e.root}>
        {cards.map((c) => {
          const Icon = PLACE_ICON[c.kind];
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={c.pressed}
              onClick={c.onPress || undefined}
              className={clsx(
                'flex min-w-0 flex-col rounded-lg border bg-surface p-4 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.04]', FOCUS_RING,
                c.pressed ? 'border-primary ring-1 ring-primary/40' : 'border-app-border',
              )}
            >
              <span className="flex items-start gap-2">
                <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded bg-black/[0.06] px-1.5 text-mini text-app-text dark:bg-white/10"><Icon size={12} aria-hidden="true" />{c.tag}</span>
                <span className="text-prose font-semibold leading-5 text-app-text">{c.title}</span>
              </span>
              <span className="mt-2 text-prose leading-5 text-app-text-secondary">{c.description}</span>
              <span className="mt-auto flex items-center pt-3 text-prose">
                <span className="text-app-text-secondary">{c.stateLabel}</span>
                <span className="ml-auto"><StatePill tone={c.stateTone}>{c.stateText}</StatePill></span>
              </span>
            </button>
          );
        })}
      </div>

      {form.open && (
        <Card title={e.form.title} icon={Plus} className="mt-4" tone="blue">
          <p className="mb-3 text-prose text-app-text-secondary">{e.form.body}</p>
          <div className="grid gap-3 md:grid-cols-3">
            <TextField label={e.form.name} value={form.name} onChange={onForm.name} placeholder={e.form.namePlaceholder} error={form.nameError} />
            <Select label={e.form.office} value={form.office} options={form.offices} onChange={onForm.office} />
            <Select label={e.form.system} value={form.system} options={e.form.systems} onChange={onForm.system} />
          </div>
          {form.job && <JobProgress job={form.job} copy={copy} className="mt-3" />}
          {form.code && form.job?.status === 'done' && (
            <p className="mt-3 rounded-md bg-emerald-500/10 px-3 py-2 text-prose text-emerald-800 dark:text-emerald-300">{e.form.code}: <span className="font-mono font-semibold">{form.code}</span> · {e.form.codeBody}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {form.job?.status !== 'running' && <Button variant="primary" icon={Plus} onClick={onForm.submit}>{e.form.submit}</Button>}
            <Button onClick={onForm.cancel}>{e.form.cancel}</Button>
          </div>
        </Card>
      )}

      <div className="mt-4 flex min-h-7 flex-wrap items-center gap-2">
        {filterLabel && (
          <>
            <span className="text-prose text-app-text-secondary">{filterLabel}</span>
            <Button size="sm" onClick={onClearFilter}>{e.filterClear}</Button>
          </>
        )}
      </div>
      <DataGrid
        className="mt-2"
        ariaLabel={e.root}
        columns={[
          { id: 'name', label: e.columns.computer, width: 220 },
          { id: 'where', label: e.columns.where, width: 130 },
          { id: 'traits', label: e.columns.traits, width: 200 },
          { id: 'does', label: e.columns.does, width: 180 },
          { id: 'state', label: e.columns.state, width: 180 },
          { id: 'seen', label: e.columns.lastSignal, width: 112 },
        ]}
        rows={rows.map((r) => ({
          id: r.id,
          selected: r.selected,
          onOpen: r.onOpen || undefined,
          cells: {
            name: <span className="whitespace-nowrap font-semibold">{r.name}</span>,
            where: <span className="whitespace-normal">{r.where}</span>,
            traits: <span className="whitespace-normal">{r.traits}</span>,
            does: <span className="whitespace-normal">{r.does || '-'}</span>,
            state: <StatePill tone={PC_TONE[r.state.kind]} icon={<PcGlyph kind={r.state.kind} />}>{r.state.text}</StatePill>,
            seen: <span className="text-app-text-secondary">{r.lastSeen}</span>,
          },
        }))}
      />
      {rows.length === 0 && <p className="mt-3 text-center text-prose text-app-text-tertiary">{e.empty}</p>}
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader leading={<BackButton label={backLabel} onClick={onBack} copy={copy} />} crumbs={[{ label: e.root }]}>
        <Button variant="primary" icon={Plus} onClick={onAdd} title={addTitle}>{e.add}</Button>
      </PaneHeader>
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {main}
          <div className="border-t border-app-border bg-surface">{side}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {main}
          <SidePanel width={360}>{side}</SidePanel>
        </div>
      )}
    </div>
  );
}
