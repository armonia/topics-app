import { ArrowRight, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button, IconButton } from '../primitives/Button';
import { Card, StatCard } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { Toggle } from '../primitives/Field';
import { KeyValue, PanelHeading, PanelSection, SidePanel } from '../primitives/Panel';
import { ProgressBar } from '../primitives/Progress';
import { Table } from '../primitives/Table';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import { CHANNEL_ICON } from './channelIcons';
import type { ChannelDetailModel, ChannelRowModel, SamePersonModel } from './model';

export interface ChannelActionModel {
  id: string;
  label: string;
  onClick: Action;
  variant?: 'primary' | 'secondary' | 'danger';
}

/**
 * The channels (ch01): a table of where the work comes in and goes out, with
 * a count of what is connected, and on the right either what a person who
 * writes on several channels looks like (the point of having one place) or,
 * once a channel is picked, its facts, what it does when something arrives
 * (the routing rules, each with its switch), the last messages and the
 * receipts of the tests. Every handler is the caller's.
 */
export function ChannelsScreen({ copy, rows, stats, detail, actions, job, samePerson, onConnect, onBack, backLabel, onAddRule, canEditRules, deniedTitle, phone }: {
  copy: UiCopy;
  rows: ChannelRowModel[];
  stats: { connected: number; total: number; volume: number; starting: number };
  detail?: ChannelDetailModel;
  actions: ChannelActionModel[];
  /** A test or a connection in progress on the selected channel. */
  job?: { title: string; progress: number; detail: string; failed?: boolean };
  samePerson: SamePersonModel;
  onConnect: Action;
  onBack?: () => void;
  backLabel?: string;
  onAddRule: Action;
  canEditRules: boolean;
  deniedTitle?: string;
  phone?: boolean;
}) {
  const c = copy.viewsMore.channels;
  const table = (
    <Table
      ariaLabel={c.tableLabel}
      columns={[
        { id: 'name', label: c.columns.channel, width: 170 },
        { id: 'entra', label: c.columns.in, width: 96 },
        { id: 'esce', label: c.columns.out, width: 84 },
        { id: 'volume', label: c.columns.volume, width: 96, align: 'right' },
        { id: 'flow', label: c.columns.flow, width: 200 },
        { id: 'before', label: c.columns.before, width: 130 },
        { id: 'state', label: c.columns.state, width: 104 },
      ]}
      rows={rows.map((r) => {
        const Icon = CHANNEL_ICON[r.icon];
        return {
          id: r.id,
          selected: r.selected,
          onOpen: r.selected ? undefined : r.onOpen,
          cells: {
            name: (
              <span className="inline-flex min-w-0 items-center gap-2 font-medium" aria-current={r.selected ? 'true' : undefined}>
                <Icon size={15} className="shrink-0 text-app-text-secondary" aria-hidden="true" />
                <span className="min-w-0">{r.name}</span>
              </span>
            ),
            entra: r.entra,
            esce: r.esce,
            volume: r.volume !== undefined ? c.number(r.volume) : <span className="text-app-text-tertiary">{r.volumeNote ?? c.none}</span>,
            flow: r.flow,
            before: r.beforeExit,
            state: <Chip tone={r.state.tone}>{r.state.label}</Chip>,
          },
        };
      })}
    />
  );
  const overview = (
    <>
      <PanelHeading tag={c.sameTag} title={samePerson.name}>{c.sameBody}</PanelHeading>
      <PanelSection>
        <ul className="flex flex-col gap-1">
          {samePerson.items.map((it) => {
            const Icon = CHANNEL_ICON[it.icon];
            const body = (
              <>
                <Icon size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-left text-prose text-app-text">{it.text}</span>
                <span className="shrink-0 text-mini tabular-nums text-app-text-tertiary">{it.at}</span>
              </>
            );
            return (
              <li key={it.id}>
                {it.onOpen ? (
                  <button type="button" onClick={it.onOpen} className={clsx('flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-app-hover', FOCUS_RING)}>{body}</button>
                ) : <div className="flex items-center gap-2 px-1.5 py-1.5">{body}</div>}
              </li>
            );
          })}
        </ul>
      </PanelSection>
      <PanelSection><p className="text-compact leading-5 text-app-text-secondary">{samePerson.note}</p></PanelSection>
      <PanelSection label={c.principles}>
        <ul className="flex flex-col gap-3 text-compact leading-5 text-app-text-secondary">
          <li><span className="font-medium text-app-text">{c.principle1.title}</span> {c.principle1.body}</li>
          <li><span className="font-medium text-app-text">{c.principle2.title}</span> {c.principle2.body}</li>
          <li><span className="font-medium text-app-text">{c.principle3.title}</span> {c.principle3.body}</li>
        </ul>
      </PanelSection>
    </>
  );
  const picked = detail ? (
    <>
      <PanelHeading tag={detail.provider} title={detail.name}>{detail.address}</PanelHeading>
      <PanelSection>
        <KeyValue label={c.columns.state} value={<Chip tone={detail.state.tone}>{detail.state.label}</Chip>} />
        <KeyValue label={c.columns.in} value={detail.entra} />
        <KeyValue label={c.columns.out} value={detail.esce} />
        <KeyValue label={c.columns.volume} value={detail.volume !== undefined ? c.number(detail.volume) : detail.volumeNote ?? c.none} />
        <KeyValue
          label={c.columns.flow}
          value={detail.onOpenFlow
            ? <button type="button" onClick={detail.onOpenFlow} className={clsx('inline-flex items-center gap-1 text-sky-700 hover:underline dark:text-sky-300', FOCUS_RING)}>{detail.flow}<ArrowRight size={12} aria-hidden="true" /></button>
            : detail.flow}
        />
        <KeyValue label={c.columns.before} value={detail.beforeExit} />
        {detail.error && (
          <p role="alert" data-error="true" className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-compact leading-5 text-rose-700 dark:text-rose-300">{detail.error}</p>
        )}
        <p className="mt-2 text-compact leading-5 text-app-text-secondary">{detail.policy}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((a) => <Button key={a.id} variant={a.variant ?? 'secondary'} onClick={a.onClick} title={a.onClick === false ? deniedTitle : undefined}>{a.label}</Button>)}
        </div>
        {job && (
          <div className="mt-3">
            <ProgressBar value={job.progress} label={job.title} detail={job.detail} tone={job.failed ? 'red' : 'blue'} />
          </div>
        )}
      </PanelSection>
      {detail.receipts.length > 0 && (
        <PanelSection label={c.receiptsTitle}>
          <ul className="flex flex-col gap-2">
            {detail.receipts.map((r) => (
              <li key={r.id} className="rounded-lg border border-app-border p-2.5">
                <div className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate text-prose font-medium text-app-text">{r.title}</span><span className="text-mini tabular-nums text-app-text-tertiary">{r.at}</span></div>
                {r.lines.map((l) => <div key={l} className="text-compact text-app-text-secondary">{l}</div>)}
              </li>
            ))}
          </ul>
        </PanelSection>
      )}
      <PanelSection label={c.messagesTitle}>
        {detail.messages.length === 0 ? (
          <p className="text-compact text-app-text-tertiary">{c.messagesEmpty}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {detail.messages.map((m) => {
              const body = (
                <>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-prose text-app-text">{m.title}</span>
                    <span className="block truncate text-mini text-app-text-tertiary">{m.from}</span>
                  </span>
                  <span className="shrink-0 text-mini tabular-nums text-app-text-tertiary">{m.at}</span>
                </>
              );
              return (
                <li key={m.id}>
                  {m.onOpen
                    ? <button type="button" onClick={m.onOpen} className={clsx('flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-app-hover', FOCUS_RING)}>{body}</button>
                    : <div className="flex items-center gap-2 px-1.5 py-1.5">{body}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </PanelSection>
      <PanelSection label={c.rulesTitle}>
        <p className="mb-2 text-compact text-app-text-tertiary">{c.rulesHint}</p>
        {detail.rules.length === 0 && <p className="mb-2 text-compact text-app-text-tertiary">{c.rulesEmpty}</p>}
        <ul className="flex flex-col gap-2">
          {detail.rules.map((r) => (
            <li key={r.id} className="flex items-start gap-2 rounded-lg border border-app-border p-2.5">
              <div className="min-w-0 flex-1 text-compact leading-5">
                <div className="text-app-text"><span className="text-app-text-tertiary">{c.ruleWhen}</span> {r.when}</div>
                <div className="text-app-text"><span className="text-app-text-tertiary">{c.ruleThen}</span> {r.then}</div>
                {r.onOpenFlow && <button type="button" onClick={r.onOpenFlow} className={clsx('mt-0.5 inline-flex items-center gap-1 text-mini text-sky-700 hover:underline dark:text-sky-300', FOCUS_RING)}>{c.openFlow}<ArrowRight size={11} aria-hidden="true" /></button>}
              </div>
              <Toggle checked={r.on} onChange={() => r.onToggle && r.onToggle()} disabled={r.onToggle === false} title={r.onToggle === false ? deniedTitle : c.toggleRule} />
              <IconButton icon={Trash2} label={c.deleteRule} onClick={r.onDelete} className="!h-7 !w-7 border-0 bg-transparent shadow-none" />
            </li>
          ))}
        </ul>
        <div className="mt-2.5"><Button size="sm" icon={Plus} onClick={onAddRule} title={canEditRules ? undefined : deniedTitle}>{c.addRule}</Button></div>
      </PanelSection>
    </>
  ) : null;
  const main = (
    <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label={c.statConnected} value={`${stats.connected} / ${stats.total}`} />
        <StatCard label={c.statVolume} value={c.number(stats.volume)} detail={c.statVolumeNote} />
        <StatCard label={c.statStarting} value={stats.starting} detail={c.statStartingNote} />
      </div>
      {table}
      {!detail && <Card><p className="text-compact leading-5 text-app-text-secondary">{c.pickHint}</p></Card>}
    </div>
  );
  const side = detail ? picked : overview;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        crumbs={detail ? [{ label: copy.shell.nav.channels }, { label: detail.name }] : [{ label: copy.shell.nav.channels, detail: c.subtitle }]}
        leading={detail && onBack && backLabel ? <BackButton label={backLabel} onClick={onBack} copy={copy} /> : undefined}
      >
        <Button variant="primary" icon={Plus} onClick={onConnect}>{c.connect}</Button>
      </PaneHeader>
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {main}
          <div className="border-t border-app-border bg-surface">{side}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto">{main}</div>
          <SidePanel width={detail ? 400 : 340}>{side}</SidePanel>
        </div>
      )}
    </div>
  );
}
