import { useRef, useMemo, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import type { Pane, PaneGroup, PaneGroupType, PaneType, GroupLayoutRow } from '../../types';
import { PaneTabBar, type TabLinkContext } from './PaneTabBar';
import { CellSubStack } from './CellSubStack';
import { setColumnStackHeights, columnDepth } from './groupLayoutStacks';
import { flattenGroupRows } from './flattenLayout';
import { startDragPreview } from '../../lib/dragPreview';
import { equalizeWidths, weightedWidths } from './gridWidths';
import { DND_TYPES, dragMatchesScope } from '../../lib/dndTypes';
import { paneCellBg, paneCellTopInset } from '../../lib/paneCellBg';
import { CHROME_BAR, CHROME_BAR_CONSUMED, CHROME_BAR_H_VAR, CHROME_BAR_SUB, CHROME_BAR_SUB_H_CLASS } from '../../lib/selectionStyles';
import { PaneKeepAlive } from './PaneKeepAlive';
import { usePaneResidency } from './hooks/usePaneResidency';
import { usePaneAlive } from '../../state/paneLiveness';
import { canSplitPane, canDropSplit } from './splitRules';
import { draggedPaneId } from '../../lib/dragPayload';
import { pushUndo } from '../../contexts/UndoContext';
import { useTabNotifications } from '../../hooks/useTabNotifications';
import { useT } from '../../hooks/useT';
import { useRefMirror } from '../../hooks/useRefMirror';
import { detectDropZone, type EdgeZone } from '../../lib/dropZone';
import { SplitRegion, CenterRegion, FullWidthRowZone, RowGapDropZone } from './DropOverlay';
import { FULL_ROW_GUTTER_PX } from '../../lib/dropFeedback';
import { SplitTree } from './SplitTree';
import { type LayoutNode } from '../../state/layout/layoutTree';
import { buildShallowGridTree } from '../../state/layout/legacyAdapters';
import { pxToWeightDelta, resizeWeights } from '../../state/layout/splitController';
import { MIN_PANE_FRACTION, TAB_BAR_H } from './constants';

interface GroupLayoutProps {
  panes: Pane[];
  groups: PaneGroup[];
  rows: GroupLayoutRow[];
  rowHeights: number[];
  focusedGroupId: string | null;
  /** Drag scope for this project's tab bars (its projectPath). Tabs can only
   *  be dragged between groups of the SAME project; a foreign tab (main window
   *  or another project) shows no drop indicators and is ignored on drop. */
  dndScope?: string;
  /** True when the panel hosting this layout is the App-level focused panel.
   *  Drives the dimmed-active vs full-active visual state in PaneTabBar
   *  and the pane content ring, so the active tab stays visually identifiable
   *  even when the project sits next to a focused sibling in split view.
   *  Defaults to true for callers that don't track App-level focus. */
  isAppFocused?: boolean;
  onActivatePane: (groupId: string, paneId: string) => void;
  onClosePane: (groupId: string, paneId: string) => void;
  /** Optional immediate close (bypass PendingAction countdown). Wired via the
   *  PaneTabBar right-click "Close now" entry. */
  onClosePaneImmediate?: (groupId: string, paneId: string) => void;
  onAddPaneToGroup: (groupId: string, type: PaneType, subType?: string) => void;
  onNewChatInGroup?: (groupId: string) => void;
  onAddPaneWhenEmpty?: (type: PaneType, subType?: string) => void;
  onReorderGroupPanes?: (groupId: string, newPaneIds: string[]) => void;
  onMovePaneBetweenGroups?: (sourceGroupId: string, targetGroupId: string, paneId: string, insertIdx: number) => void;
  /**
   * Split a group on an edge. Vertical (top/bottom) splits default to a
   * SINGLE-COLUMN vertical stack — the soloed pane lands under just the
   * target's column. Pass `opts.fullRow` (the container's full-width drop
   * strips) to instead insert a new row spanning every column.
   */
  onSplitGroup?: (sourceGroupId: string, paneId: string, targetGroupId: string, edge: 'left' | 'right' | 'top' | 'bottom', opts?: { fullRow?: boolean }) => void;
  onReorderRows?: (newRowOrder: number[]) => void;
  onUpdateRows: (rows: GroupLayoutRow[]) => void;
  onUpdateRowHeights: (heights: number[]) => void;
  /** Render a pane's body. `isFocused` reflects "this is the active pane
   *  AND its group is the focused group AND the App-level panel is the
   *  focused panel". `isVisible` reflects only "this is the active pane in
   *  its group" — i.e. the keep-alive wrapper is `display:flex`, not
   *  `display:none`. The two diverge in split view: a non-focused group's
   *  active pane is still visible, just dimmed. Browser panes need
   *  isVisible separately because their OS-level WebContentsView can't
   *  observe the wrapper's display property. */
  renderPane: (pane: Pane, isFocused: boolean, isVisible: boolean) => React.ReactNode;
  availableTypesForGroup: (groupType: PaneGroupType, groupId: string) => PaneType[];
  onContextRingClick?: (paneId: string) => void;
  onStopStreaming?: (paneId: string) => void;
  onSettings?: (paneId: string) => void;
  onPopOut?: (paneId: string) => void;
  onPinPane?: (groupId: string, paneId: string) => void;
  /**
   * Il pin della sidebar per una tab, e la sua lettura — DIVERSI da `onPinPane`,
   * che promuove una tab di anteprima a permanente.
   *
   * Finora nessun gruppo li riceveva, quindi dentro una finestra di progetto la
   * voce «Fissa» del menu di una tab non compariva affatto (`PaneTabBar` la
   * nasconde quando l'ospite non la cabla). Col dito era il caso peggiore: lì
   * l'unica alternativa — trascinare la tab sui Fissati — non esiste, perché su
   * iOS il drag HTML5 non c'è.
   */
  onToggleFissato?: (pinKey: string) => void;
  isFissato?: (pinKey: string) => boolean;
  /** La chiave di pin del progetto che contiene queste barre, se ce n'è uno:
   *  è ciò che fa comparire «Fissa il progetto» accanto a «Fissa questa tab». */
  projectPinKey?: string;
  /** Tab-level rename for a project's chat tabs (routes to the host's topic
   *  update) and browser tabs (pins pane.title). Forwarded to each PaneTabBar. */
  onRenameChat?: (topicId: string, name: string) => void;
  onRenameBrowser?: (paneId: string, name: string) => void;
  /** Pane ids whose close affordance (tab X + context-menu "Close") must be
   *  hidden — panes the host owns structurally, not free-standing tabs (the
   *  task drawer's derived Thread/Piano/media surfaces). Forwarded to each
   *  PaneTabBar. Default undefined: every tab stays closable (app unchanged). */
  nonClosablePaneIds?: Set<string>;
  /**
   * Chi ospita queste tab, per «Copia link» nel menu della tab: il progetto
   * (ProjectWindow) o il task del cui drawer questa è la superficie
   * (useTaskBrowserGroupLayout). Inoltrato tale e quale a ogni PaneTabBar —
   * vedi TabLinkContext, che spiega perché non è un campo del Pane.
   */
  linkContext?: TabLinkContext;
  /** «Apri nel progetto» sul tasto destro di una tab: la cabla il drawer del
   *  task, e senza di lei la voce non esiste. Inoltrata a ogni PaneTabBar. */
  onOpenPaneInProject?: (paneId: string) => void;
  /**
   * UN NODO DA OSPITARE IN TESTA ALLA PRIMA BARRA.
   *
   * Ci vive la barra di progetto CHIUSA (`ProjectSidebar`, ramo collassato):
   * chiusa non è più una colonna verticale accanto alla riga di chrome, è una
   * fila di card DENTRO di essa, davanti alle tab.
   *
   * È un `HTMLElement`, non un `ReactNode`: il nodo lo crea il chiamante una
   * volta sola e ci scrive dentro col suo portale, quindi esiste già al primo
   * render e non c'è il fotogramma in cui la vecchia rail lampeggia. Qui lo si
   * aggancia e basta — nessuno stato, nessuna corsa fra ref e render.
   *
   * SOLO la prima barra lo ospita: con uno split ci sono N righe di chrome, ma
   * il progetto è uno. «Prima» = il primo gruppo della prima riga, e in
   * mancanza di righe la barra vuota.
   */
  leadingSlot?: HTMLElement;
  /**
   * Il fratello di {@link GroupLayoutProps.leadingSlot}, un piano più sotto: un
   * nodo agganciato SUBITO DOPO la riga di chrome del gruppo di testa, cioè
   * dentro la cella e non dentro la barra.
   *
   * Serve alla barra di progetto chiusa: la card del titolo sta in fila con le
   * tab (`leadingSlot`), i suoi tre comandi vanno «sotto il trigger» (Attilio,
   * 09/08). Dentro la barra non ci starebbero — è alta 34 e ne conterrebbe due
   * righe — quindi escono da lei e si appoggiano sotto, allineati al bordo
   * sinistro della card.
   */
  belowSlot?: HTMLElement;
  /**
   * Questa superficie sta DENTRO un'altra riga di chrome — è il caso della
   * finestra di progetto, che vive sotto la tab del progetto nella barra
   * dell'app. La sua prima riga diventa {@link CHROME_BAR_SUB}: più bassa, e
   * senza l'aria in cima che la riga sopra ha già messo.
   *
   * SOLO la prima riga. Sotto un divisore (rowIdx ≥ 1) quell'aria non l'ha
   * pagata nessuno, e una barra più bassa lì sarebbe inchiostro appeso.
   */
  subordinate?: boolean;
}

/**
 * L'ospite di {@link GroupLayoutProps.leadingSlot}: un div nel flusso, in testa
 * alla barra, dentro cui viene spostato il nodo del chiamante.
 *
 * Nel FLUSSO e non in overlay: il blocco di sinistra ha una larghezza che
 * dipende dal nome del progetto, e una riserva `padding-left` fissa — la strada
 * che usa la barra standalone per il suo unico bottone — qui non saprebbe quanto
 * riservare. Stando in fila, le tab si spostano da sole.
 */
function LeadingSlot({ node }: { node: HTMLElement }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const h = host.current;
    if (!h) return;
    // IL PRIMO CHE LO PRENDE SE LO TIENE.
    //
    // Il nodo è UNO, e gli ospiti possono essere più d'uno: il ramo a griglia
    // rende una volta PER GRUPPO, quindi in un progetto in split due ospiti si
    // contendevano lo stesso nodo. `appendChild` lo SPOSTA, quindi vinceva
    // l'ultimo che montava e gli altri restavano scatole vuote — e i comandi
    // finivano in un gruppo qualsiasi invece che nel primo. Sintomo: «vedo una
    // barra grigia ma non vedo i tasti» (Attilio, 09/08).
    //
    // Chi arriva secondo non ruba: rende una scatola vuota e alta zero, che non
    // si vede. Il cleanup toglie il nodo SOLO se è ancora suo, quindi lo
    // smontaggio dell'ospite che non l'ha mai avuto non lo strappa a chi ce l'ha.
    if (node.parentNode && node.parentNode !== h && node.parentNode.isConnected) return;
    h.appendChild(node);
    return () => { if (node.parentNode === h) h.removeChild(node); };
  }, [node]);
  return <div ref={host} className="flex items-center min-w-0 empty:hidden" />;
}


export function GroupLayout({
  panes, groups, rows, rowHeights, focusedGroupId, dndScope, isAppFocused = true, leadingSlot, belowSlot, subordinate = false,
  onActivatePane, onClosePane, onClosePaneImmediate, onAddPaneToGroup, onNewChatInGroup, onAddPaneWhenEmpty, onReorderGroupPanes,
  onMovePaneBetweenGroups, onSplitGroup, onReorderRows,
  onUpdateRows, onUpdateRowHeights,
  renderPane, availableTypesForGroup, onContextRingClick, onStopStreaming,
  onSettings, onPopOut, onPinPane, onToggleFissato, isFissato, projectPinKey, onRenameChat, onRenameBrowser, nonClosablePaneIds, linkContext, onOpenPaneInProject,
}: GroupLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Mobile (<768px): the SplitTree has no mobile mode and would cram two groups
  // side-by-side. On a phone we FLATTEN every group's panes into a single tab
  // strip and show one pane at a time (see the mobile branch in the return).
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);

  const { getBadgeCount, clearPane } = useTabNotifications();
  const tr = useT();

  const paneMap = useMemo(() => {
    const m = new Map<string, Pane>();
    for (const p of panes) m.set(p.id, p);
    return m;
  }, [panes]);

  const groupMap = useMemo(() => {
    const m = new Map<string, PaneGroup>();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  // NOTE: the sidebar split mini-map (per-topic cell schematic) is published
  // separately via SplitPositionContext — GroupLayout no longer threads a
  // `splitMap` descriptor into the tab bars (the tab bar never rendered it).

  // Keep-alive: una pane visitata resta montata (solo nascosta con
  // display:none) così l'utente non vede la cronologia rifetchata, lo scroll
  // azzerato o la bozza persa a ogni switch di tab.
  //
  // Per QUANTO resti montata lo decide il registro di residenza
  // (`state/pane/residency/`): prima era un `Set` che accumulava ogni pane mai
  // attivata e si svuotava solo alla chiusura, e siccome ne esisteva UNO PER
  // ISTANZA di questo componente — compreso il `GroupLayout` annidato dentro
  // ogni pane `project` — con quattro progetti aperti il costo si moltiplicava
  // per quattro. Adesso il tetto è unico per tutto il renderer.
  //
  // Le chiavi restano `stableKey ?? id`: PANE_ID_REMAP (promozione bozza →
  // topic vero) cambia l'`id` e conserva lo `stableKey`, e usare l'id
  // rimonterebbe il contenuto (rieseguendo loadHistory, azzerando lo scroll).
  const stableKeyOf = useCallback((p: Pane) => p.stableKey ?? p.id, []);
  // Su mobile i gruppi sono APPIATTITI in un'unica striscia di tab e si vede
  // una pane sola (vedi `renderMobile`), quindi il pavimento è diverso: dire
  // "sono visibili tutte le attive di ogni gruppo" terrebbe montato N volte
  // tanto proprio sul dispositivo che ha meno memoria.
  // La superficie stessa e' visibile? Un `GroupLayout` vive anche ANNIDATO
  // dentro una pane `project`, e quella pane puo' essere nascosta. Senza questa
  // domanda, il gruppo interno continuava a dichiarare la propria pane attiva
  // come "visibile", cioe' come PAVIMENTO del tetto di residenza — e il
  // pavimento non si sfratta mai. Con sei progetti aperti erano sei pane
  // esenti dal tetto per costruzione, comprese le pane browser, che sono la
  // classe cara.
  //
  // `usePaneAlive()` risponde esatto perche' e' `parentAlive && isVisible`
  // moltiplicato lungo tutta la catena dei gusci: falso qui vuol dire che un
  // antenato e' `display:none`, quindi NESSUNA pane di questa superficie e'
  // sullo schermo. Fuori da ogni guscio (la finestra principale) il default e'
  // `true` e non cambia niente.
  const surfaceAlive = usePaneAlive();
  const visibleKeys = useMemo(() => {
    if (!surfaceAlive) return [];
    if (isMobile) {
      const flat: Pane[] = [];
      const seen = new Set<string>();
      for (const g of groups) {
        for (const id of g.paneIds) {
          const p = paneMap.get(id);
          if (p && !seen.has(p.id)) { seen.add(p.id); flat.push(p); }
        }
      }
      const focused = (focusedGroupId ? groupMap.get(focusedGroupId) : undefined) ?? groups[0];
      const activeId =
        focused?.activePaneId && flat.some((p) => p.id === focused.activePaneId)
          ? focused.activePaneId
          : flat[0]?.id;
      const p = activeId ? paneMap.get(activeId) : undefined;
      return p ? [stableKeyOf(p)] : [];
    }
    const out: string[] = [];
    for (const g of groups) {
      const p = g.activePaneId ? paneMap.get(g.activePaneId) : undefined;
      if (p) out.push(stableKeyOf(p));
    }
    return out;
  }, [surfaceAlive, isMobile, groups, paneMap, groupMap, focusedGroupId, stableKeyOf]);
  const isResidentPane = usePaneResidency(panes, visibleKeys);

  // Vertical leaf depth of a row = its deepest column's sub-stack (primary + any
  // groups stacked under it). A 2-deep column needs twice the row height so each
  // stacked leaf matches a leaf in a plain row — the project-internal twin of the
  // main grid's project-cell weighting.
  const rowVerticalDepth = useCallback((row: GroupLayoutRow): number => {
    let d = 1;
    for (const gid of row.groupIds) {
      const cd = columnDepth(row, gid);
      if (cd > d) d = cd;
    }
    return d;
  }, []);

  // Auto-equalize the columns of a row whenever its column COUNT changes (a split
  // added or removed) — the project-internal twin of the main grid's
  // auto-rebalance, so leaf panes stay equal without a manual double-click. Keyed
  // by each row's first group id so REORDERING rows never triggers a spurious
  // reset; a manual column drag (no count change) is preserved between edits.
  const prevColCountsRef = useRef<Map<string, number>>(
    new Map(rows.map((r) => [r.groupIds[0], r.groupIds.length])),
  );
  useEffect(() => {
    const prev = prevColCountsRef.current;
    const nextCounts = new Map<string, number>();
    let changed = false;
    const nextRows = rows.map((r) => {
      const key = r.groupIds[0];
      nextCounts.set(key, r.groupIds.length);
      const had = prev.get(key);
      if (had !== undefined && had !== r.groupIds.length && r.groupIds.length > 1) {
        changed = true;
        return { ...r, widths: equalizeWidths(r.groupIds.length) };
      }
      return r;
    });
    prevColCountsRef.current = nextCounts;
    if (changed) onUpdateRows(nextRows);
  }, [rows, onUpdateRows]);

  // Auto-equalize row heights when the row COUNT changes or a column's vertical
  // sub-stack depth changes — WEIGHTED by each row's depth so every leaf ends the
  // same height (a row with a 2-deep column gets twice the height). The signature
  // is the depth multiset + count, so it's reorder-invariant; a manual height
  // drag (no structural change) is preserved.
  const rowSig = (rs: GroupLayoutRow[]) =>
    rs.length + '|' + rs.map(rowVerticalDepth).slice().sort((a, b) => a - b).join(',');
  const prevRowSigRef = useRef<string>(rowSig(rows));
  useEffect(() => {
    const sig = rowSig(rows);
    const prev = prevRowSigRef.current;
    prevRowSigRef.current = sig;
    // No change, nothing to balance (≤1 row), or the empty→populated initial
    // fill (which must not overwrite the persisted heights being restored).
    if (prev === sig || rows.length <= 1 || prev.startsWith('0|')) return;
    const nh = weightedWidths(rows.map(rowVerticalDepth));
    if (nh.length === rowHeights.length && nh.every((x, i) => Math.abs(x - rowHeights[i]) < 1e-4)) return;
    onUpdateRowHeights(nh);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowSig is a render-local pure helper; deps are the structural inputs (rows), the compared heights, and the stable setter
  }, [rows, rowHeights, rowVerticalDepth, onUpdateRowHeights]);

  /* ---- Edge drop zone state (Phase 3: split-on-edge-drop) ---- */
  // `edge` may also be 'center': a tab hovering the pane BODY's middle box
  // previews (and drops as) a MERGE into this group — before, the middle of a
  // project pane was a dead drop (nothing painted, release did nothing).
  const [edgeDropTarget, setEdgeDropTarget] = useState<{ groupId: string; edge: EdgeZone | 'center' } | null>(null);
  // Ref mirror so the drop handler always sees the latest target — React
  // state from `setEdgeDropTarget` may not be committed yet when `drop`
  // fires in the same frame as `dragover`, causing fast drops to silently
  // no-op (the "drop twice to land" bug).
  const edgeDropTargetRef = useRefMirror(edgeDropTarget);

  const handleGroupContentDragOver = useCallback((groupId: string) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB)) return;
    // Scope guard: only this project's tabs may split its groups — a foreign
    // tab gets no edge overlay (and no preventDefault, so it can't drop here).
    if (!dragMatchesScope(e.dataTransfer.types, dndScope)) return;
    // Group-tagged tab drags only (dragover can't read VALUES, so we can't
    // tell WHICH group — every project tab drag qualifies here).
    if (!e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP)) return;

    e.preventDefault();
    e.stopPropagation();
    // Explicit dropEffect: WKWebView (Tauri) won't infer it from preventDefault,
    // so the source's dragend would otherwise see dropEffect:'none' and the
    // standalone pop-out path would close the just-split pane. Signal acceptance.
    e.dataTransfer.dropEffect = 'move';

    if (!onSplitGroup) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // 5-zone: edges split, the middle box MERGES the tab into this group
    // (add-as-tab). The tab BAR is a sibling of this content area (its own
    // capture handler clears our preview), so 'center' here is always the
    // pane body.
    const edge = detectDropZone(e, rect, 'edges+center') as EdgeZone | 'center' | null;

    if (edge) {
      // DEDUP: dragover fires ~60fps+; only re-render when the target edge/group
      // actually changes, else the project window re-rendered every frame of the
      // drag ("preview delle aree di drop laggano").
      const cur = edgeDropTargetRef.current;
      if (!cur || cur.groupId !== groupId || cur.edge !== edge) {
        const next = { groupId, edge };
        edgeDropTargetRef.current = next;
        setEdgeDropTarget(next);
      }
    } else {
      if (edgeDropTargetRef.current?.groupId === groupId) {
        edgeDropTargetRef.current = null;
        setEdgeDropTarget(null);
      }
    }
  }, [onSplitGroup, edgeDropTargetRef, dndScope]);

  // When a cross-group tab drag moves over THIS group's tab bar (a sibling of
  // the content area), the user is aiming to drop the tab INTO the bar — not to
  // split the group. The edge "area" overlay can have been painted moments
  // earlier, while the pointer transited the content's top edge band on its way
  // up to the bar, and a missed `dragleave` (common on a fast drag or in the
  // frame right before a drop) would leave it stuck. Clearing on every tab-bar
  // dragover guarantees the preview is gone while the pointer is over the bar —
  // so it can't show "split here" when you only want a tab, and can't survive
  // the drop. We never preventDefault here: PaneTabBar still owns the drop.
  // Wired in the CAPTURE phase — PaneTabBar's per-tab dragover calls
  // stopPropagation, so a bubble-phase handler on this wrapper would be skipped
  // exactly when the pointer is over a tab (the common aim). Capture runs
  // top-down before that, so the clear fires for every dragover in the bar.
  const handleTabBarDragOver = useCallback((groupId: string) => () => {
    if (edgeDropTargetRef.current?.groupId === groupId) {
      edgeDropTargetRef.current = null;
      setEdgeDropTarget(null);
    }
  }, [edgeDropTargetRef]);

  const handleGroupContentDragLeave = useCallback((groupId: string) => (e: React.DragEvent) => {
    // Ignore a dragleave that merely crossed into a child of the content area
    // (the pane body) — only clear when the pointer actually left, or the edge
    // preview flickers while dragging over the content.
    const rt = e.relatedTarget as Node | null;
    if (rt && (e.currentTarget as HTMLElement).contains(rt)) return;
    if (edgeDropTargetRef.current?.groupId === groupId) {
      edgeDropTargetRef.current = null;
      setEdgeDropTarget(null);
    }
  }, [edgeDropTargetRef]);

  // True while a same-scope tab is being dragged anywhere over this layout —
  // gates the full-width drop strips so they only intercept events during a
  // drag (otherwise their top/bottom bands would swallow normal clicks on the
  // first row's tab bar). Set on the container's capture-phase dragenter,
  // cleared by resetDndOverlays (window dragend/drop). Declared here, above
  // handleGroupContentDrop, so the setter isn't referenced before its
  // declaration (react-hooks/no-use-before-declare).
  const [dragActive, setDragActive] = useState(false);

  const handleGroupContentDrop = useCallback((groupId: string) => (e: React.DragEvent) => {
    // Validate this is a tab drop before consuming the event.
    const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
    if (!sourcePaneId || !sourceGroupId) return;
    // Scope guard: reject a tab from another window/project on drop too.
    const sourceScope = e.dataTransfer.getData(DND_TYPES.PANE_TAB_SCOPE);
    if (dndScope && sourceScope && sourceScope !== dndScope) return;

    // Splittable at all? ONE predicate, the same the context menu is gated on
    // (splitRules.canDropSplit → canSplitPane). This used to be an inline
    // "source group holds a single pane → refuse", which contradicted both the
    // menu and handleSplitGroup: the latter auto-spawns a draft companion for
    // exactly that case, so a project opened with one pane in one group painted
    // the edge preview and then swallowed the release.
    if (
      !canDropSplit({
        surface: 'project',
        sourceGroupSize: groupMap.get(sourceGroupId)?.paneIds.length ?? 0,
        sameGroup: sourceGroupId === groupId,
      })
    ) {
      edgeDropTargetRef.current = null;
      setEdgeDropTarget(null);
      return;
    }

    // Prefer the cached target from the latest dragover (ref to dodge React
    // commit lag), but if the user wobbled out of the edge zone in the last
    // few pixels before release the cache may be null/stale — fall back to
    // recomputing from the drop coordinates so a drop anywhere inside an
    // edge band still splits.
    let edge: EdgeZone | 'center' | null = null;
    const cached = edgeDropTargetRef.current;
    if (cached && cached.groupId === groupId && cached.edge) {
      edge = cached.edge;
    } else {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      edge = detectDropZone(e, rect, 'edges+center') as EdgeZone | 'center' | null;
    }
    if (!edge) { edgeDropTargetRef.current = null; setEdgeDropTarget(null); return; }

    e.preventDefault();
    e.stopPropagation();

    if (edge === 'center') {
      // Merge-as-tab into this group (append at the end — a drop on the BAR
      // owns precise insert indexes). Same-group center is a no-op, but the
      // event is still consumed so WKWebView's dragend can't read the release
      // as a drag-out (pop-out/close).
      if (sourceGroupId !== groupId) {
        const insertIdx = groupMap.get(groupId)?.paneIds.length ?? 0;
        onMovePaneBetweenGroups?.(sourceGroupId, groupId, sourcePaneId, insertIdx);
      }
    } else {
      onSplitGroup?.(sourceGroupId, sourcePaneId, groupId, edge);
    }
    edgeDropTargetRef.current = null;
    setEdgeDropTarget(null);
    // Same leak as handleFullRowDrop: stopPropagation + onSplitGroup reparenting
    // the source defeats both the window 'drop' reset and 'dragend', so the
    // full-width strips (gated on dragActive) would stay painted after an
    // edge-split drop too. Clear it here.
    setDragActive(false);
  }, [onSplitGroup, onMovePaneBetweenGroups, edgeDropTargetRef, dndScope, groupMap]);

  /* ---- Cross-group tab drop handler ---- */
  const handleCrossGroupDrop = useCallback((targetGroupId: string) =>
    (sourcePaneId: string, sourceGroupId: string, insertIdx: number) => {
      onMovePaneBetweenGroups?.(sourceGroupId, targetGroupId, sourcePaneId, insertIdx);
    }, [onMovePaneBetweenGroups]);

  /* ---- Full-width row drop strips (split "in basso/in alto a TUTTE le tab") ----
   * The per-cell top/bottom edges split a SINGLE column (cellStacks). To still
   * offer the full-width row — a new row spanning every column — we paint two
   * thin strips at the container's extreme top and bottom that only light up
   * during a cross-group tab drag. Dropping there calls onSplitGroup with
   * `fullRow: true` (no target group needed; the handler inserts above the
   * first / below the last row). */
  const [fullRowDrop, setFullRowDrop] = useState<'top' | 'bottom' | null>(null);
  const fullRowDropRef = useRefMirror(fullRowDrop);

  const isPaneTabDrag = useCallback((e: React.DragEvent) =>
    e.dataTransfer.types.includes(DND_TYPES.PANE_TAB) &&
    e.dataTransfer.types.includes(DND_TYPES.PANE_TAB_GROUP) &&
    dragMatchesScope(e.dataTransfer.types, dndScope), [dndScope]);

  /**
   * Would a full-width-row release reshape anything, given the group `size` the
   * pane is leaving? Asked by the strips' `dragover` (which reads the source off
   * the module shelf, since a dragover cannot read payload VALUES) and again by
   * their `drop` (which reads it off the dataTransfer) — one predicate, so the
   * strip never lights up for a release that would redraw the same tree.
   */
  const fullRowWouldReshape = useCallback((size: number | undefined) =>
    size === undefined ||
    canDropSplit({
      surface: 'project',
      sourceGroupSize: size,
      sameGroup: true,
      fullRow: true,
      totalGroups: groups.length,
    }), [groups.length]);

  /** Size of the group the pane in flight left, or undefined when the drag came
   *  from another window (the shelf is empty there — only the drop can tell). */
  const draggedGroupSize = useCallback((): number | undefined => {
    const paneId = draggedPaneId();
    if (!paneId) return undefined;
    return groups.find(g => g.paneIds.includes(paneId))?.paneIds.length;
  }, [groups]);

  const handleFullRowDragOver = useCallback((side: 'top' | 'bottom') => (e: React.DragEvent) => {
    if (!onSplitGroup || !isPaneTabDrag(e)) return;
    if (!fullRowWouldReshape(draggedGroupSize())) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move'; // WKWebView: signal acceptance (see handleGroupContentDragOver)
    // The strip sits over a cell's edge band — clear that per-cell preview so
    // only ONE intent (full-width) shows while the pointer is on the strip.
    if (edgeDropTargetRef.current) { edgeDropTargetRef.current = null; setEdgeDropTarget(null); }
    if (fullRowDropRef.current !== side) { fullRowDropRef.current = side; setFullRowDrop(side); }
  }, [onSplitGroup, isPaneTabDrag, edgeDropTargetRef, fullRowDropRef, fullRowWouldReshape, draggedGroupSize]);

  const handleFullRowDragLeave = useCallback((e: React.DragEvent) => {
    const rt = e.relatedTarget as Node | null;
    if (rt && (e.currentTarget as HTMLElement).contains(rt)) return;
    fullRowDropRef.current = null;
    setFullRowDrop(null);
  }, [fullRowDropRef]);

  const handleFullRowDrop = useCallback((side: 'top' | 'bottom') => (e: React.DragEvent) => {
    const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
    fullRowDropRef.current = null;
    setFullRowDrop(null);
    // This handler stopPropagation()s the drop (below) AND onSplitGroup reparents
    // the dragged tab — so neither the window 'drop' reset nor 'dragend' fires.
    // Clear dragActive here or the "Full-width row" strips stay painted forever.
    setDragActive(false);
    if (!sourcePaneId || !sourceGroupId) return;
    const sourceScope = e.dataTransfer.getData(DND_TYPES.PANE_TAB_SCOPE);
    if (dndScope && sourceScope && sourceScope !== dndScope) return;
    // Same predicate the strip's dragover used to decide whether to light up.
    if (!fullRowWouldReshape(groupMap.get(sourceGroupId)?.paneIds.length)) return;
    e.preventDefault();
    e.stopPropagation();
    // targetGroupId '' → handler falls back to first/last row for the new row.
    onSplitGroup?.(sourceGroupId, sourcePaneId, '', side, { fullRow: true });
  }, [onSplitGroup, dndScope, fullRowDropRef, fullRowWouldReshape, groupMap]);

  /* ---- Interior row-gap strips: the ONLY gesture that inserts a full-width
   * row BETWEEN two existing rows. The extreme strips above cover "above the
   * first / below the last"; per-cell top/bottom edges stack a SINGLE column;
   * and the SplitTree dividers are deliberately drop-inert (their band is
   * neutralized mid-drag so edge drops land on cells) — so this op had no
   * path at all. One strip per row boundary, positioned by the cumulative
   * row heights, dropping calls the same fullRow split anchored on the row
   * ABOVE the gap. Drag-only, like the extreme strips. ---- */
  const [rowGapDrop, setRowGapDrop] = useState<number | null>(null);
  const rowGapDropRef = useRefMirror(rowGapDrop);

  const handleRowGapDragOver = useCallback((gapIdx: number) => (e: React.DragEvent) => {
    if (!onSplitGroup || !isPaneTabDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move'; // WKWebView: signal acceptance
    if (edgeDropTargetRef.current) { edgeDropTargetRef.current = null; setEdgeDropTarget(null); }
    if (rowGapDropRef.current !== gapIdx) { rowGapDropRef.current = gapIdx; setRowGapDrop(gapIdx); }
  }, [onSplitGroup, isPaneTabDrag, edgeDropTargetRef, rowGapDropRef]);

  const handleRowGapDragLeave = useCallback((e: React.DragEvent) => {
    const rt = e.relatedTarget as Node | null;
    if (rt && (e.currentTarget as HTMLElement).contains(rt)) return;
    rowGapDropRef.current = null;
    setRowGapDrop(null);
  }, [rowGapDropRef]);

  const handleRowGapDrop = useCallback((gapIdx: number) => (e: React.DragEvent) => {
    const sourcePaneId = e.dataTransfer.getData(DND_TYPES.PANE_TAB);
    const sourceGroupId = e.dataTransfer.getData(DND_TYPES.PANE_TAB_GROUP);
    rowGapDropRef.current = null;
    setRowGapDrop(null);
    setDragActive(false); // see handleFullRowDrop — dragend/drop resets are defeated here
    if (!sourcePaneId || !sourceGroupId) return;
    const sourceScope = e.dataTransfer.getData(DND_TYPES.PANE_TAB_SCOPE);
    if (dndScope && sourceScope && sourceScope !== dndScope) return;
    const anchor = rows[gapIdx]?.groupIds[0];
    if (!anchor) return;
    e.preventDefault();
    e.stopPropagation();
    // 'bottom' + fullRow anchored on the row above the gap → the new row
    // lands exactly in this gap.
    onSplitGroup?.(sourceGroupId, sourcePaneId, anchor, 'bottom', { fullRow: true });
  }, [onSplitGroup, dndScope, rows, rowGapDropRef]);

  /* ---- Row drag reordering (Phase 5) ---- */
  const [draggingRowIdx, setDraggingRowIdx] = useState<number | null>(null);
  const [rowDropTarget, setRowDropTarget] = useState<{ idx: number; side: 'top' | 'bottom' } | null>(null);

  const handleRowDragStart = useCallback((rowIdx: number) => (e: React.DragEvent) => {
    if (!onReorderRows) return;
    setDraggingRowIdx(rowIdx);
    e.dataTransfer.setData(DND_TYPES.LAYOUT_ROW, String(rowIdx));
    e.dataTransfer.effectAllowed = 'move';
    // Una riga non ha un nome, quindi il sottotitolo dice l'unica cosa che la
    // distingue dalle sorelle: quante pane ci stanno dentro. Il registro dei
    // fantasmi da drenare non serve più — vedi `lib/dragPreview`, che si spegne
    // da sé su cinque porte agganciate al documento.
    //
    // Passa dal catalogo e non da una stringa scritta qui: il prodotto spedisce
    // in inglese, e un titolo cucito nel componente e' l'unica riga di questa
    // anteprima che nessun selettore di lingua puo' cambiare.
    const quanti = rows[rowIdx]?.groupIds.length ?? 0;
    startDragPreview(e, {
      title: tr('space.row.title', { n: rowIdx + 1 }),
      subtitle: quanti > 0
        ? (quanti === 1 ? tr('space.row.groups.one') : tr('space.row.groups.many', { n: quanti }))
        : undefined,
    });
  }, [onReorderRows, rows, tr]);

  const handleRowDragOver = useCallback((rowIdx: number) => (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_TYPES.LAYOUT_ROW)) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const yRatio = (e.clientY - rect.top) / rect.height;
    const side = yRatio < 0.5 ? 'top' : 'bottom';
    // DEDUP: only re-render when the row/side actually changes (dragover is ~60fps).
    setRowDropTarget((prev) => (prev && prev.idx === rowIdx && prev.side === side ? prev : { idx: rowIdx, side }));
  }, []);

  const handleRowDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const sourceIdxStr = e.dataTransfer.getData(DND_TYPES.LAYOUT_ROW);
    if (!sourceIdxStr || !rowDropTarget || !onReorderRows) return;

    const sourceIdx = parseInt(sourceIdxStr, 10);
    if (isNaN(sourceIdx)) return;

    const order = rows.map((_, i) => i);
    const removed = order.splice(sourceIdx, 1)[0];
    let targetIdx = rowDropTarget.idx;
    if (sourceIdx < rowDropTarget.idx) targetIdx--;
    if (rowDropTarget.side === 'bottom') targetIdx++;
    order.splice(targetIdx, 0, removed);

    onReorderRows(order);
    setDraggingRowIdx(null);
    setRowDropTarget(null);
  }, [rows, rowDropTarget, onReorderRows]);

  // One reset for every drag-end path: a clean drop, an escape-cancel, a drop
  // outside any zone, or a flaky boundary. Clears BOTH the edge-split preview
  // and the row-drag indicators. The container's onDragEnd only fires when the
  // drag started inside this subtree; the window listener catches every other
  // case, so no overlay is ever left painted after the gesture — the same
  // belt-and-suspenders pattern PaneTabBar uses for its tab indicators.
  const resetDndOverlays = useCallback(() => {
    edgeDropTargetRef.current = null;
    setEdgeDropTarget(null);
    setDraggingRowIdx(null);
    setRowDropTarget(null);
    fullRowDropRef.current = null;
    setFullRowDrop(null);
    rowGapDropRef.current = null;
    setRowGapDrop(null);
    setDragActive(false);
  }, [edgeDropTargetRef, fullRowDropRef, rowGapDropRef]);

  // Reset on dragend OR drop. A cross-group move unmounts the dragged tab
  // synchronously inside its drop handler, and the browser then never fires
  // `dragend` on the now-detached source element — so a dragend-only reset
  // leaves the edge-split preview (painted while the drag passed over this
  // group's content) stuck on screen. The `drop` event still bubbles to the
  // window (the tab-bar drop doesn't stopPropagation), so listening for it too
  // guarantees the overlay clears even when dragend is swallowed.
  useEffect(() => {
    const onEnd = () => resetDndOverlays();
    window.addEventListener('dragend', onEnd);
    window.addEventListener('drop', onEnd);
    return () => {
      window.removeEventListener('dragend', onEnd);
      window.removeEventListener('drop', onEnd);
    };
  }, [resetDndOverlays]);

  // Belt-and-suspenders for a `dragActive` that never saw its `dragend`/`drop`:
  // in WKWebView (the Tauri shell) a release captured by a native browser
  // WebContentsView — or a drag that ends off-window — can drop BOTH terminal
  // DnD events, leaving the full-width/ row-gap strips (real pointer-events:auto
  // hit targets, z-50) mounted forever. Stuck, they swallow clicks and tab-move
  // drops in the tab-bar band — the "sometimes I can't click a tab / it's like
  // it detects that drag-preview piece" report. HTML5 DnD suppresses pointer
  // events for the drag's DURATION, so the FIRST `pointermove` with no button
  // held (or any `pointerup`/window blur) proves the gesture is over — clear
  // then. Attached only while a drag is nominally active (cheap, self-removing).
  useEffect(() => {
    if (!dragActive) return;
    const clear = () => resetDndOverlays();
    const onMove = (e: PointerEvent) => { if ((e.buttons & 1) === 0) clear(); };
    window.addEventListener('pointerup', clear, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('pointerup', clear, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('blur', clear);
    };
  }, [dragActive, resetDndOverlays]);

  /* ================================================================== */
  /*  Split-tree render path                                              */
  /* ================================================================== */
  //
  // Renders the project grid through the unified <SplitTree> engine. The tree is
  // 1:1 with `rows` (a col-split of rows, each a row-split of columns), so a
  // divider's (path, idx) maps straight back to (rowIdx, colIdx). Every gesture
  // reuses the existing handlers: edge-split / cross-group / full-row drops ride
  // inside renderGroupBlock + the container; divider resize/equalize map onto the
  // rows/rowHeights state; row drag-reorder is wired into renderTreeLeaf (every
  // leaf of a row is that row's drop zone, the grab handle rides the first column).
  // Column/row RESIZE, every SPLIT path, cross-group MOVE, full-row split and
  // row-reorder all work — full parity with the legacy renderer this replaced.

  // key (column primary group id) → [rowIdx, colIdx]. Sub-stack members aren't
  // tree leaves (they live inside their column's CellSubStack).
  const keyPos = useMemo<ReadonlyMap<string, [number, number]>>(() => {
    const m = new Map<string, [number, number]>();
    rows.forEach((row, r) => row.groupIds.forEach((gid, c) => { if (!m.has(gid)) m.set(gid, [r, c]); }));
    return m;
  }, [rows]);

  // Shallow tree, 1:1 with rows. Missing / duplicate groups become inert
  // `__skip:*` weight-0 leaves so the index stays stable and no blank gap shows.
  const treeRoot = useMemo<LayoutNode | null>(
    () =>
      buildShallowGridTree(
        rows.map((r) => ({ keys: r.groupIds, widths: r.widths })),
        rowHeights,
        (gid) => groupMap.has(gid),
      ),
    [rows, rowHeights, groupMap],
  );

  // Divider drag → shift weight on the matching band (path [] = row heights,
  // path [rowIdx] = that row's column widths). Floor = the live MIN_PANE_FRACTION,
  // matching SplitTree's internal floor so live drag and committed weight agree.
  const handleTreeResize = useCallback((path: number[], dividerIdx: number, deltaPx: number, bandPx: number) => {
    const wd = pxToWeightDelta(bandPx, deltaPx);
    if (wd === 0) return;
    if (path.length === 0) {
      onUpdateRowHeights(resizeWeights(rowHeights, dividerIdx, wd, MIN_PANE_FRACTION));
    } else if (path.length === 1) {
      const rowIdx = path[0];
      onUpdateRows(rows.map((r, i) => (i === rowIdx ? { ...r, widths: resizeWeights(r.widths, dividerIdx, wd, MIN_PANE_FRACTION) } : r)));
    }
  }, [rows, rowHeights, onUpdateRows, onUpdateRowHeights]);

  // Double-click a divider → equalize. Row heights are weighted by each row's
  // sub-stack depth (matches legacy equalizeVertical); columns are plain 1/n
  // (legacy equalizeHorizontal — columns span the full row height).
  const handleTreeEqualize = useCallback((path: number[]) => {
    if (path.length === 0) {
      onUpdateRowHeights(weightedWidths(rows.map(rowVerticalDepth)));
    } else if (path.length === 1) {
      const rowIdx = path[0];
      onUpdateRows(rows.map((r, i) => (i === rowIdx ? { ...r, widths: equalizeWidths(r.groupIds.length) } : r)));
    }
  }, [rows, rowVerticalDepth, onUpdateRows, onUpdateRowHeights]);

  // "Reimposta pannelli" — flatten every split back to a single row of equal
  // columns (cellStacks dissolve; nothing closes). Null = already flat, so
  // the ctx-menu entry hides. The handler passes the LIVE group ids so the
  // [groups]-dep sync effect can't "heal" a missed group afterwards and skew
  // the equal widths. rows + rowHeights are computed OUTSIDE the setters as
  // plain values and committed in one handler (React 18 batches them; the
  // StrictMode double-invoke hazard only bites functional updaters reading
  // stale siblings).
  const canFlatten = useMemo(() => flattenGroupRows(rows) !== null, [rows]);
  const handleResetLayout = useCallback(() => {
    const flat = flattenGroupRows(rows, [...groupMap.keys()]);
    if (!flat) return;
    // Flatten is undoable — it used to irreversibly discard manual widths/
    // heights/stacks, and ⌘Z silently undid the previous CLOSE instead. The
    // pre-flatten rows/rowHeights are pure data, snapshotted verbatim.
    const prevRows = rows;
    const prevHeights = rowHeights;
    pushUndo({
      description: 'Reimposta pannelli',
      undo: () => {
        onUpdateRows(prevRows);
        onUpdateRowHeights(prevHeights);
      },
      redo: () => {
        onUpdateRows(flat.rows);
        onUpdateRowHeights(flat.rowHeights);
      },
    });
    onUpdateRows(flat.rows);
    onUpdateRowHeights(flat.rowHeights);
  }, [rows, rowHeights, groupMap, onUpdateRows, onUpdateRowHeights]);

  // Global "Reimposta pannelli" ('topics:reset-split-layout') is fired ONLY by the
  // header Topics menu and the ⌘K palette — a broad "tidy my layout" action with no
  // specific target. So every mounted surface flattens ITS OWN split; a surface
  // already flat no-ops (handleResetLayout early-returns on canFlatten=false). The
  // old `isAppFocused` gate meant a split living in a NON-focused surface never
  // reset (diagnosed: the focused surface was already flat while the split sat in a
  // blurred one) — the "non fa nulla" report. The per-tab context menu keeps its
  // targeted reset (it calls onResetLayout directly, not this event).
  useEffect(() => {
    const handler = () => handleResetLayout();
    window.addEventListener('topics:reset-split-layout', handler);
    return () => window.removeEventListener('topics:reset-split-layout', handler);
  }, [handleResetLayout]);

  // CHI E' SUBORDINATO: TUTTA la prima riga, non solo il primo gruppo.
  //
  // La condizione era `rowIdx === 0 && gid === leadingGid`, cioe' la sola barra
  // che ospita anche il blocco di testa. Sbagliata: in uno SPLIT i gruppi della
  // prima riga stanno fianco a fianco alla STESSA quota, e una barra da 34
  // accanto a una da 40 e' esattamente il disallineamento segnalato («in uno
  // split progetto la seconda tabbar esce disallineata», Attilio 09/08).
  // Lo slot di testa resta invece del solo primo gruppo: il progetto e' uno.
  //
  // Dalla riga 1 in giu' si torna a 40, e non e' un'eccezione: sopra quelle
  // barre c'e' un DIVISORE, non una riga di chrome — l'aria in cima non l'ha
  // messa nessuno, quindi va messa da loro.
  //
  // La riga di chrome subordinata, e la variabile che la accompagna. Vanno
  // SEMPRE insieme: `--chrome-bar-h` alimenta il rientro delle celle e il varco
  // in cima alla conversazione, quindi una barra a 34 con la variabile a 40
  // aprirebbe una fascia vuota sotto la barra. La classe va al POSTO dello stile
  // in linea, che altrimenti la batte.
  const barraSub = (primo: boolean) => (subordinate && primo ? CHROME_BAR_SUB : CHROME_BAR);
  const cardVar = (primo: boolean) =>
    subordinate && primo
      ? ({ className: CHROME_BAR_SUB_H_CLASS, style: undefined } as const)
      : ({ className: '', style: CHROME_BAR_H_VAR } as const);

  if (rows.length === 0) {
    const emptyAvailableTypes = availableTypesForGroup('chat', '');
    return (
      <div className={`relative flex-1 flex flex-col min-h-0 min-w-0 ${cardVar(true).className}`} style={cardVar(true).style}>
        {/* Match the populated branch's chrome row (h-10) so the empty
            project tab bar aligns with the sidebar header. */}
        <div className={barraSub(true)}>
          {leadingSlot && <LeadingSlot node={leadingSlot} />}
          <div className="flex-1 flex items-center min-w-0 overflow-hidden">
            <PaneTabBar
              hasLeadingBlock={!!leadingSlot}
              panes={[]}
              activePaneId={null}
              onActivate={() => {}}
              onClose={() => {}}
              onAddPane={(type, subType) => (onAddPaneWhenEmpty ?? (() => {}))(type, subType)}
              availableTypes={emptyAvailableTypes}
              dndScope={dndScope}
              onResetLayout={canFlatten ? handleResetLayout : undefined}
              onNewChat={onNewChatInGroup ? () => onNewChatInGroup('') : undefined}
            />
          </div>
        </div>
        {belowSlot && <LeadingSlot node={belowSlot} />}
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-app-text-muted">
          <div className="text-sm">No chats open</div>
          {onNewChatInGroup && (
            <button
              onClick={() => onNewChatInGroup('')}
              className="px-3 py-1.5 text-xs rounded-md bg-app-surface border border-app-border hover:bg-app-hover transition-colors text-app-text"
            >
              New Chat
            </button>
          )}
        </div>
      </div>
    );
  }

  // Render one group's "block" — its tab bar + active-pane content — reused for
  // a column's primary group AND for each group vertically stacked under it via
  // cellStacks. `rowIdx` drives the last-row gutter inset; `seenPaneIds` is
  // threaded so a duplicated pane id never paints twice.
  // Il gruppo la cui barra ospita il blocco di testa (vedi `leadingSlot`): il
  // primo della prima riga. Con uno split le righe di chrome sono N, il
  // progetto uno solo.
  const leadingGid = rows[0]?.groupIds[0];

  const renderGroupBlock = (gid: string, rowIdx: number, seenPaneIds: Set<string>): React.ReactNode => {
    const group = groupMap.get(gid);
    if (!group) return null;
    const groupPanes = group.paneIds
      .map(id => paneMap.get(id))
      .filter((p): p is Pane => !!p && !seenPaneIds.has(p.id));
    for (const p of groupPanes) seenPaneIds.add(p.id);
    // `focusedGroupId` e' null finche' non si clicca (e all'apertura di una
    // finestra senza fuoco persistito). Trattarlo come «nessun gruppo a fuoco»
    // direbbe che l'utente non sta guardando niente, e da quel giudizio dipende
    // il rilievo della tab attiva e la soppressione del suo badge. La convenzione
    // «senza fuoco vale il primo gruppo» esiste gia' qui sopra (la scelta della
    // pane residente): questa la riusa invece di inventarne una seconda.
    const isFocusedGroup = (focusedGroupId ?? groups[0]?.id ?? null) === gid;
    const groupNotifications = new Map<string, number>();
    for (const p of groupPanes) {
      // `isActive` qui vuol dire «l'utente la sta guardando», non «e' l'attiva
      // del suo gruppo»: in split view ogni gruppo ha la sua attiva, e passare
      // la seconda faceva scattare la scorciatoia di `getBadgeCount` (che
      // restituisce la sola attenzione Claude, senza gli unread) anche per i
      // gruppi che non hai davanti. Stesso predicato che usa `PaneTabBar` per
      // sopprimere il badge.
      const guardata = p.id === group.activePaneId && isFocusedGroup && isAppFocused;
      const c = getBadgeCount(p.id, p.topicId, guardata);
      if (c > 0) groupNotifications.set(p.id, c);
    }
    // Tri-state for the active tab + content ring:
    //  - fully focused: project is App-focused AND this is the focused group
    //  - dimmed-active: this is the focused group inside the project, but
    //    the project itself sits next to a focused sibling at App level
    //  - inactive: not the focused group of this project
    const isFullyFocused = isFocusedGroup && isAppFocused;
    const edgeDrop = edgeDropTarget?.groupId === gid ? edgeDropTarget.edge : null;
    // Shared split gating (splitRules.ts, one predicate with the standalone
    // surface): splitting the only pane of a group into itself is a visual
    // no-op — hide the entries instead of offering a silent failure
    // (handleSplitGroup used to just console.warn).
    const groupCanSplit = canSplitPane({ surface: 'project', groupSize: group.paneIds.length });
    return (
      <div data-split-card className={`relative flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden ${cardVar(rowIdx === 0).className}`} style={cardVar(rowIdx === 0).style}>
        {/* Per-group tab bar — h-10 to match the project sidebar header
            and the StandaloneChatGroup header (consistent chrome row). */}
        <div className={barraSub(rowIdx === 0)} onDragOverCapture={handleTabBarDragOver(gid)}>
          {leadingSlot && gid === leadingGid && <LeadingSlot node={leadingSlot} />}
          <div className="flex-1 flex items-center min-w-0 overflow-hidden">
          <PaneTabBar
              hasLeadingBlock={!!leadingSlot}
            subordinate={subordinate && rowIdx === 0}
            panes={groupPanes}
            activePaneId={group.activePaneId}
            groupIsFocused={isFocusedGroup}
            groupIsAppFocused={isFullyFocused}
            onActivate={(paneId) => { clearPane(paneId); onActivatePane(gid, paneId); }}
            onClose={(paneId) => onClosePane(gid, paneId)}
            onCloseImmediate={onClosePaneImmediate ? (paneId) => onClosePaneImmediate(gid, paneId) : undefined}
            onAddPane={(type, subType) => onAddPaneToGroup(gid, type, subType)}
            availableTypes={availableTypesForGroup(group.type, gid)}
            groupType={group.type}
            groupId={gid}
            dndScope={dndScope}
            // "New Chat" is always offered in project tab bars
            // regardless of group.type. Previously gated to
            // `group.type === 'chat'`, which hid the entry from
            // file/browser/git/board groups — the user couldn't
            // create a project chat from them at all. The
            // handler routes the new chat into the project's
            // existing chat group (or creates one) — it does
            // NOT add a chat into a non-chat group.
            onNewChat={onNewChatInGroup
              ? () => onNewChatInGroup(gid)
              : undefined
            }
            onReorderPanes={onReorderGroupPanes
              ? (newPaneIds) => onReorderGroupPanes(gid, newPaneIds)
              : undefined
            }
            onCrossGroupDrop={onMovePaneBetweenGroups
              ? handleCrossGroupDrop(gid)
              : undefined
            }
            onEdgeSplitDrop={onSplitGroup
              ? (sourcePaneId, sourceGroupId, edge) => onSplitGroup(sourceGroupId, sourcePaneId, gid, edge)
              : undefined
            }
            onSplitRight={onSplitGroup && groupCanSplit
              ? (paneId) => onSplitGroup(gid, paneId, gid, 'right')
              : undefined
            }
            // "Split Down" mirrors the cell bottom-edge drop: a SINGLE-COLUMN
            // vertical stack (under just this column), not a full-width row.
            onSplitDown={onSplitGroup && groupCanSplit
              ? (paneId) => onSplitGroup(gid, paneId, gid, 'bottom')
              : undefined
            }
            onResetLayout={canFlatten ? handleResetLayout : undefined}
            onContextRingClick={onContextRingClick}
            onStopStreaming={onStopStreaming}
            onSettings={onSettings}
            onPopOut={onPopOut}
            onRenameChat={onRenameChat}
            onRenameBrowser={onRenameBrowser}
              onToggleFissato={onToggleFissato}
              isFissato={isFissato}
              projectPinKey={projectPinKey}
            onPinPane={onPinPane ? (paneId) => onPinPane(gid, paneId) : undefined}
            tabNotifications={groupNotifications}
            nonClosablePaneIds={nonClosablePaneIds}
            linkContext={linkContext}
            onOpenPaneInProject={onOpenPaneInProject}
          />
          </div>
        </div>
        {belowSlot && gid === leadingGid && <LeadingSlot node={belowSlot} />}
        {/* Active pane content */}
        {/* La riga dei comandi ha già scavalcato la barra: da qui in giù non va
            riservata una seconda volta. Vedi CHROME_BAR_CONSUMED — erano 38px
            di fascia vuota, misurati. La condizione è la STESSA della riga qui
            sopra, o si azzererebbe in gruppi che la riga non ce l'hanno. */}
        <div
          className={`flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden relative ${belowSlot && gid === leadingGid ? CHROME_BAR_CONSUMED : ''}`}
          onMouseDownCapture={() => {
            if (!isFocusedGroup && group.activePaneId) {
              onActivatePane(gid, group.activePaneId);
            }
          }}
          onDragOver={handleGroupContentDragOver(gid)}
          onDragLeave={handleGroupContentDragLeave(gid)}
          onDrop={handleGroupContentDrop(gid)}
        >
          {(() => {
            // Keep-alive render: every pane that has been visited
            // stays mounted; only the active one is visible. This
            // preserves chat scroll, history caches, terminal
            // buffers, and form drafts across tab switches —
            // before this, switching tabs unmounted the active
            // pane and re-mounted it from scratch, so users saw
            // a "reload" flicker (re-fetched history, lost
            // scroll, etc.) every time they came back.
            //
            // Always include the currently-active pane even if the
            // residency registry hasn't caught up yet — a surface
            // registers itself in a useEffect that runs *after*
            // render, so on the first render after activation
            // we'd otherwise show the empty-state for one frame.
            // Using `stableKey` as the React key (not pane.id)
            // keeps the subtree mounted across PANE_ID_REMAP.
            const visiblePanes = groupPanes.filter(
              (p) => isResidentPane(p) || p.id === group.activePaneId,
            );
            if (visiblePanes.length === 0) {
              return (
                <div className="flex-1 flex items-center justify-center text-app-text-muted text-sm">
                  No pane selected
                </div>
              );
            }
            return visiblePanes.map((pane) => {
              const isPaneActive = pane.id === group.activePaneId;
              return (
                <PaneKeepAlive
                  key={stableKeyOf(pane)}
                  paneKey={stableKeyOf(pane)}
                  isVisible={isPaneActive}
                  // Cell background tier (paneCellBg): `project`/`terminal`
                  // fully transparent (they frost themselves), chat + kanban +
                  // browser in the frosted tier (`pane-frost`), the rest opaque
                  // `bg-surface` so dense text stays crisp over the vibrancy.
                  className={`flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden ${paneCellBg(pane.type)} ${paneCellTopInset(pane.type)}`}
                >
                  {renderPane(pane, isFocusedGroup && isPaneActive, isPaneActive)}
                </PaneKeepAlive>
              );
            });
          })()}

          {/* Single-column split preview — a filled region the width of THIS
              column. On the bottom row (when full-width-row strips are live) its
              bottom stops above the gutter so the column-split and full-width-row
              previews never visually collide; width alone tells them apart.
              'center' paints the inset merge region instead (add-as-tab). */}
          {edgeDrop && edgeDrop !== 'center' && (
            <SplitRegion
              zone={edgeDrop}
              gutterInset={rowIdx === rows.length - 1 && rows.some((r) => r.groupIds.length > 1) ? FULL_ROW_GUTTER_PX : 0}
              topInset={rowIdx === 0 && rows.some((r) => r.groupIds.length > 1) ? FULL_ROW_GUTTER_PX : 0}
            />
          )}
          {edgeDrop === 'center' && <CenterRegion />}
        </div>
      </div>
    );
  };

  // One tree leaf = one top-level column cell. Reuses renderGroupBlock + the same
  // CellSubStack composition as the legacy cell, so tab bars, keep-alive, DnD and
  // sub-stacks behave identically; SplitTree owns only the structural flex +
  // dividers, so the leaf wrapper carries NO `flex` style (it's already 100%×100%).
  const renderTreeLeaf = (gid: string): React.ReactNode => {
    if (gid.startsWith('__skip:')) return null;
    const group = groupMap.get(gid);
    if (!group) return null;
    const pos = keyPos.get(gid);
    const rowIdx = pos ? pos[0] : 0;
    const groupIdx = pos ? pos[1] : 0;
    const rawStack = rows[rowIdx]?.cellStacks?.[gid];
    const stackedIds = (rawStack?.groupIds ?? []).filter((id) => groupMap.has(id));
    const subStack = stackedIds.length > 0
      ? { items: stackedIds, heights: rawStack?.heights ?? [] }
      : undefined;
    // Each leaf renders independently; treeRoot already deduped GROUPS (first
    // occurrence wins), so a fresh per-leaf Set only has to stop a pane duplicated
    // within this column's own stack from painting twice.
    const seen = new Set<string>();
    // Row drag-reorder, migrated 1:1 from the legacy row container: every leaf in
    // a row is a drop zone for THAT row (drop on any column targets the row), and
    // the inset band shows on EVERY leaf of the target row, so the indicator spans
    // the full row exactly like legacy's single row-wide container. The grab handle
    // lives only on the first column (groupIdx 0) so it sits at the row's left edge.
    // All of this reuses the SAME handlers/state as the legacy path — it only
    // mutates `rows` via onReorderRows, and the tree re-derives from `rows`, so the
    // reorder is structural, not a tree concern. Type-guarded (LAYOUT_ROW) inside
    // the handlers, so pane DnD passes straight through.
    const isDraggingRow = draggingRowIdx === rowIdx;
    const rowDropSide = rowDropTarget?.idx === rowIdx ? rowDropTarget.side : null;
    return (
      <div
        data-group-cell={`${rowIdx}-${groupIdx}`}
        className={`relative flex w-full h-full min-h-0 min-w-0 overflow-hidden ${isDraggingRow ? 'opacity-40' : ''}`}
        // DOVE CADRÀ, con l'attributo del contratto invece di un'ombra scritta
        // qui: `before`/`after` sono lo stesso inserimento posizionale della
        // barra delle tab, e adesso lo dicono con la stessa lama. L'asse lo
        // dichiara il bersaglio perché qui la fila è IMPILATA — si entra sopra
        // o sotto, non a sinistra o a destra (vedi `data-drop-axis` in
        // index.css).
        data-drop-axis="y"
        data-drop-active={rowDropSide === 'top' ? 'before' : rowDropSide === 'bottom' ? 'after' : undefined}
        onDragOver={handleRowDragOver(rowIdx)}
        onDrop={handleRowDrop}
      >
        {onReorderRows && rows.length > 1 && groupIdx === 0 && (
          <div
            className="absolute left-0 top-0 w-3 h-full z-20 cursor-grab active:cursor-grabbing flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
            draggable
            onDragStart={handleRowDragStart(rowIdx)}
            title={`Drag to reorder row ${rowIdx + 1}`}
          >
            <div className="w-1 h-6 bg-app-text-tertiary/40 rounded-full" />
          </div>
        )}
        <CellSubStack
          stack={subStack}
          primary={renderGroupBlock(gid, rowIdx, seen)}
          primaryKey={gid}
          renderStackItem={(stackedId) => renderGroupBlock(stackedId, rowIdx, seen)}
          onResize={(nextHeights) => onUpdateRows(setColumnStackHeights(rows, gid, nextHeights))}
        />
      </div>
    );
  };

  // ── Mobile flatten (<768px). A phone shows ONE pane at a time; every pane
  // across every group becomes a tab in a single strip, and only the active
  // pane renders. Bypasses the SplitTree entirely (no split on a narrow
  // screen). The underlying group/row model and its sync are left untouched —
  // we only flatten at RENDER, so desktop behaviour is unchanged.
  const renderMobile = (): React.ReactNode => {
    const seen = new Set<string>();
    const flatPanes: Pane[] = [];
    for (const g of groups) {
      for (const id of g.paneIds) {
        const p = paneMap.get(id);
        if (p && !seen.has(p.id)) { seen.add(p.id); flatPanes.push(p); }
      }
    }
    const groupIdOfPane = (pid: string): string | undefined =>
      groups.find((g) => g.paneIds.includes(pid))?.id;
    const focusedGroup = (focusedGroupId ? groupMap.get(focusedGroupId) : undefined) ?? groups[0];
    const fgid = focusedGroup?.id ?? '';
    const activePaneId =
      focusedGroup?.activePaneId && flatPanes.some((p) => p.id === focusedGroup.activePaneId)
        ? focusedGroup.activePaneId
        : (flatPanes[0]?.id ?? null);

    if (flatPanes.length === 0) {
      return (
        <div className={`relative flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden ${cardVar(true).className}`} style={cardVar(true).style}>
          <div className={barraSub(true)}>
            {leadingSlot && <LeadingSlot node={leadingSlot} />}
            <div className="flex-1 flex items-center min-w-0 overflow-hidden">
              <PaneTabBar
              hasLeadingBlock={!!leadingSlot}
                panes={[]}
                activePaneId={null}
                onActivate={() => {}}
                onClose={() => {}}
                onAddPane={(type, subType) => (onAddPaneWhenEmpty ?? (() => {}))(type, subType)}
                availableTypes={availableTypesForGroup('chat', '')}
                dndScope={dndScope}
                onNewChat={onNewChatInGroup ? () => onNewChatInGroup('') : undefined}
              />
            </div>
          </div>
          {belowSlot && <LeadingSlot node={belowSlot} />}
        </div>
      );
    }

    const notifications = new Map<string, number>();
    for (const p of flatPanes) {
      // Vista piatta: un solo gruppo, quindi «guardata» = attiva E app a fuoco.
      const c = getBadgeCount(p.id, p.topicId, p.id === activePaneId && isAppFocused);
      if (c > 0) notifications.set(p.id, c);
    }

    return (
      <div className={`relative flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden ${cardVar(true).className}`} style={cardVar(true).style}>
        <div className={barraSub(true)}>
          {leadingSlot && <LeadingSlot node={leadingSlot} />}
          <div className="flex-1 flex items-center min-w-0 overflow-hidden">
            <PaneTabBar
              hasLeadingBlock={!!leadingSlot}
              panes={flatPanes}
              activePaneId={activePaneId}
              groupIsFocused
              groupIsAppFocused={isAppFocused}
              onActivate={(paneId) => { clearPane(paneId); const gid = groupIdOfPane(paneId); if (gid) onActivatePane(gid, paneId); }}
              onClose={(paneId) => { const gid = groupIdOfPane(paneId); if (gid) onClosePane(gid, paneId); }}
              onCloseImmediate={onClosePaneImmediate ? (paneId) => { const gid = groupIdOfPane(paneId); if (gid) onClosePaneImmediate(gid, paneId); } : undefined}
              onAddPane={(type, subType) => onAddPaneToGroup(fgid, type, subType)}
              availableTypes={availableTypesForGroup(focusedGroup?.type ?? 'chat', fgid)}
              groupType={focusedGroup?.type}
              groupId={fgid}
              dndScope={dndScope}
              onNewChat={onNewChatInGroup ? () => onNewChatInGroup(fgid) : undefined}
              onContextRingClick={onContextRingClick}
              onStopStreaming={onStopStreaming}
              onSettings={onSettings}
              onPopOut={onPopOut}
              onRenameChat={onRenameChat}
              onRenameBrowser={onRenameBrowser}
              onToggleFissato={onToggleFissato}
              isFissato={isFissato}
              projectPinKey={projectPinKey}
              onPinPane={onPinPane ? (paneId) => { const gid = groupIdOfPane(paneId); if (gid) onPinPane(gid, paneId); } : undefined}
              tabNotifications={notifications}
              nonClosablePaneIds={nonClosablePaneIds}
              linkContext={linkContext}
              onOpenPaneInProject={onOpenPaneInProject}
            />
          </div>
        </div>
        {belowSlot && <LeadingSlot node={belowSlot} />}
        {/* Stessa cosa nella vista piatta: vedi CHROME_BAR_CONSUMED. */}
        <div className={`flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden relative ${belowSlot ? CHROME_BAR_CONSUMED : ''}`}>
          {flatPanes
            .filter((p) => isResidentPane(p) || p.id === activePaneId)
            .map((pane) => {
              const isPaneActive = pane.id === activePaneId;
              return (
                <PaneKeepAlive
                  key={stableKeyOf(pane)}
                  paneKey={stableKeyOf(pane)}
                  isVisible={isPaneActive}
                  className={`flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden ${paneCellBg(pane.type)} ${paneCellTopInset(pane.type)}`}
                >
                  {renderPane(pane, isPaneActive, isPaneActive)}
                </PaneKeepAlive>
              );
            })}
        </div>
      </div>
    );
  };

  // The full-width drop strips (split "in basso/in alto a TUTTE le tab") only
  // make sense when there's more than one column somewhere — with a single
  // column a per-cell vertical split already spans the full width, so the
  // distinction (and the strips) would be redundant.
  const hasMultipleColumns = rows.some((r) => r.groupIds.length > 1);
  const showFullRowStrips = dragActive && hasMultipleColumns && !!onSplitGroup;

  return (
    <div
      ref={containerRef}
      data-split-surface
      // See PanelGrid: mid-drag, neutralise the divider grab band (CSS below)
      // so an edge drop that lands on the divider band still splits the group.
      data-drag-active={dragActive || undefined}
      className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden relative"
      onDragEnd={resetDndOverlays}
      onDragEnterCapture={(e) => { if (isPaneTabDrag(e)) setDragActive(true); }}
    >
      {/* Full-width row drop strips — only live mid-drag (dragActive) so their
          top/bottom bands never swallow normal clicks on the first row's tab
          bar. Dropping here inserts a NEW row spanning every column. */}
      {showFullRowStrips && (['top', 'bottom'] as const).map((side) => (
        <FullWidthRowZone
          key={side}
          side={side}
          active={fullRowDrop === side}
          // Offset the TOP strip below the first row's tab bar (h-10 = 40px) so
          // it sits over content, never over the bar — otherwise it swallowed
          // clicks and stole tab-move drops on the first row's tabs.
          edgeOffset={side === 'top' ? TAB_BAR_H : 0}
          onDragOver={handleFullRowDragOver(side)}
          onDragLeave={handleFullRowDragLeave}
          onDrop={handleFullRowDrop(side)}
        />
      ))}
      {/* Interior row-gap strips — insert a full-width row BETWEEN rows i and
          i+1 (see the handlers above). Positioned at each boundary via the
          cumulative row heights; the 1px divider offset is negligible vs the
          26px band. */}
      {dragActive && !!onSplitGroup && rows.length > 1 && (() => {
        const total = rowHeights.reduce((s, h) => s + (Number.isFinite(h) && h > 0 ? h : 1 / rows.length), 0) || 1;
        let acc = 0;
        return rows.slice(0, -1).map((_, i) => {
          const h = rowHeights[i];
          acc += (Number.isFinite(h) && h > 0 ? h : 1 / rows.length) / total;
          return (
            <RowGapDropZone
              key={`gap-${i}`}
              topPct={acc * 100}
              active={rowGapDrop === i}
              onDragOver={handleRowGapDragOver(i)}
              onDragLeave={handleRowGapDragLeave}
              onDrop={handleRowGapDrop(i)}
            />
          );
        });
      })()}
      {isMobile
        ? renderMobile()
        : treeRoot && (
          <SplitTree
            node={treeRoot}
            renderLeaf={renderTreeLeaf}
            onResize={handleTreeResize}
            onEqualize={handleTreeEqualize}
            gutter={1}
          />
        )}
    </div>
  );
}
