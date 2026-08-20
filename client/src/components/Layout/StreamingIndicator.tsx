/**
 * Streaming indicators — the canonical "working now" affordance for a row/tab,
 * rendered as three columns rising and falling out of phase inside their own
 * track (see WaveLoader), NOT a rotating ring or a row of dots. A spinner reads
 * as "blocking / fetching a resource"; the wave reads as "alive, computing" —
 * the right metaphor for an LLM turn or a busy pty.
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
 *     interrupt the LLM stream in place — on hover the wave swaps for a stop
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
 * target for the chat row (still the WaveLoader glyph). Don't roll your own off
 * a DIFFERENT signal or a different glyph — every surface must report from the
 * same loading facade and the same component so they can't drift.
 */

import { useTopicLoading, useTopicAwaitingInput, useProjectLoading, useProjectAwaitingInput, useTerminalLoading, useBrowserLoading } from '../../state/signals';
import { useT } from '../../hooks/useT';
import { useSharedNow } from '../../state/useSharedNow';
import { deriveWorkLongevity, formatElapsedCompact } from '../../state/workLongevity';

/**
 * L'ONDA — tre colonne che salgono e scendono sfalsate dentro la loro traccia.
 *
 * Sostituisce la matrice 2×3 di quadratini accesi uno alla volta. Il motivo non
 * è solo che era spenta da guardare («l'icona del loader potremmo farla un po'
 * più carina e interessante, piuttosto che solo quel coso fermo», Attilio,
 * 10/08): quella matrice era larga 7,5px in una scatola da 16 e quindi nasceva a
 * 4,25px dal bordo — un quadrato da 3px su un quarto di pixel si rasterizza
 * sfocato. Qui il glifo è 10×12 in una scatola da 16: 3px di margine per lato e
 * 2 sopra/sotto, tutti interi, quindi ogni barra ha bordi netti.
 *
 * GEOMETRIA — 3 barre da 2px con 2px di passo: 2+2+2+2+2 = 10.
 *
 * DUE STRATI per barra, ed è ciò che tiene la parentela con SplitMiniMap: la
 * TRACCIA è sempre presente e porta la stessa acqua del "pannello disattivato"
 * del mini-map (`currentColor 22%`, che si inverte col tema); dentro ci sale la
 * barra viva col gradiente del primario (la "sfumatura dentro" che avevano le
 * celle accese). Il silhouette non cambia mai misura, quindi il glifo non
 * "sparisce" nei momenti bassi dell'onda.
 *
 * Si anima solo `transform: scaleY` con origine in basso — nessun riflusso,
 * nessun lavoro sul main thread. Le altezze e i tempi stanno in `index.css`
 * (`wave-bar`), incluso il ramo `prefers-reduced-motion`.
 */
const BAR_W = 2;
const BAR_H = 12;
const BAR_GAP = 2;
const BARS = 3;
const WAVE_W = BARS * BAR_W + (BARS - 1) * BAR_GAP; // 10
/** Lo sfalsamento fra una colonna e la successiva. Un terzo scarso del ciclo:
 *  abbastanza da leggere come un'onda che viaggia, non tanto da sembrare tre
 *  animazioni scollegate. */
const STAGGER_MS = 130;

// La barra viva: gradiente verticale sul primario — più chiara in cima, più
// profonda in fondo — così una colonna legge come un volume illuminato invece
// che come un rettangolo pieno.
const BAR_GRADIENT =
  'linear-gradient(180deg, color-mix(in srgb, var(--primary) 68%, #fff) 0%, var(--primary) 52%, color-mix(in srgb, var(--primary) 84%, #000) 100%)';
// La traccia: la stessa acqua di un pannello disattivato dello SplitMiniMap, per
// non far divergere i due glifi.
const TRACK_WASH = 'color-mix(in srgb, currentColor 22%, transparent)';

// L'ATTESA: stesse barre, ferme a mezz'altezza e in ambra. Un turno sospeso su
// una domanda è aperto ma non macina, e l'onda che scorre gli darebbe un lavoro
// che non sta facendo. L'ambra è la stessa tinta del tier 'input' (TIER_INPUT_BG
// in selectionStyles): dove il fill dice "tocca a te", il glifo dice lo stesso.
// Non è però un fermo-immagine: respira piano (`animate-wave-breath`), perché
// «in attesa» non è «spento».
const STILL_FILL = 'color-mix(in srgb, var(--color-amber-500, #f59e0b) 88%, transparent)';
/** Altezze di riposo delle tre colonne quando l'onda è ferma: una forma, non una
 *  riga piatta. */
const STILL_SCALE = [0.5, 1, 0.68];

export function WaveLoader({ className = '', still = false }: { className?: string; still?: boolean }) {
  return (
    <span
      className={`inline-flex items-end ${className}`}
      style={{ gap: BAR_GAP, width: WAVE_W, height: BAR_H }}
      aria-hidden="true"
    >
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          style={{
            position: 'relative',
            width: BAR_W,
            height: BAR_H,
            borderRadius: BAR_W / 2,
            background: TRACK_WASH,
          }}
        >
          <span
            className={still ? 'animate-wave-breath' : 'animate-wave-bar'}
            data-slot={i}
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 'inherit',
              background: still ? STILL_FILL : BAR_GRADIENT,
              transformOrigin: '50% 100%',
              ...(still
                ? { transform: `scaleY(${STILL_SCALE[i]})`, animationDelay: `${i * 260}ms` }
                : { animationDelay: `${i * STAGGER_MS}ms` }),
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
  /** When provided, the slot becomes a stop button — hover swaps the wave for a
   *  stop glyph and a click interrupts. Omit for read-only loaders. */
  onStop?: () => void;
  title?: string;
  /** Wrapper classes (margins, alignment). */
  className?: string;
  /** Box size in px (square). Default 16 (the tab-bar slot); the sidebar chat
   *  row passes a larger value for a comfier hit target. */
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
 */
function LoaderSlot({ onStop, title, className = '', size = 16, waiting = false }: LoaderSlotProps) {
  const tip = title ?? (waiting ? 'Ferma: in attesa di una tua risposta' : onStop ? 'Stop' : 'In esecuzione');
  const box = { width: size, height: size } as const;
  const state = waiting ? 'waiting' : 'working';
  if (onStop) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onStop(); }}
        // `relative z-30` — IL PIANO CHE IL CONTRATTO DICHIARAVA E NESSUNO AVEVA
        // SCRITTO. `PaneTabBar` lo mette per esteso sul binario dei comandi: «lo
        // spinner resta FUORI (SOPRA): fermare un turno e chiudere la tab sono
        // due azioni diverse nello stesso istante». "Sopra" è una quota, e qui
        // non c'era: `.row-actions` è `position:absolute; right:8px; z-index:20`
        // e questo bottone stava nel flusso senza z-index, quindi quando la coda
        // dei segnali è vuota — cioè proprio MENTRE un turno streama — il
        // cerchio di chiusura gli finiva sopra. Misurato da Playwright, che
        // rifiuta il clic dicendo «<span class="row-actions …"> subtree
        // intercepts pointer events»: passi il mouse sulla tab per fermare il
        // turno e sotto il dito trovi «chiudi».
        //
        // Perché il PIANO e non la geometria. Riservare in flusso la larghezza
        // del binario sposterebbe il layout a ogni inizio e fine turno, e questo
        // repo ha già la regola opposta («mai layout su stato asincrono»); farlo
        // sempre costerebbe ~28px di etichetta a ogni tab, che è il conto che il
        // commento di PaneTabBar aveva già rifiutato. Alzare la quota non muove
        // un pixel: cambia solo CHI vince i pixel contesi, e li vince l'azione
        // che esiste solo per pochi secondi ed è quella che stai cercando.
        //
        // Solo il ramo con `onStop`. L'altro è un glifo di sola lettura, cioè
        // uno dei «segnali che il comando può coprire»: quello resta sotto,
        // com'è giusto.
        className={`group/stop relative z-30 flex-shrink-0 inline-flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors cursor-pointer ${className}`}
        style={box}
        title={tip}
        aria-label={tip}
        data-loader-state={state}
      >
        <WaveLoader className="group-hover/stop:hidden" still={waiting} />
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
      data-loader-state={state}
    >
      <WaveLoader still={waiting} />
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
  onStop,
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
        onStop={onStop}
        title={title}
        className={className}
        size={size}
        quiet={quiet}
        waiting={waiting}
      />
    );
  }
  const tip = title ?? (waiting ? 'Ferma: in attesa di una tua risposta' : onStop ? 'Stop generating' : 'Streaming');
  return <LoaderSlot onStop={onStop} title={tip} className={className} size={size} waiting={waiting} />;
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
  quiet,
  waiting = false,
}: {
  lastUpdate: number | undefined;
  onStop?: () => void;
  title?: string;
  className?: string;
  size?: number;
  quiet?: boolean;
  waiting?: boolean;
}) {
  const now = useSharedNow();
  const { showElapsed, isStale, elapsedMs } = deriveWorkLongevity(lastUpdate, now);

  const baseTip = title ?? (onStop ? 'Stop generating' : 'In esecuzione');
  const stopHint = onStop ? ' Passa il mouse per fermare, clicca per aprire.' : '';
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
    return <LoaderSlot onStop={onStop} title={tip} className={`${className} ${isStale ? 'opacity-70' : ''}`} size={size} waiting={waiting} />;
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
      <LoaderSlot onStop={onStop} title={tip} size={size} className={isStale ? 'opacity-70' : ''} waiting={waiting} />
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
