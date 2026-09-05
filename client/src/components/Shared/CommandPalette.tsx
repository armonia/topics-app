import { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import {
  Search, Settings, Moon, Sun, File,
  Loader2, TerminalSquare, RotateCcw, Grid2x2, Link2, ArrowLeft,
} from 'lucide-react';
import { EmptyState } from './EmptyState';
import { ClaudeIcon } from './ClaudeIcon';
import { CodexIcon } from './CodexIcon';
import { ProjectFavicon } from './ProjectFavicon';
import { basename } from '../../lib/path-utils';
import { getProjectLabel } from '../../lib/buildSidebarItems';
import type { Topic, SearchResult } from '../../types';
import type { ClosedTabRecord } from '../../state/pane/adapters';
import { searchApi } from '../../lib/api';
import { requestScrollToMessage } from '../../state/scrollToMessage';
import { PANE_CONFIG, tabTargetForPane } from '../../state/pane/adapters';
import { usePaneStore } from '../../state/pane/store';
import { useCopyTabLink } from '../../hooks/useCopyTabLink';
import { describeTabTarget } from '../../../../shared/tab-link';
import {
  MODAL_BACKDROP, MODAL_PANEL, MODAL_LAYER,
  MODAL_PAGE_CONTAINER, MODAL_PAGE_PANEL, MODAL_PAGE_INSET,
} from '../../lib/modalStyles';
import { useMobile } from '../../hooks/useMobile';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useT } from '../../hooks/useT';
import { isDesktop } from '../../lib/shell';
import { rankPaths } from '../../lib/fuzzyScore';
import { buildAddMenuItems } from './addMenuItems';
import { buildHistoryRows } from '../../lib/historyRows';
import { pagesSnapshot, subscribeSites } from '../../state/browserSiteHistory';
import { BrowserFavicon } from '../Browser/BrowserFavicon';
import { AddMenuIcon } from './AddMenuIcon';
import type { PaneType } from '../../types';
import { shortcut } from '../../lib/shortcutLabel';

export interface CommandAction {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode | null;
  category: 'project' | 'topic' | 'action' | 'command' | 'file' | 'message' | 'recent-closed' | 'recent-file';
  shortcut?: string;
  action: () => void;
  /** Raw content for highlight rendering in message results */
  _rawContent?: string;
  /** Sort timestamp used when mixing topics with recently-closed in the main list. */
  _ts?: number;
  /** Optional override for the row's title tooltip — used when the row
   *  carries a long path (cwd, file path) that we want fully revealed on
   *  hover, not just the truncated description. */
  titleOverride?: string;
  /** `data-testid` sulla riga. Lo usano le voci di CREAZIONE, che devono
   *  restare confrontabili col menu "+" (gate di parità ADD-09). */
  testId?: string;
}


function getProjectDescription(projectPath: string): string {
  const parts = projectPath.split('/').filter(Boolean);
  if (parts.length === 0) return projectPath;
  const folderName = parts[parts.length - 1];
  const parentPath = parts.slice(0, -1).join('/');
  if (!parentPath) return folderName;
  const parentName = parentPath.split('/').pop() || parentPath;
  return `${folderName} (${parentName})`; // e.g., "topics-app (Projects)"
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  /** Result scope: 'all' (⌘K — topics, messages, files, everything),
   *  'projects' (⌘F — find/jump to a project; only project rows render) or
   *  'history' (the HISTORY: closed tabs and visited pages, one single list). */
  scope?: 'all' | 'projects' | 'history';
  topics: Record<string, Topic>;
  /** Known workspace project paths (same source the sidebar uses) — merged
   *  into the Projects list so ⌘F can jump to a project even when none of
   *  its chats are loaded as topics. */
  workspaceProjects?: string[];
  onOpenTopic: (id: string) => void;
  onOpenProject?: (projectPath: string) => void;
  onNewTopic: () => void;
  /** Apre il picker di sistema «Apri / Crea progetto». UNA prop: prima erano
   *  `onNewProject` e `onCreateProject`, due nomi che App cablava alla stessa
   *  funzione per alimentare due pill identiche. */
  onProjectPicker?: () => void;
  /** «Crea una pane di questo tipo nel contesto standalone». Sostituisce le
   *  vecchie onNewClaude/onNewCodex/onNewTerminal: le pill escono da
   *  `buildAddMenuItems`, quindi una callback per AGENTE non serve più — e
   *  serviva a produrre proprio la divergenza (opencode non c'era). */
  onAddPane?: (type: PaneType, subType?: string) => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onOpenFileSearch?: () => void;
  /** "Reimposta pannelli al primo livello" — flattens the FOCUSED surface's
   *  split layout to a single row (App dispatches the per-window
   *  'topics:reset-split-layout' CustomEvent; the focused GroupLayout /
   *  PanelGrid listener acts). Always offered; a no-op when already flat. */
  onResetPanels?: () => void;
  onAutoTilePanels?: () => void;
  themeMode: string;
  projectPath?: string;
  onOpenFile?: (path: string, lineNumber?: number) => void;
  closedTabs?: ClosedTabRecord[];
  onReopenClosedTab?: (record: ClosedTabRecord) => void;
  /** Opens a history URL in a browser pane. Without it the page rows never
   *  show up at all: a row that leads nowhere is worse than a row that is
   *  simply missing. */
  onOpenHistoryUrl?: (url: string) => void;
}

export function CommandPalette({
  isOpen,
  onClose,
  scope = 'all',
  topics,
  workspaceProjects = [],
  onOpenTopic,
  onOpenProject,
  onNewTopic,
  onProjectPicker,
  onAddPane,
  onToggleTheme,
  onOpenSettings,
  onResetPanels,
  onAutoTilePanels,
  themeMode,
  projectPath,
  onOpenFile,
  closedTabs,
  onReopenClosedTab,
  onOpenHistoryUrl,
}: CommandPaletteProps) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Le voci di CREAZIONE sono il menu "+" standalone — stesso modello, stesso
  // ordine, stesso insieme — rese come RIGHE della lista, non come pill.
  //
  // Erano pill in fondo, e da lì la tastiera non le raggiungeva: in ⌘K il fuoco
  // sta nel campo di ricerca, quindi la lettera nuda che apre una voce nel menu
  // "+" qui scriverebbe soltanto una lettera nella query. Dipingerla sarebbe
  // stato lo stesso errore del "⌘N" sulla riga New Chat — un hint falso.
  // Come righe invece ereditano le scorciatoie che in questa superficie
  // ESISTONO e che il footer già annuncia: ↑↓ per scorrere, ↵ per aprire. E si
  // possono cercare: "brow" trova Browser. In più la barra in fondo smette di
  // andare a capo, perché non porta più otto pill.
  const createItems = useMemo((): CommandAction[] =>
    buildAddMenuItems({
      scope: 'standalone',
      onNewChat: onNewTopic,
      onAddPane,
      onProjectPicker,
    }).map((item) => ({
      id: `create-${item.id}`,
      label: item.label,
      icon: <AddMenuIcon item={item} size={14} />,
      category: 'action' as const,
      shortcut: item.id === 'new-chat' && isDesktop ? shortcut('N') : undefined,
      testId: `cmdk-add-${item.id}`,
      action: () => { item.run(); onClose(); },
    })),
    [onNewTopic, onAddPane, onProjectPicker, onClose],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /* «Quante colonne» e' la domanda di `isMobile`, non di `isTouch`: qui decide
     se la palette e' una scheda che galleggia o una pagina. Vedi useMobile. */
  const { isMobile } = useMobile();
  const [fileList, setFileList] = useState<string[]>([]);
  const [searchResults, setSearchResults] = useState<CommandAction[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  // A FAILED search is not an empty one. Without this flag a 500, a timeout or
  // a dropped network rendered the very same "no results" as a word that truly
  // is not there, which teaches the reader the wrong thing about their own
  // data. `FileSearch` already draws the two apart; this is the same shape.
  const [searchFailed, setSearchFailed] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced message search
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    const q = query.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchFailed(false);
      return;
    }
    setSearchLoading(true);
    setSearchFailed(false);
    searchTimeout.current = setTimeout(async () => {
      try {
        const data = await searchApi.search(q, 20);
        setSearchResults(
          data.results
            .filter((r: SearchResult) => r.topicId)
            .map((r: SearchResult) => {
              const roleLabel = r.role === 'user' ? 'You' : 'Assistant';
              const truncated = r.content.slice(0, 80).replace(/\n/g, ' ');
              const dateStr = r.timestamp ? new Date(r.timestamp).toLocaleDateString() : '';
              return {
                id: `msg-${r.sessionKey}-${r.timestamp}`,
                label: `${roleLabel}: ${truncated}`,
                description: `${r.topicName}${dateStr ? ' · ' + dateStr : ''}`,
                // Topic chats carry no leading icon (agent brands live only on
                // Claude Code / Codex sessions, not on topic chats).
                icon: null,
                category: 'message' as const,
                action: () => {
                  // Register the jump target BEFORE opening — a fresh mount's
                  // load-complete pass must already find it (legacy JSONL hits
                  // carry no id → plain open, as before).
                  if (r.messageId) requestScrollToMessage(r.topicId!, r.messageId);
                  onOpenTopic(r.topicId!);
                  onClose();
                },
                _rawContent: r.content.slice(0, 200),
              };
            })
        );
      } catch {
        setSearchResults([]);
        setSearchFailed(true);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [query, onOpenTopic, onClose]);

  // Fetch flat file list when palette opens with a project path. Skipped in
  // projects scope (⌘F) — only project rows render there. Guard the payload:
  // a malformed/mocked response without a `files` array must not poison the
  // searchFileItems memo (`undefined.filter` crashed the whole palette).
  useEffect(() => {
    if (projectPath && isOpen && scope !== 'projects') {
      // Staleness guard: the palette stays mounted while open, and ⌘1-9
      // switches focusedProjectPath (its capture-phase handler is NOT gated on
      // the palette). If project A's slow flatList resolves after B's, it must
      // not clobber B's list — the user would see/open paths from the wrong
      // project.
      let cancelled = false;
      // `const { … } = await import(…)` e non `import(…).then(({ … }) => …)`:
      // sono la stessa cosa a runtime, non per il cancello sul codice morto. Un
      // `import()` il cui risultato non finisce in una destrutturazione è OPACO
      // per knip, che non sapendo quali membri leggerai assume che li usi TUTTI
      // — e da lì in poi NESSUN export di quel modulo può più risultare morto.
      // Con `api.ts` (49 export, la superficie HTTP del client) questa riga da
      // sola teneva cieco il cancello sull'intero file. Guardia:
      // `bun run check:deadcode-blindspots`.
      void (async () => {
        const { filesApi } = await import('../../lib/api');
        try {
          const data = await filesApi.flatList(projectPath);
          if (!cancelled) setFileList(Array.isArray(data?.files) ? data.files : []);
        } catch { /* lista file non disponibile: la palette resta sui comandi */ }
      })();
      return () => { cancelled = true; };
    }
  }, [projectPath, isOpen, scope]);

  // ── Projects column (always visible accordion, left) ────────────────────
  const projectItems = useMemo((): CommandAction[] => {
    const recentProjects: string[] = (() => {
      try {
        const raw = localStorage.getItem('recent-projects');
        return raw ? JSON.parse(raw) : [];
      } catch { return []; }
    })();
    const projectPaths = new Set<string>();
    Object.values(topics).forEach(t => { if (t.projectPath) projectPaths.add(t.projectPath); });
    recentProjects.forEach(p => projectPaths.add(p));
    workspaceProjects.forEach(p => projectPaths.add(p));
    const ordered = [
      ...recentProjects.filter(p => projectPaths.has(p)),
      ...Array.from(projectPaths).filter(p => !recentProjects.includes(p)).sort(),
    ];
    return ordered.map(pp => ({
      id: `project-${pp}`,
      label: getProjectLabel(pp),
      description: getProjectDescription(pp),
      // Real project icon when the folder ships a favicon / web-manifest /
      // index.html <link rel=icon> (resolved by /api/projects/icon); folders
      // without one render nothing (no fake folder glyph — same convention as
      // TopicTree).
      icon: <ProjectFavicon path={pp} size={14} />,
      category: 'project' as const,
      action: () => { onOpenProject?.(pp); onClose(); },
      titleOverride: pp, // Full path on hover
    }));
  }, [topics, workspaceProjects, onOpenProject, onClose]);

  // ── HISTORY (closed tabs + visited pages, one single list) ──
  //
  // They were two separate lists: closed tabs here, the browser pages inside
  // a dropdown on its own toolbar, per topic. Two places for the same question
  // ("where was I, take me back") means searching twice. The rows are built by
  // `buildHistoryRows`, which is pure and merges them by time; the only thing
  // decided here is what the click does, the one thing genuinely different
  // between the two: a tab REOPENS where it was, a URL opens in a browser pane.
  const pages = useSyncExternalStore(subscribeSites, pagesSnapshot, pagesSnapshot);
  const recentItems = useMemo((): CommandAction[] => {
    const rows = buildHistoryRows({
      closedTabs: onReopenClosedTab ? closedTabs : [],
      pages: onOpenHistoryUrl ? pages : [],
      limit: 40,
    });
    return rows.map((row, i) => {
      const record = row.record;
      const paneType = row.paneType;
      const icon = row.kind === 'page'
        ? <BrowserFavicon url={row.url ?? ''} faviconUrl={row.favicon} size={14} />
        : record?.terminal?.sessionType === 'claude-code'
          ? <ClaudeIcon size={14} />
          : record?.terminal?.sessionType === 'codex'
            ? <CodexIcon size={14} />
            : paneType === 'terminal'
              ? <TerminalSquare size={14} />
              : <RotateCcw size={14} />;
      const when = formatTimeAgo(row.at);
      const parts = [row.kind === 'page' ? when : `Chiusa ${when}`, row.detail].filter(Boolean);
      const config = paneType ? PANE_CONFIG[paneType] : undefined;
      return {
        id: `history-${row.id}`,
        label: row.label || config?.label || paneType || row.url || '',
        description: parts.join(' · '),
        icon,
        category: 'recent-closed' as const,
        _ts: row.at,
        // The undo shortcut belongs to the most recent TAB, which is the only
        // thing ⇧⌘T reopens: pinning it on a page row would promise a key that
        // does something else.
        shortcut: i === 0 && row.kind === 'tab' ? shortcut('T', { shift: true }) : undefined,
        titleOverride: row.url || record?.terminal?.cwd || record?.projectPath || undefined,
        action: () => {
          if (row.kind === 'tab' && record && onReopenClosedTab) onReopenClosedTab(record);
          else if (row.url && onOpenHistoryUrl) onOpenHistoryUrl(row.url);
          onClose();
        },
      };
    });
  }, [closedTabs, pages, onReopenClosedTab, onOpenHistoryUrl, onClose]);

  // ── Topics for SEARCH (rendered only when there's a query, sorted by recency) ──
  // Includes ARCHIVED (= closed) topics on purpose: in the 2-state model a
  // closed topic is reopened by finding it here and selecting it (which
  // unarchives + opens via handleTopicClick/openPanel). Archived ones are
  // marked "chiuso" so the state is clear. NOT shown in the empty state
  // (the empty body renders only the Projects + Recently-closed columns).
  const topicItems = useMemo((): CommandAction[] => {
    return Object.values(topics)
      .map(topic => {
        // Guard against NaN — topics without updatedAt/createdAt (e.g. the
        // Master/system topics, or chats created before timestamps were
        // tracked) would otherwise produce NaN which corrupts sort order
        // and pins them silently at the top of the list.
        const raw = new Date(topic.updatedAt || topic.createdAt).getTime();
        const ts = Number.isFinite(raw) ? raw : 0;
        const projLabel = topic.projectPath ? getProjectLabel(topic.projectPath) : undefined;
        const cloud = topic.provider === 'openclaw' ? 'cloud' : undefined;
        const descBits = [topic.archived ? 'chiuso' : undefined, cloud, projLabel].filter(Boolean);
        const description = descBits.length ? descBits.join(' · ') : undefined;
        return {
          id: `topic-${topic.id}`,
          label: topic.name,
          description,
          icon: null,
          category: 'topic' as const,
          _ts: ts,
          action: () => { onOpenTopic(topic.id); onClose(); },
        };
      })
      .sort((a, b) => (b._ts || 0) - (a._ts || 0));
  }, [topics, onOpenTopic, onClose]);

  // ── «Copia link» della tab a fuoco ──────────────────────────────────────
  // La terza superficie dello stesso gesto (le altre due sono il menu della tab
  // e quello del topic in sidebar), con le stesse parole — useCopyTabLink.
  //
  // Il soggetto è la tab a fuoco a LIVELLO APP, letta dal pane-store: è la
  // stessa `focusedPaneId` che usePanelLifecycle tiene allineata alla superficie
  // attiva. Con una finestra di progetto a fuoco il link è quello del PROGETTO —
  // le sue tab interne non vivono nel pane-store, e per quelle il link si copia
  // dal loro menu contestuale, che il progetto ce l'ha per prop.
  const focusedPane = usePaneStore((s) => (s.focusedPaneId ? s.panes[s.focusedPaneId] ?? null : null));
  const focusedTabTarget = useMemo(
    () => (focusedPane ? tabTargetForPane(focusedPane) : null),
    [focusedPane],
  );
  const { copyTabLink } = useCopyTabLink();

  // ── Layout actions (searchable command rows, 'action' category) ─────────
  // "Reimposta pannelli" (collapse every split into one tabbed cell) and its
  // inverse "Disponi automaticamente" (auto-tile every pane into a balanced
  // grid). Offered when the host wires the callback; each no-ops when there's
  // nothing to do. Rendered in the query results, not the empty-state columns.
  const actionItems = useMemo((): CommandAction[] => {
    const items: CommandAction[] = [];
    if (focusedTabTarget) {
      items.push({
        id: 'copy-tab-link',
        label: 'Copia link alla tab',
        // Il target per esteso: dice QUALE tab si sta per copiare, che con la
        // palette aperta sopra tutto non è ovvio.
        description: describeTabTarget(focusedTabTarget),
        icon: <Link2 size={14} />,
        category: 'action' as const,
        action: () => { void copyTabLink(focusedTabTarget); onClose(); },
      });
    }
    if (onResetPanels) {
      items.push({
        id: 'reset-panels',
        label: 'Reimposta pannelli',
        description: 'Riunisce tutti i pannelli in uno solo (le schede restano aperte)',
        icon: <RotateCcw size={14} />,
        category: 'action' as const,
        action: () => { onResetPanels(); onClose(); },
      });
    }
    if (onAutoTilePanels) {
      items.push({
        id: 'auto-tile-panels',
        label: 'Disponi automaticamente',
        description: 'Dispone tutte le schede affiancate in una griglia bilanciata',
        icon: <Grid2x2 size={14} />,
        category: 'action' as const,
        action: () => { onAutoTilePanels(); onClose(); },
      });
    }
    return items;
  }, [focusedTabTarget, copyTabLink, onResetPanels, onAutoTilePanels, onClose]);

  // ── File search results (only when query has text) ──────────────────────
  const searchFileItems = useMemo((): CommandAction[] => {
    if (!projectPath || !query.trim() || !onOpenFile) return [];
    // Ordina PRIMA, taglia DOPO. Era il contrario, e il difetto si misura:
    // cercando `store.ts` gli 11 file veri esistevano nella lista e NESSUNO
    // entrava nelle 20 righe mostrate, perché il taglio prendeva i primi venti
    // che il filesystem aveva incontrato. `rankPaths` premia i caratteri
    // consecutivi e il nome del file sul path (lib/fuzzyScore) — lo stesso
    // matcher che usa la ricerca per nome di ⌘P: uno solo, non tre.
    return rankPaths(fileList, query, 20)
      .map(f => {
        const name = basename(f) || f;
        return {
          id: `file-${f}`,
          label: name,
          description: f,
          icon: <File size={14} />,
          category: 'file' as const,
          action: () => { onOpenFile(projectPath + '/' + f); onClose(); },
        };
      });
  }, [projectPath, query, fileList, onOpenFile, onClose]);

  // ── Query-based filtering ───────────────────────────────────────────────
  // Files are pre-filtered by the search effect above; for the other lists
  // we filter on label/description here. With empty query everything is shown.
  const filterByQuery = useCallback((arr: CommandAction[]) => {
    if (!query.trim()) return arr;
    const q = query.toLowerCase();
    return arr.filter(a =>
      a.label.toLowerCase().includes(q) ||
      (a.description && a.description.toLowerCase().includes(q))
    );
  }, [query]);

  const filteredProjects = useMemo(() => filterByQuery(projectItems), [projectItems, filterByQuery]);
  const recentFiltered = useMemo(() => filterByQuery(recentItems), [recentItems, filterByQuery]);
  const filteredMain = useMemo(() => filterByQuery(topicItems), [topicItems, filterByQuery]);
  const filteredActions = useMemo(() => filterByQuery(actionItems), [actionItems, filterByQuery]);
  const filteredCreate = useMemo(() => filterByQuery(createItems), [createItems, filterByQuery]);

  // Flat order for keyboard nav, matching the render order in each mode:
  //  · projects scope:   Projects only (⌘F — jump to a project)
  //  · empty (no query): Create → Projects → Recently-closed (Create on top by design)
  //  · query:            left column (Projects) THEN right column, top to bottom
  //                      (Create → Actions → Topics → Recently-closed → Files → Messages).
  //                      The render is two columns: Projects on the left, everything
  //                      else on the right. Enumerating Create first put index 0 on
  //                      the top-RIGHT row, so ↑↓ zig-zagged between columns.
  const allItems = useMemo(() => {
    if (scope === 'projects') return filteredProjects;
    // History is one single list: no projects, no actions, no topics. You get
    // here from the "Topics" menu to look for WHERE YOU WERE, and every other
    // row in here would be noise on that question.
    if (scope === 'history') return recentFiltered;
    // «Crea» sta in cima anche a query vuota: in una palette vuota la cosa piu'
    // azionabile e' quella che fa nascere qualcosa, ed e' l'unico modo per cui
    // le frecce ci arrivino sopra (prima era una barra di pill, fuori dalla
    // navigazione da tastiera).
    if (!query.trim()) return [...filteredCreate, ...filteredProjects, ...recentFiltered];
    return [...filteredProjects, ...filteredCreate, ...filteredActions, ...filteredMain, ...recentFiltered, ...searchFileItems, ...searchResults];
  }, [scope, query, filteredProjects, filteredCreate, filteredActions, recentFiltered, filteredMain, searchFileItems, searchResults]);

  // O(1) id→index lookup, built once per `allItems` change. Rendering each
  // section calls `indexOf` per row; a findIndex there made render O(n²) over
  // the result list — this Map keeps it linear.
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    allItems.forEach((it, i) => m.set(it.id, i));
    return m;
  }, [allItems]);

  // Reset selection on filter change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Reset on open. Il focus iniziale sull'input lo mette useModalDialog qui
  // sotto — un solo posto che decide dove va il focus, invece di un setTimeout
  // che corre contro il render.
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setSearchResults([]);
      setSearchLoading(false);
    }
  }, [isOpen]);

  // Escape chiude, il Tab resta dentro, il focus torna da dove è partito.
  // L'Escape stava sull'input (React onKeyDown): valeva solo col cursore lì
  // dentro, e il Tab usciva sulla pagina coperta.
  useModalDialog({ open: isOpen, onClose, panelRef, initialFocusRef: inputRef });

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (allItems[selectedIndex]) {
        allItems[selectedIndex].action();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }, [allItems, selectedIndex, onClose]);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-cmd-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!isOpen) return null;

  // Each rendered row needs a stable global index for keyboard nav. We build
  // the indices in the same order `allItems` enumerates them so arrow keys
  // and rendered selection stay in sync.
  const indexOf = (id: string) => indexById.get(id) ?? -1;
  const renderRow = (item: CommandAction, opts?: { compact?: boolean; highlight?: boolean }) => {
    const idx = indexOf(item.id);
    return (
      <PaletteRow
        key={item.id}
        item={item}
        idx={idx}
        selected={idx === selectedIndex}
        onHover={setSelectedIndex}
        compact={opts?.compact}
        highlightTerm={opts?.highlight ? query : undefined}
      />
    );
  };

  return (
    <div
      data-testid="command-palette"
      // Which scope the palette was opened in, stated in the DOM. The only
      // other outward sign is the input placeholder, and that one is
      // translated: reading the scope off it makes a gate that turns red the
      // day the UI speaks another language, while saying nothing about the
      // scope itself.
      data-scope={scope}
      data-page={isMobile ? 'true' : undefined}
      className={isMobile
        ? MODAL_PAGE_CONTAINER
        : `fixed inset-0 ${MODAL_LAYER} flex items-start justify-center pt-[12vh]`}
      onClick={isMobile ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {!isMobile && <div className={MODAL_BACKDROP} />}
      <div
        ref={panelRef}
        className={isMobile
          ? MODAL_PAGE_PANEL
          : `relative w-full max-w-4xl mx-4 flex flex-col ${MODAL_PANEL}`}
        onClick={e => e.stopPropagation()}
        style={isMobile ? MODAL_PAGE_INSET : { maxHeight: '76vh' }}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-app-border flex-shrink-0">
          {isMobile ? (
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              className="w-11 h-11 -ml-3 flex items-center justify-center flex-shrink-0 text-app-text-secondary"
            >
              <ArrowLeft size={20} />
            </button>
          ) : (
            <Search size={16} className="text-app-text-secondary flex-shrink-0" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={scope === 'projects' ? t('palette.searchProjects') : scope === 'history' ? t('palette.searchHistory') : projectPath ? t('palette.searchWithFiles') : t('palette.search')}
            /* Il campo misurava 24px di altezza: e' il bersaglio piu' importante
               della superficie e stava sotto misura come tutti gli altri. Su
               mobile anche `text-[16px]`, perche' sotto i 16 iOS ingrandisce la
               pagina al primo tocco e la pagina di ricerca parte storta. */
            className={`flex-1 bg-transparent text-app-text placeholder-app-placeholder outline-none ${
              isMobile ? 'h-11 text-[16px]' : 'text-[14px]'
            }`}
          />
          {/* Il suggerimento del tasto vale per chi ha un tasto. Su un telefono
              e' inchiostro che dice come uscire da una porta che non c'e'. */}
          {!isMobile && <kbd className="kbd">ESC</kbd>}
        </div>

        {/* Body. Empty (no query) = two side-by-side columns:
            Ultimi progetti | Chiuse di recente. With a query = one full-width
            results list with plain section labels (no collapsible accordions). */}
        <div className="flex-1 min-h-0 flex flex-col">
          {scope === 'history' ? (
            /* HISTORY: one full-width list, closed tabs and pages merged by
               time. The same row as the normal palette, so the two surfaces
               cannot tell the same story in two different ways. */
            <div ref={listRef} className="flex-1 min-w-0 overflow-y-auto py-1" role="listbox" aria-label="Cronologia" data-testid="palette-history">
              <div className="px-3 py-1.5 text-[10px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-1.5">
                {t('palette.history')}
                {recentFiltered.length > 0 && <span className="text-app-text-tertiary font-normal">{recentFiltered.length}</span>}
              </div>
              {recentFiltered.length > 0 ? (
                recentFiltered.map(item => renderRow(item, { highlight: !!query.trim() }))
              ) : (
                <EmptyState variant="panel" title={t('palette.noHistory')} />
              )}
            </div>
          ) : scope === 'projects' ? (
            /* ⌘F — projects scope: one full-width list, find/jump to a project. */
            <div ref={listRef} className="flex-1 min-w-0 overflow-y-auto py-1" role="listbox" aria-label="Projects">
              <div className="px-3 py-1.5 text-[10px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-1.5">
                Projects
                {filteredProjects.length > 0 && <span className="text-app-text-tertiary font-normal">{filteredProjects.length}</span>}
              </div>
              {filteredProjects.length > 0 ? (
                filteredProjects.map(item => renderRow(item, { highlight: !!query.trim() }))
              ) : (
                <EmptyState variant="panel" title="No projects" />
              )}
            </div>
          ) : !query.trim() ? (
            <div ref={listRef} className={`flex-1 min-h-0 flex ${isMobile ? 'flex-col overflow-y-auto' : ''}`}>
              {/* Ultimi progetti */}
              {/* Impilate, le sezioni prendono l'altezza che serve loro e scorre
                  il contenitore: `flex-1` le spartirebbe a meta' lo schermo,
                  lasciando un vuoto sotto la lista corta. */}
              <section className={`min-w-0 py-1 ${isMobile ? 'flex-none border-b border-app-border' : 'flex-1 overflow-y-auto border-r border-app-border'}`}>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-1.5">
                  {t('palette.recentProjects')}
                  {filteredProjects.length > 0 && <span className="text-app-text-tertiary font-normal">{filteredProjects.length}</span>}
                </div>
                {filteredProjects.length > 0 ? (
                  filteredProjects.map(item => renderRow(item, { compact: !isMobile }))
                ) : (
                  <EmptyState variant="section" title={t('palette.noProject')} />
                )}
              </section>
              {/* Crea + Chiuse di recente. «Crea» sta in cima perche' a palette
                  vuota e' la colonna delle cose che si FANNO, mentre a sinistra
                  ci sono quelle che si ritrovano. */}
              <section className={`min-w-0 py-1 ${isMobile ? 'flex-none' : 'flex-1 overflow-y-auto'}`}>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-1.5">
                  {t('palette.create')}
                </div>
                {filteredCreate.map(item => renderRow(item, { compact: !isMobile }))}
                <div className="px-3 pt-2 pb-1.5 text-[10px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-1.5 border-t border-app-border mt-1">
                  {t('palette.history')}
                  {recentFiltered.length > 0 && <span className="text-app-text-tertiary font-normal">{recentFiltered.length}</span>}
                </div>
                {recentFiltered.length > 0 ? (
                  recentFiltered.map(item => renderRow(item, { compact: !isMobile }))
                ) : (
                  <EmptyState variant="section" title={t('palette.noHistory')} />
                )}
              </section>
            </div>
          ) : (
            <div ref={listRef} className={isMobile
              ? 'flex-1 min-h-0 flex flex-col overflow-y-auto'
              : 'flex-1 min-h-0 grid grid-cols-2 gap-0'}>
              {/* Left: Projects (always visible). Su mobile «a sinistra» non
                  esiste: due colonne da 150px troncano ogni riga a nulla, quindi
                  le due sezioni si impilano e scorre il contenitore. */}
              <section className={`min-w-0 py-1 ${isMobile ? 'flex-none border-b border-app-border' : 'overflow-y-auto border-r border-app-border'}`}>
                <div className="px-3 py-1.5 text-[10px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-1.5">
                  {t('palette.projects')}
                  {filteredProjects.length > 0 && <span className="text-app-text-tertiary font-normal">{filteredProjects.length}</span>}
                </div>
                {filteredProjects.length > 0 ? (
                  filteredProjects.map(item => renderRow(item, { highlight: !!query.trim() }))
                ) : (
                  <EmptyState variant="section" title={t('palette.noResults')} />
                )}
              </section>
              {/* Right: other results (Actions, Topics, Files, Messages) */}
              <section className={`min-w-0 py-1 ${isMobile ? 'flex-none' : 'overflow-y-auto'}`} role="listbox" aria-label={t('palette.results')}>
                {/* The search DID NOT ANSWER: say so, above whatever local rows
                    are still valid. Saying "no results" here would blame the
                    query for a failure of the server. */}
                {searchFailed && (
                  <div data-testid="palette-search-error" className="px-3 py-4 text-center text-red-400 text-xs">
                    {t('palette.searchFailed')}
                  </div>
                )}
                {allItems.length === 0 && !searchLoading && !searchFailed ? (
                  <EmptyState variant="panel" title={t('palette.noResults')} />
                ) : (
                  <>
                    {filteredCreate.length > 0 && (
                      <>
                        <SectionHeader label={t('palette.create')} />
                        {filteredCreate.map(item => renderRow(item, { highlight: true }))}
                      </>
                    )}
                    {filteredActions.length > 0 && (
                      <>
                        <SectionHeader label="Azioni" />
                        {filteredActions.map(item => renderRow(item, { highlight: true }))}
                      </>
                    )}
                    {filteredMain.length > 0 && (
                      <>
                        <SectionHeader label="Topic" />
                        {filteredMain.map(item => renderRow(item, { highlight: true }))}
                      </>
                    )}
                    {recentFiltered.length > 0 && (
                      <>
                        <SectionHeader label={t('palette.history')} />
                        {recentFiltered.map(item => renderRow(item, { highlight: true }))}
                      </>
                    )}
                    {searchFileItems.length > 0 && (
                      <>
                        <SectionHeader label="File" />
                        {searchFileItems.map(item => renderRow(item, { highlight: true }))}
                      </>
                    )}
                    {(searchResults.length > 0 || searchLoading) && (
                      <SectionHeader label="Messaggi" rightSlot={searchLoading ? <Loader2 size={10} className="animate-spin" /> : null} />
                    )}
                    {searchResults.map(item => renderRow(item, { highlight: true }))}
                  </>
                )}
              </section>
            </div>
          )}
        </div>

        {/* Barra dei COMANDI globali — due voci, una riga, non va piu' a capo.
            Le voci di creazione se ne sono andate da qui: erano otto pill che
            mandavano la barra su tre righe e che la tastiera non raggiungeva.
            Ora sono righe nella sezione «Crea», dove frecce e ↵ funzionano e
            si possono cercare. La barra resta per cio' che non e' un
            risultato: preferenze e tema. */}
        <div className="border-t border-app-border px-2 py-1.5 flex items-center gap-1 flex-shrink-0">
          {/* Le pill di creazione NON sono più una lista scritta a mano: escono
              dallo STESSO modello del menu "+" (`buildAddMenuItems`, scope
              standalone). Prima erano due elenchi paralleli e divergevano —
              qui mancavano opencode, Browser e Board generale.
              ⌘N è legato senza condizioni (useKeyboardShortcuts) ma ci ARRIVA
              solo nel guscio desktop: in una scheda del browser il tasto se lo
              tiene il browser. Per questo l'hint è gated su `isDesktop`. */}
          <ActionPill isMobile={isMobile} icon={<Settings size={12} />} label="Settings" shortcut={shortcut(',')} onClick={() => { onOpenSettings(); onClose(); }} />
          <ActionPill
            isMobile={isMobile}
            icon={themeMode === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
            label="Theme"
            onClick={() => { onToggleTheme(); onClose(); }}
          />
        </div>

        {/* Footer hints. Tre frecce, un invio e un escape: e' il vocabolario di
            una tastiera. Su un telefono non c'e' nessuno dei tre, e la riga
            toglie spazio proprio alla lista che deve leggersi. */}
        {!isMobile && (
          <div className="px-4 py-1.5 border-t border-app-border flex items-center gap-4 text-[11px] text-app-text-muted flex-shrink-0">
            <span className="flex items-center gap-1"><kbd className="kbd">↑↓</kbd> {t('palette.hint.navigate')}</span>
            <span className="flex items-center gap-1"><kbd className="kbd">↵</kbd> {t('palette.hint.open')}</span>
            <span className="flex items-center gap-1"><kbd className="kbd">esc</kbd> {t('palette.hint.close')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function SectionHeader({ label, rightSlot }: { label: string; rightSlot?: React.ReactNode }) {
  return (
    <div className="px-4 py-1.5 text-[11px] font-semibold text-app-text-muted uppercase tracking-wider flex items-center gap-2">
      {label}
      {rightSlot}
    </div>
  );
}

interface PaletteRowProps {
  item: CommandAction;
  idx: number;
  selected: boolean;
  onHover: (idx: number) => void;
  compact?: boolean;
  highlightTerm?: string;
}

function PaletteRow({ item, idx, selected, onHover, compact, highlightTerm }: PaletteRowProps) {
  // Fixed row height keeps closed-tabs, topics, files etc. visually aligned
  // even when some have a description line and some don't. The icon slot is
  // a fixed 14×14 box (rendered empty when item.icon is null) so labels
  // line up across rows with and without icon.
  const rowHeight = compact ? 'h-9' : 'h-11';
  return (
    <button
      role="option"
      aria-selected={selected}
      data-cmd-idx={idx}
      data-testid={item.testId}
      onClick={item.action}
      onMouseEnter={() => onHover(idx)}
      title={item.titleOverride || item.description}
      className={`w-full ${compact ? 'px-3' : 'px-4'} ${rowHeight} flex items-center gap-2.5 text-left transition-colors ${
        selected
          ? 'bg-primary/10 text-primary dark:text-primary-dark'
          : 'text-app-text hover:bg-app-hover'
      }`}
    >
      <span
        className={`w-[14px] h-[14px] flex items-center justify-center flex-shrink-0 ${
          selected ? 'text-primary dark:text-primary-dark' : 'text-app-text-muted'
        }`}
        aria-hidden={!item.icon}
      >
        {item.icon}
      </span>
      <span className="flex-1 min-w-0 flex flex-col justify-center">
        <span className={`${compact ? 'text-[12px]' : 'text-[13px]'} font-medium truncate block leading-tight`}>
          {highlightTerm ? highlightQuery(item.label, highlightTerm) : item.label}
        </span>
        {item.description && (
          <span className="text-[11px] text-app-text-muted truncate block leading-tight mt-0.5">
            {item.description}
          </span>
        )}
      </span>
      {item.shortcut && (
        <kbd className="kbd flex-shrink-0">{item.shortcut}</kbd>
      )}
    </button>
  );
}

/**
 * `py-1` la teneva a 24,5px misurati: meno di un dito. Su mobile diventa alta
 * 44 e il suggerimento del tasto sparisce, perche' su un telefono annuncia una
 * scorciatoia che non si puo' premere.
 */
function ActionPill({ icon, label, shortcut, onClick, testId, isMobile }: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
  testId?: string;
  isMobile?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 px-2.5 font-medium text-app-text-muted hover:text-app-text hover:bg-app-hover rounded-md transition-colors flex-shrink-0 whitespace-nowrap ${
        isMobile ? 'h-11 text-[13px]' : 'py-1 text-[11px]'
      }`}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      {icon} {label}
      {shortcut && !isMobile && <kbd className="kbd ml-1 opacity-60">{shortcut}</kbd>}
    </button>
  );
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'ora';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m fa`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h fa`;
  const days = Math.floor(hours / 24);
  return `${days}g fa`;
}

function highlightQuery(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-800 text-inherit rounded px-0.5">{part}</mark>
      : part
  );
}
