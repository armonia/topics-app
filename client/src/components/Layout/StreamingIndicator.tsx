/**
 * Streaming indicators — the canonical "working now" affordance for a row/tab,
 * rendered as a ring with a gradient sweep travelling around it (see
 * OrbitLoader), NOT a row of dots and no longer the three-column equaliser.
 * The sweep has no head and no end, so it reads as "alive, computing" rather
 * than as a determinate progress bar about to finish.
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

import { LoaderCircle } from 'lucide-react';
import { useTopicLoading, useTopicAwaitingInput, useProjectLoading, useProjectAwaitingInput, useTerminalLoading, useBrowserLoading } from '../../state/signals';
import { useT } from '../../hooks/useT';
import { useSharedNow } from '../../state/useSharedNow';
import { deriveWorkLongevity, formatElapsedCompact } from '../../state/workLongevity';

/**
 * THE ORBIT — a faint full ring with lucide's `LoaderCircle` arc turning on top
 * of it, forever.
 *
 * It replaces the hand-rolled conic sweep, which replaced a three-column
 * equaliser, which replaced a 2x3 matrix of little squares. The sweep was a
 * gradient painted into a masked disc: it dissolved at its tail, so at 12px the
 * only thing left with a definite edge was the head, and the glyph read as a
 * smudge that got brighter on one side. The card asked for a loader that is
 * both nicer and MORE SUITABLE, and the suitable part is the one that decides
 * it: a shape with two crisp round caps says "arc going round" at any size,
 * on any background, at any theme.
 *
 * It is a lucide component and not an SVG of ours on purpose — every other
 * glyph in this app comes from that set, and a bespoke one drifts in stroke
 * weight and cap shape the moment the set updates.
 *
 * GEOMETRY — the glyph is 12x12 inside the 16px slot, so the margin is
 * (16 - 12) / 2 = 2 on both axes: whole pixels, which is the rule the tab
 * geometry test enforces (a glyph born on a quarter pixel rasterises blurred).
 * The TRACK is a real 2px ring cut out of a disc by a donut mask rather than a
 * `border`, so it takes the same `currentColor 22%` wash as a disabled panel of
 * the SplitMiniMap and cannot drift from it.
 *
 * TWO LAYERS, same family as before: the track is always there and never moves,
 * and over it turns the arc. The silhouette never changes size, so the glyph
 * never "disappears" at any point of the cycle.
 *
 * Only `transform: rotate` animates: no reflow, no main-thread work. Timings and
 * the `prefers-reduced-motion` branch live in `index.css` (`orbit-spin`).
 */
/** Ring diameter. 12 in a 16px slot leaves an integer 2px margin per side. */
const GLYPH = 12;
/** Ring thickness, cut by the donut mask below. */
const STROKE = 2;

/** Keeps only the outer STROKE px of the disc: a ring, from a background a
 *  `border` could not carry (a colour-mix wash that inverts with the theme). */
const DONUT_MASK = `radial-gradient(closest-side, transparent calc(100% - ${STROKE}px), #000 calc(100% - ${STROKE}px))`;

/** The track: the same water as a disabled panel of the SplitMiniMap, so the
 *  two glyphs of the family cannot drift apart. */
const TRACK_WASH = 'color-mix(in srgb, currentColor 22%, transparent)';

/**
 * Stroke width in lucide's 24-unit box. The default 2 lands at 1px once the
 * icon is scaled to 12, which reads thinner than the 2px track under it: the
 * arc has to be the loud layer, so it is scaled to match.
 */
const ARC_STROKE = (STROKE / GLYPH) * 24;

export function OrbitLoader({ className = '', still = false }: { className?: string; still?: boolean }) {
  const box = { width: GLYPH, height: GLYPH } as const;
  return (
    <span
      className={`relative inline-block ${className}`}
      style={box}
      aria-hidden="true"
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background: TRACK_WASH,
          WebkitMaskImage: DONUT_MASK,
          maskImage: DONUT_MASK,
        }}
      />
      {/* THE WAIT: the same arc, frozen and amber. A turn parked on a question
          is open and NOT grinding, and a turning arc would credit it with work
          it is not doing. The amber is the tint of the 'input' tier
          (TIER_INPUT_BG in selectionStyles): where the fill says "your move",
          the glyph says the same. Frozen is not off, so it breathes slowly. */}
      <LoaderCircle
        size={GLYPH}
        strokeWidth={ARC_STROKE}
        className={`absolute inset-0 ${still ? 'animate-orbit-breath text-amber-500' : 'animate-orbit-spin text-[var(--primary)]'}`}
      />
    </span>
  );
}

interface LoaderSlotProps {
  title?: string;
  /** Wrapper classes (margins, alignment). */
  className?: string;
  /** Box size in px (square). Default 16, the shared slot on every surface. */
  size?: number;
  /** Il turno è aperto ma FERMO ad aspettare una risposta: glifo immobile
   *  ambra invece dell'onda, e il tooltip lo dice. */
  waiting?: boolean;
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
function LoaderSlot({ title, className = '', size = 16, waiting = false }: LoaderSlotProps) {
  const tip = title ?? (waiting ? 'Ferma: in attesa di una tua risposta' : 'In esecuzione');
  return (
    <span
      className={`flex-shrink-0 inline-flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      title={tip}
      aria-label={tip}
      data-loader-state={waiting ? 'waiting' : 'working'}
    >
      <OrbitLoader still={waiting} />
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
}

export function TopicStreamingSpinner({
  topicId,
  title,
  className = '',
  size,
  variant = 'compact',
  lastActivity,
  quiet,
}: TopicSpinnerProps) {
  const streaming = useTopicLoading(topicId);
  // Il turno sospeso è ANCORA aperto (loading resta true, lo stop ha senso), ma
  // non lavora: cambia il glifo, non l'esistenza dell'indicatore. Prima fuori
  // dalla chat una domanda a schermo si leggeva identica a un turno che macina.
  const waiting = useTopicAwaitingInput(topicId);
  if (!streaming) return null;
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
  return <LoaderSlot title={tip} className={className} size={size} waiting={waiting} />;
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
    return <LoaderSlot title={tip} className={`${className} ${isStale ? 'opacity-70' : ''}`} size={size} waiting={waiting} />;
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
      <LoaderSlot title={tip} size={size} className={isStale ? 'opacity-70' : ''} waiting={waiting} />
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
  if (!loading) return null;
  return (
    <LoaderSlot
      title={title ?? (waiting ? tr('project.chatWaits') : tr('project.chatAnswers'))}
      className={className}
      waiting={waiting}
    />
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
