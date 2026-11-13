import { useT } from '../../hooks/useT';
import { getMediaUrl } from '../../lib/api';
import { parseQuestionBlock, type TaskStatus, type TaskComment, STATUS_LABEL, TASK_STATUSES, commentAuthorLabel, parseStatusEvent } from '../../lib/board';
import { ChevronRight, Bot, Paperclip, Camera, ExternalLink } from 'lucide-react';
import { StatusIcon } from './atoms';
import { ChatMarkdown } from '../ChatMarkdown';
import { COMPACT_MD_CLS, type TaskSurface } from './constants';
import { isFreshSessionNote } from '../../../../shared/task-comment-service';
import { stripMarkdown } from '../../lib/stripMarkdown';
import { ZoomableImage } from '../Shared/ImageLightbox';
import { actionOriginDisplay, authorDisplay } from '../../lib/authorDisplay';
import { PlanSurface } from './PlanSurface';
import { isImagePath, isPdfPath, isVideoPath } from '../../lib/mediaKind';
import { questionToProse } from '../../../../shared/question-prose';
import { openLink, isExternalLinkGesture } from '../../lib/openLink';
import { commentTime } from './format';

/**
 * Renders one LIGHT task surface full-height (media viewer / plan). The browser
 * group is NOT handled here — it renders through the app's real GroupLayout
 * engine (see useTaskBrowserGroupLayout), placed directly by TaskDetail. The
 * caller places this inside a flex-col so flex-1 children fill.
 */
export function SurfaceContent({ surface, taskId }: { surface: TaskSurface; taskId?: string }) {
  void taskId;
  if (surface.kind === 'media') return <MediaViewer key={surface.url} url={surface.url} path={surface.path} />;
  if (surface.kind === 'browser') return null; // handled by GroupLayout in TaskDetail
  // The fence is NOT the plan. The treatment lives in `PlanSurface`, in a file
  // of its own, because this one does not mount in a unit test.
  return <PlanSurface content={surface.content} />;
}

/**
 * Viewer for OUR /api/media files (allowlisted attachments): image inline,
 * PDF in a NON-sandboxed frame — the sandbox blocks WKWebView's native PDF
 * viewer (blank white pane). These are static files this server serves, not
 * agent-controlled web pages: the URL-sandbox rationale doesn't apply.
 */
export function MediaViewer({ url, path }: { url: string; path: string }) {
  const tr = useT();
  const isImg = isImagePath(path);
  const isPdf = isPdfPath(path);
  // A review clip is a first-class artifact, like the screenshot: it used to
  // fall into the "No preview for this file type" branch and you had to leave
  // the app to watch it. Controls yes (so you can scrub), no autoplay: you opened the tab
  // yourself, so it starts when you want it to.
  if (isVideoPath(path)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-app-inset p-3">
        <video src={url} controls playsInline preload="metadata" className="max-h-full max-w-full rounded" />
      </div>
    );
  }
  if (isImg) {
    return (
      <div className="min-h-0 flex-1 overflow-auto bg-app-inset p-3">
        <img src={url} alt="" className="mx-auto max-w-full rounded" />
      </div>
    );
  }
  if (isPdf) {
    return <iframe src={url} title={tr('board.task.pdfPreviewTitle')} className="min-h-0 w-full flex-1 border-0 bg-white" />;
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-body-lg leading-5 text-app-text-secondary">{tr('board.task.noPreviewForType')}</p>
      <button
        onClick={(e) => openLink(url, { external: isExternalLinkGesture(e), origin: e.target })}
        className="flex items-center gap-1 rounded bg-white/10 px-2.5 py-1.5 text-compact leading-4 text-app-text hover:bg-white/20"
      ><ExternalLink className="h-3.5 w-3.5" /> {tr('board.task.openInBrowser')}</button>
    </div>
  );
}

/**
 * Attachments of a thread message: images inline, other files as name chips.
 * Served through the allowlist-gated /api/media, exactly like chat message
 * media.
 *
 * AN IMAGE OPENS THE LIGHTBOX, the same one the chat opens (card 058ea722,
 * 03/09: "I attached to the task, and it does not show me the preview when I
 * click on it"). It used to open a workspace TAB through `onPreview`, which
 * needs the drawer's tab group to be mounted and reads as nothing happening
 * when it is not, and outside the drawer fell back to the system browser. A
 * tab is still one click away in the "Delivered files" list; a click on the
 * picture means "let me see it", and that is what it does everywhere now.
 * `onPreview` keeps serving the non-image chips (a PDF, a video, a log).
 */
export function MediaStrip({ media, onPreview }: { media?: string[]; onPreview?: (path: string) => void }) {
  const tr = useT();
  if (!media || media.length === 0) return null;
  const isImg = (p: string) => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(p);
  // In-app preview when the host provides it (drawer → output panel): a
  // target=_blank anchor is a silent no-op inside the Tauri WKWebView.
  const open = (e: React.MouseEvent, p: string) => {
    e.preventDefault();
    if (onPreview) onPreview(p);
    // A tab of the Topics browser, not the system one: target=_blank is dead in
    // WKWebView, and an attachment is something you look at without leaving.
    else openLink(getMediaUrl(p), { external: isExternalLinkGesture(e), origin: e.target });
  };
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {media.map((p) => isImg(p) ? (
        <ZoomableImage key={p} src={getMediaUrl(p)} alt={p.split('/').pop() ?? ''} title={p.split('/').pop()} testId="task-media-image" className="max-h-40 max-w-full rounded-md object-contain" />
      ) : (
        <a
          key={p} href={getMediaUrl(p)} target="_blank" rel="noreferrer" onClick={(e) => open(e, p)}
          title={onPreview ? tr('task.media.preview') : p.split('/').pop()}
          className="flex max-w-[14rem] items-center gap-1.5 rounded-md bg-white/10 px-2 py-1.5 text-compact leading-4 text-app-text hover:bg-white/20"
        ><Paperclip className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{p.split('/').pop()}</span></a>
      ))}
    </div>
  );
}

/**
 * A status change: a CHIP, not a paragraph.
 *
 * It used to be a row as wide as the thread just to say that a card changed
 * column, and on the live database that is 4406 rows out of 9973: half of the
 * wall that makes a card opened for a decision unreadable. The fact stays (the
 * history of a reopened card is the one thing nobody can reconstruct), but it
 * takes up only what it is worth: a chip that is read at a glance, leaving the
 * rest under the mouse.
 *
 * WHAT GOES ON SCREEN AND WHAT GOES IN THE TOOLTIP, and it is not a preference:
 *  · the DESTINATION always: it is the fact;
 *  · the REASON always when there is one: it is the why, and without the fact
 *    it is mute;
 *  · WHO moved the card **only when it was not the app**. A thread in which
 *    every row is signed «Topics» has stopped saying anything: the name matters
 *    again precisely because it appears only when a person is behind it;
 *  · time, full identity and the raw transition text: in the `title`.
 */
function StatusChip({ comment, ownerName }: { comment: TaskComment; ownerName: string | null }) {
  const tr = useT();
  // The same parser as the server: the destination is read up to the separator,
  // otherwise a transition with its reason (`done→in_progress · the land
  // conflicted`) loses the icon and is printed raw.
  const ev = parseStatusEvent(comment.content);
  const to = ev?.to as TaskStatus | undefined;
  const valid = !!to && TASK_STATUSES.includes(to);
  const at = new Date(comment.createdAt);
  const who = authorDisplay(commentAuthorLabel(comment.author), tr, ownerName, { personName: comment.actorPersonName, deviceName: comment.actorDeviceName }, comment.origin);
  const origin = actionOriginDisplay(comment.origin, tr);
  const shownOrigin = who.kind === 'user' && !who.self ? null : origin;
  // The app moving a card by itself is not news: the name stays only for
  // whoever is news (you, an agent, the verification).
  const mover = who.kind === 'system' || who.kind === 'dispatcher' ? null : who.name;
  return (
    <span
      className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1 px-1.5 py-0.5 text-mini text-app-text-muted"
      title={`${who.name} (${who.detail})${shownOrigin ? ` · ${shownOrigin}` : ''} · ${comment.content} · ${at.toLocaleString('it-IT')}`}
      data-testid="task-status-event"
    >
      {valid ? <StatusIcon status={to} /> : <span className="h-1 w-1 shrink-0 rounded-full bg-app-text-faint" />}
      {mover && <span className="shrink-0 text-app-text-secondary">{mover}</span>}
      {shownOrigin && <span className="shrink-0 text-app-text-faint">{shownOrigin}</span>}
      {mover && <span className="shrink-0 text-app-text-secondary">→</span>}
      <span className="shrink-0">{valid ? STATUS_LABEL[to] : comment.content}</span>
      {/* Reasons wrap so touch users can read them without a tooltip. */}
      {valid && ev?.reason && <span className="min-w-0 break-words text-app-text-secondary">· {ev.reason}</span>}
    </span>
  );
}

/**
 * ADJACENT status changes, in a single strip.
 *
 * `todo → in_progress → review` are three consecutive facts that say one thing,
 * and vertically they were three rows. Horizontally they are the trail they
 * are, and the time of the last one closes the strip: the others live in the
 * tooltips, where they help whoever needs an exact moment, not whoever is
 * scrolling.
 */
export function StatusTrail({ comments, ownerName }: { comments: TaskComment[]; ownerName: string | null }) {
  const tr = useT();
  const last = comments[comments.length - 1];
  if (!last) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-1 px-1 py-1 text-center"
      data-testid="task-status-trail"
      aria-label={tr('board.task.statusTrail')}
    >
      {comments.map((c) => <StatusChip key={c.id} comment={c} ownerName={ownerName} />)}
      <span className="shrink-0 text-mini text-app-text-faint">
        {new Date(last.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  );
}

export function CommentBubble({ comment, ownerName = null, resolvedParked = false, onPreview, questionActions, historicalQuestion = false, continuation = false }: {
  comment: TaskComment;
  /** The name of whoever uses the app: YOUR rows are signed with your name. */
  ownerName?: string | null;
  /**
   * This row is the question about parked subtasks, and the subtasks have
   * since moved. It stays in the history (it happened) but stops taking the
   * space of a decision: no frame, no list of exits, just a chip like the other
   * service rows. The caller decides, since it has the children at hand.
   */
  resolvedParked?: boolean;
  onPreview?: (path: string) => void;
  questionActions?: React.ReactNode;
  historicalQuestion?: boolean;
  continuation?: boolean;
}) {
  const tr = useT();
  const origin = actionOriginDisplay(comment.origin, tr);
  // Machine-authored review evidence (live-preview screenshot from the verifier).
  // Distinct from human/agent speech: it never woke the agent, it just informs.
  //
  // NO BOX. It used to be a green bordered card inside a thread of bare
  // paragraphs, and the box promised standalone content that is not there: it
  // is a row like the others, written by a different hand. The only thing that
  // really sets it apart stays (WHO wrote it), on the same header line as every
  // other message, in green.
  if (comment.kind === 'review-note') {
    return (
      <div className="pr-8">
        <p className="flex items-center gap-1 text-mini font-medium uppercase tracking-wide text-emerald-400/80">
          <Camera size={11} /> {tr('board.task.reviewPreview')}
          {origin && <span className="normal-case tracking-normal text-app-text-faint">{origin}</span>}
          <span className="ml-auto normal-case tracking-normal text-app-text-faint">{commentTime(comment.createdAt)}</span>
        </p>
        <div className="text-body-lg leading-5 text-app-text"><CommentBody content={comment.content} /></div>
        <MediaStrip media={comment.media} onPreview={onPreview} />
      </div>
    );
  }
  const who = authorDisplay(commentAuthorLabel(comment.author), tr, ownerName, { personName: comment.actorPersonName, deviceName: comment.actorDeviceName }, comment.origin);
  // A 'user' row from the API/MCP is already named by `authorDisplay` ("via API"); the origin chip would say it twice.
  const shownOrigin = who.kind === 'user' && !who.self ? null : origin;
  const app = who.kind === 'system' || who.kind === 'dispatcher';
  /**
   * AN APP ROW IS A CHIP, not a paragraph with a header above it.
   *
   * «Mergiato su main (commit 4f1a2b).» (an example app message: "Merged into
   * main") is a one-line fact, and it used to take three: the name of the
   * speaker, the text, the time. On a card that has been worked on that is ten
   * such rows, and it is half of the "packed with situational messages"
   * complaint. The criterion is ONE LINE, not a length judged by eye: the same
   * boundary that `task-comment-service.ts` already uses for the delivery note,
   * and for the same reason: when the app reports the agent's recovered words
   * it puts them after a blank line, and those words are often the only thing
   * the agent said. Multi-line stays prose, always.
   */
  // (`review-note` has already returned above, with its green header.)
  // An already resolved question drops to the same rank: it is a fact that
  // happened, not something to decide. The `question` block is multi-line
  // because of the fences, so it would not pass the test above, but what is
  // left to read is a single sentence, and that is what the chip shows.
  const oneLiner = app && (resolvedParked || (!parseQuestionBlock(comment.content) && !/[\n\r]/.test(comment.content.trim())));
  if (oneLiner) {
    return (
      <div
        className="mx-auto flex w-fit max-w-full items-center justify-center gap-1.5 px-1.5 py-0.5 text-center text-mini text-app-text-muted"
        data-testid="task-app-note"
        title={`${who.name} (${who.detail})${shownOrigin ? ` · ${shownOrigin}` : ''} · ${comment.content} · ${new Date(comment.createdAt).toLocaleString('it-IT')}`}
      >
        <Bot className="h-3 w-3 shrink-0" />
        {shownOrigin && <span className="shrink-0 text-app-text-faint">{shownOrigin}</span>}
        <span className="min-w-0 break-words">{isFreshSessionNote(comment) ? tr('board.task.freshSessionQueued') : parseQuestionBlock(comment.content)?.question ?? comment.content}</span>
        <span className="ml-auto shrink-0 text-app-text-faint">{commentTime(comment.createdAt)}</span>
      </div>
    );
  }
  if (!who.self) {
    // WHO SPOKE IS WRITTEN OUT, not hung on a tooltip. The only place the name
    // used to appear was the `title`, so an agent row and an app row read the
    // same and the difference was found with the mouse. On a thread that mixes
    // four voices it is the difference you need first.
    return (
      <div className="pr-8">
        {(!continuation || app) && <p className="flex items-baseline gap-1.5 text-mini" title={who.detail}>
          <span className={`font-medium uppercase tracking-wide ${app ? 'text-app-text-faint' : 'text-app-text-secondary'}`}>{who.name}</span>
          {shownOrigin && <span className="text-app-text-faint">{shownOrigin}</span>}
          <span className="ml-auto text-app-text-faint">{commentTime(comment.createdAt)}</span>
        </p>}
        <div className={`text-body-lg leading-5 ${app ? 'text-app-text-muted' : 'text-app-text'}`}>
          <CommentBody content={comment.content} questionActions={questionActions} historicalQuestion={historicalQuestion} />
        </div>
        <MediaStrip media={comment.media} onPreview={onPreview} />
      </div>
    );
  }
  // The bubble for what YOU write: the same grey as the chat
  // (`bg-app-user-bubble` + the `user-bubble` class that restyles code and
  // links), not the previous light blue. In this app blue is the accent for
  // ACTIONS, and a message is not an action: two surfaces saying the same thing
  // in two different colors were the reason the drawer "did not look like the
  // app".
  return (
    <div className="flex justify-end">
      <div className="user-bubble max-w-[88%] rounded-lg bg-app-user-bubble px-2.5 py-1.5 text-body-lg leading-5 text-app-text">
        <CommentBody content={comment.content} />
        <MediaStrip media={comment.media} onPreview={onPreview} />
        <p className="mt-0.5 text-right text-mini text-app-text-muted" title={who.detail}>
          {who.name}{shownOrigin ? ` · ${shownOrigin}` : ''} · {commentTime(comment.createdAt)}
        </p>
      </div>
    </div>
  );
}

/**
 * Current questions carry their answer buttons in the conversation. Historical
 * questions disclose their original Markdown and options without active actions.
 */
export function CommentBody({ content, questionActions, historicalQuestion = false }: { content: string; questionActions?: React.ReactNode; historicalQuestion?: boolean }) {
  const q = parseQuestionBlock(content);
  // A fence that does NOT parse (opened and never closed, empty body) would
  // arrive here as is, and for the renderer ```…``` is a code block: prose in
  // `whitespace-pre`, i.e. horizontal scroll. `questionToProse` is a no-op on
  // everything else. See `shared/question-prose.ts`.
  if (!q) return <div className={`mt-0.5 text-app-text ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{questionToProse(content)}</ChatMarkdown></div>;
  const outside = content.replace(/```question[\s\S]*?```/, '').trim();
  const options = q.options.length > 0 ? (
    <ul className="mt-1 space-y-0.5">
      {q.options.map((opt, i) => (
        <li key={i} className="flex items-start gap-1.5 text-compact leading-4 text-app-text-secondary">
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-app-text-muted" />
          <span className={`min-w-0 flex-1 ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{opt}</ChatMarkdown></span>
        </li>
      ))}
    </ul>
  ) : null;
  return (
    <div className="mt-0.5 space-y-1">
      {outside && <div className={`text-app-text ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{outside}</ChatMarkdown></div>}
      {/* The question and its options go through the SAME markdown renderer as
          the rest of the thread. They were the only two strings printed raw, and
          the agent writes them like everything else: `**Opus**`, `` `--flag` ``
          and the backticks around a path showed up here as literal characters. */}
      {historicalQuestion ? (
        <details className="group text-app-text-secondary" data-testid="task-past-question">
          <summary className="flex cursor-pointer list-none items-start gap-1.5 py-1 text-body-lg leading-5 hover:text-app-text">
            <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 group-open:rotate-90" />
            <span>{stripMarkdown(q.question)}</span>
          </summary>
          <div className={`pl-5 ${COMPACT_MD_CLS}`}><ChatMarkdown components={{}}>{q.question}</ChatMarkdown>{options}</div>
        </details>
      ) : <div className="rounded border border-app-border bg-white/[0.02] px-2.5 py-2">
        <div className={`text-prose leading-snug text-app-text ${COMPACT_MD_CLS}`}>
          <ChatMarkdown components={{}}>{q.question}</ChatMarkdown>
        </div>
        {questionActions ?? options}
      </div>}
    </div>
  );
}

