import { useState } from 'react';
import { useFindFocusThinking } from '../../state/chatFindFocus';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useDisclosureToggle } from './transcriptDisclosure';
import { DisclosureBody } from './DisclosureBody';

interface Props {
  /** Raw thinking text. */
  content: string;
  /** Whether the thinking is still streaming — shows a subtle pulsing dot. */
  partial?: boolean;
  /** Default to collapsed; the row mirrors the tool-call row visually. */
  defaultCollapsed?: boolean;
  /** The message the reasoning belongs to, for the chat find bar. */
  messageId?: string;
}

/**
 * One inline reasoning row. Same shape as `ToolCallRow` so a stack of mixed
 * tool/reasoning entries reads as a single coherent list. Click to expand
 * the thinking text underneath.
 */
export function ReasoningRow({ content, partial, defaultCollapsed = true, messageId }: Props) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // The chat find bar landed on a word of this reasoning (CHAT-FIND-02): it
  // opens on that edge and stays open.
  const findSeq = useFindFocusThinking(messageId, content);
  const [seenFindSeq, setSeenFindSeq] = useState(0);
  if (findSeq !== 0 && findSeq !== seenFindSeq) {
    setSeenFindSeq(findSeq);
    setCollapsed(false);
  }
  const disclose = useDisclosureToggle();
  if (!content) return null;
  const length = content.length;

  return (
    <div data-testid="reasoning-row" className="text-compact">
      <button
        type="button"
        onClick={(e) => { disclose(e.currentTarget); setCollapsed((v) => !v); }}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-2 py-1 text-left text-app-text-secondary hover:text-app-text transition-colors"
      >
        {collapsed ? <ChevronRight size={12} className="text-app-text-muted flex-shrink-0" /> : <ChevronDown size={12} className="text-app-text-muted flex-shrink-0" />}
        <Brain size={13} className="text-purple-500 flex-shrink-0" />
        <span className="text-app-text">Reasoning</span>
        <span className="text-mini text-app-text-muted">({length.toLocaleString()} chars)</span>
        {partial && (
          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse flex-shrink-0" />
        )}
      </button>
      <DisclosureBody open={!collapsed} className="ml-5 pb-1.5">
        <pre className="text-mini font-mono text-app-text-secondary whitespace-pre-wrap leading-relaxed bg-app-hover/40 rounded px-2 py-1.5 max-h-72 overflow-auto">
          {content}
        </pre>
      </DisclosureBody>
    </div>
  );
}
