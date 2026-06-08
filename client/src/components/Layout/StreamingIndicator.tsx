/**
 * Streaming indicators — the canonical "working now" affordance for a row/tab,
 * rendered as a 3×3 grid of squares lit by a diagonal wave (see GridLoader),
 * NOT a rotating ring or a row of dots. A spinner reads as "blocking / fetching
 * a resource"; the rippling matrix reads as "alive, computing" — the right
 * metaphor for an LLM turn or a busy pty.
 *
 * Every variant renders through ONE wrapper (LoaderSlot), so the loader is
 * pixel-identical across surfaces — a project (parent) tab and its chat /
 * terminal (children) tabs line up exactly, instead of drifting because one was
 * a bare span and another a button. The slot is a fixed 16px box; vary it only
 * via an explicit `size` (the sidebar chat row wants a bigger hit target).
 *
 * Variants, matching the StreamingContext shape:
 *   - <TopicStreamingSpinner topicId onStop? />   — single topic; optional
 *     stop affordance (a chat tab/sidebar row passes onStop so the user can
 *     interrupt the LLM stream in place — on hover the grid swaps for a stop
 *     glyph).
 *   - <ProjectStreamingSpinner projectPath />     — aggregated; surfaces when
 *     ANY child of the project is producing output: a chat mid-stream
 *     (StreamingContext, works even before the window mounts) OR a non-chat
 *     child — terminal / browser / agent — reported by the mounted
 *     ProjectWindow into the projectActivity store. Read-only because stopping
 *     a specific inner stream requires drilling into that child.
 *   - Terminal / Browser / Agent variants — read-only, same look.
 *
 * Used in: PaneTabBar (chat / project / terminal / browser / agents tabs) and
 * Sidebar/TopicTree (project, terminal, browser rows). Sidebar/TopicItem reads
 * the same useTopicLoading signal but renders its own larger stop-button hit
 * target for the chat row (still the GridLoader glyph). Don't roll your own off
 * a DIFFERENT signal or a different glyph — every surface must report from the
 * same loading facade and the same component so they can't drift.
 */

import { useTopicLoading, useProjectLoading, useTerminalLoading, useBrowserLoading, useAnyAgentActive } from '../../state/signals';

/**
 * The vertical 2-column × 3-row square matrix, drawn with the SAME grammar as
 * SplitMiniMap so the two glyphs read as one family: identical cell radius
 * (1.5px), identical gap (1.5px), and unlit cells painted the exact "deactivated
 * pane" wash of the mini-map (`currentColor 22%`, theme-inverting). Each cell is
 * two layers — a quiet neutral base frame that's always present, plus a lit
 * OVERLAY carrying the primary-blue "sfumatura dentro" (an internal gradient).
 * Exactly one overlay is lit at a time and the lit cell TRAVELS
 * column-by-column, top→bottom — each cell's `animation-delay` is its slot in
 * that path × one slot (the `.animate-grid-lit` keyframe in index.css pops the
 * overlay on, then snaps it off, revealing the neutral base). Reads as cells
 * activating one by one, not a soft collective fade. Opacity-only → no layout
 * reflow when it mounts. The blue stays the loading accent; only the unlit frame
 * went neutral to match the mini-map.
 */
// Grid auto-flows row-major (2 cols), so DOM children are [r0c0, r0c1, r1c0,
// r1c1, r2c0, r2c1]. We want the lit cell to descend column 0 (r0→r1→r2) then
// column 1, so each child's slot in that vertical path is:
//   r0c0→0  r0c1→3  r1c0→1  r1c1→4  r2c0→2  r2c1→5
const SEQ_ORDER = [0, 3, 1, 4, 2, 5];
const SLOT_MS = 183; // ≈ 1100ms cycle / 6 cells

// The "lit" tile's internal gradient (sfumatura dentro): a light-blue sheen at
// the top-left easing into the primary and a touch deeper at the bottom-right,
// so a lit cell reads as a glossy tile rather than a flat fill.
const LIT_GRADIENT =
  'linear-gradient(150deg, color-mix(in srgb, var(--primary) 72%, #fff) 0%, var(--primary) 58%, color-mix(in srgb, var(--primary) 82%, #000) 100%)';
// The unlit frame: the exact wash a deactivated SplitMiniMap pane uses, so the
// two glyphs share their quiet colour and invert together with the theme.
const UNLIT_WASH = 'color-mix(in srgb, currentColor 22%, transparent)';

export function GridLoader({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-grid ${className}`}
      style={{ gridTemplateColumns: 'repeat(2, 3px)', gap: 1.5, width: 7.5, height: 12 }}
      aria-hidden="true"
    >
      {SEQ_ORDER.map((slot, i) => (
        <span
          key={i}
          style={{
            position: 'relative',
            width: 3,
            height: 3,
            borderRadius: 1.5,
            overflow: 'hidden',
            background: UNLIT_WASH,
          }}
        >
          <span
            className="animate-grid-lit"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 'inherit',
              background: LIT_GRADIENT,
              animationDelay: `${slot * SLOT_MS}ms`,
            }}
          />
        </span>
      ))}
    </span>
  );
}

/** Filled stop square shown on hover in place of the loader. */
function StopGlyph({ size = 7, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`bg-primary rounded-[1px] ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

interface LoaderSlotProps {
  /** When provided, the slot becomes a stop button — hover swaps the grid for a
   *  stop glyph and a click interrupts. Omit for read-only loaders. */
  onStop?: () => void;
  title?: string;
  /** Wrapper classes (margins, alignment). */
  className?: string;
  /** Box size in px (square). Default 16 (the tab-bar slot); the sidebar chat
   *  row passes a larger value for a comfier hit target. */
  size?: number;
}

/**
 * The single wrapper every loading indicator renders through, so the glyph
 * sits in an identically-sized, identically-centred box on every surface. This
 * is what keeps the parent (project) tab loader aligned with the children
 * (chat / terminal / …) tab loaders — they can no longer drift apart.
 */
function LoaderSlot({ onStop, title, className = '', size = 16 }: LoaderSlotProps) {
  const tip = title ?? (onStop ? 'Stop' : 'In esecuzione');
  const box = { width: size, height: size } as const;
  if (onStop) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onStop(); }}
        className={`group/stop flex-shrink-0 inline-flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer ${className}`}
        style={box}
        title={tip}
        aria-label={tip}
      >
        <GridLoader className="group-hover/stop:hidden" />
        <StopGlyph className="hidden group-hover/stop:block" />
      </button>
    );
  }
  return (
    <span
      className={`flex-shrink-0 inline-flex items-center justify-center ${className}`}
      style={box}
      title={tip}
      aria-label={tip}
    >
      <GridLoader />
    </span>
  );
}

interface TopicSpinnerProps {
  topicId: string | undefined;
  /** Wrapper classes (margins, alignment). */
  className?: string;
  /**
   * When provided, the loader becomes a stop button — hover swaps it for a stop
   * glyph. Used by the chat-tab and sidebar-chat-row surfaces where the user
   * can interrupt the generation in place.
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
  const streaming = useTopicLoading(topicId);
  if (!streaming) return null;
  const tip = title ?? (onStop ? 'Stop generating' : 'Streaming');
  return <LoaderSlot onStop={onStop} title={tip} className={className} />;
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
  // Central rollup: true if ANY child (chat / terminal / agent) of this
  // project is loading — computed from global signals, no window mount needed.
  const loading = useProjectLoading(projectPath);
  if (!loading) return null;
  return <LoaderSlot title={title ?? 'Una chat di questo progetto sta rispondendo'} className={className} />;
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
  const active = useTerminalLoading(sessionId);
  if (!active) return null;
  return <LoaderSlot title={title ?? 'Terminal is producing output'} className={className} />;
}

interface BrowserSpinnerProps {
  /** The browser pane id (`browser:<contextId>`). */
  paneId: string;
  className?: string;
  title?: string;
}

/**
 * Browser busy spinner — page loading or an agent driving the browser. Reads
 * the generic paneActivity store, which the RemoteBrowserPanel / native panel
 * report into (their loading/agentActive lives inside the panel).
 */
export function BrowserStreamingSpinner({
  paneId,
  title,
  className = '',
}: BrowserSpinnerProps) {
  const active = useBrowserLoading(paneId);
  if (!active) return null;
  return <LoaderSlot title={title ?? 'Browser is working'} className={className} />;
}

/**
 * Agents tab spinner — pulses while ANY agent session is active (the agents
 * pane is a global list, not project-scoped). Reads the agentActivity store
 * App mirrors from its live useAgents subscription.
 */
export function AgentStreamingSpinner({
  title,
  className = '',
}: {
  className?: string;
  title?: string;
}) {
  const active = useAnyAgentActive();
  if (!active) return null;
  return <LoaderSlot title={title ?? 'An agent is running'} className={className} />;
}
