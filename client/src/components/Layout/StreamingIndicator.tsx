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

import { useTopicLoading, useProjectLoading, useTerminalLoading, useBrowserLoading, useAnyAgentActive, useSessionLastActivityFor } from '../../state/signals';
import { useSharedNow } from '../../state/useSharedNow';
import { deriveWorkLongevity, formatElapsedCompact } from '../../state/workLongevity';

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
  /** Box size in px (default 16 — the tab slot). The sidebar chat row passes a
   *  larger value for a comfier hit target while keeping the identical glyph. */
  size?: number;
  /**
   * `compact` (default) — the bare glyph, identical on every tab. `labeled` — the
   * sidebar treatment: once a turn runs long enough, an elapsed readout appears
   * next to the glyph, and past a stale threshold the whole thing calms to a
   * "long-running / maybe waiting" tone (see LabeledTopicSpinner). Only the
   * roomy sidebar chat row opts in; the compact tab bar stays untouched.
   */
  variant?: 'compact' | 'labeled';
}

export function TopicStreamingSpinner({
  topicId,
  onStop,
  title,
  className = '',
  size,
  variant = 'compact',
}: TopicSpinnerProps) {
  const streaming = useTopicLoading(topicId);
  if (!streaming) return null;
  // `labeled` reads extra live signals (activity + a shared clock); keep that in a
  // child that only mounts WHILE streaming, so idle rows never subscribe to the tick.
  if (variant === 'labeled') {
    return (
      <LabeledTopicSpinner
        topicId={topicId}
        onStop={onStop}
        title={title}
        className={className}
        size={size}
      />
    );
  }
  const tip = title ?? (onStop ? 'Stop generating' : 'Streaming');
  return <LoaderSlot onStop={onStop} title={tip} className={className} size={size} />;
}

/**
 * The sidebar-only "labeled" loader, shared by chat rows AND project rows. Given a
 * last-update epoch-ms it reads TIME SINCE THE LAST UPDATE — a turn actively
 * streaming keeps bumping it and never reads as stale. Below WORK_ELAPSED_AFTER_MS
 * it's byte-identical to the compact spinner; past it an "agg. Xm fa" chip appears;
 * past WORK_STALE_AFTER_MS the chip goes amber, the glyph dims and the tooltip
 * explains — so a row that hasn't updated in 18 minutes reads as "forse ferma / in
 * attesa", not as a fresh spinner. Mounted only while its parent is streaming, so
 * the shared 10s clock ticks only while ≥1 row is actually working. `onStop`
 * (chat rows) keeps the hover-to-stop affordance; project rows omit it (read-only
 * aggregate). Stop (hover) and open (row click) are otherwise unchanged.
 */
function LabeledLoader({
  lastUpdate,
  onStop,
  title,
  className = '',
  size,
}: {
  lastUpdate: number | undefined;
  onStop?: () => void;
  title?: string;
  className?: string;
  size?: number;
}) {
  const now = useSharedNow();
  const { showElapsed, isStale, elapsedMs } = deriveWorkLongevity(lastUpdate, now);

  const baseTip = title ?? (onStop ? 'Stop generating' : 'In esecuzione');
  const stopHint = onStop ? ' Passa il mouse per fermare, clicca per aprire.' : '';
  const tip = isStale
    ? `Nessun aggiornamento da ${formatElapsedCompact(elapsedMs)} — potrebbe essere ferma o in attesa di un processo in background.${stopHint}`
    : showElapsed
      ? `Ultimo aggiornamento ${formatElapsedCompact(elapsedMs)} fa`
      : baseTip;

  // Under the threshold (or no trustworthy last-update): exactly the compact spinner.
  if (!showElapsed) {
    return <LoaderSlot onStop={onStop} title={tip} className={className} size={size} />;
  }
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span
        className={`text-[10px] leading-none tabular-nums flex-shrink-0 ${
          isStale ? 'text-amber-600 dark:text-amber-400' : 'text-app-text-tertiary'
        }`}
        aria-hidden="true"
      >
        {formatElapsedCompact(elapsedMs)}
      </span>
      <LoaderSlot onStop={onStop} title={tip} size={size} className={isStale ? 'opacity-70' : ''} />
    </span>
  );
}

/** Chat-row labeled spinner: sources the last-update from the per-topic signal. */
function LabeledTopicSpinner({
  topicId,
  onStop,
  title,
  className = '',
  size,
}: {
  topicId: string | undefined;
  onStop?: () => void;
  title?: string;
  className?: string;
  size?: number;
}) {
  const lastUpdate = useSessionLastActivityFor(topicId);
  return (
    <LabeledLoader lastUpdate={lastUpdate} onStop={onStop} title={title} className={className} size={size} />
  );
}

interface ProjectSpinnerProps {
  projectPath: string | undefined;
  className?: string;
  title?: string;
  /**
   * `compact` (default, tab bar) — the bare glyph. `labeled` (sidebar) — shows
   * "agg. Xm fa" and, past the stale threshold, the calm "in attesa" treatment,
   * driven by `lastActivity` (the project's aggregate last-touch).
   */
  variant?: 'compact' | 'labeled';
  /**
   * The project's aggregate last-update epoch-ms — max last-activity over its
   * children, as buildSidebarItems already computes it for row ordering. Only read
   * in the `labeled` variant; a fresh child keeps the whole project fresh, so a
   * project reads as stale only when its active work has actually gone quiet.
   */
  lastActivity?: number;
}

export function ProjectStreamingSpinner({
  projectPath,
  title,
  className = '',
  variant = 'compact',
  lastActivity,
}: ProjectSpinnerProps) {
  // Central rollup: true if ANY child (chat / terminal / agent) of this
  // project is loading — computed from global signals, no window mount needed.
  const loading = useProjectLoading(projectPath);
  if (!loading) return null;
  const tip = title ?? 'Una chat di questo progetto sta rispondendo';
  if (variant === 'labeled') {
    return <LabeledLoader lastUpdate={lastActivity} title={tip} className={className} />;
  }
  return <LoaderSlot title={tip} className={className} />;
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
