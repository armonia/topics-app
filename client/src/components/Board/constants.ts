import type { LucideIcon } from 'lucide-react';
import { PackageCheck, Hourglass, Square, TimerOff } from 'lucide-react';
import { MAX_FANOUT, PARKED_STOPPED, PARKED_WAITED_OUT } from '../../lib/board';
import type { TaskLabel, TaskStatus } from '../../lib/board';
import { EFFORT_TIERS } from '../../lib/effortTiers';

/** Compact prose for the shared ChatMarkdown renderer inside small board
 *  surfaces (session slices, comments, task description): small text, tight
 *  paragraph/list rhythm, scrollable code blocks. */
export const COMPACT_MD_CLS =
  // list-disc/decimal restore the markers Tailwind's preflight strips — without
  // them ul/ol render as unindented plain text and a bullet/numbered description
  // "non sembra formattata md". Headings get weight/size back too (preflight
  // flattens them), so an agent's plan reads as structured markdown.
  // break-words on prose (p/li/a) so a long unbreakable token — a URL, a path,
  // a hash — wraps instead of forcing the surface (card / drawer) to overflow.
  '[&_p]:my-0.5 [&_p]:break-words [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-black/40 [&_pre]:p-2 ' +
  '[&_ul]:my-0.5 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:my-0.5 [&_ol]:pl-4 [&_ol]:list-decimal [&_li]:my-0.5 [&_li]:break-words [&_li]:marker:text-app-text-muted ' +
  '[&_h1]:font-semibold [&_h1]:text-[13px] [&_h2]:font-semibold [&_h2]:text-[13px] [&_h3]:font-semibold [&_h3]:text-xs [&_h1]:mt-1 [&_h2]:mt-1 [&_h3]:mt-1 ' +
  '[&_code]:text-xs md:[&_code]:text-[11px] [&_a]:break-words [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-app-border-light [&_blockquote]:pl-2 [&_blockquote]:text-app-text-secondary [&_strong]:font-semibold';

// A PLAN is a document, not a chat bubble: this reading typography gives it a
// roomy vertical rhythm, section-divider headings, and prominent numbered steps
// so the agent's proposal is scannable instead of a dense wall. Used only by the
// "Piano" tab (the thread keeps COMPACT_MD_CLS). Kept in one string so the plan
// panel and any future plan surface share the exact same look.
export const PLAN_MD_CLS =
  '[&_p]:my-2 [&_p]:leading-relaxed ' +
  // Headings act as section titles with an underline divider; first one flush to top.
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:pb-1 [&_h1]:border-b [&_h1]:border-app-border [&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:text-app-text ' +
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:pb-1 [&_h2]:border-b [&_h2]:border-app-border [&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:text-app-text ' +
  '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-app-text ' +
  '[&>*:first-child]:mt-0 ' +
  // Roomy lists; numbered steps get a bold violet marker so each step reads as a beat.
  '[&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-2 [&_ol]:pl-6 [&_ol]:list-decimal ' +
  '[&_li]:my-1.5 [&_li]:pl-1 [&_li]:leading-relaxed [&_li]:marker:text-violet-300/70 [&_ol>li]:marker:font-semibold [&_ol>li]:marker:text-violet-300 ' +
  '[&_li_ul]:my-1 [&_li_ol]:my-1 ' +
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre]:text-[12px] ' +
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-white/10 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_code]:text-[12px] ' +
  '[&_a]:text-sky-400 [&_a]:underline [&_strong]:font-semibold [&_strong]:text-app-text ' +
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-violet-400/40 [&_blockquote]:pl-3 [&_blockquote]:text-app-text-secondary ' +
  '[&_hr]:my-3 [&_hr]:border-app-border';

export const PRIORITY_DOT: Record<number, string> = {
  0: 'bg-app-text-faint', 1: 'bg-sky-400', 2: 'bg-emerald-400', 3: 'bg-amber-400', 4: 'bg-rose-500',
};
// 4-first: the dispatch queue serves higher priorities first.
export const PRIORITY_ORDER = [4, 3, 2, 1, 0] as const;
export const PRIORITY_LABEL: Record<number, string> = {
  4: 'Urgente', 3: 'Alta', 2: 'Media', 1: 'Bassa', 0: 'Minima',
};

/**
 * The colour of a kanban column, on its glyph.
 *
 * ── Two tones per theme, and the reason is measured ─────────────────────────
 * They were Tailwind's `-400` alone: born on a dark surface, where they hold
 * up. On the LIGHT chrome (#eaecf0) they measure — against the background,
 * which for a glyph is the comparison that counts — sky-400 1.83:1,
 * emerald-400 1.64:1, rose-400 2.28:1: three colours you infer instead of
 * seeing. It is the «blue too light» Attilio reported on 07/08, and ever since
 * these glyphs appear in the SIDEBAR too (the board's row) it is visible in the
 * light theme without opening anything.
 *
 * The `-600` on the same background give 3.46 / 3.19 / 3.10:1, that is, above
 * the 3:1 threshold WCAG asks of a graphic element. In dark nothing changes:
 * the `-400` from before stay, and there they are right.
 *
 * `backlog` and `todo` were already on text tokens, hence already bi-thematic:
 * the correction concerns the three that had a fixed tint.
 */
export const STATUS_ICON_COLOR: Record<TaskStatus, string> = {
  backlog: 'text-app-text-muted',
  todo: 'text-app-text-heading',
  in_progress: 'text-sky-600 dark:text-sky-400',
  review: 'text-rose-500 dark:text-rose-400',
  done: 'text-emerald-600 dark:text-emerald-400',
};

/* (`STATUS_DOT` used to be here, the filled dots for summarising a column
   where there is no room for the name. Its only consumer was the count on the
   board's row in the sidebar, which since 07/08 draws the REAL kanban glyph
   (`StatusIcon`) instead of a dot: the colour on its own says «red», it does
   not say «review» nor in what order the columns come. With no consumers the
   map was dead code, and `check:deadcode` would have flagged it next time
   round.) */

// Card chip for the dispatch lifecycle (server: tasks.dispatch_state).
export const DISPATCH_CHIP: Record<string, { text: string; cls: string; title?: string; Icon?: LucideIcon }> = {
  // RIPIEGO, non la voce principale: da quando ogni card in `todo` porta la sua
  // ragione (`task.queueReason`, risolta dal server) questi due si disegnano solo
  // se quella manca — cioè se il server non è riuscito a calcolarla. Restano
  // perché un chip vuoto sarebbe peggio, ma «in coda» da solo è esattamente la
  // parola che non dice niente.
  queued: { text: 'in coda', cls: 'bg-white/10 text-app-text-heading' },
  // The agent DECLARED an external-condition wait: back in the queue, slot freed,
  // re-dispatched when its window elapses. NOT a delivery — never in review. The
  // reason rides in task.dispatchError → shown as the chip tooltip.
  //
  // «rinviata» e non «in attesa»: quella parola sulla card significa già il
  // CONTRARIO — «altri aspettano questa» (vedi `waitingOnThisChip`) — e due
  // fatti opposti non possono condividere un'etichetta, qualunque cosa dica il
  // tooltip. Un tooltip, poi, su un telefono non esiste.
  waiting: { text: 'rinviata', cls: 'bg-indigo-500/15 text-indigo-300', title: "Aspetta una condizione esterna: lo slot è libero, riparte da sola", Icon: Hourglass },
  starting: { text: 'avvio…', cls: 'bg-amber-500/15 text-amber-300' },
  working: { text: 'al lavoro', cls: 'bg-sky-500/15 text-sky-300' },
  // Both live in Review, but they ask different things of the human:
  // needs_input = the agent ASKED (answer required); delivered = clean
  // hand-off, the agent believes it's done (approve/reject).
  needs_input: { text: 'serve te', cls: 'bg-rose-500/15 text-rose-300' },
  delivered: { text: 'consegnato', cls: 'bg-emerald-500/15 text-emerald-300', title: "L'agent ha consegnato: aspetta la tua review", Icon: PackageCheck },
  // Same state as `delivered`, opposite meaning: the reaper pushed the card into
  // review after every attempt was spent, so nobody handed anything over. Green
  // "consegnato" on that card is a promise the thread does not keep — the human
  // opens it expecting work to judge and finds a run that died. Amber, and the
  // word says who moved it.
  delivered_by_system: {
    text: 'corsa finita',
    cls: 'bg-amber-500/15 text-amber-300',
    title: "L'ho portato io in review: l'agent non l'ha consegnato. Guarda il thread prima di valutare",
    Icon: PackageCheck,
  },
  // In review with nothing behind it: no branch, no commit, no changed file.
  // Neither "consegnato" nor "corsa finita" fits, because the question is not
  // who moved the card but whether anything exists to look at. Neutral, not
  // red: it is not a failure, it is an empty hand.
  delivered_empty: {
    text: 'niente da vedere',
    cls: 'bg-white/10 text-app-text-secondary',
    title: 'Nessun ramo, nessun commit, nessun file toccato: non c\'e\' un diff da guardare',
  },
  // Parked in backlog after a dispatch ended badly. 'failed' = the agent genuinely
  // failed (timeout without review after the cap / repeated setup errors) — a red,
  // ringed chip so it never reads as a neutral manual "fermato". 'blocked' = a
  // config issue the human must fix first (no worktree / project unresolvable).
  // The specific reason rides in task.dispatchError → shown as the chip tooltip.
  failed: { text: 'fallito', cls: 'bg-rose-500/25 text-rose-200 ring-1 ring-rose-400/40' },
  blocked: { text: 'da sistemare', cls: 'bg-amber-500/15 text-amber-300' },
  // 'stopped' = l'ha fermato una PERSONA (menu della card o bottone del
  // drawer). Neutro per costruzione: non è un fallimento e non c'è niente da
  // sistemare — il turno è stato tagliato e il task aspetta che tu lo rimetta
  // in Todo. Senza questa voce un park umano restava a NULL, cioè una card
  // muta indistinguibile da una mai dispacciata.
  // Il motivo NON è scritto qui: come per 'failed'/'blocked' viaggia in
  // `task.dispatchError` («Fermato da te: … Rimetti il task in Todo per
  // ripartire») e diventa il tooltip. Un titolo fisso lo coprirebbe.
  [PARKED_STOPPED]: { text: 'fermato', cls: 'bg-white/10 text-app-text-secondary', Icon: Square },
  // 'waited_out' = la SERIE di attese dichiarate ha sfondato il tetto. Il task è
  // in Backlog e non riparte da solo, ma non ha fallito niente: aspettava, e
  // quello che aspettava non è arrivato. Perciò indigo come 'in attesa' (è la
  // stessa storia, un capitolo dopo) e non rosso come 'fallito' — con l'anello
  // di 'fallito', che è ciò che distingue un park da un chip di passaggio.
  // Il motivo NON è scritto qui: viaggia in `task.dispatchError` (quante attese,
  // per cosa, da quanto) e diventa il tooltip. Un titolo fisso lo coprirebbe.
  [PARKED_WAITED_OUT]: { text: 'troppa attesa', cls: 'bg-indigo-500/25 text-indigo-200 ring-1 ring-indigo-400/40', Icon: TimerOff },
};

// Single shared new-task draft → single caret key (board composer is global).
export const COMPOSER_CURSOR_KEY = 'board:composer';

/**
 * Quanto resta acceso il lampo su una card appena creata. Uguale al keyframe
 * `taskCreatedFlash` in index.css — se i due divergono la classe se ne va prima
 * che l'animazione finisca (taglio secco) o resta dopo (card ferma e accesa).
 *
 * È anche la finestra entro cui la board accetta di scorrere fino alla card
 * nuova: passata quella, il gesto che l'ha creata non è più "appena successo" e
 * portare a schermo qualcosa sarebbe uno strattone che risponde a niente.
 */
export const CREATED_FLASH_MS = 2400;

/**
 * One tab of a task's surface tab group. The Thread is the always-present body;
 * these are the auxiliary surfaces the side panel / inline tab bar switch to.
 */
export type TaskSurface =
  // NON c'è una superficie 'output': l'URL consegnato dall'agent (`output_url`)
  // semina una tab BROWSER vera (TaskDetail → browser.seedFromUrl), non un
  // iframe a parte. La variante + il suo OutputFrame sono stati rimossi quando
  // nessuno li costruiva più.
  | { id: string; kind: 'plan'; label: string; content: string }
  | { id: string; kind: 'media'; label: string; url: string; path: string }
  // The task-owned browser GROUP (feature-flagged): a single surface whose
  // content is the app's real GroupLayout engine driving the task's browser tabs
  // (split / drag / tab-stack / resize). Task-scoped, never in the global pane
  // store (see state/taskBrowserTabs + state/taskBrowserLayout).
  | { id: 'browser'; kind: 'browser'; label: string };

/** The tool the session is running RIGHT NOW: name, its input cut to one line, since when. */
export interface LiveTool { name: string; input: string | null; since: number }

/**
 * The wait before the dispatcher retries a turn that died (usually the
 * provider). `at` is when the retry fires; the card counts down to it. Transient
 * like the rest of the event: it is a timer in the server process.
 */
export interface RetryWait {
  at: number; attempt: number; cap: number;
  /** The attempt is not counted (provider error, human stop). */
  free: boolean;
  /** Why the turn ended, as the dispatcher says it. */
  reason: string;
  /** The raw error text, for the tooltip. */
  detail: string | null;
}

/** Live per-turn usage pushed by the dispatcher (`task:usage-live`, transient). */
export interface LiveUsage {
  turnStartedAt: number; baseMs: number; liveTokens: number; model: string | null;
  /** What the agent is doing now, or null when no tool is running / unknown. */
  lastTool?: LiveTool | null;
  /**
   * The turn is dead and the dispatcher is waiting to retry it. While this is
   * set the card draws the wait, not a stopwatch: a stopwatch running on a
   * session that is not answering was the lie this field removes.
   */
  retry?: RetryWait | null;
  /**
   * Primo turno, card ancora com'era: l'agente sta INQUADRANDO il lavoro
   * (titolo, priorità, primi passi) e non ha ancora lasciato un segno. Si
   * spegne al primo segno, e da un server più vecchio non arriva affatto.
   */
  triage: boolean;
}

// ── Board settings (auto-dispatch config) ───────────────────────────────────
// La scala effort vive in `shared/effort.ts` (via lib/effortTiers): il
// selettore del dispatch e lo slider della chat leggono la STESSA scala ordinata.
//
// `auto` sta in TESTA e non in coda perché è il default consigliato: fissare un
// effort per tutta una board significa pagare lo stesso sforzo su un typo e su
// un refactor, e la differenza non è teorica (stesso micro-task: `medium` 61,1k
// token di lavoro, `xhigh` 108,8k). Su `auto` lo sceglie il classificatore task
// per task, con pavimento `medium`.
export const EFFORTS = ["auto", ...EFFORT_TIERS] as const;

/** 1..MAX_FANOUT — le scelte del selettore fan-out, DERIVATE dal tetto condiviso
 *  (`shared/board.ts`): alzare il tetto allunga la fila da solo. */
export const FANOUT_CHOICES = Array.from({ length: MAX_FANOUT }, (_, i) => i + 1);

/**
 * Aprire un task dalla board. `focusPaneId` è opzionale e dice QUALE tab del
 * task deve stare davanti all'apertura — serve al gesto «apri l'anteprima in
 * una tab» partendo dalla card: senza, il drawer si apre sempre sul Thread e
 * l'artefatto appena cliccato lo dovresti ricercare a mano.
 */
export type OpenTask = (id: string, focusPaneId?: string) => void;

/** Pane id dell'allegato `path` dentro il gruppo di tab del task. Unica fonte:
 *  la costruisce `useTaskBrowserGroupLayout`, la consumano card e drawer. */
export const mediaPaneIdFor = (path: string): string => `media:${path}`;

/**
 * L'etichetta testuale di un chip nelle barre strette della board (riga di
 * controlli del composer, filtri inline della kanban): sparisce quando il
 * CONTENITORE `@container` scende sotto i 448px, lasciando il chip con la sola
 * icona più il suo `title`.
 *
 * Perché sul contenitore e non sul viewport: queste barre vivono dentro una
 * pane, e una pane può essere molto più stretta di qualunque breakpoint `sm:`
 * — che guarda la finestra e quindi non scatta mai. Stesso schema del composer
 * della chat (`ChatInput.tsx` + `ProviderModelPicker.tsx`).
 */
export const CHIP_LABEL = 'truncate @max-[28rem]:hidden';

/**
 * Da quanti caratteri in su il riassunto di una card in review si RIPIEGA.
 *
 * 620 sono circa dieci righe nella colonna della board (~62 caratteri per riga
 * a 13px in una colonna da 300px). Sotto quella misura il pieghevole sarebbe
 * attrito senza guadagno: due righe non nascondono niente a nessuno.
 *
 * Si guarda il TESTO e non l'altezza resa: misurare l'altezza dopo il render
 * vorrebbe dire far saltare la card di un fotogramma, e su una colonna di otto
 * card il salto si vede.
 */
export const COMMENTO_PIEGA_CHARS = 620;

/**
 * Da quanti caratteri in su la RICHIESTA UMANA citata sulla card si ripiega.
 *
 * La riga stava a `truncate`: una riga sola, con il resto della frase perso nel
 * tooltip. Segnalato cosi': «una cosa che non si capisce al momento e' che il
 * mio ultimo messaggio che ho mandato viene tagliato». La parola dell'agente
 * sopra ha il pieghevole da mesi; la richiesta a cui risponde no, e la meta'
 * mancante era proprio quella che diceva cosa era stato chiesto.
 *
 * 190 sono circa tre righe nella colonna (~63 caratteri per riga a 11px in una
 * colonna da 300px). Tre e non dieci perche' questa riga e' CONTESTO: sta sopra
 * la risposta, e se si prende mezza card smette di essere il contorno della
 * consegna e diventa il protagonista. Sotto le tre righe non si ripiega niente:
 * il testo c'e' tutto e nessun bottone compare.
 */
export const RICHIESTA_PIEGA_CHARS = 190;

/**
 * THE SHELL OF EVERY FILTER CONTROL in the board toolbar: the search box, the
 * priority/assignee token field, the labels chip and the project picker wear
 * this and nothing else. It is also the look the task composer gives its own
 * pickers (model, priority, project), so filtering and creating speak one
 * language.
 *
 * WHY ONE FUNCTION AND NOT FOUR CLASS STRINGS. They were four: the chips came
 * through here, the search `<input>` styled itself (no hover, no active state,
 * its own text token) and the token field styled its own wrapper (`px-1.5`,
 * `gap-1`, and idle-looking even while it held three tokens). Four controls on
 * one row, three paddings and two ways of saying "I am filtering something".
 * The differences were invisible one at a time and obvious side by side.
 *
 * `active` is the SAME statement everywhere: this control is currently
 * narrowing the board. Text typed in the search box, tokens in the field,
 * labels or projects picked - all of them darken the shell the same way.
 *
 * `h-6` explicit (not `py-*`) because an `<input>`, which the UA line-height
 * makes taller, has to land on the exact same height as a button.
 */
/**
 * The focus ring of a filter control: 1px, INSET, on the SHELL.
 *
 * The app's one focus rule (`index.css`, `@layer base`) paints
 * `outline: 2px solid var(--primary)` with `outline-offset: 2px` on every
 * button and input. On a 24px-tall control that ring is drawn OUTSIDE the
 * rounded rectangle and escapes the field. A ring is a box-shadow, so it costs
 * no layout, and `ring-inset` cannot leave the shell by construction.
 *
 * Two selectors because this class dresses two kinds of element: a chip IS the
 * focus target (`focus-visible:`), a field CONTAINS it
 * (`has-[:focus-visible]:`). Nothing in `index.css` changes - on a normal-sized
 * button the global offset ring is right, and rewriting it would reach the
 * whole app.
 *
 * It also fills a hole: `filterInputClass` carries `outline-none` with no
 * replacement, so tabbing onto the search input showed nothing at all.
 */
export const filterFocusRingClass =
  'outline-none focus-visible:outline-none has-[:focus-visible]:outline-none ' +
  'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/70 ' +
  'has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-primary/70';

export const filterFieldClass = (active: boolean) =>
  `flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors ${filterFocusRingClass} ${
    active
      ? 'bg-black/15 text-app-text dark:bg-white/15'
      : 'bg-black/5 text-app-text-heading hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10'
  }`;

/**
 * The INPUT that lives inside one of those shells (search, token field): it
 * brings no background and no ring of its own, because the shell around it is
 * already the field. Shared so the two inputs cannot drift apart again.
 */
export const filterInputClass =
  'h-5 min-w-0 flex-1 bg-transparent text-[11px] leading-none text-app-text outline-none placeholder:text-app-placeholder';

/**
 * A PILL inside the token field: the value the field holds. It sits on an
 * ACTIVE shell (a field with tokens is filtering), so it is declared one step
 * lighter than that shell in both themes plus a token border, otherwise the
 * pills melt into the field the moment it darkens.
 */
export const filterTokenPillClass =
  'inline-flex shrink-0 items-center gap-1 rounded border border-app-border-light bg-black/5 px-1.5 py-0.5 text-[11px] font-medium text-app-text-heading dark:bg-white/10';

/** Caption of a group inside a filter dropdown. It was a local string inside
 *  `InlineFilters`; the field that owns the menu now owns the class. */
export const filterMenuCaptionClass =
  'px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted';

/**
 * The board's five filter axes. It used to be declared TWICE inside
 * `KanbanBoardPane` - `BoardFilters` for the props and `Filters` for the state -
 * which is the same shape in two places, i.e. two shapes waiting to drift.
 */
export interface BoardFilters {
  priority: number[];
  assignedTo: string[];
  text: string;
  projectId: string[];
  /** Labels in AND: "only the visible ones in review" is this plus the column. */
  labels: TaskLabel[];
}

/** What the ONE field owns: every axis except the project, which keeps its own
 *  control (it already has a search box and an inline chip strip of its own). */
export type BoardFieldFilters = Omit<BoardFilters, 'projectId'>;
