import { useLayoutEffect, useRef, useState } from 'react';
import { useFindFocusThinking } from '../../state/chatFindFocus';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useDisclosureToggle } from './transcriptDisclosure';
import { DisclosureBody } from './DisclosureBody';
import { SparkLoader } from '../Layout/StreamingIndicator';

interface Props {
  /** Raw thinking text. */
  content: string;
  /** Whether the thinking is still streaming — shows a subtle pulsing dot. */
  partial?: boolean;
  /** Closed once the reasoning is over; while it streams it stays open. */
  defaultCollapsed?: boolean;
  /** The message the reasoning belongs to, for the chat find bar. */
  messageId?: string;
  /**
   * Whether the message this row belongs to is still live. When it already
   * isn't, by the time `partial` drops for this row the turn itself has
   * already ended — closing then must not animate (CHAT-TURN-END): nothing
   * may move after the loader is gone.
   */
  turnLive?: boolean;
}

/**
 * One inline reasoning row, the way the chat apps people know show it
 * (ChatGPT, Claude.ai, Cursor): OPEN while the model is thinking, with the
 * newest lines in view, and CLOSED on its own once the thinking is over.
 *
 * "Over" is the moment `partial` drops for this row: in the blocks timeline
 * that is when the next block (an answer, a tool) starts, so the body folds
 * while what follows is just being drawn and nothing already read moves.
 * A press by the person wins over both automatic states.
 */
export function ReasoningRow({ content, partial, defaultCollapsed = true, messageId, turnLive = true }: Props) {
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
  // Only the automatic close that lands with the turn already over skips the
  // animation; a press by the person always gets the normal slide.
  const instantClose = pressed === null && !turnLive;
  const bodyRef = useRef<HTMLDivElement>(null);
  // While live the body is a short window that follows the newest line.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (live && pressed === null && el) el.scrollTop = el.scrollHeight;
  }, [content, live, pressed]);
  const disclose = useDisclosureToggle();
  // A partial turn that has entered reasoning keeps its row (count 0) from the
  // start, so the row is already in its final place when the text arrives.
  if (!content && !partial) return null;
  const length = content.length;

  return (
    <div data-testid="reasoning-row" className="text-compact">
      <button
        type="button"
        onClick={(e) => { disclose(e.currentTarget); setPressed(collapsed); }}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-2 py-1 text-left text-app-text-secondary hover:text-app-text transition-colors"
      >
        {collapsed ? <ChevronRight size={12} className="text-app-text-muted flex-shrink-0" /> : <ChevronDown size={12} className="text-app-text-muted flex-shrink-0" />}
        <Brain size={13} className="text-purple-500 flex-shrink-0" />
        <span className="text-app-text">Reasoning</span>
        <span className="text-mini text-app-text-muted">({length.toLocaleString()} chars)</span>
        {partial && (
          <SparkLoader className="ml-auto flex-shrink-0" activity="think" />
        )}
      </button>
      <DisclosureBody open={!collapsed} className="ml-1.5 pb-1.5" instant={instantClose}>
        {/* Prose, not code: the thinking is sentences, in the reading font,
            muted and set off by a rule on the left. */}
        <div
          ref={bodyRef}
          data-testid="reasoning-body"
          className={`text-compact text-app-text-muted whitespace-pre-wrap break-words leading-relaxed border-l-2 border-app-border pl-3 overflow-auto ${live && pressed === null ? 'max-h-32' : 'max-h-96'}`}
        >
          {content}
        </div>
      </DisclosureBody>
    </div>
  );
}
