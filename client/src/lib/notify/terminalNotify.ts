// Pure decision logic for terminal-session OS banners — extracted from
// useCompletionNotifier so it's unit-testable in isolation (bun:test).
//
// Terminal Claude Code sessions publish `session:state` with a NULL sessionKey
// (they're keyed off claudeSessionId, not a Topics session id), so the chat
// notifier path early-returns on them and they never got an OS banner. This
// module answers, for a terminal phase transition: should we banner, and with
// what title/body — mirroring the chat semantics established in the status
// redesign (commits 2cc7a013 / 4ebb4a00): a system banner fires ONLY for an
// action-required phase (your turn / needs approval / error) OR a finish
// (completed) — never for every turn-end, and never for a working phase.

import type { ClaudeSessionPhase, ClaudeSessionPendingApproval } from '../../types';
import { createPaneId } from '../../state/pane/adapters/paneConfig';

/**
 * The phases that warrant an OS banner for a terminal session. Identical to the
 * chat notifier's actionable set:
 *   - awaiting-user     → the turn finished and Claude is waiting on you ("your turn")
 *   - awaiting-approval → a permission gate mid-task (needs a decision NOW)
 *   - completed         → an explicit success ack (background work surfacing)
 *   - error             → the session crashed; you must intervene
 * A working phase (running / tool-running) or a quiet phase (starting / paused /
 * dormant) never banners.
 */
const BANNER_PHASES: ReadonlySet<ClaudeSessionPhase> = new Set([
  'awaiting-user',
  'awaiting-approval',
  'completed',
  'error',
]);

/** True iff this phase should raise an OS banner (see BANNER_PHASES). */
export function isBannerPhase(phase: ClaudeSessionPhase): boolean {
  return BANNER_PHASES.has(phase);
}

/**
 * Is the user ACTIVELY looking at this pane right now — i.e. its tab is the
 * active one AND the Topics window itself has OS focus?
 *
 * The banner is suppressed only when this is true (unless notifyEvenWhenFocused).
 * The window-focus half is load-bearing: `focusedPanelId` is just "which tab is
 * selected" and never clears when the window goes to the background, so on its
 * own it wrongly muted the banner whenever the matching tab happened to be the
 * last-active one while the whole app sat in the background — precisely the case
 * an OS banner exists for. Gating on `windowHasFocus` (document.hasFocus() at the
 * call site) fixes that: a backgrounded window is never "actively visible", so a
 * legitimate awaiting/approval/error/completed banner always surfaces.
 *
 * Pure so it's unit-testable; the caller passes the two booleans it reads from
 * the DOM. `windowHasFocus` defaults to true so an env without a DOM (tests that
 * don't care about it) keeps the tab-only behaviour.
 */
export function isTabActivelyVisible(
  isActivePanel: boolean,
  windowHasFocus: boolean = true,
): boolean {
  return isActivePanel && windowHasFocus;
}

export interface TerminalNotifyInput {
  /** The terminal session id (roster id). */
  terminalId: string;
  /** The phase the session just transitioned INTO. */
  phase: ClaudeSessionPhase;
  /** The prior phase, or undefined if this is the first frame we've seen for
   *  this session (a fresh mount / reconnect bootstrap). */
  prevPhase: ClaudeSessionPhase | undefined;
  /** Monotonic revision from the session state — part of the dedupe key so a
   *  reconnect replay of the SAME (phase, rev) can't re-fire. */
  rev: number;
  /** The pending approval payload (question / plan text), when the phase is
   *  awaiting-approval. Its `prompt` becomes the banner body. */
  pendingApproval?: ClaudeSessionPendingApproval;
  /** Friendly session name (auto-name or user rename), used as the banner title. */
  name?: string;
  /** Fallback title when the session has no name (e.g. the owning topic's name). */
  fallbackTitle?: string;
  /** Is the Topics window focused AND this terminal's tab the active one? When
   *  true we suppress (the user is already looking at it) unless the override
   *  below is set. Mirrors the chat path's focused-pane suppression. */
  isFocusedAndVisible: boolean;
  /** Settings.notifyEvenWhenFocused — banner even when focused+visible. */
  notifyEvenWhenFocused: boolean;
}

export interface TerminalNotifyDecision {
  /** Banner title — the session/tab name (or the topic/generic fallback). */
  title: string;
  /** Banner body — the question/plan text for an approval, else a status line. */
  body: string;
  /** 'warn' for error/approval, 'ok' for your-turn/completed. Drives the sound
   *  level parity with the chat path (cosmetic; the OS banner text is title/body). */
  level: 'ok' | 'warn';
  /** The dedupe key the caller should record so this exact event doesn't
   *  re-fire on a reconnect replay: `<terminalId>:<phase>:<rev>`. */
  dedupeKey: string;
}

/** Build the stable dedupe key for a terminal phase event. Exposed so the
 *  caller can seed / check its record set with the identical key. */
export function terminalDedupeKey(terminalId: string, phase: ClaudeSessionPhase, rev: number): string {
  return `${terminalId}:${phase}:${rev}`;
}

/** The terminal panel id for a session id. Delega a `createPaneId` invece di
 *  ricostruire la stringa: il commento diceva già «matches createPaneId», ma era
 *  una promessa, non un vincolo. */
export function terminalPanelId(terminalId: string): string {
  return createPaneId('terminal', terminalId);
}

/**
 * È il terminale `terminalId` la tab che l'utente ha davvero selezionato?
 *
 * Non basta `focusedPanelId === 'terminal:<id>'`, ed è un buco vero: un terminale
 * che vive DENTRO una finestra progetto non compare mai come pane di livello App.
 * Lo dice il modello stesso (`state/projectFocus.ts`): «when you focus a child
 * inside a project, the App-level focusedPanelId stays the project pane». Quindi
 * per ogni terminale annidato in un progetto il confronto secco era sempre falso
 * e il banner partiva mentre l'utente stava GUARDANDO quel terminale — proprio il
 * caso che la soppressione esiste per evitare.
 *
 * Il secondo livello lo risolve `activePaneByProject`: la ProjectWindow a fuoco
 * pubblica lì la sua tab interna attiva. Se il pane a fuoco è `project:<path>` e
 * la sua tab interna è il nostro terminale, l'utente ci sta dentro.
 *
 * Confronto SEMPRE esatto, mai `includes()`: un `focusedPanelId` che per caso
 * contiene questo id (un pane diverso, un path che se lo porta dentro) non deve
 * poter zittire una notifica altrui.
 *
 * Pura di proposito: il chiamante legge lo store e passa la mappa.
 */
export function isTerminalPaneSelected(
  terminalId: string,
  focusedPanelId: string | null | undefined,
  activePaneByProject: Record<string, string | null> = {},
): boolean {
  if (!focusedPanelId) return false;
  const paneId = terminalPanelId(terminalId);
  if (focusedPanelId === paneId) return true;
  if (!focusedPanelId.startsWith('project:')) return false;
  // Il pane id porta il path PERCENT-ENCODED (`project:${encodeURIComponent(p)}`)
  // mentre la mappa è chiavata sul path GREZZO. Invece di decodificare — che su
  // una stringa malformata lancia — ricostruisco l'id da ogni chiave con la
  // stessa funzione che l'ha creato: l'inverso esatto, e impossibile da far
  // divergere. Le chiavi sono i progetti aperti, una manciata.
  for (const [projectPath, activePaneId] of Object.entries(activePaneByProject)) {
    if (activePaneId !== paneId) continue;
    if (createPaneId('project', projectPath) === focusedPanelId) return true;
  }
  return false;
}

/**
 * Human-readable status line for a phase, used as the banner BODY when there's
 * no richer text (an approval carries its prompt instead). Italian, e UNICA
 * fonte del testo: la legge anche il notificatore delle chat
 * (`useCompletionNotifier`), che prima aveva una copia a mano andata in deriva
 * («in attesa di te» contro «In attesa di te», «interventi richiesti» contro
 * «intervieni»). Due superfici, una frase sola.
 */
export function statusBody(phase: ClaudeSessionPhase): string {
  switch (phase) {
    case 'awaiting-user': return 'In attesa di te';
    case 'awaiting-approval': return "Serve un'approvazione";
    case 'completed': return 'Lavoro completato';
    case 'error': return 'Errore, intervieni';
    default: return '';
  }
}

/**
 * Decide whether a terminal phase transition should raise an OS banner, and if
 * so with what title/body/level + dedupe key. Returns null to suppress.
 *
 * Suppression rules (in order):
 *   1. First frame (no prevPhase) — baseline only, never banner. A reconnect
 *      bootstrap re-broadcasts the full roster, so a session already parked at
 *      awaiting-user would otherwise banner on every reconnect. Mirrors the
 *      chat path's isFirstFrame guard.
 *   2. No real transition (prevPhase === phase) — a repeat frame, never banner.
 *   3. Not an actionable/terminal phase — never banner (no every-turn spam).
 *   4. Focused AND visible, and notifyEvenWhenFocused is off — the user is
 *      already looking at this tab; suppress.
 *
 * Dedupe by (terminalId, phase, rev) is the CALLER's responsibility: this
 * function returns the key to record, but doesn't hold state (keeps it pure /
 * testable). The caller checks its record set before firing and records the
 * returned key after.
 */
/**
 * La transizione è REALE, o è il bootstrap che ci ripresenta il passato?
 *
 * `session:state` è per-transizione, ma alla connessione il server rimanda lo
 * SNAPSHOT di ogni sessione. Un client appena avviato non ha nessuna fase
 * precedente in memoria, quindi ogni sessione ferma in `awaiting-user` o
 * `completed` — cioè ogni conversazione mai finita — sembra essere appena
 * arrivata lì.
 *
 * Il ramo terminale lo gestiva già; quello delle chat NO, e il commento del
 * primo diceva «mirrors the chat path's isFirstFrame guard» descrivendo una
 * guardia che non esisteva. Il risultato, il 2026-08-02: sei riavvii dell'app in
 * una sera, e a ogni riavvio una raffica di banner per lavoro finito giorni
 * prima.
 *
 * Il costo del `false` sul primo frame è noto e accettato: una sessione che
 * nasce E finisce mentre il client è disconnesso non produce banner al
 * ritorno. È il prezzo per non riannunciare tutto il passato a ogni avvio, ed è
 * lo stesso compromesso che il ramo terminale ha già preso.
 */
export function isRealPhaseTransition(
  prevPhase: ClaudeSessionPhase | undefined,
  phase: ClaudeSessionPhase,
): boolean {
  if (prevPhase === undefined) return false; // primo frame: solo baseline
  return prevPhase !== phase;
}

export function decideTerminalBanner(input: TerminalNotifyInput): TerminalNotifyDecision | null {
  // 1 + 2: only fire on a genuine transition we can attribute.
  if (!isRealPhaseTransition(input.prevPhase, input.phase)) return null;

  // 3: gate on the actionable/terminal phase set.
  if (!isBannerPhase(input.phase)) return null;

  // 4: focused-pane suppression.
  if (input.isFocusedAndVisible && !input.notifyEvenWhenFocused) return null;

  const title = input.name || input.fallbackTitle || 'Claude Code';

  // Body: an approval carries the actual question/plan text (commit cb77dab8 put
  // it in pendingApproval.prompt) — far more useful than a generic status line.
  // Trim + collapse whitespace so a multi-line plan reads cleanly in the banner,
  // and cap the length so the OS doesn't truncate mid-word unpredictably.
  let body = statusBody(input.phase);
  if (input.phase === 'awaiting-approval' && input.pendingApproval?.prompt) {
    const cleaned = input.pendingApproval.prompt.replace(/\s+/g, ' ').trim();
    if (cleaned) body = cleaned.length > 180 ? `${cleaned.slice(0, 179)}…` : cleaned;
  }

  const level: 'ok' | 'warn' =
    input.phase === 'error' || input.phase === 'awaiting-approval' ? 'warn' : 'ok';

  return {
    title,
    body,
    level,
    dedupeKey: terminalDedupeKey(input.terminalId, input.phase, input.rev),
  };
}
