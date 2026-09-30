/**
 * The shape of a pane while its chunk is on the way.
 *
 * `LazyPane` used to show one 16 px ring for every pane (fluidity audit
 * panes:F10): the dashboard, the profile, the editor and the board all spent
 * 250-600 ms as a dot in an empty rectangle and then appeared whole in one
 * frame. Each skeleton here copies the layout classes of the pane it stands
 * for, so the content lands where the placeholders stood and nothing moves.
 * Text lines are drawn as `&nbsp;` inside the SAME type classes as the real
 * text: the line box, not a guessed pixel height, decides the row.
 *
 * Main-bundle code: no pane module is imported from here, only markup.
 */
import { BoardSkeleton } from '../Board/BoardSkeleton';
import { SpinnerFallback } from '../Shared/Spinner';

/** The theme-agnostic lift used by every skeleton bar (see `Shared/Skeleton`). */
const BAR = 'rounded bg-black/10 dark:bg-white/10';
const NO_BREAK_SPACE = ' ';

/** Which placeholder a lazy pane shows. `spinner` keeps the ring. */
export type PaneSkeletonKind = 'board' | 'dashboard' | 'profile' | 'file' | 'spinner';

const KPI_CARDS = 9;

/** `DashboardPane`: header, the 5-column KPI grid (9 cards) and the chart box. */
export function DashboardSkeleton() {
  return (
    <div data-testid="pane-skeleton-dashboard" aria-hidden="true" className="flex-1 flex flex-col min-h-0 overflow-auto">
      <div className="flex items-center justify-between px-4 py-2 border-b border-app-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className={`w-3.5 h-3.5 ${BAR}`} />
          <span className="text-prose font-semibold">{NO_BREAK_SPACE}</span>
        </div>
        <span className="text-mini">{NO_BREAK_SPACE}</span>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div data-testid="pane-skeleton-kpi-grid" className="grid grid-cols-5 gap-2">
          {Array.from({ length: KPI_CARDS }).map((_, i) => (
            <div key={i} className="bg-surface border border-app-border rounded-lg px-3 py-2.5 flex flex-col gap-1 min-w-0 animate-pulse">
              <div className="flex items-center justify-between">
                <div className={`w-3.5 h-3.5 ${BAR}`} />
              </div>
              {/* `truncate-tight` sets the value's line box, as on the real card. */}
              <div className="flex items-baseline gap-1 min-w-0">
                <span className={`inline-block w-12 text-headline font-semibold truncate-tight ${BAR}`}>{NO_BREAK_SPACE}</span>
              </div>
              <span className="text-mini leading-tight">{NO_BREAK_SPACE}</span>
            </div>
          ))}
        </div>
        <div data-testid="pane-skeleton-chart" className="bg-surface border border-app-border rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="px-2 py-0.5 text-mini">{NO_BREAK_SPACE}</span>
            <div className="flex items-center gap-0.5 border border-app-border rounded-md p-0.5">
              <span className="px-2 py-0.5 text-mini">{NO_BREAK_SPACE}</span>
            </div>
          </div>
          <div className="w-full" style={{ height: 200 }}>
            <div className={`h-full w-full ${BAR} opacity-40 animate-pulse`} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** `ProfilePane`: its scroll column, with the self-profile's head and a few rows. */
export function ProfileSkeleton() {
  return (
    <div data-testid="pane-skeleton-profile" aria-hidden="true" className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-hidden px-4 py-4 md:px-5 animate-pulse">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-full bg-black/10 dark:bg-white/10" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className={`h-4 w-40 ${BAR}`} />
            <div className={`h-3 w-56 ${BAR}`} />
          </div>
        </div>
        <div className="mt-6 space-y-3">
          {[72, 58, 80, 64].map((w, i) => (
            <div key={i} className={`h-9 ${BAR}`} style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Widths (%) of the placeholder code lines: a file, not a block of bars. */
const CODE_LINE_WIDTHS = [42, 64, 58, 0, 36, 72, 80, 54, 0, 46, 68, 38, 60, 0, 50, 74];

/**
 * The editor area: a gutter and indented code lines at CodeMirror's line pitch.
 * `breadcrumb` adds the path strip `FilePane` draws above it (the lazy chunk
 * does not have the real `BreadcrumbNav` yet; `FilePane` passes its own).
 */
export function EditorSkeleton({ breadcrumb = false }: { breadcrumb?: boolean }) {
  return (
    <div data-testid="pane-skeleton-editor" aria-hidden="true" className="flex flex-col h-full min-h-0">
      {breadcrumb && (
        <div className="flex items-center px-3 py-1 border-b border-app-border bg-elevated dark:bg-app-panel flex-shrink-0">
          <span className="text-mini">{NO_BREAK_SPACE}</span>
          <div className={`h-2.5 w-40 ${BAR}`} />
          <span className="ml-auto p-0.5"><span className="block h-[13px] w-[13px]" /></span>
        </div>
      )}
      <div className="flex-1 overflow-hidden pt-1 animate-pulse">
        {CODE_LINE_WIDTHS.map((w, i) => (
          <div key={i} className="flex items-center h-[19px]">
            <div className="w-10 flex-shrink-0 pr-3 flex justify-end">
              <div className={`h-2 w-3 ${BAR} opacity-60`} />
            </div>
            {w > 0 && <div className={`h-2.5 ${BAR}`} style={{ width: `${w}%`, marginLeft: `${(i % 3) * 16}px` }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The fallback `LazyPane` renders for a kind. */
export function PaneSkeleton({ kind }: { kind: PaneSkeletonKind }) {
  switch (kind) {
    case 'board': return <BoardSkeleton />;
    case 'dashboard': return <DashboardSkeleton />;
    case 'profile': return <ProfileSkeleton />;
    case 'file': return <EditorSkeleton breadcrumb />;
    default: return <SpinnerFallback />;
  }
}
