import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { Action, SourceModel } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { PaneHeader } from '../shell/PaneHeader';
import { PHONE_FILL } from '../work/phoneFrame';
import { AssistantPanel } from './AssistantPanel';
import { DocumentList } from './DocumentList';
import { DraftEditor } from './DraftEditor';
import type { RecordModel, RecordSection } from './model';
import { PhaseTrack } from './PhaseTrack';

export type PhoneRecordTab = 'draft' | 'documents' | 'assistant';

/**
 * A record open to work on it (x06): where it stands among the stages of its
 * type, its documents on the left, the draft in the middle with the AI's
 * proposals to accept one by one, and the record's own assistant on the right.
 * `notice` is the slot for what the picture declares about its data.
 * A container drives it through the optional props: every handler is passed
 * down to the part it belongs to, `leading` is the way back, `sectionBody`
 * fills the left column for the data and history sections, and `main` replaces
 * the draft with another column (an original document). Without them it is
 * the same picture as before; an `Action` set to `false` draws that control
 * disabled. `headerActions` sit before the buttons (who has it), `docsExtra`
 * under the related records (receipts), `draftFooter` under the page, `tools`
 * and `assist` bring the editor and the assistant to life. With `phone` the
 * three columns become three tabs and the two buttons a bar at the foot.
 */
export function RecordScreen({
  record, copy, notice, section, onSectionChange, onSaveDraft, onPrimary, primaryVariant = 'primary', primaryTitle, saveTitle,
  leading, onOpenDeadline, onOpenStep, selectedDocumentId, onOpenDocument, onOpenRelated,
  sectionBody, onOpenSource, onProposal, onTool, tools, onSend, main, headerActions, docsExtra, draftFooter, assist, banner, primarySlot,
  phone, phoneTab = 'draft', onPhoneTabChange,
}: {
  record: RecordModel;
  copy: UiCopy;
  notice?: ReactNode;
  section?: RecordSection;
  onSectionChange?: (section: RecordSection) => void;
  onSaveDraft?: Action;
  onPrimary?: Action;
  primaryVariant?: 'primary' | 'confirm' | 'secondary';
  primaryTitle?: string;
  saveTitle?: string;
  leading?: ReactNode;
  onOpenDeadline?: () => void;
  onOpenStep?: (stepId: string) => void;
  selectedDocumentId?: string;
  onOpenDocument?: (docId: string) => void;
  onOpenRelated?: (id: string) => void;
  sectionBody?: ReactNode;
  onOpenSource?: (s: SourceModel) => void;
  onProposal?: (blockIndex: number, decision: 'accept' | 'discard') => void;
  onTool?: Action;
  tools?: React.ComponentProps<typeof DraftEditor>['tools'];
  onSend?: Action;
  main?: ReactNode;
  headerActions?: ReactNode;
  docsExtra?: ReactNode;
  draftFooter?: ReactNode;
  assist?: {
    message: string;
    onMessageChange: (m: string) => void;
    onAsk: (question: string) => void;
    onToggleCheck: (id: string) => void;
    busy?: boolean;
  };
  /** A strip under the header: the case waits for confirmation, a job is running or failed. */
  banner?: ReactNode;
  /** Replaces the primary button (a job in progress, reopen). */
  primarySlot?: ReactNode;
  phone?: boolean;
  phoneTab?: PhoneRecordTab;
  onPhoneTabChange?: (tab: PhoneRecordTab) => void;
}) {
  const deadline = <Chip tone="red" icon={CircleAlert}>{record.deadline}</Chip>;
  const deadlineChip = onOpenDeadline ? (
    <button
      type="button"
      onClick={onOpenDeadline}
      data-tip={copy.preview.whereFrom}
      className="inline-flex rounded hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      {deadline}
    </button>
  ) : deadline;
  const documents = (
    <DocumentList
      record={record}
      copy={copy}
      section={section}
      onSectionChange={onSectionChange}
      selectedId={selectedDocumentId}
      onOpen={onOpenDocument}
      onOpenRelated={onOpenRelated}
      body={sectionBody}
      extra={docsExtra}
      fill={phone}
    />
  );
  const draft = main ?? (
    <DraftEditor draft={record.draft} copy={copy} onOpenSource={onOpenSource} onProposal={onProposal} onTool={onTool} tools={tools} footer={draftFooter} phone={phone} />
  );
  const assistant = (
    <AssistantPanel
      assistant={record.assistant}
      copy={copy}
      onOpenSource={onOpenSource}
      onSend={onSend}
      message={assist?.message}
      onMessageChange={assist?.onMessageChange}
      onAsk={assist?.onAsk}
      onToggleCheck={assist?.onToggleCheck}
      busy={assist?.busy}
      fill={phone}
    />
  );

  if (phone) {
    const title = record.crumbs[record.crumbs.length - 1];
    return (
      <div className={clsx('flex min-h-0 flex-col', PHONE_FILL)}>
        <div className="shrink-0 px-4 pb-2 pt-3">
          {leading && <div className="mb-1 flex items-center">{leading}</div>}
          <h1 className="text-body-lg font-semibold leading-6 text-app-text">{title.label}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {deadlineChip}
            {record.exampleTag && <Chip>{record.exampleTag}</Chip>}
          </div>
        </div>
        {banner}
        <PhaseTrack label={record.phasesLabel} phases={record.phases} copy={copy} onOpenStep={onOpenStep} phone />
        <div className="shrink-0 px-4 py-2">
          <SegmentedControl
            value={phoneTab}
            onChange={(v) => onPhoneTabChange?.(v)}
            ariaLabel={copy.record.sectionsLabel}
            options={[
              { value: 'draft', label: copy.work.record.tabDraft },
              { value: 'documents', label: copy.record.documents },
              { value: 'assistant', label: copy.work.record.tabAssistant },
            ]}
          />
        </div>
        <div className={clsx('flex min-h-0 flex-1 flex-col', phoneTab === 'draft' && 'overflow-y-auto')}>
          {phoneTab === 'draft' ? draft : phoneTab === 'documents' ? documents : assistant}
        </div>
        <div className="flex shrink-0 items-center gap-2 border-t border-app-border bg-surface px-4 pb-3 pt-2.5">
          {headerActions}
          <Button size="lg" onClick={onSaveDraft} title={saveTitle} className="flex-1">{copy.record.saveDraft}</Button>
          {primarySlot ?? <Button size="lg" variant={primaryVariant} onClick={onPrimary} title={primaryTitle} className="flex-[2]">{record.primaryAction}</Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        crumbs={record.crumbs}
        leading={leading}
        status={
          <span className="flex items-center gap-1.5">{deadlineChip}</span>
        }
      >
        {notice}
        {headerActions}
        <Button onClick={onSaveDraft} title={saveTitle}>{copy.record.saveDraft}</Button>
        {primarySlot ?? <Button variant={primaryVariant} onClick={onPrimary} title={primaryTitle}>{record.primaryAction}</Button>}
      </PaneHeader>
      {banner}
      {/* The example tag sits here, not in the header, so the header keeps its room for the title and the buttons. */}
      <PhaseTrack label={record.phasesLabel} phases={record.phases} copy={copy} onOpenStep={onOpenStep} trailing={record.exampleTag && <Chip>{record.exampleTag}</Chip>} />
      <div className="flex min-h-0 flex-1">
        {documents}
        {draft}
        {assistant}
      </div>
    </div>
  );
}
