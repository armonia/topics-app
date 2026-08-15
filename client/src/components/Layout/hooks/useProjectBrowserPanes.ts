/**
 * useProjectBrowserPanes — tutta la vita delle pane BROWSER dentro una
 * ProjectWindow: aprirle, navigarle, metterle a fuoco, chiuderle, e spostarle
 * in una cella propria appena nate. Estratto da `useProjectLayout` (erano tre
 * dei suoi effetti, ~240 righe).
 *
 * Possiede:
 *  - `ensureBrowserPaneAndNavigate`: la regola «una pane per contextId», il
 *    riuso di quella esistente, la semina dell'URL sulla pane (persistenza) e
 *    la coda dello split.
 *  - Le quattro sorgenti che la chiamano: WS `browser:navigate` e
 *    `browser:open-near-pane`, l'evento DOM `browser:open-and-navigate`, e il
 *    drenaggio delle navigazioni PARCHEGGIATE mentre la finestra era chiusa.
 *  - Le due richieste della pagina/agente: `browser:request-close` e
 *    `browser:request-focus`, entrambe dietro la stessa guardia di proprietà
 *    (agisce una sola superficie, mai due).
 *  - Lo split differito: la pane appena aggiunta esce dal gruppo ospite in una
 *    cella propria, orientata sullo spazio misurato — tranne su mobile.
 *
 * NON possiede:
 *  - La creazione della pane in sé (`handleAddPaneToGroup`), lo split
 *    (`handleSplitGroup`), la chiusura (`handleClosePane`), la persistenza
 *    (`updatePane`): li riceve come ref e li CHIAMA. Sono definiti in
 *    `useProjectLayout` centinaia di righe più in basso, ed è per questo che
 *    arrivano come ref e non come funzioni.
 *  - Il fuoco fra finestre di progetto: la guardia di appartenenza qui è per
 *    topic/projectPath/contextId, non per pannello a fuoco.
 */
import { useEffect, useRef, useState } from 'react';
import type { Pane, PaneGroup, PaneType, Topic, WSMessage } from '../../../types';
import {
  createPaneId,
  getBrowserContextFromPaneId,
  drainProjectBrowserNavigates,
  registerProjectWindow,
} from '../../../state/pane/adapters';
import { resolveBrowserNavigateUrl } from '../../../lib/browserNavUrl';
import { setBrowserSpawner } from '../../../state/browserSpawner';
import { chooseSplitOrientation } from '../gridWidths';

export interface UseProjectBrowserPanesArgs {
  projectPath: string;
  topics: Record<string, Topic>;
  panes: Pane[];
  groups: PaneGroup[];
  panesRef: React.RefObject<Pane[]>;
  groupsRef: React.RefObject<PaneGroup[]>;
  focusedGroupIdRef: React.RefObject<string | null>;
  setGroups: React.Dispatch<React.SetStateAction<PaneGroup[]>>;
  setFocusedGroupId: React.Dispatch<React.SetStateAction<string | null>>;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  onBrowserNavigateUrl?: (url: string, paneId?: string) => void;
  /** Handler definiti PIÙ IN BASSO in `useProjectLayout`, passati come ref
   *  proprio per questo: l'effetto si monta qui in cima e li chiama a runtime. */
  handleAddPaneToGroupRef: React.RefObject<((groupId: string, type: PaneType, subType?: string, paneKey?: string) => Promise<string | undefined>) | null>;
  /** La stessa cosa per un progetto SENZA gruppi: crea il gruppo insieme alla
   *  pane. Serve perché «Apri nel workspace» può arrivare su una finestra di
   *  progetto con tutte le tab chiuse, e lì `handleAddPaneToGroup` non ha
   *  nessun gruppo a cui appendere. */
  handleAddPaneWhenEmptyRef: React.RefObject<((type: PaneType, subType?: string, paneKey?: string) => Promise<string | undefined>) | null>;
  handleSplitGroupRef: React.RefObject<((sourceGroupId: string, paneId: string, targetGroupId: string, edge: 'left' | 'right' | 'top' | 'bottom', opts?: { fullRow?: boolean }) => void) | null>;
  handleClosePaneRef: React.RefObject<((groupId: string, paneId: string) => void) | null>;
  updatePaneRef: React.RefObject<((paneId: string, updates: Partial<Pane>) => void) | null>;
}

export function useProjectBrowserPanes({
  projectPath,
  topics,
  panes,
  groups,
  panesRef,
  groupsRef,
  focusedGroupIdRef,
  setGroups,
  setFocusedGroupId,
  onWSMessage,
  onBrowserNavigateUrl,
  handleAddPaneToGroupRef,
  handleAddPaneWhenEmptyRef,
  handleSplitGroupRef,
  handleClosePaneRef,
  updatePaneRef,
}: UseProjectBrowserPanesArgs): void {
  // A browser pane just added to a group, queued to be split OUT into its own
  // space-aware group beside the source (consumed by the effect below once the
  // pane is committed). Mirrors the standalone pendingSoloPanelId pattern.
  const [pendingBrowserSplit, setPendingBrowserSplit] = useState<{ paneId: string; sourceGroupId: string } | null>(null);
  // Set inside the WS/DOM browser-open effect; read by the parked-navigate drain
  // effect so a board "Apri nel workspace" that raced this window's mount still
  // opens its pane once the layout exists.
  const ensureBrowserPaneAndNavigateRef = useRef<((url: string, targetGroupId?: string, spawnerKey?: string, contextId?: string) => void) | null>(null);

  // Dichiara questa finestra al registro: chi vorrebbe promuovere qualcosa nel
  // workspace (la board, con «Apri nel workspace») può così sapere se la
  // finestra c'è GIÀ, invece di sparare `topics:open-project` a ogni click.
  useEffect(() => registerProjectWindow(projectPath), [projectPath]);

  // --- Browser-navigate listener (parity with StandaloneChatGroup) -----------
  //
  // When the server (PR #18+#19) or a local `/browser` slash command requests
  // a URL navigation, the canonical broadcast is `{type:"browser:navigate",
  // topicId, url}` over WS plus a `browser:open-and-navigate` CustomEvent on
  // window. Without this hook the bug surfaces: `usePaneOrdering` early-exits
  // when a ProjectWindowPane is open (`hasProjectPaneRef.current → return`),
  // expecting THIS hook to take over — but it never did before. Result: the
  // marker / tool call fires, the broadcast lands, no pane opens.
  //
  // What we do here:
  //   1. Match by topicId: only open a pane when the broadcast targets a
  //      topic visible in this ProjectWindow (any open chat pane bound to it,
  //      or the topic itself living under this projectPath).
  //   2. Ensure exactly one browser pane exists in the focused group
  //      (singleton). If it already exists, focus it; otherwise add it.
  //   3. Push the URL through `onBrowserNavigateUrl(url)` so the component-
  //      level `browserNavigateUrl` state can thread it into
  //      `<RemoteBrowserPanel navigateUrl={…} />`.
  //
  // No retries, no buffering — the URL flows through component state and the
  // panel consumes it via `onNavigateConsumed`. If the broadcast races the
  // pane mount, the navigateUrl prop will be honoured on first render.
  useEffect(() => {
    const ensureBrowserPaneAndNavigate = (rawUrl: string, targetGroupId?: string, spawnerKey?: string, contextId?: string) => {
      if (!rawUrl) return;
      // Rewrite localhost/127.0.0.1/*.local → the LAN https host for remote/mobile
      // clients, exactly as the standalone path does (usePaneOrdering). Without it
      // a project browser opened from another device gets a raw localhost URL it
      // can't reach (white pane) — and seedPaneUrl would persist that dead URL.
      // On Tauri/local this is a passthrough, so desktop behaviour is unchanged.
      const url = resolveBrowserNavigateUrl(rawUrl);
      // Default to the focused group (chat-driven navigation), but allow an
      // explicit target so a terminal-originated open lands beside the SAME
      // group as the terminal pane rather than wherever focus happens to be.
      // Fall back to the first group when nothing is focused yet: a freshly
      // opened project window can drain a parked "Apri nel workspace" navigate
      // before focus settles, and we still want the pane to land somewhere.
      // `undefined` quando il progetto non ha NESSUN gruppo — tutte le tab
      // chiuse, il ramo «No chats open». Non è una ragione per lasciar cadere
      // l'apertura: sotto, il ramo di creazione si fa dare la pane e il suo
      // gruppo insieme. Fino al 15/08 qui c'era un `return` muto, e «Apri nel
      // workspace» su un progetto vuoto non apriva niente senza dirlo.
      const fgid = targetGroupId ?? focusedGroupIdRef.current ?? groupsRef.current[0]?.id;

      // Reuse ANY existing browser in this project — refresh it in place rather
      // than spawning a second. A project shares one browser context across its
      // panes, so a duplicate would fight over the same Electron view.
      // Persist the URL onto the project pane deterministically at open — the
      // standalone path does this (usePaneOrdering persistBrowserPaneUrl) but the
      // project path relied solely on the timing-fragile onUrlChange render, so a
      // fast open could restore the tab to about:blank after a window restart.
      // updatePane (not persistBrowserPaneUrl, which no-ops for non-store project
      // panes) is the project-side persistence seam; round-trips via projectLayoutSync.
      const seedPaneUrl = (paneId: string): void => {
        if (url && url !== 'about:blank') updatePaneRef.current?.(paneId, { url });
      };

      // Per-session isolation: each contextId gets its OWN browser pane. Match
      // THIS contextId's pane (NOT "any browser in the project") so a second
      // session opening a browser in the same project gets its OWN pane instead of
      // STEALING the first's. The old code did find(type==='browser') + REBIND
      // (rename the existing pane to the incoming contextId), which collapsed EVERY
      // session in a project onto one shared browser — the "unica per tutti" bug.
      // Different contextIds are different native views (own WKWebView/WebContents-
      // View + own server Playwright context), so per-session panes coexist cleanly
      // in their own DOM slots; the new-pane path below creates one when absent.
      const existing = contextId
        ? panesRef.current.find(p => p.id === createPaneId('browser', contextId))
        : panesRef.current.find(p => p.type === 'browser');
      if (existing) {
        const grp = groupsRef.current.find(g => g.paneIds.includes(existing.id));
        if (grp) {
          setGroups(prev => prev.map(g => (g.id === grp.id ? { ...g, activePaneId: existing.id } : g)));
          setFocusedGroupId(grp.id);
        }
        const ctx = getBrowserContextFromPaneId(existing.id);
        if (ctx && spawnerKey) setBrowserSpawner(ctx, spawnerKey);
        seedPaneUrl(existing.id);
        onBrowserNavigateUrl?.(url, existing.id);
        return;
      }

      // None yet → add the browser to the source group, then queue a split so
      // it lands in its own space-aware cell BESIDE the chat/terminal instead
      // of sitting hidden as a tab. The split effect below consumes this once
      // the pane is committed and picks side-by-side vs stacked by space.
      queueMicrotask(async () => {
        const newId = fgid
          ? await handleAddPaneToGroupRef.current?.(fgid, 'browser', undefined, contextId)
          : await handleAddPaneWhenEmptyRef.current?.('browser', undefined, contextId);
        if (newId) {
          const ctx = getBrowserContextFromPaneId(newId);
          if (ctx && spawnerKey) setBrowserSpawner(ctx, spawnerKey);
          seedPaneUrl(newId);
          // Niente split quando il gruppo è nato adesso: non c'è nessun vicino
          // da cui staccarsi, e la pane è già sola nella sua cella.
          if (fgid) setPendingBrowserSplit({ paneId: newId, sourceGroupId: fgid });
          // Navigate the pane we just created — and ONLY that one. The old
          // untargeted call here fired before the pane even existed and landed
          // on whatever browser panes happened to be visible.
          onBrowserNavigateUrl?.(url, newId);
        }
      });
    };
    // Expose it so the parked-navigate drain effect (below) can open a pane for a
    // board "Apri nel workspace" that arrived while this window was still closed.
    ensureBrowserPaneAndNavigateRef.current = ensureBrowserPaneAndNavigate;

    const topicBelongsToThisProject = (topicId: string | undefined): boolean => {
      if (!topicId) return false;
      // Match if the topic is currently rendered as a chat pane here OR if its
      // projectPath matches ours. The latter handles broadcasts that arrive
      // before the user has explicitly opened the chat pane in this window.
      const inOpenChats = panesRef.current.some(
        p => p.type === 'chat' && p.topicId === topicId,
      );
      if (inOpenChats) return true;
      const t = topics[topicId];
      return !!t && t.projectPath === projectPath;
    };

    const unsubWS = onWSMessage((msg: WSMessage) => {
      const m = msg as unknown as { type?: string; topicId?: string; url?: string; paneId?: string; contextId?: string };
      if (m.type === 'browser:navigate' && m.url && topicBelongsToThisProject(m.topicId)) {
        // Bind the pane to the server-resolved contextId (== topic.id) so the
        // native CDP target registers under the id the agent's browser_* tools
        // resolve to (no invisible Playwright phantom). Falls back to topicId
        // (the chat-topic contextId) when the broadcast predates the field.
        ensureBrowserPaneAndNavigate(m.url, undefined, m.topicId, m.contextId ?? m.topicId);
      }
      // Terminal-originated open: only the project window whose layout actually
      // contains the terminal pane reacts; it opens the browser beside that
      // exact group (next to the terminal), not the focused group. The spawner
      // key is the terminal pane id so its tab gets the "opened a browser" cue.
      if (m.type === 'browser:open-near-pane' && m.url && m.paneId) {
        const g = groupsRef.current.find(gr => gr.paneIds.includes(m.paneId!));
        if (g) ensureBrowserPaneAndNavigate(m.url, g.id, m.paneId, m.contextId);
      }
    });

    const domHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ topicId?: string; url?: string; projectPath?: string; contextId?: string }>).detail;
      if (!detail?.url) return;
      // Belongs to this window if the event names THIS project path (the board's
      // "Apri nel workspace", which has no chat topic to key on) OR the topic is
      // one of ours (chat-driven /browser).
      const belongs =
        (!!detail.projectPath && detail.projectPath === projectPath) ||
        topicBelongsToThisProject(detail.topicId);
      if (!belongs) return;
      // chat-topic contextId === topicId (resolveContextIdForTopic); the board
      // passes an explicit contextId so the pane is steerable by the agent later.
      ensureBrowserPaneAndNavigate(detail.url, undefined, detail.topicId, detail.contextId ?? detail.topicId);
      // Handled live by a mounted window — drop any copy parked for the not-yet-
      // mounted case so it can't re-fire on a later remount.
      drainProjectBrowserNavigates(projectPath);
    };
    window.addEventListener('browser:open-and-navigate', domHandler);

    // Page-initiated close: a page (or the agent) called window.close(); App
    // bridges it to this event. Close the browser pane IF this project owns it —
    // the ownership guard means exactly one surface (app-level or the owning
    // project window) acts, never both. Mirrors a normal tab close (deferred,
    // animated, undo-able) via handleClosePane.
    const closeHandler = (e: Event) => {
      const ctx = (e as CustomEvent<{ contextId?: string }>).detail?.contextId;
      if (!ctx) return;
      const paneId = createPaneId('browser', ctx);
      const pane = panesRef.current.find(p => p.id === paneId);
      if (!pane) return; // not ours — another surface owns it
      const grp = groupsRef.current.find(g => g.paneIds.includes(paneId));
      if (grp) handleClosePaneRef.current?.(grp.id, paneId);
    };
    window.addEventListener('browser:request-close', closeHandler);

    // Page/agent-initiated focus (browser_focus_tab): activate the pane in its
    // group if THIS project owns it (same ownership guard as close). Reuses the
    // exact "activate existing browser" mutation from the open-and-navigate path.
    const focusHandler = (e: Event) => {
      const ctx = (e as CustomEvent<{ contextId?: string }>).detail?.contextId;
      if (!ctx) return;
      const paneId = createPaneId('browser', ctx);
      const pane = panesRef.current.find(p => p.id === paneId);
      if (!pane) return; // not ours — another surface owns it
      const grp = groupsRef.current.find(g => g.paneIds.includes(paneId));
      if (grp) {
        setGroups(prev => prev.map(g => (g.id === grp.id ? { ...g, activePaneId: paneId } : g)));
        setFocusedGroupId(grp.id);
      }
    };
    window.addEventListener('browser:request-focus', focusHandler);

    return () => {
      unsubWS();
      window.removeEventListener('browser:open-and-navigate', domHandler);
      window.removeEventListener('browser:request-close', closeHandler);
      window.removeEventListener('browser:request-focus', focusHandler);
    };
    // handleAddPaneToGroupRef is read via ref to avoid re-registering on every
    // render. Deps are the stable identity inputs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onWSMessage, onBrowserNavigateUrl, topics, projectPath]);

  // Open a browser pane for any "Apri nel workspace" navigate parked while this
  // window was closed (the board dispatches topics:open-project + enqueues here;
  // the racing browser:open-and-navigate event loses the mount, so the parked
  // copy is what actually opens the pane). Fires once the layout has a group to
  // host it; idempotent — a re-run finds the queue already drained.
  useEffect(() => {
    // Nessuna guardia su `groups.length`: i gruppi sono seminati in modo
    // SINCRONO dallo snapshot al mount (`useState(() => initial.groups)`),
    // quindi zero gruppi vuol dire zero gruppi, non «non ancora caricati» — e
    // la navigazione parcheggiata deve aprire la sua pane anche lì.
    for (const nav of drainProjectBrowserNavigates(projectPath)) {
      ensureBrowserPaneAndNavigateRef.current?.(nav.url, undefined, nav.spawnerKey ?? nav.contextId, nav.contextId);
    }
  }, [projectPath, groups.length]);

  // Consume a queued browser split: once the freshly added browser pane is
  // committed into its source group (beside the chat/terminal), split it OUT
  // into its own cell, oriented by the source group's available space (wide →
  // side-by-side, tall/narrow → stacked). Idempotent: a browser already alone
  // in its group is left as-is, so re-opening just navigates it.
  useEffect(() => {
    if (!pendingBrowserSplit) return;
    const { paneId } = pendingBrowserSplit;
    if (!panes.some(p => p.id === paneId)) return; // not committed yet — wait
    // Mobile (<768px): never split. A phone shows one pane at a time (GroupLayout
    // flattens groups into a single tab strip), and splitting here would ALSO
    // restructure the SYNCED layout — the desktop would suddenly show a split it
    // never asked for. Leave the browser as a tab in its host group.
    if (window.innerWidth < 768) { setPendingBrowserSplit(null); return; }
    const hostGroup = groups.find(g => g.paneIds.includes(paneId));
    if (!hostGroup) return;
    // Already in its own cell (sibling closed / prior split) → nothing to do.
    if (hostGroup.paneIds.length <= 1) { setPendingBrowserSplit(null); return; }
    // Measure the source group's on-screen cell to pick the orientation.
    let rect: { width: number; height: number } | null = null;
    try {
      const bar = document.querySelector(`[data-testid="panel-tab-bar"][data-group-id="${hostGroup.id}"]`);
      const cell = (bar?.parentElement as HTMLElement | null) ?? null;
      const r = cell?.getBoundingClientRect();
      if (r) rect = { width: r.width, height: r.height };
    } catch { /* DOM not ready / bad selector — fall back to 'side' */ }
    const edge = chooseSplitOrientation(rect) === 'side' ? 'right' : 'bottom';
    handleSplitGroupRef.current?.(hostGroup.id, paneId, hostGroup.id, edge);
    setPendingBrowserSplit(null);
    // `handleSplitGroupRef` è un oggetto ref: entra fra le dipendenze perché ora
    // arriva dall'esterno (dentro l'hook di prima era un `useRef` locale, che il
    // lint sa già essere stabile). L'identità non cambia mai, quindi l'effetto
    // non riparte per questo.
  }, [pendingBrowserSplit, panes, groups, handleSplitGroupRef]);
}
