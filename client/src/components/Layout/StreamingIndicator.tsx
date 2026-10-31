/**
 * Streaming indicators — the canonical "working now" affordance for a row/tab,
 * rendered as a body of 48 sliding squares (see SparkLoader), NOT a row of
 * dots and not a spinning ring. It promises no quantity, so it reads as
 * "alive, computing" rather than as a progress bar about to finish.
 *
 * Every variant renders through ONE wrapper (LoaderSlot), so the loader is
 * pixel-identical across surfaces — a project (parent) tab and its chat /
 * terminal (children) tabs line up exactly, instead of drifting because one was
 * a bare span and another a button. The slot is a fixed 16px box; vary it only
 * via an explicit `size` (the sidebar chat row wants a bigger hit target).
 *
 * EVERY VARIANT IS READ-ONLY, and one of them used to be a button: the chat tab
 * and the sidebar chat row swapped the ring for a stop square under the pointer,
 * which made a status glyph the only place a running turn could be interrupted.
 * Stopping is now a named command in the trailing rail, before close (see
 * `lib/rowCommandOrder`). This file answers one question again: is it working.
 *
 * Variants, matching the StreamingContext shape:
 *   - <TopicStreamingSpinner topicId />           — single topic.
 *   - <ProjectStreamingSpinner projectPath />     — aggregated; surfaces when
 *     ANY child of the project is producing output: a chat mid-stream
 *     (StreamingContext, works even before the window mounts) OR a non-chat
 *     child — terminal / browser / agent — reported by the mounted
 *     ProjectWindow into the projectActivity store. Read-only because stopping
 *     a specific inner stream requires drilling into that child.
 *   - Terminal / Browser / Agent variants — read-only, same look.
 *
 * Used in: PaneTabBar (chat / project / terminal / browser / agents tabs) and
 * Sidebar/TopicTree + Sidebar/TopicItem (project, chat, terminal, browser rows),
 * all in the same 16px slot at the END of the row's quiet trail. Don't roll your
 * own off a DIFFERENT signal or a different glyph — every surface must report
 * from the same loading facade and the same component so they can't drift.
 */

import { useEffect, useRef } from 'react';
import { useTopicLoading, useTopicAwaitingInput, useTopicInProgress, useTopicBackgroundTasks, useProjectLoading, useProjectAwaitingInput, useTerminalLoading, useTerminalBackgroundTasks, useBrowserLoading } from '../../state/signals';
import { useT } from '../../hooks/useT';
import { loaderInkClass, loaderStateFor, type LoaderState } from './loaderState';
import { LoaderBody, sharedLoaderClock, type ClockClient, type LoaderActivity } from './squareLoader';
import { useSharedNow } from '../../state/useSharedNow';
import { deriveWorkLongevity, formatElapsedCompact } from '../../state/workLongevity';

/**
 * THE SQUARE LOADER: 48 rounded squares that slide between shapes (the engine
 * is `squareLoader.ts`, a port of the approved bench). `activity` picks the
 * movement where the caller knows what is going on; without it `working` is
 * `think` and `waiting` is `wait`. The colour is the element's `currentColor`,
 * so `loaderArcClass` keeps deciding it (primary, amber, the ink of a fill).
 *
 * GEOMETRY: 12x12 inside the 16px slot, so the margin is 2 on both axes, whole
 * pixels (the tab geometry test enforces it). At 12-16px the body is a 7x7 grid
 * on device pixels, at 20px 9x9, above that it is free. `hollow` keeps the
 * centre of the grid empty (the tab slot draws a count there).
 *
 * COST: one shared clock, paused off screen and in a hidden window, 30 fps at
 * most under 24px, one still frame under `prefers-reduced-motion`.
 */
/** Glyph size. 12 in a 16px slot leaves an integer 2px margin per side. */
const GLYPH = 12;

/** The ink fades from one state to the next (CSS, `motion-safe`); the canvas re-reads it for this long. */
const INK_FADE_MS = 400;

/** The movement a loader plays when the caller does not say. */
function defaultActivity(state: LoaderState): LoaderActivity {
  return state === 'waiting' ? 'wait' : 'think';
}

/** `onFill`: the glyph sits on an attention fill and takes the fill's ink (`loaderArcClass`).
 *  `size`: the tab slot draws the same body at 20 around a count (TABSLOT-02).
 *  `activity`: which movement to play; `done` and `error` only where a surface already shows that outcome. */
export function SparkLoader({ className = '', state = 'working', onFill = false, size = GLYPH, activity, hollow = false }: {
  className?: string;
  state?: LoaderState;
  onFill?: boolean;
  size?: number;
  activity?: LoaderActivity;
  hollow?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shown = activity ?? defaultActivity(state);
  const activityRef = useRef(shown);
  activityRef.current = shown;
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = canvas.height = Math.round(size * scale);
    const body = new LoaderBody(size, ctx, { scale, hollow });
    let color = getComputedStyle(canvas).color;
    let draws = 0;
    let fadingUntil = 0;
    const still = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    refreshRef.current = () => {
      color = getComputedStyle(canvas).color;
      fadingUntil = performance.now() + INK_FADE_MS;
      if (still) { body.snap(activityRef.current, 2); body.draw(color); }
    };
    const client: ClockClient = {
      body,
      activity: () => activityRef.current,
      // The ink can change with the theme: re-read it now and then, not on every frame.
      color: () => {
        if (++draws % 45 === 0 || performance.now() < fadingUntil) color = getComputedStyle(canvas).color;
        return color;
      },
    };
    if (still) {
      body.snap(activityRef.current, 2);
      body.draw(color);
      return;
    }
    const clock = sharedLoaderClock();
    let visible = typeof IntersectionObserver === 'undefined';
    const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      const now = entries[entries.length - 1]?.isIntersecting ?? true;
      if (now === visible) return;
      visible = now;
      if (now) { color = getComputedStyle(canvas).color; clock.add(client); } else clock.remove(client);
    });
    io?.observe(canvas);
    if (visible) clock.add(client);
    return () => { io?.disconnect(); clock.remove(client); };
  }, [size, hollow]);

  // The state changes the ink at once, not at the next periodic read; the still frame redraws.
  useEffect(() => { refreshRef.current?.(); }, [shown, state, onFill]);

  return (
    <span
      className={`relative inline-flex items-center justify-center motion-safe:transition-colors motion-safe:duration-base ${loaderInkClass(state, onFill, activity)} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="absolute inset-0" style={{ width: size, height: size }} />
    </span>
  );
}

interface LoaderSlotProps {
  title?: string;
  /** Wrapper classes (margins, alignment). */
  className?: string;
  /** Box size in px (square). Default 16, the shared slot on every surface. */
  size?: number;
  /** `waiting`: the turn is open but parked on an answer. See `loaderState.ts`. */
  state?: LoaderState;
  /** The slot sits on an attention fill (see `loaderArcClass`). */
  onFill?: boolean;
}

/**
 * The single wrapper every loading indicator renders through, so the glyph
 * sits in an identically-sized, identically-centred box on every surface. This
 * is what keeps the parent (project) tab loader aligned with the children
 * (chat / terminal / …) tab loaders — they can no longer drift apart.
 *
 * IT IS A SIGN AND NOT A BUTTON, and it used to be both. On the surfaces where
 * a turn can be interrupted the slot became a `<button>` whose ring swapped for
 * a stop square under the pointer: the only way to stop was to hover a STATUS
 * glyph and trust that something would appear. Stopping is now a named command
 * in the trailing rail, next to close (see `rowCommandOrder`), which is where a
 * command can carry a label, a tooltip and a keyboard focus. What is left here
 * only ever answers "is it working".
 */
export function LoaderSlot({ title, className = '', size = 16, state = 'working', onFill = false }: LoaderSlotProps) {
  const tip = title ?? (state === 'waiting' ? 'Ferma: in attesa di una tua risposta' : 'In esecuzione');
  return (
    <span
      className={`flex-shrink-0 inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      title={tip}
      aria-label={tip}
      data-loader-state={state}
    >
      <SparkLoader state={state} onFill={onFill} />
    </span>
  );
}

interface TopicSpinnerProps {
  topicId: string | undefined;
  /** Wrapper classes (margins, alignment). */
  className?: string;
  /** Tooltip override. Defaults to "Streaming". */
  title?: string;
  /** Box size in px (default 16, the shared slot). */
  size?: number;
  /**
   * `compact` (default) — the bare glyph, identical on every tab. `labeled` — the
   * sidebar treatment: past a threshold an "agg. Xm fa" readout appears next to the
   * glyph, and past a stale threshold the whole thing calms to a "maybe waiting"
   * tone (see LabeledLoader). Only the roomy sidebar chat row opts in; the compact
   * tab bar stays untouched.
   */
  variant?: 'compact' | 'labeled';
  /**
   * The chat's last-update epoch-ms — `topic.updatedAt`, the SAME value the row
   * shows at rest ("agg. X fa") AND the same one the project aggregate maxes over,
   * so a chat row and its project row read ONE consistent time (a session actively
   * writing keeps it fresh; only a genuinely quiet one goes stale). `labeled` only.
   */
  lastActivity?: number;
  /**
   * `labeled` con `quiet` mostra la cifra SOLO quando la riga è stale (oltre
   * WORK_STALE_AFTER_MS): sotto quella soglia resta lo spinner nudo.
   *
   * Serve dove accanto c'è già una voce di tempo — le righe di chat e terminale,
   * che sotto al nome mostrano `SessionActivity` («Esegue un comando · 12m»). Lì
   * il chip in coda era un SECONDO numero che misurava un'altra cosa (il tempo
   * dall'ultimo aggiornamento, non la durata del turno), e due numeri diversi
   * sulla stessa riga si leggono come un errore. Da stale il numero torna, perché
   * lì non duplica niente: dice quanto è che NON si muove. Le righe di progetto,
   * che una subline non ce l'hanno, non passano `quiet` e restano com'erano.
   */
  quiet?: boolean;
  /** The row or tab carries an attention fill: the arc takes its ink. */
  onFill?: boolean;
}

export function TopicStreamingSpinner({
  topicId,
  title,
  className = '',
  size,
  variant = 'compact',
  lastActivity,
  quiet,
  onFill,
}: TopicSpinnerProps) {
  const streaming = useTopicLoading(topicId);
  // Il turno sospeso è ANCORA aperto (loading resta true, lo stop ha senso), ma
  // non lavora: cambia il glifo, non l'esistenza dell'indicatore. Prima fuori
  // dalla chat una domanda a schermo si leggeva identica a un turno che macina.
  const waiting = useTopicAwaitingInput(topicId);
  // In progress: a turn open, or the job a closed turn left running (attention
  // `working`, the frame the fill reads too, so the ring and a fill agree).
  const inProgress = useTopicInProgress(topicId);
  const tasks = useTopicBackgroundTasks(topicId);
  const tr = useT();
  const state = loaderStateFor({ inProgress, waiting });
  if (!state) return null;
  // No turn open: the ring of the job left running, never the labeled clock,
  // which times a turn. The tooltip says what runs, and that the chat is free.
  if (!streaming) {
    return <LoaderSlot title={title ?? backgroundTip(tr, workCount(tasks))} className={className} size={size} state={state} onFill={onFill} />;
  }
  // `labeled` (sidebar) shows the elapsed-since-last-update + stale treatment via
  // LabeledLoader, which mounts only here (while streaming) so the shared clock
  // ticks only for working rows. `compact` (tab bar) stays the bare glyph.
  if (variant === 'labeled') {
    return (
      <LabeledLoader
        lastUpdate={lastActivity}
        title={title}
        className={className}
        size={size}
        quiet={quiet}
        waiting={waiting}
      />
    );
  }
  const tip = title ?? (waiting ? 'Ferma: in attesa di una tua risposta' : 'Streaming');
  return <LoaderSlot title={tip} className={className} size={size} state={waiting ? 'waiting' : 'working'} />;
}

/** The tasks that are work: a queued wake is the CLI about to answer, said as «resuming». */
function workCount(tasks: readonly { kind: string }[]): number {
  return tasks.filter((t) => t.kind !== 'wake').length;
}

/** How much runs, and that the chat is free: what the ring of a closed turn cannot say on its own. */
function backgroundTip(tr: ReturnType<typeof useT>, n: number): string {
  if (n === 0) return tr('topic.backgroundResuming');
  return n === 1 ? tr('topic.backgroundOne') : tr('topic.backgroundMany', { n });
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
  title,
  className = '',
  size,
  quiet,
  waiting = false,
}: {
  lastUpdate: number | undefined;
  title?: string;
  className?: string;
  size?: number;
  quiet?: boolean;
  waiting?: boolean;
}) {
  const now = useSharedNow();
  const { showElapsed, isStale, elapsedMs } = deriveWorkLongevity(lastUpdate, now);

  const baseTip = title ?? 'In esecuzione';
  // The stop is no longer up here: it lives in the row's trailing rail, where
  // it has a written name. The tooltip says so, because whoever went looking
  // for the stop went looking on this glyph.
  const stopHint = ' Passa il mouse sulla riga per fermare, clicca per aprire.';
  // Quando SAPPIAMO che aspetta, lo diciamo: il testo "stale" è una congettura
  // ("potrebbe essere ferma"), e una congettura non deve coprire un fatto.
  const tip = waiting
    ? `Ferma da ${formatElapsedCompact(elapsedMs)} in attesa di una tua risposta.${stopHint}`
    : isStale
      ? `Nessun aggiornamento da ${formatElapsedCompact(elapsedMs)}. Potrebbe essere ferma, o in attesa di un processo in background.${stopHint}`
      : showElapsed
        ? `Ultimo aggiornamento ${formatElapsedCompact(elapsedMs)} fa`
        : baseTip;

  // `quiet`: la cifra esce solo da stale. Il tooltip resta sempre completo — la
  // spiegazione non occupa spazio sulla riga.
  const showNumber = quiet ? isStale : showElapsed;
  // Under the threshold (or no trustworthy last-update): exactly the compact spinner.
  if (!showNumber) {
    return <LoaderSlot title={tip} className={`${className} ${isStale ? 'opacity-70' : ''}`} size={size} state={waiting ? 'waiting' : 'working'} />;
  }
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span
        className={`text-mini leading-none tabular-nums flex-shrink-0 ${
          isStale ? 'text-amber-600 dark:text-amber-400' : 'text-app-text-tertiary'
        }`}
        aria-hidden="true"
      >
        {formatElapsedCompact(elapsedMs)}
      </span>
      <LoaderSlot title={tip} size={size} className={isStale ? 'opacity-70' : ''} state={waiting ? 'waiting' : 'working'} />
    </span>
  );
}

interface ProjectSpinnerProps {
  projectPath: string | undefined;
  className?: string;
  title?: string;
  /** The folder row or tab carries an attention fill: the arc takes its ink. */
  onFill?: boolean;
}

export function ProjectStreamingSpinner({
  projectPath,
  title,
  className = '',
  onFill,
}: ProjectSpinnerProps) {
  const tr = useT();
  // Central rollup: true if ANY child (chat / terminal / agent) of this
  // project is loading — computed from global signals, no window mount needed.
  // The project's "agg. X fa" last-update label is rendered by the sidebar row
  // itself (TopicTree), like the chat/terminal/browser rows — this stays the bare
  // busy glyph on every surface.
  const loading = useProjectLoading(projectPath);
  // Se dentro c'è qualcuno che aspetta TE, il glifo sta fermo in ambra come
  // quello di una chat: sulla stessa riga il fill era già ambra e l'onda blu lo
  // contraddiceva — un segno diceva «tocca a te», l'altro «lascialo lavorare».
  const waiting = useProjectAwaitingInput(projectPath);
  // `loading` counts the children waiting on the job they launched too.
  const state = loaderStateFor({ inProgress: loading, waiting });
  if (!state) return null;
  const tip = state === 'waiting' ? tr('project.chatWaits') : tr('project.chatAnswers');
  return <LoaderSlot title={title ?? tip} className={className} state={state} onFill={onFill} />;
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
  // A closed turn that left work running is at work too, as for a chat
  // (ATTN-12): one ring, and the tooltip names the tasks.
  const tasks = useTerminalBackgroundTasks(sessionId);
  const tr = useT();
  const state = loaderStateFor({ inProgress: active, waiting: false });
  if (!state) return null;
  const tip = tasks.length > 0 ? backgroundTip(tr, workCount(tasks)) : 'Terminal is producing output';
  return <LoaderSlot title={title ?? tip} className={className} state={state} />;
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
