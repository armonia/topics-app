/**
 * Streaming spinners — canonical loading affordance for a row/tab.
 *
 * Two variants matching the StreamingContext shape:
 *   - <TopicStreamingSpinner topicId onStop? />   — single topic; optional
 *     stop affordance (a chat tab/sidebar row passes onStop so the user
 *     can interrupt the LLM stream from there).
 *   - <ProjectStreamingSpinner projectPath />     — aggregated; surfaces
 *     when ANY child of the project is producing output: a chat mid-stream
 *     (StreamingContext, works even before the window mounts) OR a non-chat
 *     child — terminal / browser / agent — reported by the mounted
 *     ProjectWindow into the projectActivity store. Read-only because
 *     stopping a specific inner stream requires drilling into that child.
 *
 * Used in: PaneTabBar (chat + project tabs), Sidebar/TopicItem,
 * Sidebar/TopicTree (project row). Don't roll your own — every surface
 * should report identically.
 *
 * Spinner is fixed at 12px (w-3/h-3). Tailwind JIT can't pick up arbitrary
 * sizes built from runtime template strings, and varying the size across
 * surfaces makes the affordance feel inconsistent anyway. If a future
 * surface really needs a different size, add a variant — don't take a
 * size prop.
 */

import { useTopicStreaming, useProjectStreaming, useTerminalStreaming } from '../../contexts/StreamingContext';
import { useProjectActivityLoading } from '../../state/projectActivity';

function SpinnerCircle() {
  return (
    <span className="inline-block w-3 h-3 border-[1.5px] border-primary border-t-transparent rounded-full animate-spin" />
  );
}

interface TopicSpinnerProps {
  topicId: string | undefined;
  /** Wrapper classes (margins, alignment). */
  className?: string;
  /**
   * When provided, the spinner becomes a stop button — hover swaps the
   * spinner for a stop glyph. Used by the chat-tab and sidebar-chat-row
   * surfaces where the user can interrupt the generation in place.
   */
  onStop?: () => void;
  /** Tooltip override. Defaults to "Stop generating" or "Streaming". */
  title?: string;
}

export function TopicStreamingSpinner({
  topicId,
  onStop,
  title,
  className = '',
}: TopicSpinnerProps) {
  const streaming = useTopicStreaming(topicId);
  if (!streaming) return null;
  const tip = title ?? (onStop ? 'Stop generating' : 'Streaming');
  if (onStop) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onStop(); }}
        className={`group/stop flex-shrink-0 w-4 h-4 inline-flex items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer ${className}`}
        title={tip}
        aria-label={tip}
      >
        <span className="group-hover/stop:hidden inline-flex">
          <SpinnerCircle />
        </span>
        <span className="hidden group-hover/stop:block w-[7px] h-[7px] bg-primary rounded-[1px]" />
      </button>
    );
  }
  return (
    <span className={`flex-shrink-0 inline-flex items-center ${className}`} title={tip} aria-label={tip}>
      <SpinnerCircle />
    </span>
  );
}

interface ProjectSpinnerProps {
  projectPath: string | undefined;
  className?: string;
  title?: string;
}

export function ProjectStreamingSpinner({
  projectPath,
  title,
  className = '',
}: ProjectSpinnerProps) {
  // Chat streams roll up via StreamingContext (topics carry projectPath);
  // non-chat children (terminal / browser / agent) roll up via the mounted
  // ProjectWindow into the projectActivity store. OR both so the project tab
  // pulses for any kind of child activity.
  const chatStreaming = useProjectStreaming(projectPath);
  const childLoading = useProjectActivityLoading(projectPath);
  if (!chatStreaming && !childLoading) return null;
  const tip = title ?? 'Una chat di questo progetto sta rispondendo';
  return (
    <span className={`flex-shrink-0 inline-flex items-center ${className}`} title={tip} aria-label={tip}>
      <SpinnerCircle />
    </span>
  );
}

interface TerminalSpinnerProps {
  sessionId: string | undefined;
  className?: string;
  title?: string;
}

/**
 * Terminal PTY-activity spinner. Read-only — there's no app-level "stop"
 * affordance for terminal output (Ctrl+C lives inside the terminal itself),
 * so we don't take an `onStop` like TopicStreamingSpinner does.
 */
export function TerminalStreamingSpinner({
  sessionId,
  title,
  className = '',
}: TerminalSpinnerProps) {
  const active = useTerminalStreaming(sessionId);
  if (!active) return null;
  const tip = title ?? 'Terminal is producing output';
  return (
    <span className={`flex-shrink-0 inline-flex items-center ${className}`} title={tip} aria-label={tip}>
      <SpinnerCircle />
    </span>
  );
}
