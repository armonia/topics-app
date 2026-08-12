/**
 * usePaneLifecycle — Hook 2 of the StandaloneChatGroup refactor (PLAN v2).
 *
 * Owns action handlers exposed to <PaneTabBar> and the JSX. Receives
 * `ordering.ops` and `active` to avoid setter sharing (CRITIQUE B2/B10).
 * The browser singleton flows through `ordering.ops.ensureBrowserPane`;
 * close-others bulk removal flows through `ordering.ops.removeLocalPanes`.
 *
 * Cross-group drag stays in the component (CRITIQUE B9 decision).
 */

import { useCallback, useMemo, useState } from 'react';
import { isUtilityPanelType } from '../../../state/pane/adapters/utilityPanelId';
import type { PaneType } from '../../../types';
import {
  isBrowserPaneId,
  isTerminalPaneId,
  getBrowserContextFromPaneId,
  getTerminalSessionFromPaneId,
  addBrowserTombstone,
  newBrowserContextId,
} from '../../../state/pane/adapters';
import { primaryFromSoloCellKey } from '../soloCells';
import { canSplitPane, standaloneSplitSurface } from '../splitRules';
import { clearBrowserSpawner } from '../../../state/browserSpawner';
import { isTauri } from '../../../lib/shell';
import { tauriInvoke } from '../../../lib/shell/tauri';
import { normalizeTerminalAgent } from '../../../lib/terminalAgents';
import type { UsePaneLifecycleArgs, UsePaneLifecycleReturn } from './standaloneTypes';
import { popOutTopic, popOutTopics } from '../../../lib/popOutTopic';

/**
 * Per-pane-kind close-side-effect descriptor. Keeps handleClosePane +
 * handleCloseOthers data-driven instead of three near-duplicated branches
 * with subtle differences in which side effects fire and whether focus
 * restoration is needed.
 *
 *   matches      — pane-id prefix check (isBrowserPaneId, etc.)
 *   sideEffect   — fire-and-forget server DELETE etc.; called with the
 *                  pane id once per close. Returning null means no side
 *                  effect (e.g. a browser pane is purely client-side).
 *   localManaged — `true` for panes whose lifecycle is owned by the
 *                  local ordering store; close means removeLocalPane +
 *                  onClosePanel + focus restore. `false` for panes that
 *                  flow entirely through `onClosePanel` (chat, terminal).
 */
interface PaneKindHandler {
  matches: (paneId: string) => boolean;
  sideEffect: ((paneId: string) => void) | null;
  localManaged: boolean;
}

const PANE_KIND_HANDLERS: PaneKindHandler[] = [
  {
    matches: isBrowserPaneId,
    sideEffect: (id) => {
      const ctx = getBrowserContextFromPaneId(id);
      if (ctx) {
        // `keepalive: true` — questa DELETE parte spesso mentre la pagina si sta
        // chiudendo (il commit della chiusura differita durante pagehide). Una
        // fetch normale viene ANNULLATA dal browser quando il documento muore:
        // la richiesta non arriva, e il contesto server resta acceso. E' una
        // delle strade per cui si vedevano contesti vivi senza nessuna pane.
        fetch(`/api/browsers/${encodeURIComponent(ctx)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
        // Clear the spawner relationship so the "opened a browser" tab cue
        // disappears once the browser is closed (registry isn't auto-pruned).
        clearBrowserSpawner(ctx);
        // Write the cross-device close-tombstone so the tab actually closes on
        // OTHER devices LIVE (phone PWA / web), not just here. Project-inner
        // closes already did this in useProjectLayout; standalone/global browser
        // panes did NOT, so a tab closed on the Mac lingered on the PWA. Paired
        // with tombstoneSync's evictRemotelyClosedBrowserPanes on the peer.
        addBrowserTombstone(ctx);
        // E CHIUDI LA WEBVIEW NATIVA, qui, adesso — non aspettando che React
        // smonti la pane.
        //
        // L'unico chiamante di `browser_close` era la cleanup dell'effect in
        // useTauriBrowser, differita di 350 ms. Ma quando la chiusura viene
        // COMMITTATA durante l'unload della pagina (`flushPendingActions` su
        // pagehide/beforeunload: il countdown di 3 s che scade mentre l'app si
        // ricarica) React non ri-renderizza mai, quindi quella cleanup non gira
        // e `browser_close` non viene nemmeno accodato. Al giro dopo la pane non
        // esiste più — è stata chiusa apposta, col suo tombstone — quindi non si
        // rimonterà: nessuno chiuderà MAI quella webview. E le webview native
        // sopravvivono al reload per progetto (nativeBrowserRoster.ts: le pane
        // «RIUSANO la webview di prima»). Risultato: una pagina web dipinta
        // sopra l'interfaccia, senza una tab a cui appartenga, che se ne va solo
        // riavviando l'app.
        //
        // Perché è sicuro chiamarlo di qui: questo side effect gira su una
        // chiusura VERA, mai sul re-key transitorio dell'auto-split (che passa
        // dalla grazia dei 350 ms in useTauriBrowser), e `browser_open` è
        // idempotente — un doppio close è un no-op.
        //
        // Da NON fare: rimettere un reaper al boot che chiude gli avanzi.
        // nativeBrowserRoster.ts spiega perché è stato tolto — chiudeva alla
        // cieca anche le view che sarebbero state riusate.
        if (isTauri) {
          void tauriInvoke('browser_close', { id: ctx }).catch(() => {});
          // TRUE close (tombstone path, mai il re-key transitorio dell'auto-split):
          // recupera anche il WKWebsiteDataStore su disco. `browser_close` svuota
          // il CONTENUTO ma il silo cookie/localStorage/IndexedDB resta su disco per
          // sempre — l'audit del 2026-08-02 ha trovato ~1,1 GB di store che nessuna
          // pane riaprirà. Il purge cancella login/sessione: va bene SOLO qui, dove
          // la pane se ne va davvero (col tombstone). Il comando fa da sé il close
          // idempotente prima di rimuovere lo store.
          void tauriInvoke('browser_purge_data_store', { id: ctx }).catch(() => {});
        }
      }
    },
    localManaged: true,
  },
  {
    matches: isTerminalPaneId,
    sideEffect: (id) => {
      const sessionId = getTerminalSessionFromPaneId(id);
      if (sessionId) fetch(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    },
    localManaged: false,
  },
];

function findHandler(paneId: string): PaneKindHandler | undefined {
  return PANE_KIND_HANDLERS.find((h) => h.matches(paneId));
}

export function usePaneLifecycle(args: UsePaneLifecycleArgs): UsePaneLifecycleReturn {
  const {
    ordering, active,
    topics, gridItemKey,
    onClosePanel, onFocusPanel,
    onSplitPane, onUnsolo,
    onCreateTerminal, onMergeIntoCell, onPersistReorder, claudeSkipPermissions,
    stopSession,
  } = args;
  const { validatedOrderedIds } = ordering.derived;
  const { activePaneId } = active;

  // Settings modal trigger.
  const [settingsTopicId, setSettingsTopicId] = useState<string | null>(null);

  const handleReorderPanes = useCallback((newPaneIds: string[]) => {
    ordering.ops.reorder(newPaneIds);
    // Persist upstream too — the local ordering state alone doesn't survive
    // a reload (App.openPanels is what the boot path reads back).
    onPersistReorder?.(newPaneIds);
  }, [ordering.ops, onPersistReorder]);

  const handlePinPane = useCallback((paneId: string) => {
    ordering.ops.pin(paneId);
  }, [ordering.ops]);

  const handleAddPane = useCallback(async (type: PaneType, subType?: string) => {
    if (type === 'browser') {
      // Un contesto NUOVO a ogni click, come la voce Browser della sidebar
      // (App.handleStandaloneAddPane) e come il «+» dentro una finestra di
      // progetto, che appende sempre una pane in più. Senza contesto il
      // riduttore singleton riusava il primo browser del gruppo: il PRIMO click
      // apriva la pane, il SECONDO non faceva niente — nessuna tab, nessun
      // messaggio. Il riuso resta dov'è giusto: le navigazioni senza contextId
      // (WS/DOM legacy), che vogliono la pane esistente, non una in più.
      //
      // La pane vive nel pool standalone (group:default) e PanelGrid la mette
      // nella barra del pool. Quando il «+» appartiene a una cella splittata,
      // la si ri-mira dentro quella cella, come fa il ramo terminale sotto.
      const paneId = ordering.ops.ensureBrowserPane(newBrowserContextId());
      const browserTarget = primaryFromSoloCellKey(gridItemKey);
      if (paneId && browserTarget && onMergeIntoCell) {
        onMergeIntoCell(paneId, browserTarget);
      }
    } else if (type === 'terminal') {
      const termType = normalizeTerminalAgent(subType);
      // App-level creation appends the pane to openPanels, which PanelGrid
      // places in the main 'standalone' cell. When the "+" that was clicked
      // belongs to a SPLIT cell ('solo:<primary>'), re-target the new pane
      // into that cell — otherwise the tab visibly opens in the OTHER split
      // group's tab bar.
      const paneId = await onCreateTerminal?.(termType, claudeSkipPermissions);
      const targetPrimary = primaryFromSoloCellKey(gridItemKey);
      if (paneId && targetPrimary && onMergeIntoCell) {
        onMergeIntoCell(paneId, targetPrimary);
      }
    } else if (isUtilityPanelType(type)) {
      // Pane utility singleton (`__board__`, `__dashboard__`, `__cron__`) —
      // le possiede l'hook di lifecycle di App (handleOpenAsPage). Il bus è lo
      // stesso di `topics:open-project-picker`, così ogni ospite del «+» le apre
      // identicamente senza prop-threading.
      //
      // Elencare UN tipo a mano qui è già costato: quando Dashboard e Cron sono
      // uscite dal menu «Topics ▾» per entrare nel «+», le loro righe comparivano
      // e non facevano NIENTE — un no-op silenzioso, il difetto più difficile da
      // vedere. L'insieme è quello che il ricevitore già accetta.
      window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type } }));
    }
  }, [ordering.ops, claudeSkipPermissions, onCreateTerminal, gridItemKey, onMergeIntoCell]);

  const handleClosePane = useCallback((paneId: string) => {
    // PANE_KIND_HANDLERS centralises the side effects + local-vs-store
    // distinction. Per kind:
    //   browser  → localManaged + server DELETE; on close drop from local
    //              ordering FIRST (so the tab bar updates without waiting
    //              for the store→openPanels round trip), then call
    //              onClosePanel (purges App.openPanels + persisted state
    //              so the closed tab doesn't reappear on reload), then
    //              fire the DELETE. Refocus the next pane if the closed
    //              one was active.
    //              (purely client-side, no resource to release).
    //   terminal → store-managed; fire the server DELETE and let
    //              onClosePanel handle the rest. No refocus — the
    //              parent's close-cascade does it.
    //   chat (default) → onClosePanel only.
    const handler = findHandler(paneId);
    if (!handler) { onClosePanel(paneId); return; }

    // Defer BOTH the local-ordering drop AND the server-side DELETE to the
    // pending-action commit (3s after the X). The old flow dropped the tab
    // from the local ordering UPFRONT ("so the tab bar updates without
    // waiting") — but that erased the very tab that paints the countdown
    // fill, while the CELL stayed in the layout until commit: a ghost pane
    // with an invisible timer for 3s, reported live as "closing a
    // floating-split tab takes forever to settle". Keeping the tab in place
    // makes browser/viewer closes read exactly like chat closes (visible 3s
    // fill on the tab, then the whole cell leaves in one step); cancelling
    // the countdown leaves everything untouched. The server DELETE stays at
    // commit too — inline it would kill the PTY immediately and the xterm
    // pane would print "[Session ended]" mid-countdown.
    onClosePanel(paneId, () => {
      if (handler.localManaged) ordering.ops.removeLocalPane(paneId);
      handler.sideEffect?.(paneId);
    });
    if (handler.localManaged && activePaneId === paneId) {
      const remaining = validatedOrderedIds.filter((id) => id !== paneId);
      if (remaining.length > 0) onFocusPanel(remaining[0]);
    }
  }, [ordering.ops, activePaneId, validatedOrderedIds, onFocusPanel, onClosePanel]);

  // La pane si chiude solo se la chat è stata davvero buttata via, e a dirlo è
  // il server (`stopSession` risolve sul suo `cleared`). Quando decideva il
  // client, uno Stop su un primo turno che aveva già lavorato chiudeva la pane
  // di una chat che il server teneva intatta.
  const handleStopStreaming = useCallback((paneId: string) => {
    const topic = topics[paneId];
    if (!topic) return;
    void stopSession(topic.sessionKey).then((discarded) => {
      if (discarded) onClosePanel(paneId);
    });
  }, [topics, stopSession, onClosePanel]);

  const handleSettings = useCallback((paneId: string) => {
    setSettingsTopicId(paneId);
  }, []);

  const handlePopOut = useCallback((paneId: string) => {
    // Close the source pane only if a window actually opened — see popOutTopic.
    void popOutTopic(paneId).then((opened) => {
      if (opened) onClosePanel(paneId);
    });
  }, [onClosePanel]);

  // Pop the WHOLE group out into ONE window ("stacca il gruppo"): detach all its
  // topics together, then close the source panes only if a window actually
  // opened (same contract as handlePopOut, but for the group).
  const handlePopOutGroup = useCallback((topicIds: string[]) => {
    const ids = topicIds.filter(Boolean);
    if (ids.length === 0) return;
    void popOutTopics(ids).then((opened) => {
      if (opened) for (const id of ids) onClosePanel(id);
    });
  }, [onClosePanel]);

  // Determine if a pane can be split into its own grid cell — delegated to
  // the SHARED canSplitPane rule (splitRules.ts), the single source of truth
  // both surfaces' menus, drags and handlers gate on:
  //
  //   - the main pool is always splittable (single-tab split auto-spawns a
  //     draft companion in PanelGrid.handleSplitPane so the result is two
  //     visible cells);
  //   - a solo split cell is splittable only when it holds MORE than one tab
  //     (the lone tab has nothing left to split away from; a multi-tab
  //     member splits out into its own cell, like the drag path);
  //   - utility panes and drafts are no longer special-cased: utility panes
  //     render fine as solo cells, and draft cells survive promotion via the
  //     'topics:pane-id-remap' remap in PanelGrid — the drag path always
  //     allowed both, so the menu now agrees with it.
  const isSplittable = useCallback((id: string) => {
    if (!validatedOrderedIds.includes(id)) return false;
    return canSplitPane({
      surface: standaloneSplitSurface(gridItemKey),
      groupSize: validatedOrderedIds.length,
    });
  }, [gridItemKey, validatedOrderedIds]);

  const handleSplitRight = useCallback((paneId: string) => {
    if (!onSplitPane || !isSplittable(paneId)) return;
    onSplitPane(paneId, 'right');
  }, [onSplitPane, isSplittable]);

  const handleSplitDown = useCallback((paneId: string) => {
    if (!onSplitPane || !isSplittable(paneId)) return;
    onSplitPane(paneId, 'down');
  }, [onSplitPane, isSplittable]);

  const handleDetach = useMemo(() => {
    if (!onSplitPane) return undefined;
    return (paneId: string) => {
      if (!isSplittable(paneId)) return;
      onSplitPane(paneId, 'right');
    };
  }, [onSplitPane, isSplittable]);

  const handleUnsolo = useMemo(() => {
    if (!onUnsolo) return undefined;
    return (paneId: string) => {
      onUnsolo(paneId);
    };
  }, [onUnsolo]);

  // "Close Others" — same close path as handleClosePane, applied per pane.
  // Local panes (browser) are batch-removed from the ordering
  // store first so the tab bar collapses instantly, but EVERY pane still goes
  // through onClosePanel: that purges App.openPanels + the persisted store
  // (otherwise local panes resurrect on reload) and defers each server-side
  // DELETE into the pending-action commit, keeping the close countdown
  // cancellable exactly like a single close.
  const handleCloseOthers = useCallback((keepPaneId: string) => {
    const toClose = validatedOrderedIds.filter((id) => id !== keepPaneId);
    if (toClose.length === 0) return;

    const localToClose = toClose.filter((id) => findHandler(id)?.localManaged);
    if (localToClose.length > 0) ordering.ops.removeLocalPanes(localToClose);

    for (const id of toClose) {
      const h = findHandler(id);
      onClosePanel(id, h?.sideEffect ? () => h.sideEffect!(id) : undefined);
    }

    onFocusPanel(keepPaneId);
  }, [validatedOrderedIds, ordering.ops, onClosePanel, onFocusPanel]);

  return {
    settingsTopicId,
    setSettingsTopicId,
    handlers: {
      handleReorderPanes,
      handlePinPane,
      handleAddPane,
      handleClosePane,
      handleStopStreaming,
      handleSettings,
      handlePopOut,
      handlePopOutGroup,
      handleSplitRight,
      handleSplitDown,
      handleDetach,
      handleUnsolo,
      handleCloseOthers,
      isSplittable,
    },
  };
}
