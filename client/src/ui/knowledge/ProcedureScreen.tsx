import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, CircleCheck, Clock, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action, SourceModel } from '../types';
import { Button, IconButton } from '../primitives/Button';
import { Card } from '../primitives/Card';
import { Chip } from '../primitives/Chip';
import { StateChip } from '../contracts/StateChip';
import { TextArea, TextField } from '../primitives/Field';
import { KeyValue, PanelHeading, PanelSection } from '../primitives/Panel';
import { Source } from '../primitives/Source';
import { PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import type { ProcedureModel, ProcedureStepModel } from './model';
import { PanelColumn } from './PanelColumn';

/** What the procedure offers to do, by the state it is in; `false` is an action the person may not take. */
export interface ProcedureActions {
  approve?: Action;
  /** Why approving is off, when `approve` is `false`. */
  approveTitle?: string;
  requestChanges?: Action;
  discard?: Action;
  restore?: Action;
  edit?: Action;
  rewrite?: Action;
  openTest?: () => void;
}

/** One step of the procedure, numbered, with the source it rests on. */
function StepRow({ n, step, copy, onOpenSource }: { n: number; step: ProcedureStepModel; copy: UiCopy; onOpenSource: (s: SourceModel) => void }) {
  const p = copy.knowledgeMore.procedure;
  return (
    <li className={clsx('flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md px-2 py-1.5 text-prose leading-6 text-app-text', step.added && 'bg-emerald-500/10')}>
      <span className="min-w-0 flex-1 basis-64">
        <b className="mr-1">{n}.</b>
        {step.text}
        {step.source && (
          <span className="ml-1.5">
            <Source source={{ id: step.source.id, label: step.source.label }} pageLabel={copy.common.page} onOpen={step.source.id ? onOpenSource : undefined} />
          </span>
        )}
      </span>
      {step.added && <Chip tone="green">{p.stepAdded}</Chip>}
    </li>
  );
}

/** The steps while a person edits them: a field per step, move, remove, add. */
function StepEditor({ steps, copy, onChange, onAdd, onRemove, onMove }: {
  steps: ProcedureStepModel[];
  copy: UiCopy;
  onChange: (id: string, text: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
}) {
  const p = copy.knowledgeMore.procedure;
  return (
    <div className="space-y-2">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-end gap-1.5">
          <span className="mb-1.5 w-5 shrink-0 text-right text-prose font-semibold text-app-text-secondary">{i + 1}.</span>
          <TextField className="flex-1" title={p.editStepLabel(i + 1)} value={s.text} onChange={(v) => onChange(s.id, v)} />
          <IconButton icon={ArrowUp} label={p.moveUp} onClick={() => onMove(s.id, -1)} />
          <IconButton icon={ArrowDown} label={p.moveDown} onClick={() => onMove(s.id, 1)} />
          <IconButton icon={Trash2} label={p.removeStep} onClick={() => onRemove(s.id)} />
        </div>
      ))}
      <Button size="sm" icon={Plus} onClick={onAdd}>{p.addStep}</Button>
    </div>
  );
}

/**
 * A procedure the AI wrote from the closed cases and the norms they cite
 * (x04): who does it, how long, with which programs, what it rests on; the
 * steps, each with its source; the mistakes to avoid. A person approves it,
 * asks for changes with a comment, edits it, or discards it; the comments and
 * the versions are on the page. Everything that changes the procedure is a
 * handler of the caller, drawn off (with its reason) for a person who may not.
 */
export function ProcedureScreen({
  copy, phone, model, actions, backSlot,
  editing, draftSteps, onEditChange, onEditAdd, onEditRemove, onEditMove, onEditSave, onEditCancel,
  changesOpen, changesDraft, onChangesDraft, onChangesSend, onChangesClose,
  commentDraft, onCommentDraft, onCommentSend,
  onOpenSource, afterSlot,
}: {
  copy: UiCopy;
  phone?: boolean;
  model: ProcedureModel;
  actions: ProcedureActions;
  backSlot?: ReactNode;
  editing: boolean;
  draftSteps: ProcedureStepModel[];
  onEditChange: (id: string, text: string) => void;
  onEditAdd: () => void;
  onEditRemove: (id: string) => void;
  onEditMove: (id: string, dir: -1 | 1) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  changesOpen: boolean;
  changesDraft: string;
  onChangesDraft: (v: string) => void;
  onChangesSend: () => void;
  onChangesClose: () => void;
  commentDraft: string;
  onCommentDraft: (v: string) => void;
  onCommentSend: () => void;
  onOpenSource: (s: SourceModel) => void;
  /** The rows of «after the approval»: they hold links the caller owns. */
  afterSlot: ReactNode;
}) {
  const p = copy.knowledgeMore.procedure;
  const m = model;
  const a = actions;
  const tone = m.panel.tagTone;
  const buttons = (
    <>
        <span className="hidden text-compact text-app-text-tertiary xl:inline">{m.note}</span>
        {a.edit !== undefined && !editing && <Button icon={Pencil} onClick={a.edit}>{p.edit}</Button>}
        {a.discard !== undefined && <Button variant="danger" onClick={a.discard}>{p.discard}</Button>}
        {a.restore !== undefined && <Button onClick={a.restore}>{p.restore}</Button>}
        {a.requestChanges !== undefined && <Button onClick={a.requestChanges}>{p.requestChanges}</Button>}
        {a.rewrite !== undefined && <Button variant="primary" icon={Sparkles} onClick={a.rewrite}>{p.rewrite}</Button>}
        {a.openTest && <Button variant="primary" onClick={a.openTest}>{p.openTest}</Button>}
        {a.approve !== undefined && <Button variant="confirm" icon={CircleCheck} onClick={a.approve} title={a.approve === false ? a.approveTitle : undefined}>{p.approve}</Button>}
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={m.crumbs} leading={backSlot} status={<Chip tone={m.status.tone} icon={m.status.tone === 'green' ? CircleCheck : Clock}>{m.status.text}</Chip>}>{!phone && buttons}</PaneHeader>
      {phone && <div className="flex flex-wrap gap-2 border-b border-app-border px-4 py-2">{buttons}</div>}
      <div className={clsx('flex min-h-0 flex-1', phone ? 'flex-col overflow-y-auto' : 'flex-row')}>
        <div className={clsx('min-w-0 space-y-4 px-4 py-5 md:px-7', phone ? 'shrink-0' : 'flex-1 overflow-y-auto')}>
          <p className="text-compact text-app-text-tertiary xl:hidden">{m.note}</p>
          <div className="flex flex-wrap items-start gap-2 rounded-lg bg-fuchsia-500/10 px-3.5 py-3 text-compact leading-5 text-app-text">
            <Chip tone="pink" icon={Sparkles}>{copy.common.ai}</Chip>
            <span className="min-w-0 flex-1 basis-64">{m.intro} <Chip>{p.example}</Chip></span>
          </div>
          <h2 className="text-headline font-semibold tracking-[-0.01em] text-app-text">{m.title}</h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {m.facts.map((f) => (
              <div key={f.label} className="rounded-lg border border-app-border bg-surface px-3 py-2.5">
                <div className="text-compact text-app-text-tertiary">{f.label}</div>
                <div className="mt-0.5 text-prose font-semibold leading-5 text-app-text">{f.value}</div>
              </div>
            ))}
          </div>
          <Card
            title={p.stepsTitle}
            actions={editing ? (
              <>
                <Button size="sm" variant="primary" onClick={onEditSave}>{p.editDone}</Button>
                <Button size="sm" variant="ghost" onClick={onEditCancel}>{p.editCancel}</Button>
              </>
            ) : undefined}
          >
            {editing ? (
              <StepEditor steps={draftSteps} copy={copy} onChange={onEditChange} onAdd={onEditAdd} onRemove={onEditRemove} onMove={onEditMove} />
            ) : (
              <ol className="-mx-2 space-y-0.5">
                {m.steps.map((s, i) => <StepRow key={s.id} n={i + 1} step={s} copy={copy} onOpenSource={onOpenSource} />)}
              </ol>
            )}
          </Card>
          <Card title={p.mistakesTitle}><p className="text-compact leading-6">{m.mistakes}</p></Card>
          {changesOpen && (
            <Card title={p.changesTitle} tone="amber">
              <TextArea label={p.changesLabel} placeholder={p.changesPlaceholder} value={changesDraft} onChange={onChangesDraft} rows={3} />
              <div className="mt-2.5 flex gap-2">
                <Button size="sm" variant="primary" onClick={onChangesSend}>{p.changesSend}</Button>
                <Button size="sm" variant="ghost" onClick={onChangesClose}>{p.changesCancel}</Button>
              </div>
            </Card>
          )}
          <Card title={p.versionsTitle}>
            <ol className="space-y-1.5">
              {m.versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2 text-prose text-app-text">
                  <span className="font-semibold">{v.label}</span>
                  {v.current && <StateChip tone="green">{p.versionCurrent}</StateChip>}
                  <span className="min-w-0 flex-1 text-compact text-app-text-tertiary">{v.detail}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <PanelColumn phone={phone} width={360}>
          <PanelHeading tag={m.panel.tag} tagIcon={tone === 'green' ? CircleCheck : Clock} title={m.panel.title}>{m.panel.description}</PanelHeading>
          <PanelSection label={p.sourcesTitle}>
            {m.sources.map((s) => (
              <KeyValue
                key={s.label}
                label={s.label}
                value={s.id ? (
                  <button type="button" onClick={() => onOpenSource({ id: s.id, label: s.label })} className={clsx('rounded font-semibold text-primary underline-offset-2 hover:underline dark:text-primary-dark', FOCUS_RING)}>{s.value}</button>
                ) : <span className="font-semibold">{s.value}</span>}
              />
            ))}
          </PanelSection>
          <PanelSection label={p.commentsTitle}>
            <div className="space-y-2">
              {m.comments.length === 0 && <p className="text-compact text-app-text-tertiary">{p.commentsEmpty}</p>}
              {m.comments.map((c) => (
                <div key={c.id} className="rounded-lg bg-black/[0.04] px-3 py-2 text-prose leading-5 text-app-text dark:bg-white/[0.06]">
                  <b>{c.who}</b> · {c.text}
                  <div className="mt-0.5 text-mini text-app-text-tertiary">{c.at}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-2">
              <TextArea label={p.commentLabel} placeholder={p.commentPlaceholder} value={commentDraft} onChange={onCommentDraft} rows={2} />
              <Button size="sm" onClick={onCommentSend}>{p.commentSend}</Button>
            </div>
          </PanelSection>
          <PanelSection label={p.afterTitle}>{afterSlot}</PanelSection>
        </PanelColumn>
      </div>
    </div>
  );
}
