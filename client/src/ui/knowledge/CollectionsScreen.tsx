import type { ReactNode } from 'react';
import { BookOpen, ChevronRight, CircleCheck, FileText, Link2, Lock, MessageSquareText, Network, RefreshCw, Sparkles, Unlink, Upload } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action, SourceModel } from '../types';
import { Button } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip, Count } from '../primitives/Chip';
import { MenuButton } from '../primitives/Menu';
import { KeyValue, PanelHeading, PanelSection } from '../primitives/Panel';
import { ProgressBar } from '../primitives/Progress';
import { Table } from '../primitives/Table';
import { PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import { AnswerCard } from './AnswerCard';
import { AskBox } from './AskBox';
import type { AnswerModel, CollectionPanelModel, CollectionRowModel, PassageModel, RecentModel } from './model';
import { PanelColumn } from './PanelColumn';

const STATE_ICON = { green: CircleCheck, amber: Sparkles, neutral: Lock } as const;

/** What one list of recent or cited things looks like: a titled card of rows that open something. */
function RowCard({ title, icon, children, empty }: { title: string; icon: typeof FileText; children: ReactNode; empty?: string }) {
  return (
    <Card title={title} icon={icon}>
      {empty ? <p className="text-compact text-app-text-tertiary">{empty}</p> : <ul className="-mx-2 space-y-0.5">{children}</ul>}
    </Card>
  );
}

/** One row of a list that opens something. */
function OpenRow({ label, detail, trailing, onOpen }: { label: string; detail?: string; trailing?: ReactNode; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-app-hover', FOCUS_RING)}>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-prose font-medium text-app-text">{label}</span>
          {detail && <span className="block truncate text-compact text-app-text-tertiary">{detail}</span>}
        </span>
        {trailing ?? <ChevronRight size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />}
      </button>
    </li>
  );
}

/**
 * The collections of an organization's knowledge and the question box over
 * them (n13): ask, read the answer with its numbered sources, see what was
 * opened lately and what is cited most, then the collections with their
 * counts; the selected one is described on the right. Everything that opens
 * something is a handler of the caller.
 */
export function CollectionsScreen({
  copy, phone, count, jobs,
  question, onQuestionChange, onAsk, suggestions, answer, onClearAnswer, onOpenSource, onOpenPassage,
  rows, selectedId, onSelectRow, panel, lockedPanel, onPanelAction, onOpenPanelItem, onOpenReview,
  recent, onOpenRecent, mostCited, onOpenCited,
  onMap, onConnect, onConnectAction, connectTitle, connected, onUpload, uploadTitle, uploadSlot,
}: {
  copy: UiCopy;
  phone?: boolean;
  count: number;
  /** Work in progress with visible progress (SharePoint, a document being read). */
  jobs?: Array<{ id: string; label: string; progress: number }>;
  question: string;
  onQuestionChange: (v: string) => void;
  onAsk: (question: string) => void;
  suggestions: string[];
  answer?: AnswerModel;
  onClearAnswer?: () => void;
  onOpenSource: (source: SourceModel) => void;
  onOpenPassage: (p: PassageModel) => void;
  rows: CollectionRowModel[];
  selectedId: string;
  onSelectRow: (id: string) => void;
  panel: CollectionPanelModel;
  /** Replaces the panel when the selected collection is not open to the person. */
  lockedPanel?: ReactNode;
  onPanelAction: (token: string) => void;
  onOpenPanelItem: (id: string) => void;
  onOpenReview: (id: string) => void;
  recent: RecentModel[];
  onOpenRecent: (r: RecentModel) => void;
  mostCited: Array<{ id: string; label: string; count: number }>;
  onOpenCited: (id: string) => void;
  onMap: () => void;
  /** Connects SharePoint; `false` when the person may not (the title says why). */
  onConnect: Action;
  /** What the menu of a connected SharePoint does. */
  onConnectAction: (id: 'sync' | 'disconnect') => void;
  connectTitle?: string;
  connected: boolean;
  onUpload: Action;
  uploadTitle?: string;
  /** The upload form, when it is open. */
  uploadSlot?: ReactNode;
}) {
  const c = copy.knowledgeMore.collections;
  const p = c.panel;
  const buttons = (
    <>
        <Button icon={Network} onClick={onMap}>{c.map}</Button>
        {connected ? (
          <MenuButton
            label={c.connected}
            icon={Link2}
            align="right"
            items={[{ id: 'sync', label: c.syncSharePoint, icon: RefreshCw, disabled: onConnect === false, title: connectTitle }, { id: 'disconnect', label: c.disconnect, icon: Unlink, danger: true, disabled: onConnect === false, title: connectTitle }]}
            onSelect={(id) => onConnectAction(id as 'sync' | 'disconnect')}
          />
        ) : (
          <Button icon={Link2} onClick={onConnect} title={connectTitle}>{c.connect}</Button>
        )}
        <Button variant="primary" icon={Upload} onClick={onUpload} title={uploadTitle}>{c.upload}</Button>
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={[{ label: copy.knowledge.root, detail: c.count(count) }]}>{!phone && buttons}</PaneHeader>
      {phone && <div className="flex flex-wrap gap-2 border-b border-app-border px-4 py-2">{buttons}</div>}
      <div className={clsx('flex min-h-0 flex-1', phone ? 'flex-col overflow-y-auto' : 'flex-row')}>
        <div className={clsx('min-w-0 space-y-4 px-4 py-4 md:px-7', phone ? 'shrink-0' : 'flex-1 overflow-y-auto')}>
          {jobs?.map((j) => <ProgressBar key={j.id} label={j.label} value={j.progress} />)}
          <AskBox copy={copy} value={question} onChange={onQuestionChange} onAsk={onAsk} suggestions={suggestions} asked={!!answer} onClear={onClearAnswer} />
          {answer && <AnswerCard answer={answer} copy={copy} onOpenSource={onOpenSource} onOpenPassage={onOpenPassage} onUpload={onUpload || undefined} />}
          {uploadSlot}
          <div className="grid gap-4 md:grid-cols-2">
            <RowCard title={c.recent} icon={FileText} empty={recent.length ? undefined : c.recentEmpty}>
              {recent.map((r) => (
                <OpenRow
                  key={r.id}
                  label={r.label}
                  detail={r.detail}
                  trailing={r.kind === 'question' ? <MessageSquareText size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" /> : undefined}
                  onOpen={() => onOpenRecent(r)}
                />
              ))}
            </RowCard>
            <RowCard title={c.mostCited} icon={BookOpen} empty={mostCited.length ? undefined : c.mostCitedEmpty}>
              {mostCited.map((m) => (
                <OpenRow key={m.id} label={m.label} trailing={<Count value={m.count} tone="blue" />} onOpen={() => onOpenCited(m.id)} />
              ))}
            </RowCard>
          </div>
          <Table
            ariaLabel={c.tableLabel}
            columns={[
              { id: 'name', label: c.columns.collection, width: 160 },
              { id: 'docs', label: c.columns.documents, width: 90, align: 'right' },
              { id: 'viewers', label: c.columns.viewers, width: 130 },
              { id: 'source', label: c.columns.source, width: 170 },
              { id: 'state', label: c.columns.state },
            ]}
            rows={rows.map((r) => {
              const StateIcon = STATE_ICON[r.state.tone];
              return {
                id: r.id,
                selected: r.id === selectedId,
                onOpen: r.id === selectedId ? undefined : () => onSelectRow(r.id),
                cells: {
                  name: <b className="font-semibold">{r.label}</b>,
                  docs: r.count,
                  viewers: r.viewers,
                  source: r.source,
                  state: <Chip tone={r.state.tone} icon={StateIcon}>{r.state.text}</Chip>,
                },
              };
            })}
          />
        </div>
        <PanelColumn phone={phone} width={360}>
          {lockedPanel ?? (
            <>
              <PanelHeading tag={p.tag} tagIcon={BookOpen} title={panel.title}>
                {panel.description}
                {panel.action && <div className="mt-2.5"><Button size="sm" onClick={() => onPanelAction(panel.action?.token ?? '')}>{panel.action.label}</Button></div>}
              </PanelHeading>
              {panel.review.length > 0 && (
                <PanelSection label={p.review}>
                  {panel.review.map((r) => (
                    <button key={r.id} type="button" onClick={() => onOpenReview(r.id)} className={clsx('flex min-h-7 w-full items-center gap-2 rounded py-0.5 text-left text-prose text-app-text hover:text-primary', FOCUS_RING)}>
                      <span className="min-w-0 flex-1 truncate">{r.label}</span>
                      <Chip tone="pink" icon={Sparkles}>{copy.common.ai}</Chip>
                    </button>
                  ))}
                </PanelSection>
              )}
              <PanelSection label={p.documents}>
                {panel.items.length ? panel.items.map((it) => (
                  <button key={it.id} type="button" onClick={() => onOpenPanelItem(it.id)} className={clsx('flex min-h-7 w-full items-center gap-2 rounded py-0.5 text-left text-prose text-app-text hover:text-primary', FOCUS_RING)}>
                    <span className="min-w-0 flex-1 truncate">{it.label}</span>
                    {it.chip && <Chip tone={it.chip.tone}>{it.chip.text}</Chip>}
                    <ChevronRight size={13} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                  </button>
                )) : <p className="text-compact text-app-text-tertiary">{p.documentsEmpty}</p>}
              </PanelSection>
              <PanelSection label={p.rules}>
                {panel.rules.map((r) => (
                  <KeyValue
                    key={r.label}
                    label={r.label}
                    value={r.action ? (
                      <button type="button" onClick={() => onPanelAction(r.action as string)} className={clsx('rounded font-semibold text-primary underline-offset-2 hover:underline dark:text-primary-dark', FOCUS_RING)}>{r.value}</button>
                    ) : <span className="font-semibold">{r.value}</span>}
                  />
                ))}
              </PanelSection>
              <PanelSection label={p.usage}>
                {panel.usage.map((u) => (
                  <KeyValue
                    key={u.label}
                    label={u.label}
                    value={u.action ? (
                      <button type="button" onClick={() => onPanelAction(u.action as string)} className={clsx('rounded font-semibold text-primary underline-offset-2 hover:underline dark:text-primary-dark', FOCUS_RING)}>{u.value}</button>
                    ) : <span className="font-semibold">{u.value}</span>}
                  />
                ))}
                <p className="mt-1.5 text-mini text-app-text-tertiary">{p.estimateNote}</p>
              </PanelSection>
            </>
          )}
        </PanelColumn>
      </div>
    </div>
  );
}
