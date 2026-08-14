/**
 * PaneAddMenu — single source of truth for the "+" / "Add pane" affordance.
 *
 * EXACTLY TWO menu variants exist, keyed by `scope`:
 *
 *   - `scope="project"`    — inside a ProjectWindow (top tab bar group "+",
 *     sidebar project-header "+", touch overflow menu). Items: New Chat,
 *     Shell, Claude Code, Codex, opencode, Browser, Git, Files, Board.
 *   - `scope="standalone"` — no project context (standalone tab bar "+",
 *     sidebar global header "+"). Items: New Chat, Shell, Claude Code,
 *     Codex, opencode, Browser, Board generale, then (desktop) Apri / Crea
 *     Progetto.
 *
 * L'ELENCO non vive più qui: sta in `addMenuItems.tsx`, che lo costruisce da
 * `PANE_CONFIG.addableScopes` + `TERMINAL_AGENT_TYPES` e lo condivide con le
 * pill della palette ⌘K. Qui resta solo la RESA. (Prima le due superfici
 * scrivevano due liste a mano, e infatti divergevano: ⌘K non offriva opencode,
 * né Browser, né Board.)
 *
 * Gli unici pomelli che gli ospiti hanno:
 *   - `availableTypes` override for group-level singleton filtering (a group
 *     that already has a Git pane hides "Git"; computed by GroupLayout /
 *     StandaloneChatGroup) — a subset filter, never a reorder.
 *   - trigger presentation (`triggerVariant`, `triggerClassName`,
 *     `triggerKbd`, `noElectronDrag`).
 *   - `presentation` — how the OPENED menu renders:
 *       'dropdown' (default): il primitivo `Menu` (portal, flip/clamp,
 *         dismissal, role=menu, frecce, sheet mobile). NON si riscrive a mano:
 *         fino al 2026-08-06 questo file duplicava ~120 righe di `Menu` e nel
 *         farlo perdeva role, tabIndex, fuoco nel pannello e navigazione da
 *         tastiera — cioè metà del motivo per cui la primitiva esiste.
 *       'palette': centered ⌘K-style modal (lib/modalStyles.ts grammar) —
 *         the sidebar header's standalone add menu. Also opens via the
 *         global `topics:open-add-palette` window event (⌘N).
 *
 * **⌘N apre SEMPRE E SOLO la palette standalone** (una sola istanza in tutta
 * l'app, in App.tsx). Per questo l'hint "⌘N" vive sul TRIGGER e su nessuna riga:
 * sulle tab bar diceva «⌘N crea una chat in QUESTO gruppo» (falso: apre una
 * seconda superficie standalone sopra quella che guardi), e sulla riga New Chat
 * della palette era falso pure lì — a palette aperta ⌘N la CHIUDE. Ogni riga
 * porta invece la sua lettera nuda, che è vera in tutte e due le presentazioni.
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import { useClaudeSkipPermissions } from '../../hooks/useClaudePrefs';
import { useMobile } from '../../hooks/useMobile';
import { useDismissable } from '../../hooks/useDismissable';
import { useMenuKeyboard } from '../../hooks/useMenuKeyboard';
import { type PaneScope } from '../../state/pane/adapters';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { MODAL_BACKDROP, MODAL_PANEL, MODAL_LAYER } from '../../lib/modalStyles';
import { POPOVER_ITEM, POPOVER_DIVIDER } from '../../lib/popoverStyles';
import { GLYPH_KBD_PADDING, RAISED_CONTROL, ROW_ACTION_BOX } from '../../lib/selectionStyles';
import { Menu } from './Menu';
import { buildAddMenuItems, type AddMenuItem } from './addMenuItems';
import { AddMenuIcon } from './AddMenuIcon';
import type { PaneType } from '../../types';

/** Window event that opens the centered add palette (⌘N — dispatched by
 *  useKeyboardShortcuts). Only instances with `presentation="palette"`
 *  listen, so the shortcut always lands on the sidebar's standalone menu. */
export const OPEN_ADD_PALETTE_EVENT = 'topics:open-add-palette';

/** Fire the global "open / create a project (native folder picker)" intent.
 *  Handled by a listener in App.tsx — kept event-based so EVERY PaneAddMenu
 *  host (top tab bar, sidebar project header) triggers it identically, with no
 *  prop-threading. The native picker lets you select an existing folder OR
 *  create a new one. Desktop-only (needs the OS dialog). */
function openProjectPicker() {
  window.dispatchEvent(new CustomEvent('topics:open-project-picker'));
}

/**
 * La lettera di scorciatoia, a destra della riga.
 *
 * `aria-hidden` NON è cosmesi: senza, il nome accessibile del bottone diventa
 * «Shell S» e ogni `getByRole('button', { name: 'Shell', exact: true })` — che
 * esiste, `terminal-tab-reload.spec.ts:242` — smette di trovarlo. Per gli
 * screen reader la stessa informazione passa da `aria-keyshortcuts`, che è il
 * canale giusto.
 */
function MnemonicHint({ children }: { children: string }) {
  return (
    <kbd className="kbd text-app-text-muted flex-shrink-0" aria-hidden="true">
      {children}
    </kbd>
  );
}

export interface PaneAddMenuItemsProps {
  /** Which of the TWO canonical menu variants this host gets. Drives the
   *  default `availableTypes` (via PANE_CONFIG.addableScopes) AND whether
   *  the Apri/Crea Progetto actions render (standalone only, desktop). */
  scope: PaneScope;
  /** Spawn a new chat in the current scope. Hidden when omitted. */
  onNewChat?: () => void;
  /** Spawn a new pane of `type` in the current scope. Required for any
   *  `availableTypes` entry to actually do something on click. */
  onAddPane?: (type: PaneType, subType?: string) => void;
  /** Group-level singleton FILTER (subset of the scope's canonical list).
   *  Defaults to `getAddableTypesForScope(scope)`. Hosts pass it only to
   *  hide singletons already present in the target group — never to add
   *  types or change the order, which are owned by the scope. */
  availableTypes?: readonly PaneType[];
  /** Called after any item is invoked, so the parent can close the menu. */
  onClose: () => void;
}

export function PaneAddMenuItems({
  scope,
  onNewChat,
  onAddPane,
  availableTypes,
  onClose,
}: PaneAddMenuItemsProps) {
  const [claudeSkipPermissions, setClaudeSkipPermissions] = useClaudeSkipPermissions();
  const { isMobile } = useMobile();

  // Touch targets are bigger on mobile, so the icons need to scale up to
  // stay legible inside the larger row.
  const iconSize = isMobile ? 18 : 14;

  const items = buildAddMenuItems({
    scope,
    availableTypes,
    onNewChat,
    onAddPane,
    // Lo scoping (solo standalone, solo desktop) lo applica `buildAddMenuItems`:
    // è una proprietà della VOCE, non dell'ospite, e finché è stata dell'ospite
    // le due superfici hanno dato risposte diverse.
    onProjectPicker: openProjectPicker,
  });

  const choose = (item: AddMenuItem) => () => {
    item.run();
    onClose();
  };

  return (
    <>
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.dividerBefore && <div className={POPOVER_DIVIDER} />}
          <button
            type="button"
            role="menuitem"
            onClick={choose(item)}
            className={POPOVER_ITEM}
            data-testid={item.testId}
            data-mnemonic={item.mnemonic || undefined}
            aria-keyshortcuts={item.mnemonic || undefined}
          >
            <AddMenuIcon item={item} size={iconSize} />
            <span className="flex-1 text-left">{item.label}</span>
            {/* Claude Code porta il suo interruttore --dangerously-skip-permissions.
                È un <span>, non un <label>+<input>: un controllo interattivo
                dentro un <button> è HTML non valido e rompe il nome accessibile
                della riga. Il click sulla riga NON deve creare la sessione, per
                questo ferma la propagazione. */}
            {item.id === 'claude-code' && (
              <span
                className="flex items-center gap-1 text-[11px] text-app-text-muted flex-shrink-0"
                onClick={(e) => { e.stopPropagation(); setClaudeSkipPermissions(!claudeSkipPermissions); }}
                role="checkbox"
                aria-checked={claudeSkipPermissions}
                aria-label="yolo: salta le richieste di permesso"
                tabIndex={-1}
              >
                <span
                  aria-hidden="true"
                  className={`w-3 h-3 rounded border flex items-center justify-center ${
                    claudeSkipPermissions
                      ? 'bg-[#D97757] border-[#D97757] text-white'
                      : 'border-app-border'
                  }`}
                >
                  {claudeSkipPermissions ? '✓' : ''}
                </span>
                <span aria-hidden="true">yolo</span>
              </span>
            )}
            {/* La lettera NUDA, anche su New Chat. Ci stava "⌘N": incoerente con
                ogni altra riga e per giunta falso — a palette aperta ⌘N la
                CHIUDE (è un toggle), non crea una chat. L'hint ⌘N vive sul
                trigger, che è il posto dove è vero. */}
            {item.mnemonic && !isMobile && <MnemonicHint>{item.mnemonic}</MnemonicHint>}
          </button>
        </Fragment>
      ))}
    </>
  );
}

/* ── The full menu component ───────────────────────────────────────────── */

export interface PaneAddMenuProps extends Omit<PaneAddMenuItemsProps, 'onClose'> {
  /** Tooltip on the trigger button. Defaults to "Add pane". */
  triggerTitle?: string;
  /** Trigger button visual preset. Three flavours so the menu sits naturally
   *  alongside differently-sized neighbours without divergent code paths:
   *
   *   - `'pill'` (default) — 6×6 with a `bg-surface` plate that's visible
   *     at rest. Matches the tab bar's "+" and the sidebar project header
   *     "+" (both sit next to other 6×6 affordances).
   *   - `'ghost'` — 7×7 desktop / 10×10 mobile with no resting background,
   *     hover `bg-black/5`. Matches the global sidebar header icons
   *     (Settings, Remote, etc.).
   *   - `'header'` — compact h-7 button with the shared RAISED_CONTROL fill
   *     (the same OPAQUE plate as the Search button beside it and the button
   *     that reopens the column), with room for a `triggerKbd` hint.
   *
   *  The size also drives the inner `Plus` icon (14px / 18px). */
  triggerVariant?: 'pill' | 'ghost' | 'header' | 'bar';
  /** Keyboard-shortcut hint rendered INSIDE the trigger (kbd style — same
   *  as the sidebar Search button's ⌘K). Desktop only; hidden on mobile. */
  triggerKbd?: string;
  /**
   * Un'etichetta accanto al «+», per il posto in cui il bottone non ha vicini
   * che lo spieghino: la barra dei comandi in fondo alla sidebar sul telefono,
   * dove due sole icone in mezzo a una fascia larga sono un indovinello. Assente
   * ovunque il «+» stia in fila con altre affordance della sua misura, che è il
   * caso normale — un'icona sola in un binario si legge dal contesto. */
  triggerLabel?: string;
  /** Optional class to layer on top of the default trigger styling. The
   *  sidebar uses this to make the button hover-revealed on the project
   *  header row (`'hidden group-hover/proj:flex'`); the top tab bar leaves
   *  it empty so the button is always visible. */
  triggerClassName?: string;
  /** When true, mark the trigger as `app-no-drag` and set the equivalent
   *  inline style. Used by the top tab bar inside an electron drag region
   *  so dragging the button doesn't initiate a window drag. */
  noElectronDrag?: boolean;
  /** How the opened menu renders on desktop:
   *   - `'dropdown'` (default) — il primitivo `Menu`, ancorato al trigger.
   *   - `'palette'`  — centered ⌘K-style modal (the sidebar header's
   *     standalone menu). Also opens on the `topics:open-add-palette`
   *     window event (⌘N).
   *  Mobile always uses the bottom-sheet — che è anch'esso `Menu`. */
  presentation?: 'dropdown' | 'palette';
}

/**
 * Il «+» — quello della barra delle tab, della riga di progetto e della tessera
 * fissata. Un componente, un aspetto.
 *
 * DUE correzioni, entrambe segnalate da Attilio il 07/08 («il tasto di aggiunta
 * di una nuova tab sulla tab bar forse è un po' piccolo e, fra l'altro, potrebbe
 * essere uniformato in termini di colori a quello che abbiamo sulla sidebar»):
 *
 *  · IL COLORE. Era `bg-surface`, cioè il token delle PANE DI CONTENUTO: sul
 *    desktop è bianco puro, quindi sopra la riga di chrome il bottone sembrava
 *    un ritaglio di pagina incollato lì; sotto i 768px `--bg-surface` collassa
 *    su `--chrome-bg` (vedi index.css) e il bottone spariva del tutto nel fondo.
 *    Il primo tentativo è stato `RESTING_SURFACE`, un rialzo in alpha: giusto
 *    per una superficie, sbagliato per un COMANDO — «non dovrebbe essere
 *    trasparente il +» (Attilio, subito dopo). Ora è `RAISED_CONTROL`, opaco,
 *    lo stesso del cerca e del tasto che riapre la colonna: tre gemelli, un
 *    trattamento.
 *  · LA MISURA. 24px in un binario dove ogni altro comando ora sta a
 *    {@link ROW_ACTION_BOX} (28 desktop / 36 col dito) lo lasciava sia sotto
 *    soglia col pollice sia fuori colonna rispetto ai vicini.
 */
const TRIGGER_CLASS_PILL =
  // TESTO PIENO, in due giri. Era `-muted` (`#8a9099` in scuro), l'ho portato al
  // secondario (`#aab0ba`) e non bastava: «ancora il + della sidebar e ricerca
  // li vedo grigi» (Attilio, 08/08). Ha ragione, e il motivo è che questi due
  // NON sono un gradino di gerarchia: sono i due comandi principali della
  // colonna, l'unica cosa che si preme lassù. Un gradino sotto il testo pieno
  // ha senso per una didascalia, non per il comando che apre tutto.
  `${ROW_ACTION_BOX} edge-lit flex items-center justify-center rounded-lg ${RAISED_CONTROL} text-app-text transition-colors`;

export function PaneAddMenu({
  scope,
  onNewChat,
  onAddPane,
  availableTypes,
  triggerTitle = 'Add pane',
  triggerVariant = 'pill',
  triggerLabel,
  triggerKbd,
  triggerClassName = '',
  noElectronDrag,
  presentation = 'dropdown',
}: PaneAddMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { isMobile } = useMobile();

  const close = useCallback(() => setOpen(false), []);

  // La palette è centrata, non ancorata: non passa da `Menu` e quindi si porta
  // dietro il proprio dismissal. Il dropdown (e il foglio mobile) non hanno
  // questo hook — ce l'ha `Menu` dentro.
  const paletteIsOpen = open && !isMobile && presentation === 'palette';
  useDismissable({ open: paletteIsOpen, onClose: close, refs: [buttonRef, paletteRef] });
  // Frecce + lettera nuda anche nella palette: senza, l'unica superficie che
  // ⌘N apre sarebbe l'unica senza tastiera.
  const onPaletteKeyDown = useMenuKeyboard({ panelRef: paletteRef });
  useEffect(() => {
    if (!paletteIsOpen) return;
    paletteRef.current?.focus({ preventScroll: true });
  }, [paletteIsOpen]);

  // ⌘N / programmatic open: palette instances toggle on the global
  // open-add-palette event so the keyboard shortcut needs no prop-drilling
  // (same event-based pattern as topics:open-project-picker).
  useEffect(() => {
    if (presentation !== 'palette') return;
    const handler = () => setOpen((prev) => !prev);
    window.addEventListener(OPEN_ADD_PALETTE_EVENT, handler);
    return () => window.removeEventListener(OPEN_ADD_PALETTE_EVENT, handler);
  }, [presentation]);

  const hasMenuItems =
    !!onNewChat ||
    buildAddMenuItems({ scope, availableTypes, onAddPane: onAddPane ?? (() => {}) }).length > 0;
  if (!hasMenuItems) return null;

  const handleClick = () => setOpen((prev) => !prev);

  // Trigger preset selection. The 'ghost' variant matches sidebar
  // header icons (Settings, Remote, etc.) — same 7×7 / 10×10 footprint,
  // transparent at rest, hover bg-black/5. The 'pill' variant matches
  // tab-bar / sidebar-project-row affordances — see TRIGGER_CLASS_PILL.
  // The 'header' variant matches the sidebar Search button — compact h-7
  // RAISED_CONTROL plate with an inline kbd hint.
  const triggerBase =
    // 'bar' — una delle tre porte della fila in fondo al telefono
    // (MobileChromeBar): glifo sopra, parola sotto, 44 di altezza come le sue
    // vicine. Non è una quarta pelle per gusto: quel bottone DEVE essere questo
    // componente — è lo stesso elenco di cose creabili del desktop — e deve
    // sembrare i suoi due fratelli, che non sono menu.
    // La pelle è quella di sempre (`raised-control` + `edge-lit`): la fila
    // nasceva piatta, e un comando che prende colore solo sotto il dito non si
    // trova. Il raggio resta standard su tutti e quattro gli angoli perché
    // questo tasto sta in MEZZO, dove l'arco dello schermo non arriva.
    triggerVariant === 'bar'
      ? `edge-lit flex min-w-[64px] h-11 flex-col items-center justify-center gap-0.5 rounded-xl px-3 ${RAISED_CONTROL} text-app-text transition-colors`
      : triggerVariant === 'header'
      ? `edge-lit ${isMobile ? 'h-11 w-11 justify-center' : 'h-7'} flex items-center gap-1.5 rounded-lg ${RAISED_CONTROL} text-app-text transition-colors flex-shrink-0`
      : triggerVariant === 'ghost'
        ? `${isMobile ? 'w-11 h-11' : 'w-7 h-7'} flex items-center justify-center text-app-text hover:text-app-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0`
        : TRIGGER_CLASS_PILL;
  // Il glifo cresce col dito su OGNI variante, «pill» compresa: il box della
  // pill adesso è 36px sotto i 768px (ROW_ACTION_BOX), e un «+» da 14 al centro
  // di 36 sembra un errore di misura. L'esclusione della pill era corretta
  // finché la pill era 24 e un glifo da 18 l'avrebbe riempita fino al bordo.
  // 16 e non 14, e il metro l'ha dato Attilio: «il +, confrontandolo con
  // quello di WhatsApp, mi sembra più piccolo». In una scatola da 28 un glifo
  // da 14 occupa metà larghezza e legge come mezzo comando; 16 la riempie
  // senza toccarne i bordi. Col dito la scatola è 36, quindi il glifo sale a 20.
  const triggerIconSize = triggerVariant === 'bar' ? 22 : isMobile ? 20 : 16;

  const menuItems = (
    <PaneAddMenuItems
      scope={scope}
      onNewChat={onNewChat}
      onAddPane={onAddPane}
      availableTypes={availableTypes}
      onClose={close}
    />
  );

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleClick}
        className={`${triggerBase} ${noElectronDrag ? 'app-no-drag' : ''} ${triggerClassName}`}
        // La compensazione ottica vale solo dove c'è un glifo a sinistra e del
        // testo a destra (la variante 'header' col suo ⌘N). Vedi la costante.
        style={triggerVariant === 'header' && !isMobile ? { ...GLYPH_KBD_PADDING, ...(noElectronDrag ? { WebkitAppRegion: 'no-drag' } : null) } as React.CSSProperties : (noElectronDrag ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined)}
        {...(noElectronDrag ? NO_DRAG_REGION : {})}
        title={triggerTitle}
        aria-label={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="pane-add-menu-trigger"
      >
        <Plus size={triggerIconSize} aria-hidden="true" />
        {triggerLabel && (
          <span className={triggerVariant === 'bar' ? 'text-[10px] font-medium leading-none' : 'text-[13px] font-medium'}>
            {triggerLabel}
          </span>
        )}
        {triggerKbd && !isMobile && (
          <kbd className="kbd flex-shrink-0 hidden md:inline" aria-hidden="true">{triggerKbd}</kbd>
        )}
      </button>

      {/* Dropdown desktop E foglio mobile: entrambi sono `Menu`. Il foglio
          mobile lo rende `Menu` stesso quando isMobile — anche per la
          presentazione 'palette', perché una palette centrata è un idioma
          desktop e sul telefono il foglio è quello giusto. */}
      <Menu
        open={open && (isMobile || presentation === 'dropdown')}
        anchorRef={buttonRef}
        onClose={close}
        minWidth={150}
        testId="pane-add-menu"
        ariaLabel="New"
      >
        {menuItems}
      </Menu>

      {paletteIsOpen && createPortal(
        /* Centered ⌘K-style palette — the standalone add menu as a command
           surface. Same backdrop + panel grammar as the command palette
           (lib/modalStyles.ts), narrower because it's a fixed action list.
           `MODAL_LAYER` e non `z-[60]`: a 60 finiva SOTTO ogni popover
           (Z_POPOVER = 9999) e un dropdown già aperto si disegnava nitido
           sopra la palette e sopra il suo velo. */
        <div
          className={`fixed inset-0 ${MODAL_LAYER} flex items-start justify-center pt-[12vh]`}
          onClick={close}
          data-testid="pane-add-palette"
        >
          <div className={MODAL_BACKDROP} />
          <div
            ref={paletteRef}
            role="menu"
            aria-label="New"
            tabIndex={-1}
            onKeyDown={onPaletteKeyDown}
            /* `text-[12px]`: il pannello e' portato su `document.body`, cioe'
               FUORI dal wrapper dove App scrive `fontSize` — qualunque testo
               senza classe di dimensione ricade sui 16px di default del
               browser. Ci e' gia' cascato l'header (ESC a 16px accanto a
               lettere da 12px, misurato). Una base esplicita chiude la CLASSE
               di bug, non solo l'istanza. */
            className={`relative w-full max-w-[300px] mx-4 ${MODAL_PANEL} py-1 text-[12px] outline-none`}
            onClick={(e) => e.stopPropagation()}
            data-testid="pane-add-menu"
          >
            {/* Nessuna intestazione. C'era «NEW» + un chip ESC: un titolo che
                ripete cosa sia una lista di cose da creare, e il promemoria di
                un tasto che sanno tutti — 38px di cromatura, piu' alti di una
                riga, con un 10px accostato a un 16px in due grigi diversi.
                Questa non e' una palette di RICERCA (⌘K ha il footer di hint
                perche' li' l'interazione non e' ovvia): e' una lista d'azione
                fissa, cioe' un menu che si apre al centro. I menu non si
                presentano. Cosi' palette e dropdown rendono identici. */}
            {menuItems}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
