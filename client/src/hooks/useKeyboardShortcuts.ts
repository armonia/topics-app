/**
 * useKeyboardShortcuts — App-wide keyboard handler with the ref-mirror
 * pattern (CRITIQUE C2 fix).
 *
 * Today's keyboard listener re-mounts on every panel focus / topic
 * load / modal toggle because the effect deps include focusedPanelId,
 * openPanels, topics, and four modal flags — each of which changes
 * independently of the handler's actual identity.
 *
 * The fix is NOT just file extraction. The real fix is: mirror every
 * read-on-event-only value (focused pane, open panels, topics list,
 * focused project path, four modal snapshots) into refs via no-deps
 * useEffects, then read them via `.current` inside the handler. The
 * keydown listener then registers ONCE on mount with deps containing
 * only stable callbacks — no churn on focus/open changes.
 *
 * Also owns the `open-all-boards` custom event listener.
 */

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { UtilityPanelType } from '../state/pane/adapters/utilityPanelId';
import { isDesktop, isTauri } from '../lib/shell';
import { reloadAllWindows } from '../lib/shell/app';
import { hasOpenModalSurface } from '../lib/modalSurface';
import type { Topic } from '../types';
import { undo as undoUndo, redo as undoRedo, isTextInputFocused } from '../contexts/UndoContext';
import { isProjectPaneId, getProjectPathFromPaneId, sessionKeyForPaneId, type ClosedTabRecord } from '../state/pane/adapters';
import { OPEN_ADD_PALETTE_EVENT } from '../components/Shared/PaneAddMenu';

export interface UseKeyboardShortcutsArgs {
  // Snapshots — mirrored into refs so the handler reads fresh state
  // without re-registering on every change.
  focusedPanelId: string | null;
  openPanels: string[];
  /** paneIds open inside each project window, keyed by projectPath. Used to
   *  flatten Cmd+1-9 across both top-level panels and project sub-panes. */
  projectOpenPanes: Record<string, string[]>;
  topics: Record<string, Topic>;
  focusedProjectPath: string | undefined;
  showSearch: boolean;
  showNewTopic: false | { projectPath?: string };
  showShortcuts: boolean;
  showFileSearch: false | { projectPaths: string[]; mode: 'name' | 'content' };
  /** Paid New Chat gate — when false, ⌘⇧N (New Topic modal) is inert (mirrored into a ref). */
  // Stable callbacks (must not change identity each render).
  handleClosePanel: (topicId: string) => void;
  toggleSidebar: () => void;
  handleOpenAsPage: (type: UtilityPanelType) => void;
  setFocusedPanelId: (id: string) => void;
  /** Reopen a previously-closed tab (stable identity). */
  handleReopenClosedTab: (record: ClosedTabRecord) => void;
  /** Recently-closed tabs, newest first. Snapshot — mirrored into a ref. */
  closedTabs: ClosedTabRecord[];
  /** Session-key selector — read fresh via ref, not mirrored as a snapshot. */
  isSessionStreaming: (sessionKey: string) => boolean;
  /** Aborts the current turn (SIGINT-style) without killing the session. */
  stopSession: (sessionKey: string) => Promise<boolean>;
  // Modal setters (React useState setters — stable identity).
  setShowSearch: Dispatch<SetStateAction<boolean>>;
  /** Palette scope — ⌘K apre 'all', ⌘⇧P apre 'projects' (salta a un progetto). */
  setSearchScope: Dispatch<SetStateAction<'all' | 'projects'>>;
  setShowNewTopic: Dispatch<SetStateAction<false | { projectPath?: string }>>;
  setShowShortcuts: Dispatch<SetStateAction<boolean>>;
  /** ⌘, — le Preferenze, come su ogni app macOS. */
  setShowSettings: Dispatch<SetStateAction<boolean>>;
  setShowFileSearch: Dispatch<SetStateAction<false | { projectPaths: string[]; mode: 'name' | 'content' }>>;
}

/**
 * Build the flat ordered tab list used by Cmd+1-9. Each entry maps a global
 * index → either a top-level panel (no innerPaneId) or one project sub-pane
 * (panelId is the project's panelId, innerPaneId is the sub-pane).
 *
 * Top-level non-project panels contribute one slot each; project panels
 * contribute one slot per inner pane in the order reported by the project's
 * persistence layer. When projectOpenPanes is missing for a project (e.g.
 * the project hasn't mounted yet), we fall back to a single slot for the
 * project panel so Cmd+N at minimum still focuses it.
 */
function buildGlobalTabList(
  openPanels: string[],
  projectOpenPanes: Record<string, string[]>,
): Array<{ panelId: string; innerPaneId?: string }> {
  const list: Array<{ panelId: string; innerPaneId?: string }> = [];
  for (const panelId of openPanels) {
    if (isProjectPaneId(panelId)) {
      const projectPath = getProjectPathFromPaneId(panelId);
      const innerPanes = projectPath ? projectOpenPanes[projectPath] : undefined;
      if (innerPanes && innerPanes.length > 0) {
        for (const innerPaneId of innerPanes) {
          list.push({ panelId, innerPaneId });
        }
      } else {
        list.push({ panelId });
      }
    } else {
      list.push({ panelId });
    }
  }
  return list;
}

export function useKeyboardShortcuts(args: UseKeyboardShortcutsArgs): void {
  // ---- Mirror snapshots into refs (no-deps useEffects = every render) ----
  const focusedPanelIdRef = useRef(args.focusedPanelId);
  const openPanelsRef = useRef(args.openPanels);
  const projectOpenPanesRef = useRef(args.projectOpenPanes);
  const topicsRef = useRef(args.topics);
  const focusedProjectPathRef = useRef(args.focusedProjectPath);
  const closedTabsRef = useRef(args.closedTabs);
  const modalsRef = useRef({
    showSearch: args.showSearch,
    showNewTopic: args.showNewTopic,
    showShortcuts: args.showShortcuts,
    showFileSearch: args.showFileSearch,
  });
  useEffect(() => { focusedPanelIdRef.current = args.focusedPanelId; });
  useEffect(() => { openPanelsRef.current = args.openPanels; });
  useEffect(() => { projectOpenPanesRef.current = args.projectOpenPanes; });
  useEffect(() => { topicsRef.current = args.topics; });
  useEffect(() => { focusedProjectPathRef.current = args.focusedProjectPath; });
  useEffect(() => { closedTabsRef.current = args.closedTabs; });
  useEffect(() => {
    modalsRef.current = {
      showSearch: args.showSearch,
      showNewTopic: args.showNewTopic,
      showShortcuts: args.showShortcuts,
      showFileSearch: args.showFileSearch,
    };
  });

  // ---- Keyboard listener — registered ONCE on mount (modulo stable callback identity) ----
  const {
    handleClosePanel, toggleSidebar,
    setFocusedPanelId, handleReopenClosedTab,
    setShowSearch, setSearchScope, setShowNewTopic, setShowShortcuts, setShowSettings, setShowFileSearch,
    isSessionStreaming, stopSession,
  } = args;

  useEffect(() => {
    /**
     * Il perimetro di ⌘P e ⌘F: il progetto a FUOCO per primo, poi gli altri
     * APERTI come tab. È così che si lavora qui — un progetto per tab — e
     * cercare in uno solo quando ne hai tre aperti risponde «non c'è» di una
     * cosa che c'è nella tab accanto.
     *
     * Ripiego sui progetti noti dalle topic quando non c'è niente a fuoco:
     * meglio cercare da qualche parte che non aprire nulla e sembrare rotti.
     */
    const searchProjectPaths = (): string[] => {
      const focused = focusedProjectPathRef.current;
      const open = openPanelsRef.current
        .filter((id) => isProjectPaneId(id))
        .map((id) => getProjectPathFromPaneId(id))
        .filter(Boolean) as string[];
      const ordered = [...new Set([...(focused ? [focused] : []), ...open])];
      if (ordered.length > 0) return ordered;
      return [...new Set(Object.values(topicsRef.current).map(t => t.projectPath).filter(Boolean))] as string[];
    };

    /** ⌘P = per nome, ⌘F = nel contenuto. Stessa superficie, due modi. */
    const toggleFileSearch = (mode: 'name' | 'content') => {
      setShowFileSearch(prev => {
        // Premere l'altro tasto mentre è già aperta CAMBIA modo invece di
        // chiudere: chiudere e riaprire per passare da nome a contenuto è
        // esattamente l'attrito che questa superficie unica toglie.
        if (prev) return prev.mode === mode ? false : { ...prev, mode };
        const projectPaths = searchProjectPaths();
        if (projectPaths.length === 0) return false;
        return { projectPaths, mode };
      });
    };

    // Right-⌘ TAP (press & release, alone) → focus the task composer. Armed by
    // a bare MetaRight keydown; fires on its keyup only if nothing else happened
    // in between (another key, click, wheel, focus loss) and the tap was quick —
    // so right-⌘ held as a modifier (⌘C, ⌘click, ⌘tab) never triggers it.
    let rightCmdTapAt = 0;
    const disarmRightCmdTap = () => { rightCmdTapAt = 0; };

    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      if (e.code === 'MetaRight' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        rightCmdTapAt = Date.now();
      } else {
        // Any other key while (or before) the right-⌘ is down = it's a chord,
        // not a tap.
        rightCmdTapAt = 0;
      }

      // Cmd+Z / Cmd+Shift+Z — UI undo/redo
      if (isMod && (e.key === 'z' || e.key === 'Z')) {
        if (!isTextInputFocused(e.target)) {
          e.preventDefault();
          if (e.shiftKey) {
            undoRedo();
          } else {
            undoUndo();
          }
          return;
        }
      }

      // ⌘K — command palette (everything: topics, messages, files, actions).
      // Deliberately NOT gated on text-input focus: the palette is reachable
      // from anywhere, including a focused terminal (matches the old behavior).
      if (isMod && e.key === 'k') {
        e.preventDefault();
        setSearchScope('all');
        setShowSearch(prev => !prev);
        return;
      }

      // ⌘N — the centered "New…" add palette (the sidebar header's "+").
      // Event-based so the palette state stays inside <PaneAddMenu> — same
      // pattern as topics:open-project-picker. (Moved off ⌘J: ⌘N is the
      // natural "new" key; Electron's default new-window is suppressed by
      // the preventDefault. In a plain browser tab the browser owns ⌘N —
      // Electron is the primary target.) ⌘⇧N keeps the New Topic modal.
      if (isMod && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        if (e.shiftKey) {
          setShowNewTopic({});
          return;
        }
        window.dispatchEvent(new CustomEvent(OPEN_ADD_PALETTE_EVENT));
        return;
      }

      // ⌘T — UNA CHAT NUOVA, secca. La stessa convenzione di ogni browser (e di
      // Dia, da cui arriva la richiesta): ⌘T apre la cosa che apri di più, senza
      // chiedere quale. ⌘N resta la palette «New…», che serve quando la cosa da
      // aprire NON è una chat — le due non si sostituiscono, si dividono il
      // lavoro: la scorciatoia secca per il 90% dei casi, la lista per il resto.
      //
      // Passa dal bus `topics:new-chat` che App già ascolta (lo usa il rimando
      // «nuova chat» del composer): nessuna callback nuova da tenere stabile, e
      // un solo punto in cui «crea una chat» è definito.
      //
      // `!e.shiftKey`: ⌘⇧T è «riapri la tab chiusa», e sta più sotto.
      if (isMod && !e.shiftKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('topics:new-chat'));
        return;
      }

      // ⌘⇧P — TROVA UN PROGETTO (la palette, pre-scopata su 'projects').
      //
      // Stava su ⌘F, che è la lettera sbagliata: in ogni applicazione del mondo
      // ⌘F vuol dire «cerca QUI DENTRO», non «cambia contesto». ⌘⇧P era libero
      // e in VS Code è già il tasto delle cose che si scelgono da un elenco.
      // Va controllato PRIMA di ⌘P: con Shift premuto `e.key` è 'P' maiuscola,
      // quindi i due rami non si sovrappongono, ma l'ordine rende esplicito che
      // il più specifico viene prima.
      if (isMod && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        setSearchScope('projects');
        setShowSearch(prev => !prev);
        return;
      }

      // ⌘P — apri un file per NOME (VS Code muscle memory).
      //
      // Fino al 2026-08-06 questo tasto si annunciava «Quick-open file» e apriva
      // un grep nel CONTENUTO: l'etichetta diceva una cosa e il tasto ne faceva
      // un'altra, mentre la ricerca per nome viveva sepolta dentro ⌘K. Ora fa
      // ciò che dichiara. `preventDefault` sempre, o si apre la stampa.
      if (isMod && !e.shiftKey && e.key === 'p') {
        e.preventDefault();
        toggleFileSearch('name');
        return;
      }

      // ⌘F — CERCA DENTRO: progetto a fuoco più quelli aperti.
      //
      // CRITICO: mai rubare la find a un campo di testo, al terminale (la
      // textarea di xterm) o a un editor — si esce SENZA preventDefault, così
      // la superficie a fuoco tiene la sua ⌘F. È l'unico ramo con questa
      // uscita, ed è la ragione per cui ⌘F qui non è mai stata invadente.
      //
      // L'ECCEZIONE è la ricerca stessa: quando è già aperta il fuoco sta nel
      // SUO campo, quindi la guardia scattava e ⌘F non commutava più il modo —
      // il tasto sembrava morto proprio nella superficie che comanda. Un campo
      // che appartiene alla ricerca non è un campo da cui difenderla.
      if (isMod && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        if (!modalsRef.current.showFileSearch && isTextInputFocused(e.target)) return;
        e.preventDefault();
        toggleFileSearch('content');
        return;
      }

      if (isMod && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // ⇧⌘T (primary) / ⌘⇧U (legacy alias) → reopen the most recently closed
      // tab. The target is resolved synchronously from the in-memory
      // recently-closed stack (`closedTabs[0]`), so reopen is instant for chats
      // (Warp / VS Code parity — both also bind ⇧⌘T to "reopen closed tab").
      // topics-app's primary surface is the Electron desktop app, where ⇧⌘T is
      // free: a packaged BrowserWindow has no browser tabs to "reopen", so
      // there is nothing to contend with. In a plain dev-browser tab the
      // preventDefault below overrides Chrome's reopen-tab while the app is
      // focused, which is the intended in-app behavior. The Electron app ALSO
      // claims ⇧⌘T as a native menu accelerator → `reopen-closed-tab` IPC (see
      // electron-app/main.ts + App.tsx) so the chord still fires when focus is
      // inside a native pane that swallows the renderer keydown.
      if (
        isMod && e.shiftKey &&
        (e.key === 't' || e.key === 'T' || e.key === 'u' || e.key === 'U')
      ) {
        e.preventDefault();
        const last = closedTabsRef.current[0];
        if (last) handleReopenClosedTab(last);
        return;
      }

      // Tauri only: ⌘R / ⌘⇧R reload the app. The native View ▸ Reload menu item
      // exists (lib.rs) but its key equivalent is swallowed by the focused
      // WKWebView before the menu sees it, so the accelerator never fires — we
      // intercept it here in the renderer (which DOES receive the keydown) and
      // reload directly. Electron's native menu reload works, and the web build
      // wants the browser's own reload, so this is gated to Tauri.
      //
      // Su macOS questo ramo NON scatta: il monitor NSEvent di lib.rs vede ⌘R
      // prima della webview e ingoia l'evento (`return nil`), perché deve
      // vincere anche quando il fuoco sta in una pane browser o in un terminale.
      // Resta la strada di Windows/Linux e la rete di sicurezza se quel monitor
      // sparisce — e chiama `reloadAllWindows`, cioè la stessa semantica
      // «riparti tutta» che il nativo applica con `reload_all_ui_windows`.
      //
      // `!e.shiftKey`: ⌘⇧R è "Record voice" — lo dice il pannello delle
      // scorciatoie, lo dice il tooltip del microfono, e ChatInput lo ascolta.
      // Questo ramo lo prendeva prima (capture, su window) e RICARICAVA L'APP:
      // sotto Tauri il dettato da tastiera semplicemente non esisteva, e con
      // esso se ne andava anche il testo non ancora inviato.
      if (isTauri && isMod && !e.shiftKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        // TUTTE le finestre: con i gruppi staccati, ricaricarne una sola lascia
        // due versioni dello stesso client sullo stesso pane-store.
        void reloadAllWindows();
        return;
      }

      // Desktop (Electron + Tauri): ⌘W closes the focused PANE, not the window.
      // Under Tauri the native menu's close_window accelerator is removed (lib.rs)
      // so this is the sole ⌘W handler; it reaches the focused pane whenever focus
      // is in the main webview (a child browser webview that has focus swallows
      // the keydown — that edge gets a menu accelerator in the browser-pane phase).
      if (isDesktop && isMod && e.key === 'w') {
        e.preventDefault();
        const fp = focusedPanelIdRef.current;
        if (!fp) return;
        // Give nested handlers (e.g. a focused project's GroupLayout)
        // first refusal — they close their inner active sub-tab and
        // mark the event handled. If nobody handles, fall back to
        // closing the App-level panel.
        const evt = new CustomEvent('close-focused-pane', {
          cancelable: true,
          detail: { panelId: fp },
        });
        window.dispatchEvent(evt);
        if (evt.defaultPrevented) return;
        handleClosePanel(fp);
        return;
      }

      // Tab cycling (standard): ⌃Tab → next tab, ⌃⇧Tab → previous, and ⌘⇧Tab
      // → previous (⌘Tab is reserved by macOS for app-switching, so the ⌘ pair
      // only does previous). Cycles the TOP-LEVEL panels relative to the focused
      // one, wrapping. When focus is inside a native browser pane this keydown is
      // swallowed by the OS view — the native key-forwarder (Electron before-
      // input-event / Tauri NSEvent monitor) re-dispatches it so it still fires.
      if (e.key === 'Tab' && (e.ctrlKey || (e.metaKey && e.shiftKey))) {
        e.preventDefault();
        const panels = openPanelsRef.current;
        if (panels.length >= 2) {
          const cur = focusedPanelIdRef.current;
          const idx = cur ? panels.indexOf(cur) : -1;
          const dir = e.shiftKey ? -1 : 1; // ⇧ → previous, else next
          const base = idx < 0 ? 0 : idx;
          const nextId = panels[(base + dir + panels.length) % panels.length];
          setFocusedPanelId(nextId);
        }
        return;
      }

      if (isDesktop && isMod && e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key) - 1;
        const panels = openPanelsRef.current;
        const projectPanes = projectOpenPanesRef.current;
        const flat = buildGlobalTabList(panels, projectPanes);
        if (idx >= flat.length) return; // let lower handlers see it (no global slot)
        e.preventDefault();
        // capture phase + stopImmediatePropagation suppresses the legacy
        // PaneTabBar local handler (also bound on window in capture phase),
        // so the inner project's Cmd+N never races with the global mapping.
        e.stopImmediatePropagation();
        const target = flat[idx];
        setFocusedPanelId(target.panelId);
        if (target.innerPaneId) {
          // Hop into the project window's inner pane. ProjectWindow listens
          // for this event and calls its `handleActivatePane` once the
          // panel becomes the focused one.
          const projectPath = getProjectPathFromPaneId(target.panelId);
          window.dispatchEvent(new CustomEvent('global-tab:focus-inner', {
            detail: { projectPath, paneId: target.innerPaneId },
          }));
        }
        return;
      }

      // ⌘, — Preferenze. La palette dei comandi lo annunciava gia' accanto a
      // "Settings" (ActionPill shortcut="⌘,"), ma non lo ascoltava nessuno: la
      // scorciatoia piu' automatica del Mac era scritta e basta.
      //
      // `isMod` è `metaKey || ctrlKey`, quindi qui passa anche `Ctrl+,`. Su Mac
      // ⌘, è assoluto e deve funzionare anche mentre scrivi — è la convenzione
      // di sistema. `Ctrl+,` no: dentro un terminale xterm o un editor
      // CodeMirror è un tasto VERO, e questo handler è in capture su `window`,
      // quindi il `preventDefault()` incondizionato lo mangiava prima che
      // arrivasse alla superficie a fuoco. Ctrl cede il passo a chi sta
      // scrivendo, ⌘ no.
      if (isMod && !e.shiftKey && e.key === ',' && (e.metaKey || !isTextInputFocused(e.target))) {
        e.preventDefault();
        setShowSettings(true);
        return;
      }

      if (isMod && (e.key === '?' || e.key === '/')) {
        e.preventDefault();
        setShowShortcuts(prev => !prev);
        return;
      }

      if (e.key === 'Escape') {
        const m = modalsRef.current;
        if (m.showFileSearch !== false) { setShowFileSearch(false); e.preventDefault(); return; }
        if (m.showShortcuts) { setShowShortcuts(false); e.preventDefault(); return; }
        if (m.showSearch) { setShowSearch(false); e.preventDefault(); return; }
        if (m.showNewTopic) { setShowNewTopic(false); e.preventDefault(); return; }

        // I quattro flag sopra sono i modali che QUESTO hook sa chiudere. Ma
        // l'app ne ha molti altri (Impostazioni, roster agenti, editor di
        // profilo, lightbox delle anteprime, …) che si chiudono da sé: con uno
        // di quelli aperto, Escape cadeva qui sotto e ammazzava il turno in
        // streaming DIETRO al modale. Il DOM sa quali modali sono aperti
        // meglio di una lista scritta a mano — vedi lib/modalSurface.
        if (hasOpenModalSurface()) return;

        // Niente da chiudere — come in claude-code, Escape interrompe il turno
        // del pane a fuoco (stile SIGINT: la sessione resta viva). Scatta solo
        // se quel pane sta davvero streammando, quindi un Escape a vuoto resta
        // un no-op.
        //
        // Il paneId NON è la sessionKey: per una chat il pane è il TOPIC
        // (`<uuid>`), la sessione è `topic:<uuid8>`. Usarlo com'era —
        // `focusedPanelId` come chiave — voleva dire cercare una sessione che
        // non esiste: `isSessionStreaming` diceva sempre di no e Escape non
        // interrompeva MAI, in silenzio, tranne nei pane `session-viewer:`.
        const sessionKey = sessionKeyForPaneId(focusedPanelIdRef.current, topicsRef.current);
        if (sessionKey && isSessionStreaming(sessionKey)) {
          e.preventDefault();
          void stopSession(sessionKey);
          return;
        }
      }
    };

    // Capture phase: fires before the per-PaneTabBar Cmd+1-9 handlers, so the
    // global tab list owns the mapping when it has a slot to claim.
    // Companion listeners for the right-⌘ tap: the keyup decides (tap < 400 ms
    // with nothing in between), everything else just disarms.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'MetaRight') return;
      if (rightCmdTapAt && Date.now() - rightCmdTapAt < 400) {
        window.dispatchEvent(new CustomEvent('task-composer:focus'));
      }
      rightCmdTapAt = 0;
    };

    window.addEventListener('keydown', handler, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', disarmRightCmdTap, true);
    window.addEventListener('wheel', disarmRightCmdTap, true);
    window.addEventListener('blur', disarmRightCmdTap);
    return () => {
      window.removeEventListener('keydown', handler, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousedown', disarmRightCmdTap, true);
      window.removeEventListener('wheel', disarmRightCmdTap, true);
      window.removeEventListener('blur', disarmRightCmdTap);
    };
  }, [
    handleClosePanel,
    toggleSidebar,
    handleReopenClosedTab,
    setShowSearch,
    setSearchScope,
    setShowNewTopic,
    setShowShortcuts,
    setShowSettings,
    setShowFileSearch,
    setFocusedPanelId,
    isSessionStreaming,
    stopSession,
  ]);

}
