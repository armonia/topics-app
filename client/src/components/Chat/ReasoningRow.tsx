import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFindFocusThinking } from '../../state/chatFindFocus';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useDisclosureToggle } from './transcriptDisclosure';
import { DisclosureBody } from './DisclosureBody';
import { SparkLoader } from '../Layout/StreamingIndicator';
import { useT } from '../../hooks/useT';
import { applyReasoningTranslations, requestReasoningTranslation, useReasoningTranslationsVersion } from '../../state/reasoningTranslations';

interface Props {
  /** Raw thinking text. */
  content: string;
  /** Whether the thinking is still streaming — shows a subtle pulsing dot. */
  partial?: boolean;
  /** Closed once the reasoning is over; while it streams it stays open. */
  defaultCollapsed?: boolean;
  /** The message the reasoning belongs to, for the chat find bar. */
  messageId?: string;
}

/**
 * One inline reasoning row, the way the chat apps people know show it
 * (ChatGPT, Claude.ai, Cursor): OPEN while the model is thinking, with the
 * newest lines in view, and CLOSED on its own once the thinking is over.
 *
 * "Over" is the moment `partial` drops for this row: in the blocks timeline
 * that is when the next block (an answer, a tool) starts, so the body folds
 * while what follows is just being drawn and nothing already read moves.
 * It folds in one frame, with that block: the answer and the end of the turn
 * can arrive in the same read, and a fold still animating when the turn ends
 * would move the transcript after the end (chat-turn-end-still).
 * A press by the person wins over both automatic states.
 *
 * When the model reasons in another language than the chat, the server sends
 * the sentences translated and they replace the original ones in the same
 * window, sentence by sentence. A small «Original» control, laid over the empty
 * end of the header row, switches back; it adds no height and takes no space
 * from the row, so the end of the turn still moves nothing.
 */
export function ReasoningRow({ content, partial, defaultCollapsed = true, messageId }: Props) {
  const live = !!partial && content.length > 0;
  // null = nobody pressed: the row follows the thinking (open live, closed after).
  const [pressed, setPressed] = useState<boolean | null>(null);
  // The chat find bar landed on a word of this reasoning (CHAT-FIND-02): it
  // opens on that edge and stays open.
  const findSeq = useFindFocusThinking(messageId, content);
  const [seenFindSeq, setSeenFindSeq] = useState(0);
  if (findSeq !== 0 && findSeq !== seenFindSeq) {
    setSeenFindSeq(findSeq);
    setPressed(true);
  }
  const collapsed = pressed === null ? (live ? false : defaultCollapsed) : !pressed;
  const tr = useT();
  // Subscribes the row: it draws again whenever a sentence is translated.
  const translationsVersion = useReasoningTranslationsVersion();
  const [showOriginal, setShowOriginal] = useState(false);
  const translated = applyReasoningTranslations(content);
  const hasTranslation = translated.count > 0;
  // A settled block that a person opens is translated on demand; the live one
  // gets its sentences from the stream as they close.
  useEffect(() => {
    if (!collapsed && !live && content) void requestReasoningTranslation(content);
  }, [collapsed, live, content]);
  const bodyRef = useRef<HTMLDivElement>(null);
  // While live the body is a short window that follows the newest line.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (live && pressed === null && el) el.scrollTop = el.scrollHeight;
  }, [content, live, pressed, translationsVersion]);
  const disclose = useDisclosureToggle();
  // A partial turn that has entered reasoning keeps its row (count 0) from the
  // start, so the row is already in its final place when the text arrives.
  if (!content && !partial) return null;
  const length = content.length;

  return (
    <div data-testid="reasoning-row" className="relative text-compact">
      <button
        type="button"
        onClick={(e) => { disclose(e.currentTarget); setPressed(collapsed); }}
        aria-expanded={!collapsed}
        className="group/reasoning w-full flex items-center gap-2 py-1 text-left text-app-text-secondary hover:text-app-text transition-colors"
      >
        <Brain size={13} className="text-purple-500 flex-shrink-0" />
        <span className="text-app-text">Thinking</span>
        <span className="text-mini text-app-text-muted">({length.toLocaleString()} chars)</span>
        {/* The chevron sits at the end of the row, on hover and focus only: no column
            reserved on the left, so the row starts flush with the text. */}
        {collapsed ? <ChevronRight size={12} aria-hidden="true" className="flex-shrink-0 text-app-text-muted opacity-0 transition-opacity group-hover/reasoning:opacity-100 group-focus-visible/reasoning:opacity-100 coarse:opacity-100" /> : <ChevronDown size={12} aria-hidden="true" className="flex-shrink-0 text-app-text-muted opacity-0 transition-opacity group-hover/reasoning:opacity-100 group-focus-visible/reasoning:opacity-100 coarse:opacity-100" />}
        {partial && (
          <SparkLoader className="ml-auto flex-shrink-0" activity="think" />
        )}
      </button>
      {hasTranslation && (
        // Laid over the end of the header row, which is empty there (the spinner
        // sits at the very end, so the control stops short of it): no space is
        // taken from the row and its height never changes.
        <button
          type="button"
          data-testid="reasoning-original-toggle"
          aria-pressed={showOriginal}
          title={showOriginal ? tr('reasoning.showTranslatedTitle') : tr('reasoning.showOriginalTitle')}
          onClick={() => setShowOriginal((v) => !v)}
          className="absolute right-7 top-1 text-mini text-app-text-muted hover:text-app-text underline-offset-2 hover:underline transition-colors"
        >
          {showOriginal ? tr('reasoning.showTranslated') : tr('reasoning.showOriginal')}
        </button>
      )}
      <DisclosureBody open={!collapsed} instantClose={pressed === null} className="ml-1.5 pb-1.5">
        {/* Prose, not code: the thinking is sentences, in the reading font,
            muted and set off by a rule on the left. */}
        <div
          ref={bodyRef}
          data-testid="reasoning-body"
          data-translated={hasTranslation && !showOriginal ? 'true' : undefined}
          className={`text-compact text-app-text-muted whitespace-pre-wrap break-words leading-relaxed border-l-2 border-app-border pl-3 overflow-auto ${live && pressed === null ? 'max-h-32' : 'max-h-96'}`}
        >
          {/* Summarized thinking always ends in blank lines; under pre-wrap
              they would draw empty space below the last sentence. */}
          {(hasTranslation && !showOriginal ? translated.text : content).trimEnd()}
        </div>
      </DisclosureBody>
    </div>
  );
}
