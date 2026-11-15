import type { TaskCommentAcknowledgement } from '../../../../shared/task-comment-ack';
import { STATUS_CHIP } from '@/lib/statusVisual';
import { useMemo, memo } from 'react';
import { useT } from '../../hooks/useT';
import { Spinner } from '../Shared/Spinner';
import { getMediaUrl } from '../../lib/api';
import { MAX_ATTACHMENTS, type StagedAttachment, dragCarriesFiles, filesFromDrop, imagesFromClipboard } from '../../lib/attachments';
import { isResolvedParkedQuestion } from '../../../../shared/parked-question';
import { type TaskSessionState, canOpenTaskSession } from '../../lib/taskSession';
import { isThreadSpeech, parseQuestionBlock, boardDrafts, type BoardTask, type TaskComment } from '../../lib/board';
import { taskActionWord } from './taskActionWords';
import { type TimelineItem } from './taskTimeline';
import { ArrowUpRight, ChevronRight, X, Paperclip, ArrowUp, Square, StickyNote } from 'lucide-react';
import { COMPACT_MD_CLS, mediaPaneIdFor } from './constants';
import type { RefObject, Dispatch, SetStateAction } from 'react';
import { isDoneThreadService, isServiceComment } from '../../../../shared/task-comment-service';
import { ThreadRuns } from './ThreadRuns';
import { runningToolLabel } from '../Chat/runningToolLabel';
import { emptyThreadKey } from './emptyThread';
import { SessionLiveRow } from './SessionLiveRow';
import { commentChip, commentChipTestId } from './chipKey';
import { isChronicleRow, liveToolRow } from './columnFilter';
import { stripMarkdown } from '../../lib/stripMarkdown';
import { followChoiceMayChange } from '../../lib/taskConversationFollow';
import { DispatchEnvelopeRow } from '../Chat/DispatchEnvelopeRow';
import { EffortBadge } from '../Chat/EffortBadge';
import { markActiveComposer } from '../../lib/composerCursor';
import { DictationButton } from '../Shared/DictationButton';
import { ZoomableImage } from '../Shared/ImageLightbox';
import { COMPOSER_CARD, COMPOSER_ICON_BUTTON, COMPOSER_TEXTAREA } from '../Chat/composerStyles';
import { BoardCommandHint } from './BoardCommandHint';
import { MessageContent } from '../MessageContent';
import { taskSessionSegments } from './taskSessionPresentation';
import { type TaskSessionRunItem } from './taskSessionRuns';
import { TaskWorkAccordion } from '../Chat/TaskWorkAccordion';
import { TaskWorkFoldContext } from '../Chat/taskWorkFoldContext';
import { machineStopOf, subagentResultOf, backgroundNoticeOf } from '../Chat/machineRow';
import { SubAgentResultRow } from '../Chat/SubAgentResultCard';
import { MachineStopLine } from '../Chat/MachineStopLine';
import { BackgroundNoticeLine } from '../Chat/BackgroundNoticeLine';
import type { Topic } from '../../types';
import { StatusTrail, CommentBubble } from './TaskComments';
import { TaskSessionUserRow } from './TaskSessionUserRow';

/**
 * ONE STEP OF THE AGENT, drawn exactly as the topic chat draws it.
 *
 * `MessageContent` and nothing else: the reasoning fold, the tool rows, the
 * media, and the `ToolInputForm` a paused `ask_user_question` puts on screen
 * all come for free, and they BEHAVE the same on both surfaces. The drawer used
 * to have its own miniature renderer for this (thinking, then prose, and that
 * was all), which is why a question the agent asked was answerable in the chat
 * and dead in the card.
 *
 * What is deliberately NOT passed is the accounting: `usage*` and `costCents`
 * draw a per-turn footer that belongs to the chat, not to a 22rem column where
 * the reader is following a decision. `sessionKey` IS passed, because it is
 * what lets the question form POST its answer.
 */
export const SessionRun = memo(function SessionRun({ items, sessionKey }: {
  items: TaskSessionRunItem[];
  sessionKey: string | null;
}) {
  const tr = useT();
  const groups = useMemo(() => {
    type Part = ReturnType<typeof taskSessionSegments>[number] & { originalId: string };
    const result: { folded: boolean; parts: Part[] }[] = [];
    for (const item of items) {
      for (const segment of taskSessionSegments(item.msg, item.hasThreadReply, item.foldProgress)) {
        const part = { ...segment, originalId: item.msg.id };
        const last = result[result.length - 1];
        if (segment.folded && last?.folded) last.parts.push(part);
        else result.push({ folded: segment.folded, parts: [part] });
      }
    }
    // One «Session details» row per run: later folded groups join the first.
    const firstFold = result.find((group) => group.folded);
    const merged = result.filter((group) => {
      if (!group.folded || group === firstFold) return true;
      firstFold!.parts.push(...group.parts);
      return false;
    });
    let hasFold = false;
    return merged.map((group) => {
      // The first disclosure belongs to the run. Earlier prose can join it
      // when the first tool arrives, without closing details the reader opened.
      const key = group.folded && !hasFold ? `${items[0].id}:work` : group.parts[0].message.id;
      hasFold ||= group.folded;
      return { ...group, key, summary: {
      ...group.parts[0].message,
      blocks: group.parts.flatMap((part) => part.message.blocks ?? []),
      toolCalls: group.parts.flatMap((part) => part.message.toolCalls ?? []),
    } }; });
  }, [items]);
  return <div className={`text-body-lg leading-5 text-app-text ${COMPACT_MD_CLS}`} data-testid="task-session-item" data-message-id={items[0].msg.id}>
    {groups.map(({ folded, parts, summary, key }) => {
      const content = parts.map(({ message, originalId }) => subagentResultOf(message.blocks)
        ? <SubAgentResultRow key={message.id} messageId={message.id} block={subagentResultOf(message.blocks)!} />
        : machineStopOf(message.blocks)
        ? <MachineStopLine key={message.id} cause={machineStopOf(message.blocks)!} closed={backgroundNoticeOf(message.blocks)} />
        : backgroundNoticeOf(message.blocks)
        ? <BackgroundNoticeLine key={message.id} notice={backgroundNoticeOf(message.blocks)!} />
        : <MessageContent
        key={message.id}
        content={message.content ?? ''} role={message.role}
        thinking={message.thinking} toolCalls={message.toolCalls} blocks={message.blocks} media={message.media}
        partial={message.partial}
        sessionKey={sessionKey ?? undefined} messageId={originalId}
      />);
      // The task drawer already folds the session's work into «Session
      // details»: the turn fold of the chat (`Chat/turnFold.ts`) would nest a
      // second closed row inside it, so it is switched off here the same way
      // the task chat switches it off.
      return folded
        ? <TaskWorkAccordion key={key} msg={summary} label={tr('chat.taskWork.sessionDetails')}><TaskWorkFoldContext.Provider value>{content}</TaskWorkFoldContext.Provider></TaskWorkAccordion>
        : <div key={key}><TaskWorkFoldContext.Provider value>{content}</TaskWorkFoldContext.Provider></div>;
    })}
  </div>;
}, (previous, next) => previous.sessionKey === next.sessionKey
  && previous.items.length === next.items.length
  && previous.items.every((item, index) => item.msg === next.items[index].msg
    && item.hasThreadReply === next.items[index].hasThreadReply
    && item.foldProgress === next.items[index].foldProgress));

export function TaskComposer({ agentBusy, attachments, busy, commentCursorKey, commentRef, composerAreaRef, composerPlaceholder, composerSendTitle, draft, error, fileDragOver, fileInputRef, isAgentReview, isMobile, load, loadFailedMessage, onOpenTopic, saveCommentCursor, send, sending, sessionState, sessionTopic, setAttachments, setDraft, setError, setFileDragOver, shownEffort, stopAgent, task, taskId, tr, twoCol, uploadFiles, uploading, workspaceOpen }: {
  agentBusy: boolean;
  attachments: StagedAttachment[];
  busy: boolean;
  commentCursorKey: string;
  commentRef: RefObject<HTMLTextAreaElement | null>;
  composerAreaRef: RefObject<HTMLDivElement | null>;
  composerPlaceholder: string;
  composerSendTitle: string;
  draft: string;
  error: string | null;
  fileDragOver: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  isAgentReview: boolean;
  isMobile: boolean;
  load: () => Promise<void>;
  loadFailedMessage: string | null;
  onOpenTopic: ((topicId: string) => void) | undefined;
  saveCommentCursor: () => void;
  send: (opts?: { quiet?: boolean; }) => Promise<void>;
  sending: boolean;
  sessionState: TaskSessionState;
  sessionTopic: Topic | undefined;
  setAttachments: Dispatch<SetStateAction<StagedAttachment[]>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setFileDragOver: Dispatch<SetStateAction<boolean>>;
  shownEffort: string | null;
  stopAgent: () => Promise<void>;
  task: BoardTask;
  taskId: string;
  tr: (key: string, vars?: Record<string, string | number>) => string;
  twoCol: boolean;
  uploadFiles: (files: FileList | File[]) => Promise<void>;
  uploading: boolean;
  workspaceOpen: boolean;
}) {
  return (
<>
{/* The composer floats over the conversation; its measured height
              reserves the final reading space. Delivery decisions live above. */}
          {/* DROPPING A FILE IN HERE ATTACHES IT. Paste was already on the
              text field, drag and drop was not: a captured screenshot could be
              pasted, the same screenshot saved to disk had no way in. The drop
              zone is the whole delivery area, not the field's own thirty
              pixels: whoever drags aims at the composer. A drag carrying NO
              file (a layout pane, a text selection) leaves it alone, through
              `dragCarriesFiles`. */}
          <div
            ref={composerAreaRef}
            className={`${workspaceOpen && !twoCol ? 'hidden' : ''} absolute bottom-0 left-0 right-0 chat-measure`}
            style={{ padding: isMobile ? 8 : 12, paddingBottom: 'max(var(--composer-gap), env(safe-area-inset-bottom, 0px))' }}
            onDragOver={(e) => { if (!dragCarriesFiles(e.dataTransfer)) return; e.preventDefault(); e.stopPropagation(); setFileDragOver(true); }}
            onDragLeave={(e) => { if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; setFileDragOver(false); }}
            onDrop={(e) => {
              if (!dragCarriesFiles(e.dataTransfer)) return;
              e.preventDefault(); e.stopPropagation();
              setFileDragOver(false);
              const files = filesFromDrop(e.dataTransfer);
              if (files.length) void uploadFiles(files);
            }}
            data-testid="task-thread-dropzone"
          >
            {task.status === 'review' && !task.assignedTopicId && !task.parentTaskId && (
              <p data-testid="task-comment-note-context" className="mb-1 px-1 text-mini text-app-text-secondary">
                {tr('board.task.unassignedNoteContext')}
              </p>
            )}
            {fileDragOver && (
              <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded border border-dashed border-emerald-400/60 bg-app-bg/70 text-mini text-emerald-300">
                {tr('board.task.dropToAttach')}
              </div>
            )}
            {/* The error of the last action, FIRST row of the decision zone:
                it sticks to the buttons that produced it (Approve, Land,
                the choices, the composer) and stays in the viewport as long as
                they do. At the top of the drawer it was true and invisible. */}
            {/* THE ACTION LANDED, THE REFRESH DID NOT. Every mutation here ends
                with `load()`, so when that read fails the server has already
                moved and the drawer is still drawing the row from before. Said
                next to the buttons, with the same retry: silence here reads as
                a button that did nothing. */}
            {task && loadFailedMessage && (
              <div
                data-testid="task-stale-warning"
                className="mb-2 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-mini text-amber-200"
              >
                <span className="min-w-0 flex-1 break-words">{tr('board.task.staleAfterAction', { reason: loadFailedMessage })}</span>
                <button
                  data-testid="task-stale-retry"
                  onClick={() => { void load(); }}
                  className="shrink-0 rounded px-1.5 py-0.5 text-amber-100 underline decoration-dotted hover:bg-white/10"
                >
                  {tr('board.task.loadRetry')}
                </button>
              </div>
            )}
            {error && (
              <div
                data-testid="task-action-error"
                className={`mb-2 flex items-start gap-2 rounded border border-red-500/30 px-2 py-1.5 text-mini ${STATUS_CHIP.danger}`}
              >
                <span className="min-w-0 flex-1 break-words">{error}</span>
                <button aria-label={tr('board.task.closeError')} onClick={() => setError(null)} className="tap-expand shrink-0 rounded p-0.5 hover:bg-white/10 coarse:p-1.5"><X className="h-3 w-3" /></button>
              </div>
            )}
            <BoardCommandHint
              text={draft}
              onOpenSession={onOpenTopic && canOpenTaskSession(sessionState) && task?.assignedTopicId ? () => onOpenTopic(task.assignedTopicId!) : undefined}
            />
            <div data-testid="task-composer" className={COMPOSER_CARD}>
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 p-2">
                {attachments.map((a) => (
                  <span key={a.path} className="group/att relative">
                    {a.isImage ? (
                      <ZoomableImage src={getMediaUrl(a.path)} alt={a.name} title={a.name} testId="task-composer-attachment-image" className="h-12 w-12 rounded object-cover" />
                    ) : (
                      <span className="flex max-w-[10rem] items-center gap-1 rounded bg-white/10 px-1.5 py-1 text-mini text-app-text-heading">
                        <Paperclip className="h-3 w-3 shrink-0" /><span className="truncate">{a.name}</span>
                      </span>
                    )}
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((p) => p.path !== a.path))}
                      title={tr('board.task.removeAttachmentTitle')}
                      className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-elevated p-0.5 text-app-text group-hover/att:block"
                    ><X className="h-2.5 w-2.5" /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-end p-1">
              <input ref={fileInputRef} type="file" multiple className="hidden"
                onChange={(e) => { if (e.target.files?.length) void uploadFiles(e.target.files); e.target.value = ''; }} />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
                title={tr('board.task.attachFileTitle')} aria-label={tr('board.task.attachFileTitle')}
                className={`flex ${COMPOSER_ICON_BUTTON} shrink-0 items-center justify-center rounded-lg text-app-text-secondary hover:bg-app-hover disabled:opacity-40`}>
                {uploading ? <Spinner size="md" tone="current" /> : <Paperclip className="h-4 w-4" />}
              </button>
              <textarea
                ref={commentRef}
                data-testid="task-reply-input"
                value={draft} onChange={(e) => {
                  // A responsive remount can precede the save effect. Preserve
                  // the edit in the local draft cache before that can happen;
                  // network persistence remains debounced by boardDrafts.
                  boardDrafts.putTaskDraft(taskId, e.target.value);
                  setDraft(e.target.value);
                  saveCommentCursor();
                }} rows={1}
                onSelect={saveCommentCursor} onKeyUp={saveCommentCursor} onClick={saveCommentCursor}
                onFocus={() => markActiveComposer(commentCursorKey)}
                aria-label={composerPlaceholder}
                placeholder={composerPlaceholder}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
                onPaste={(e) => {
                  const imgs = imagesFromClipboard(e.clipboardData);
                  if (imgs.length) { e.preventDefault(); void uploadFiles(imgs); }
                }}
                className={`${COMPOSER_TEXTAREA} ${isMobile ? 'text-title' : 'text-prose'}`}
                style={{ minHeight: 32, maxHeight: 140 }}
              />
              <DictationButton
                testId="task-thread-dictation"
                onText={(t) => setDraft((prev) => (prev ? `${prev} ${t}` : t))}
                onError={setError}
              />
              <button type="button" data-testid="task-composer-submit"
                onClick={() => { if (agentBusy && !draft.trim() && !attachments.length) void stopAgent(); else void send(); }}
                disabled={busy || sending || uploading || (!agentBusy && !draft.trim() && !attachments.length)}
                title={agentBusy && !draft.trim() && !attachments.length ? taskActionWord('stop', tr).title : isAgentReview ? tr('board.task.sendToAgent') : composerSendTitle}
                aria-label={agentBusy && !draft.trim() && !attachments.length ? taskActionWord('stop', tr).label : isAgentReview ? tr('board.task.sendToAgent') : composerSendTitle}
                className={`flex ${COMPOSER_ICON_BUTTON} shrink-0 items-center justify-center rounded-lg transition-all disabled:opacity-50 ${
                  draft.trim() || attachments.length ? 'bg-primary text-white hover:bg-primary-hover'
                    : agentBusy ? 'bg-app-text/15 text-app-text hover:bg-app-text/25'
                      : 'bg-transparent text-app-placeholder'
                }`}>
                {sending || busy ? <Spinner size="sm" tone="current" />
                  : agentBusy && !draft.trim() && !attachments.length ? <Square className="h-3.5 w-3.5 fill-current" />
                    : <ArrowUp className="h-4 w-4" />}
              </button>
            </div>
            </div>
            {/* Effort in force, under the field like the chat bar (card 067a1f5b). */}
            <div className="mt-1 flex items-center justify-end gap-2">
              <EffortBadge tier={shownEffort} overridden={!!(sessionTopic?.effort ?? task.effort)} testId="task-composer-effort-badge" />
              {isAgentReview && (
                <button type="button" onClick={() => void send({ quiet: true })}
                  disabled={busy || sending || uploading || (!draft.trim() && attachments.length === 0)}
                  title={tr('board.task.quietNoteTitle')} data-testid="task-reply-quiet-note"
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-compact leading-4 text-app-text-secondary hover:bg-app-hover disabled:opacity-50">
                  <StickyNote className="h-3.5 w-3.5" />{tr('board.task.quietNote')}
                </button>
              )}
            </div>
          </div>
</>
  );
}

export function ThreadRows({ details, agentBusy, answerOption, busy, children, commentReceipt, composerHeight, deliveryWord, detailsOpen, foldedDeliveryNotes, lastClientHeightRef, lastHeightRef, lastThreadComment, lastTopRef, openTaskPane, ownerName, pending, previewInThread, replyOptions, sending, sessionKey, sessionRuns, stickRef, task, threadContentRef, threadScrollRef, timeline, tr, uploading }: {
  details?: React.ReactNode;
  agentBusy: boolean;
  answerOption: (opt: string) => Promise<void>;
  busy: boolean;
  children: BoardTask[];
  commentReceipt: { id: string; delivery: TaskCommentAcknowledgement['delivery'] | 'saved'; } | null;
  composerHeight: number;
  deliveryWord: TaskComment | null;
  detailsOpen: boolean;
  foldedDeliveryNotes: Set<string>;
  lastClientHeightRef: RefObject<number>;
  lastHeightRef: RefObject<number>;
  lastThreadComment: TaskComment | null;
  lastTopRef: RefObject<number>;
  openTaskPane: (paneId: string) => boolean;
  ownerName: string | null;
  pending: { question: string; options: string[]; } | null;
  previewInThread: boolean;
  replyOptions: string[];
  sending: boolean;
  sessionKey: string | null;
  sessionRuns: { runs: Map<string, TaskSessionRunItem[]>; hidden: Set<string>; since: string | null | undefined; };
  stickRef: RefObject<boolean>;
  task: BoardTask | null;
  threadContentRef: RefObject<HTMLDivElement | null>;
  threadScrollRef: RefObject<HTMLDivElement | null>;
  timeline: TimelineItem[];
  tr: (key: string, vars?: Record<string, string | number>) => string;
  uploading: boolean;
}) {
    if (!task) return null;
    /**
     * ONE ROW OF THE CONVERSATION, whichever list it came from.
     *
     * The three shapes are not three styles of the same thing: a card comment
     * is a bubble with an author and a time, a step of the session is drawn by
     * the SAME `MessageContent` the topic chat uses (so a tool row, a question
     * form, a reasoning fold look and behave identically on both surfaces), and
     * a dispatcher envelope is one collapsed service line. What decides is
     * `source`, never the text.
     */
    const row = (item: TimelineItem, index: number) => {
      if (sessionRuns.hidden.has(item.id)) return null;
      const workRun = sessionRuns.runs.get(item.id);
      if (workRun) return <SessionRun key={item.id} items={workRun} sessionKey={sessionKey} />;
      if (item.source === 'comment') {
        const receipt = commentReceipt?.id === item.id ? commentReceipt.delivery : undefined;
        // Which of the two sources wins is a rule, and it lives in `chipKey.ts`
        // where a test can run it: the derivation is the authority, the receipt
        // speaks only where the derivation is silent or where the route moved
        // the words this instant.
        const chip = commentChip(item.delivery, receipt);
        const previous = timeline[index - 1];
        const continuation = !!item.comment.messageId && previous?.source === 'comment'
          && previous.comment.messageId === item.comment.messageId
          && previous.comment.author === item.comment.author
          && isThreadSpeech(previous.comment);
        if (foldedDeliveryNotes.has(item.id)) return (
          <details key={item.id} data-testid="task-delivery-note" className="group rounded border border-app-border-subtle">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-mini text-app-text-muted hover:text-app-text">
              <ChevronRight className="h-3 w-3 shrink-0 group-open:rotate-90" />
              <span className="shrink-0">{tr('board.task.deliveryNote')}</span>
              <span data-testid="task-delivery-note-preview" className="truncate text-app-text-secondary">{stripMarkdown(item.comment.content)}</span>
            </summary>
            <div data-testid="task-delivery-note-body" className="px-2 pb-2"><CommentBubble comment={item.comment} ownerName={ownerName} /></div>
          </details>
        );
        return (
          <div key={item.id} className="space-y-0.5">
            <CommentBubble
              comment={item.comment}
              ownerName={ownerName}
              continuation={continuation}
              resolvedParked={isResolvedParkedQuestion(item.comment, children)}
              historicalQuestion={!!parseQuestionBlock(item.comment.content) && (!pending || item.comment.id !== lastThreadComment?.id)}
              questionActions={pending && item.comment.id === lastThreadComment?.id ? (
                <div className="mt-2 flex flex-wrap gap-1.5" data-testid="task-question-options">
                  {replyOptions.map((opt) => (
                    <button key={opt} disabled={sending || busy || uploading}
                      onClick={() => void answerOption(opt)}
                      className="rounded border border-app-border bg-white/5 px-2.5 py-1.5 text-left text-compact leading-4 text-app-text hover:bg-white/10 disabled:opacity-50">
                      {stripMarkdown(opt)}
                    </button>
                  ))}
                </div>
              ) : undefined}
              onPreview={(p) => openTaskPane(mediaPaneIdFor(p))}
            />
            {/* WHERE YOUR MESSAGE GOT TO, derived from the envelopes at every
                read and never written into the thread (KANBAN-74). It sits
                under the person's own bubble, on their side. */}
            {chip && (
              <p
                data-testid={commentChipTestId(chip)}
                role={receipt ? 'status' : undefined}
                className="pr-1 text-right text-mini text-app-text-faint"
              >{tr(chip === 'note' ? 'board.task.noteSaved' : chip === 'saved' ? 'board.task.commentSaved'
                : chip === 'delivered' || chip === 'answered' ? 'board.task.delivered' : 'board.task.queuedForTurn')}</p>
            )}
          </div>
        );
      }
      if (item.envelope) return <DispatchEnvelopeRow key={item.id} messageId={item.msg.id} content={item.msg.content} />;
      // Typed into the topic itself, or a command's wake (`TaskSessionUserRow`).
      if (item.msg.role === 'user') return <TaskSessionUserRow key={item.id} message={item.msg} />;
      // Imported system/session notices remain readable too.
      return <SessionRun key={item.id} items={[{ ...item, foldProgress: false }]} sessionKey={sessionKey} />;
    };
    // Adjacent transitions share one centered event row.
    const statusRun = (items: TimelineItem[]) => (
      <StatusTrail
        comments={items.flatMap((i) => (i.source === 'comment' ? [i.comment] : []))}
        ownerName={ownerName}
      />
    );
    /**
     * WHAT FOLDS, and the guard that matters: a row of the SESSION never does.
     * The fold's rule was written for the thread's bookkeeping; run over a
     * transcript it would start classifying the agent's own steps, and a fold
     * that swallows the work is exactly the silent failure this projection
     * exists to avoid.
     */
    const folds = task.status === 'done' ? isDoneThreadService : isServiceComment;
    const isService = (item: TimelineItem) => item.source === 'comment' && folds(item);
    // The column keeps WORDS only: the dispatcher's chronicle (service notes,
    // transitions, envelopes, system lines) sits in the «Details» panel.
    const isChronicle = (item: TimelineItem) => isChronicleRow(item, { isService, hasQuestion: (c) => !!parseQuestionBlock(c) });
    const at = new Map(timeline.map((t, i) => [t.id, i]));
    const words = timeline.filter((t) => !isChronicle(t));
    const chronicle = timeline.filter(isChronicle);
    const wordRow = (item: TimelineItem) => row(item, at.get(item.id) ?? 0);
    const liveTool = liveToolRow(timeline);
    return (
      <div
        ref={threadScrollRef}
        data-testid="task-conversation-scroll"
        onScroll={() => {
          const el = threadScrollRef.current;
          if (!el) return;
          // Layout moves scrollTop by itself: when the thread re-wraps
          // taller on a resize, WebKit's anchor adjustment fires scroll
          // BEFORE any ResizeObserver re-pins. Growth the reader did not
          // scroll away from is not intent: it must not unstick the follow.
          const grew = el.scrollHeight > lastHeightRef.current;
          const movedUp = el.scrollTop < lastTopRef.current;
          const viewportResized = el.clientHeight !== lastClientHeightRef.current;
          if (followChoiceMayChange({ wasFollowing: stickRef.current, viewportResized, contentGrew: grew, movedUp })) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          lastTopRef.current = el.scrollTop;
          lastHeightRef.current = el.scrollHeight;
          lastClientHeightRef.current = el.clientHeight;
        }}
        className="min-h-0 flex-1 overflow-y-auto py-3"
        style={{
          paddingBottom: composerHeight + 24,
          maskImage: `linear-gradient(to bottom, #000 0, #000 calc(100% - ${composerHeight + 24}px), transparent calc(100% - ${composerHeight}px))`,
          WebkitMaskImage: `linear-gradient(to bottom, #000 0, #000 calc(100% - ${composerHeight + 24}px), transparent calc(100% - ${composerHeight}px))`,
        }}
      >
        <div ref={threadContentRef} className="chat-measure space-y-2 px-3">
        {details}
        {detailsOpen && chronicle.length > 0 && (
          <div data-testid="task-chronicle" className="rounded-md border border-app-border-subtle px-2 py-2">
            <div className="mb-1 text-mini font-medium uppercase tracking-wide text-app-text-muted">{tr('board.task.chronicle')} · {chronicle.length}</div>
            <div className="space-y-2">
              <ThreadRuns comments={chronicle} renderRow={wordRow} renderStatusRun={statusRun} isService={() => false} />
            </div>
          </div>
        )}
        {task.previewImage && !previewInThread && (
          <button type="button" data-testid="task-conversation-attachment" onClick={() => openTaskPane(mediaPaneIdFor(task.previewImage!))}
            className="flex w-full items-center gap-2 rounded border border-app-border px-2.5 py-2 text-left text-compact leading-4 text-app-text-secondary hover:bg-white/5 coarse:min-h-11">
            <Paperclip className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{task.previewImage.split('/').pop()}</span>
            <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
          </button>
        )}
        {/* THE EMPTY STATE SAYS WHAT WILL HAPPEN, not that it is empty. A plain
            "No comments" stated an absence that is already visible
            by itself; this line is the only place to say WHERE the delivery and
            the agent's questions will arrive, and whose move it is. It changes
            with the status, because a queued task and a backlog one wait for
            different things: the latter waits for you. The condition is now
            just the empty LIST: since the session lives in the same list, "has
            a topic" no longer says anything about what there is to read. */}
        {words.length === 0 && (
          <p data-testid="task-thread-empty" className="text-compact leading-4 text-app-text-muted">
            {tr(emptyThreadKey(task.status))}
          </p>
        )}
        {/* THE DELIVERY, PINNED, on a closed card. Whoever opens a done task
            without having followed the chat read four lines of land plumbing
            before finding what changed and why. The declared delivery is the
            one anchor the thread has; up here it is the first thing read. It is
            excluded from the list below, so it is painted once. */}
        {task.status === 'done' && deliveryWord && (
          <div data-testid="task-delivery-band" className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 pb-1 pt-1.5">
            <div className="mb-1 text-mini font-medium uppercase tracking-wide text-emerald-300">{tr('board.task.deliveryBand')}</div>
            <CommentBubble
              comment={deliveryWord}
              ownerName={ownerName}
              onPreview={(p) => openTaskPane(mediaPaneIdFor(p))}
            />
          </div>
        )}
        <ThreadRuns
          comments={words} renderRow={wordRow} renderStatusRun={statusRun}
          isService={() => false}
        />
        {/* THE LIVE ROW, at the tail: "how is it going" is asked where you
            write, and a composer with no sign of life above it reads as an
            agent that stopped. No preview any more, because the streaming row
            itself is right above this one now. */}
        {agentBusy && (
          <SessionLiveRow
            phase={task.dispatchState === 'queued' ? tr('board.task.dispatch.queued') : task.dispatchState === 'starting' ? tr('board.task.dispatch.starting') : tr('board.task.dispatch.working')}
            since={task.dispatchState === 'working' ? sessionRuns.since : null}
            tool={liveTool?.source === 'session' ? runningToolLabel(liveTool.msg) : null}
          />
        )}
        </div>
      </div>
    );
  }
