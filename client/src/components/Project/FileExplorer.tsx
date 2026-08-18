import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Folder, RefreshCw, FilePlus, FolderPlus, Pencil, Trash2, ChevronsDownUp, Copy, FileText, ExternalLink } from 'lucide-react';
import type { FileNode, WSMessage } from '../../types';
import { filesApi } from '../../lib/api';
import { useProjectFiles } from '../../hooks/useProjectFiles';
import { basename } from '../../lib/path-utils';
import { getFileIconDef } from '../../lib/fileIcons';
import { gitStatusTextClass, gitStatusLabel } from '../../lib/gitStatusColors';
import { useGitStatus } from '../../hooks/useGitStatus';
import { useDismissable } from '../../hooks/useDismissable';
import { useLongPress, openContextMenuAt } from '../../hooks/useLongPress';
import { useMobile } from '../../hooks/useMobile';
import { useHoverReveal } from '../../hooks/useHoverReveal';
import { Z_CONTEXT_MENU } from '@/lib/popoverStyles';
import { ConfirmDialog } from '../Shared/ConfirmDialog';
import { SELECTED_SURFACE, SELECTED_SURFACE_SOFT, SIDEBAR_ACTIVE, SIDEBAR_INDENT_STEP, TREE_ROW_CARD } from '@/lib/selectionStyles';
import { useToast } from '../Shared/Toast';
import { useT } from '../../hooks/useT';
import { Spinner, SpinnerFallback } from '../Shared/Spinner';
import { SkeletonRows } from '../Shared/Skeleton';

const EditorTabs = lazy(() => import('../Editor/EditorTabs').then(m => ({ default: m.EditorTabs })));

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface FileExplorerProps {
  projectPath: string;
  compact?: boolean;
  onOpenFile?: (path: string) => void;
  pendingFile?: string | null;
  onPendingFileConsumed?: () => void;
  /**
   * Il canale WS. Se c'è, l'albero si aggiorna da solo su `files:changed`;
   * se manca, resta il comportamento di prima (ricarica a mano). È opzionale
   * perché non tutte le superfici che montano l'Explorer hanno il canale.
   */
  onWSMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export interface FileExplorerHandle {
  newFile: () => void;
  newFolder: () => void;
  collapseAll: () => void;
  refresh: () => void;
}

const DIR_CHILDREN_LIMIT = 300;

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Set<string>;
  /** Cartelle di cui si stanno leggendo i figli: mostrano uno spinner. */
  loadingDirs: Set<string>;
  expandedOverflow: Set<string>;
  onToggleDir: (path: string) => void;
  onExpandOverflow: (path: string) => void;
  onSelectFile: (node: FileNode, e: React.MouseEvent) => void;
  focusedPath: string | null;
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void;
  renamingPath: string | null;
  onRenameSubmit: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  newItemParent: string | null;
  newItemType: 'file' | 'dir' | null;
  onNewItemSubmit: (name: string) => void;
  onNewItemCancel: () => void;
  gitFileMap: Map<string, string>;
  gitDirSet: Set<string>;
  selectedPaths: Set<string>;
  cutPaths: Set<string>;
  dragOverPath: string | null;
  isExternalDrag: boolean;
  onDragStart: (e: React.DragEvent, node: FileNode) => void;
  onDragOver: (e: React.DragEvent, node: FileNode) => void;
  onDragEnter: (e: React.DragEvent, node: FileNode) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, node: FileNode) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onNewFile?: (dirPath: string) => void;
  onNewFolder?: (dirPath: string) => void;
  onCollapseDir?: (dirPath: string) => void;
}

function InlineInput({ depth, icon, onSubmit, onCancel }: {
  depth: number;
  icon: React.ReactNode;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (value.trim()) onSubmit(value.trim());
      else onCancel();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-[3px] md:py-[3px] min-h-[28px] text-[12px] bg-app-hover"
      style={{ paddingLeft: `${depth * 16 + 12}px` }}
    >
      <span className="w-4 h-4 flex-shrink-0" />
      <span className="flex items-center justify-center w-4 h-4 flex-shrink-0">{icon}</span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (value.trim()) onSubmit(value.trim()); else onCancel(); }}
        className="flex-1 min-w-0 bg-surface border border-primary/50 rounded px-1.5 py-0.5 text-[12px] text-app-text-body outline-none focus:border-primary"
      />
    </div>
  );
}

// (Qui stavano `getGitStatusColor` e `getGitStatusLabel`, la copia locale di un
// lavoro che GitChanges — il pannello che sta nella STESSA colonna — faceva
// già. Le due copie divergevano dove costa: qui le tinte erano NUDE
// (`text-amber-400` senza `dark:`), cioè in tema chiaro l'albero dipingeva col
// colore pensato per il fondo scuro — 1,65:1 contro i 10 del tema scuro, lo
// stesso pixel sei volte meno leggibile. Ora la classificazione e le coppie
// stanno in `lib/gitStatusColors.ts`, misurate.)

function TreeNode({ node, depth, selectedPath, expandedDirs, loadingDirs, expandedOverflow, onToggleDir, onExpandOverflow, onSelectFile, focusedPath, onContextMenu, renamingPath, onRenameSubmit, onRenameCancel, newItemParent, newItemType, onNewItemSubmit, onNewItemCancel, gitFileMap, gitDirSet, selectedPaths, cutPaths, dragOverPath, isExternalDrag, onDragStart, onDragOver, onDragEnter, onDragLeave, onDrop, onDragEnd, onNewFile, onNewFolder, onCollapseDir }: TreeNodeProps) {
  // Il menu dei file esisteva solo col tasto destro: da telefono rinomina,
  // duplica e cestina erano irraggiungibili. Stesso gesto del resto dell'app.
  const { isTouch } = useMobile();
  const nodeLongPress = useLongPress(openContextMenuAt, { enabled: isTouch });
  // Le tre icone di una cartella (nuovo file, nuova cartella, chiudi) si
  // scoprono col mouse. Senza puntatore spariscono DAVVERO — `pointer-events`
  // compresi, altrimenti restano tre bersagli invisibili sul bordo destro di
  // una riga il cui tocco apre la cartella. Il percorso col dito c'e' gia': il
  // long-press qui sopra apre lo stesso menu del tasto destro, che ha «New
  // File» e «New Folder»; chiudere la cartella e' il tocco sulla riga stessa.
  const dirActionsReveal = useHoverReveal('node');
  const isDir = node.type === 'dir';
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedPath === node.path;
  const isMultiSelected = selectedPaths.has(node.path);
  const isFocused = focusedPath === node.path;
  const isCut = cutPaths.has(node.path);
  // Internal drag: only dirs highlight. External drag: any node can highlight.
  const isDragOver = dragOverPath === node.path && (isDir || isExternalDrag);
  const gitStatus = isDir ? undefined : gitFileMap.get(node.path);
  const dirHasChanges = isDir && gitDirSet.has(node.path);
  const isRenaming = renamingPath === node.path;
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [renameValue, setRenameValue] = useState(node.name);
  const showNewItemInput = isDir && isExpanded && newItemParent === node.path;

  useEffect(() => {
    if (isRenaming) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seed the rename edit buffer from node.name when entering rename mode (one-shot init)
      setRenameValue(node.name);
      setTimeout(() => {
        if (renameInputRef.current) {
          renameInputRef.current.focus();
          // Select the name part before the extension for files
          const dotIdx = node.name.lastIndexOf('.');
          if (!isDir && dotIdx > 0) {
            renameInputRef.current.setSelectionRange(0, dotIdx);
          } else {
            renameInputRef.current.select();
          }
        }
      }, 0);
    }
  }, [isRenaming, node.name, isDir]);

  const handleClick = (e: React.MouseEvent) => {
    if (isRenaming) return;
    if (isDir && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      onToggleDir(node.path);
    }
    onSelectFile(node, e);
  };

  const handleDoubleClick = () => {
    if (isRenaming || isDir) return;
    // Pin the file pane (make it permanent, not preview)
    window.dispatchEvent(new CustomEvent('pin-file-pane', { detail: { path: node.path } }));
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (renameValue.trim() && renameValue.trim() !== node.name) {
        onRenameSubmit(node.path, renameValue.trim());
      } else {
        onRenameCancel();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onRenameCancel();
    }
  };

  const handleRenameBlur = () => {
    if (renameValue.trim() && renameValue.trim() !== node.name) {
      onRenameSubmit(node.path, renameValue.trim());
    } else {
      onRenameCancel();
    }
  };

  return (
    <>
      <div
        // `TREE_ROW_CARD`: incasso + raggio + hover in ALPHA. Era una riga a
        // tutta larghezza con `hover:bg-app-hover` — un opaco tarato su
        // `--bg-surface` mentre questa colonna è `--chrome-bg` — cioè una fascia
        // da bordo a bordo sotto un'intestazione che è una card rientrata.
        // Il passo verticale resta quello denso dell'albero: vedi la costante.
        className={`group/node ${TREE_ROW_CARD} flex items-center gap-1.5 px-2 py-[3px] md:py-[3px] min-h-[28px] cursor-pointer text-[12px] select-none ${
          isSelected
            ? SELECTED_SURFACE
            : isMultiSelected
              ? SELECTED_SURFACE_SOFT
              : isFocused
                ? SIDEBAR_ACTIVE
                : 'text-app-text-body'
        } ${isDragOver ? 'ring-1 ring-primary/50 bg-primary/10' : ''} ${isCut ? 'opacity-50' : ''}`}
        // L'indentazione parte da `ROW_INSET` come ogni altra riga della colonna,
        // non da 12: la card è già rientrata di 6 col suo margine, quindi il
        // padding interno è quello di riga e la profondità ci si somma sopra.
        style={{ paddingLeft: `${depth * SIDEBAR_INDENT_STEP + 8}px` }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        {...nodeLongPress.handlers}
        data-pressing={nodeLongPress.pressed || undefined}
        // «Tieni premuto» = lo STESSO menu del tasto destro (l'evento e'
        // sintetizzato e bolla fino a questo handler). Senza, da telefono il
        // menu dei file — rinomina, duplica, cestina — non esisteva.
        onContextMenu={e => onContextMenu(e, node)}
        draggable={!isRenaming}
        onDragStart={e => onDragStart(e, node)}
        onDragOver={e => onDragOver(e, node)}
        onDragEnter={e => onDragEnter(e, node)}
        onDragLeave={onDragLeave}
        onDrop={e => onDrop(e, node)}
        onDragEnd={onDragEnd}
        role="treeitem"
        tabIndex={-1}
        data-path={node.path}
      >
        {isDir ? (
          <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-app-text-tertiary">
            <ChevronRight size={12} className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`} />
          </span>
        ) : (
          <span className="flex items-center justify-center w-4 h-4 flex-shrink-0">{(() => { const d = getFileIconDef(node.name); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()}</span>
        )}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            onClick={e => e.stopPropagation()}
            className="flex-1 min-w-0 bg-surface border border-primary/50 rounded px-1.5 py-0.5 text-[12px] text-app-text-body outline-none focus:border-primary"
          />
        ) : (
          <>
            <span
              data-testid={gitStatus && !isSelected && !isMultiSelected ? 'file-node-name-git' : 'file-node-name'}
              className={`truncate ${isDir ? 'font-medium' : ''} ${
                !isSelected && !isMultiSelected && gitStatus ? gitStatusTextClass(gitStatus) : ''
              }`}
            >{node.name}</span>
            {/* LA CARTELLA-ANTENATA NON PRENDE LA TINTA PIENA.
                Prima il nome di ogni cartella che CONTIENE modifiche veniva
                dipinto di ambra come se fosse essa stessa modificata: su un
                repo sporco mezzo albero diventa giallo, e un colore che
                accende metà schermo ha smesso di essere un segnale. Il fatto
                da dire è binario — «là sotto c'è qualcosa» — e un pallino lo
                dice per intero senza rubare la leggibilità del nome. Neutro di
                proposito: l'antenata non SA cosa sia cambiato là sotto, e
                fingere di saperlo con l'ambra del modificato è una bugia. */}
            {isDir && dirHasChanges && !isSelected && !isMultiSelected && (
              <span
                aria-hidden
                data-testid="dir-has-changes"
                className="ml-1 h-1 w-1 rounded-full bg-app-text-muted flex-shrink-0"
              />
            )}
            {gitStatus && !isSelected && (
              <span
                data-testid="git-status-letter"
                className={`text-[11px] flex-shrink-0 ml-1 ${gitStatusTextClass(gitStatus)}`}
              >
                {gitStatusLabel(gitStatus)}
              </span>
            )}
            {node.size !== undefined && !isDir && !gitStatus && (
              <span className="ml-auto text-[11px] text-app-text-faint flex-shrink-0">
                {node.size < 1024 ? `${node.size}B` : node.size < 1048576 ? `${(node.size / 1024).toFixed(1)}K` : `${(node.size / 1048576).toFixed(1)}M`}
              </span>
            )}
            {isDir && (
              <div className={`ml-auto flex items-center gap-0.5 flex-shrink-0 ${dirActionsReveal}`}
                   onClick={e => e.stopPropagation()}>
                <button onClick={() => onNewFile?.(node.path)} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title="New File">
                  <FilePlus size={12} />
                </button>
                <button onClick={() => onNewFolder?.(node.path)} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title="New Folder">
                  <FolderPlus size={12} />
                </button>
                {isExpanded && (
                  <button onClick={() => onCollapseDir?.(node.path)} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-app-text-tertiary" title="Collapse">
                    <ChevronsDownUp size={12} />
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {isDir && isExpanded && (
        <>
          {showNewItemInput && (
            <InlineInput
              depth={depth + 1}
              /* L'icona della cartella nuova è NEUTRA (le tre occorrenze in
                 questo file). Era `text-amber-400`, cioè esattamente la tinta
                 con cui l'albero segna «modificato»: un'icona che non ha nessuno
                 stato git indossava il colore di uno stato git, e in tema chiaro
                 quel giallo misura 1,65:1 — un evidenziatore che non si legge.
                 Le icone cartella non sono semantica di stato. */
              icon={newItemType === 'dir'
                ? <Folder size={14} className="text-app-text-tertiary" />
                : (() => { const d = getFileIconDef(''); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()
              }
              onSubmit={onNewItemSubmit}
              onCancel={onNewItemCancel}
            />
          )}
          {node.children === undefined && loadingDirs.has(node.path) && (
            // Senza questa riga una cartella oltre il terzo livello si apriva e
            // restava BIANCA: indistinguibile da una cartella vuota.
            <div className="flex items-center gap-1.5 py-[2px] text-[11px] text-app-text-tertiary" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
              <Spinner size="xs" tone="current" />
            </div>
          )}
          {node.children && (() => {
            const all = node.children;
            const showAll = expandedOverflow.has(node.path);
            const visible = showAll ? all : all.slice(0, DIR_CHILDREN_LIMIT);
            const remaining = all.length - DIR_CHILDREN_LIMIT;
            return (
              <>
                {visible.map(child => (
                  <TreeNode
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    selectedPath={selectedPath}
                    expandedDirs={expandedDirs}
                    loadingDirs={loadingDirs}
                    expandedOverflow={expandedOverflow}
                    onToggleDir={onToggleDir}
                    onExpandOverflow={onExpandOverflow}
                    onSelectFile={onSelectFile}
                    focusedPath={focusedPath}
                    onContextMenu={onContextMenu}
                    renamingPath={renamingPath}
                    onRenameSubmit={onRenameSubmit}
                    onRenameCancel={onRenameCancel}
                    newItemParent={newItemParent}
                    newItemType={newItemType}
                    onNewItemSubmit={onNewItemSubmit}
                    onNewItemCancel={onNewItemCancel}
                    gitFileMap={gitFileMap}
                    gitDirSet={gitDirSet}
                    selectedPaths={selectedPaths}
                    cutPaths={cutPaths}
                    dragOverPath={dragOverPath}
                    isExternalDrag={isExternalDrag}
                    onDragStart={onDragStart}
                    onDragOver={onDragOver}
                    onDragEnter={onDragEnter}
                    onDragLeave={onDragLeave}
                    onDrop={onDrop}
                    onDragEnd={onDragEnd}
                    onNewFile={onNewFile}
                    onNewFolder={onNewFolder}
                    onCollapseDir={onCollapseDir}
                  />
                ))}
                {!showAll && remaining > 0 && (
                  <div
                    // Stessa forma e stessa indentazione delle righe che
                    // segue: era l'unica riga dell'albero rimasta full-bleed,
                    // con un hover tinto di primary invece del rialzo neutro.
                    className={`flex items-center gap-1.5 ${TREE_ROW_CARD} px-2 py-[3px] md:py-[3px] min-h-[28px] cursor-pointer text-[11px] text-primary`}
                    style={{ paddingLeft: `${(depth + 1) * SIDEBAR_INDENT_STEP + 8}px` }}
                    onClick={() => onExpandOverflow(node.path)}
                  >
                    Show {remaining.toLocaleString()} more items...
                  </div>
                )}
              </>
            );
          })()}
        </>
      )}
    </>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, FileExplorerProps>(function FileExplorer({ projectPath, compact, onOpenFile, pendingFile, onPendingFileConsumed, onWSMessage }, ref) {
  const tr = useT();
  const toast = useToast();
  /**
   * L'albero, le cartelle aperte e lo stato di caricamento NON stanno piu' qui.
   *
   * Stavano, ed e' il motivo per cui aprendo e chiudendo la sezione si vedeva
   * uno spinner ogni volta: `ProjectSidebar` monta questo componente dentro
   * `{expandedSections.files && …}`, quindi chiudere la sezione lo SMONTA e
   * porta via tutto — albero compreso. Ora vivono in uno store per
   * `projectPath` (`hooks/useProjectFiles.ts`) che sopravvive al pannello,
   * sul modello di `useGitStatus`.
   */
  const {
    tree,
    expandedDirs: expandedList,
    loading,
    error,
    reload: reloadFiles,
    setExpanded: setDirExpanded,
    replaceExpanded,
    graft,
  } = useProjectFiles({ projectPath, onMessage: onWSMessage });
  // `useMemo` e non `tree ?? []` nudo: quel `??` produce un array NUOVO a ogni
  // render quando l'albero e' `null`, e tre callback lo hanno in dipendenza —
  // si rifarebbero di continuo, rimontando quello che tengono.
  const files = useMemo(() => tree ?? [], [tree]);
  const expandedDirs = useMemo(() => new Set<string>(expandedList), [expandedList]);
  /** Cartelle di cui si stanno leggendo i figli (caricamento pigro). */
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [contextMenuNode, setContextMenuNode] = useState<FileNode | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [newItemParent, setNewItemParent] = useState<string | null>(null);
  const [newItemType, setNewItemType] = useState<'file' | 'dir' | null>(null);
  const [expandedOverflow, setExpandedOverflow] = useState<Set<string>>(new Set());
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [rootDragOver, setRootDragOver] = useState(false);
  const { gitStatus: feGitStatus } = useGitStatus({ projectPath });

  const treeRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const editorTabsRef = useRef<{ openFile: (path: string, name: string) => void; pinTab: (path: string) => void } | null>(null);
  const lastClickedPathRef = useRef<string | null>(null);
  const draggedPathsRef = useRef<string[]>([]);
  const clipboardRef = useRef<{ paths: string[]; mode: 'copy' | 'cut' } | null>(null);
  const externalDragRef = useRef(false);
  const [isExternalDrag, setIsExternalDrag] = useState(false);
  const [cutPaths, setCutPaths] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<string[] | null>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenuPos(null);
    setContextMenuNode(null);
  }, []);

  /**
   * Ricarica la radice. E' lo store a farlo — qui c'e' solo il nome vecchio,
   * tenuto perche' lo chiamano dodici punti (create, rename, delete, move,
   * upload) e l'handle esposto col `ref`.
   *
   * Anche il caricamento iniziale e l'ascolto di `files:changed` sono passati
   * allo store: stando qui morivano con il componente, cioe' a ogni chiusura
   * della sezione. E ora il push a pannello CHIUSO non ricarica piu' niente —
   * segna «stantio» e si revalida al ritorno: il watcher del server trasmette a
   * ogni modifica del filesystem, e camminare l'albero per un pannello che
   * nessuno guarda era carico puro.
   */
  const loadFiles = reloadFiles;

  // Build git lookup maps from shared hook data (no duplicate polling).
  // Keyed on a stable signature of the file statuses so identical poll results
  // reuse the previous map references and skip downstream re-renders.
  const gitSignature = useMemo(
    () => (feGitStatus?.files ?? []).map(f => f.path + f.status).join('\n'),
    [feGitStatus],
  );
  const { gitFileMap, gitDirSet } = useMemo(() => {
    const fileMap = new Map<string, string>();
    const dirSet = new Set<string>();
    for (const f of feGitStatus?.files ?? []) {
      const absPath = projectPath + '/' + f.path;
      fileMap.set(absPath, f.status);
      // Propagate to all parent directories
      let dir = absPath.substring(0, absPath.lastIndexOf('/'));
      while (dir.length >= projectPath.length) {
        dirSet.add(dir);
        const next = dir.substring(0, dir.lastIndexOf('/'));
        if (next === dir) break;
        dir = next;
      }
    }
    return { gitFileMap: fileMap, gitDirSet: dirSet };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gitSignature is the stable proxy for feGitStatus.files
  }, [gitSignature, projectPath]);

  const handleExpandOverflow = useCallback((path: string) => {
    setExpandedOverflow(prev => { const next = new Set(prev); next.add(path); return next; });
  }, []);

  /**
   * Innesta i figli appena letti sotto il loro nodo, senza toccare il resto.
   *
   * Ricostruisce solo i nodi sul cammino: chi sta fuori dal ramo mantiene la
   * stessa identità, quindi non si ri-renderizza.
   */
  /** Il nodo a quel path, cercato solo lungo il ramo che lo contiene. */
  const findNode = useCallback((nodes: FileNode[], path: string): FileNode | null => {
    for (const n of nodes) {
      if (n.path === path) return n;
      if (n.type === 'dir' && n.children && path.startsWith(n.path + '/')) {
        const hit = findNode(n.children, path);
        if (hit) return hit;
      }
    }
    return null;
  }, []);

  const graftChildren = useCallback((nodes: FileNode[], path: string, children: FileNode[]): FileNode[] => {
    return nodes.map(n => {
      if (n.path === path) return { ...n, children };
      if (n.type === 'dir' && n.children && path.startsWith(n.path + '/')) {
        return { ...n, children: graftChildren(n.children, path, children) };
      }
      return n;
    });
  }, []);

  /**
   * Aprire una cartella la CARICA, se non è già stata letta.
   *
   * `/api/files` scende di 3 livelli e basta: una cartella al terzo livello
   * torna SENZA la chiave `children`, e il render (`{node.children && …}`) non
   * ha un ramo alternativo. Effetto: su questo stesso repo `client/src/components`
   * è già al terzo livello — si apriva e sembrava VUOTA, senza spinner, senza
   * errore. Sotto quel livello l'explorer semplicemente non esisteva.
   *
   * `children === undefined` significa «non letta», `[]` significa «vuota»: il
   * server distingue già i due casi, mancava solo chi ne approfittasse.
   */
  //
  // L'IDENTITÀ DI QUESTA FUNZIONE DEVE RESTARE STABILE. Finisce in
  // `treeNodeProps`, che è sparso su OGNI `TreeNode`, e `TreeNode` è una
  // funzione nuda senza memo: se la callback cambia a ogni variazione di
  // `files`/`expandedDirs`, l'intero albero montato si ri-renderizza a ogni
  // click e a ogni giro di git. Lo stato si legge dai ref, non dalle closure,
  // così le dipendenze restano due funzioni a loro volta stabili.
  const filesRef = useRef<FileNode[]>(files);
  filesRef.current = files;
  /** L'insieme aperto per chi lo legge DENTRO una callback stabile. */
  const expandedDirsRef = useRef<Set<string>>(expandedDirs);
  expandedDirsRef.current = expandedDirs;
  const loadingDirsRef = useRef<Set<string>>(loadingDirs);
  loadingDirsRef.current = loadingDirs;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const handleToggleDir = useCallback((path: string) => {
    const willExpand = !expandedDirsRef.current.has(path);
    setDirExpanded(path, willExpand);
    if (!willExpand) return;
    const node = findNode(filesRef.current, path);
    if (!node || node.type !== 'dir' || node.children !== undefined) return;
    if (loadingDirsRef.current.has(path)) return;
    setLoadingDirs(prev => new Set(prev).add(path));
    // I figli si innestano nello STORE: erano stati pagati con una richiesta
    // per cartella, e tenendoli nel componente si ricomprava tutto a ogni
    // riapertura del pannello.
    filesApi.list(path, 2)
      .then(children => graft(path, children))
      .catch(err => toastRef.current.error(errMessage(err) || 'Impossibile leggere la cartella'))
      .finally(() => setLoadingDirs(prev => { const n = new Set(prev); n.delete(path); return n; }));
  }, [findNode, setDirExpanded, graft]);

  // Flatten tree for keyboard navigation and shift-select
  const flattenTree = useCallback((nodes: FileNode[]): FileNode[] => {
    const result: FileNode[] = [];
    for (const node of nodes) {
      result.push(node);
      if (node.type === 'dir' && expandedDirs.has(node.path) && node.children) {
        result.push(...flattenTree(node.children));
      }
    }
    return result;
  }, [expandedDirs]);

  // Scroll a tree node into view after operations (create, rename, etc.)
  const scrollToPath = useCallback((path: string) => {
    requestAnimationFrame(() => {
      const el = treeRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }, []);

  const handleSelectFile = useCallback((node: FileNode, e: React.MouseEvent) => {
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    if (isMeta) {
      // Toggle individual selection
      setSelectedPaths(prev => {
        const next = new Set(prev);
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
        return next;
      });
      lastClickedPathRef.current = node.path;
      return;
    }

    if (isShift && lastClickedPathRef.current) {
      // Range select
      const flat = flattenTree(files);
      const lastIdx = flat.findIndex(f => f.path === lastClickedPathRef.current);
      const curIdx = flat.findIndex(f => f.path === node.path);
      if (lastIdx !== -1 && curIdx !== -1) {
        const start = Math.min(lastIdx, curIdx);
        const end = Math.max(lastIdx, curIdx);
        const next = new Set<string>();
        for (let i = start; i <= end; i++) {
          next.add(flat[i].path);
        }
        setSelectedPaths(next);
      }
      return;
    }

    // Plain click — single select, clear multi-select
    setSelectedPaths(new Set([node.path]));
    lastClickedPathRef.current = node.path;

    if (node.type !== 'dir') {
      if (compact && onOpenFile) {
        onOpenFile(node.path);
        return;
      }
      setSelectedFile(node);
      editorTabsRef.current?.openFile(node.path, node.name);
    }
  }, [compact, onOpenFile, flattenTree, files]);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    // If right-clicking on a node not in the selection, make it the only selection
    if (!selectedPaths.has(node.path)) {
      setSelectedPaths(new Set([node.path]));
    }
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setContextMenuNode(node);
  }, [selectedPaths]);

  const getParentDir = useCallback((path: string) => {
    const lastSlash = path.lastIndexOf('/');
    return lastSlash > 0 ? path.substring(0, lastSlash) : path;
  }, []);

  const handleNewItem = useCallback((type: 'file' | 'dir') => {
    if (!contextMenuNode) return;
    const parentDir = contextMenuNode.type === 'dir' ? contextMenuNode.path : getParentDir(contextMenuNode.path);
    // Ensure the parent dir is expanded so the inline input is visible
    setDirExpanded(parentDir, true);
    setNewItemParent(parentDir);
    setNewItemType(type);
    closeContextMenu();
  }, [contextMenuNode, getParentDir, closeContextMenu, setDirExpanded]);

  const handleNewItemSubmit = useCallback(async (name: string) => {
    if (!newItemParent || !newItemType) return;
    const fullPath = `${newItemParent}/${name}`;
    try {
      await filesApi.create(fullPath, newItemType);
      await loadFiles();
      setSelectedPaths(new Set([fullPath]));
      scrollToPath(fullPath);
    } catch (err: unknown) {
      console.error('Failed to create item:', err);
      toast.error(`Create failed: ${errMessage(err)}`);
    }
    setNewItemParent(null);
    setNewItemType(null);
  }, [newItemParent, newItemType, loadFiles, scrollToPath, toast]);

  const handleNewItemCancel = useCallback(() => {
    setNewItemParent(null);
    setNewItemType(null);
  }, []);

  const handleRename = useCallback(() => {
    if (!contextMenuNode) return;
    setRenamingPath(contextMenuNode.path);
    closeContextMenu();
  }, [contextMenuNode, closeContextMenu]);

  const handleRenameSubmit = useCallback(async (oldPath: string, newName: string) => {
    const parentDir = getParentDir(oldPath);
    const newPath = `${parentDir}/${newName}`;
    try {
      await filesApi.rename(oldPath, newPath);
      await loadFiles();
      setSelectedPaths(new Set([newPath]));
      scrollToPath(newPath);
    } catch (err: unknown) {
      console.error('Failed to rename:', err);
      toast.error(`Rename failed: ${errMessage(err)}`);
    }
    setRenamingPath(null);
  }, [getParentDir, loadFiles, scrollToPath, toast]);

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleDelete = useCallback(() => {
    const pathsToDelete = selectedPaths.size > 1
      ? Array.from(selectedPaths)
      : contextMenuNode ? [contextMenuNode.path] : [];
    closeContextMenu();
    if (pathsToDelete.length === 0) return;
    setDeleteConfirm(pathsToDelete);
  }, [contextMenuNode, selectedPaths, closeContextMenu]);

  const executeDelete = useCallback(async (pathsToDelete: string[]) => {
    setDeleteConfirm(null);
    try {
      await Promise.all(pathsToDelete.map(p => filesApi.remove(p)));
      setSelectedPaths(new Set());
      await loadFiles();
    } catch (err: unknown) {
      console.error('Failed to delete:', err);
      toast.error(`Delete failed: ${errMessage(err)}`);
    }
  }, [loadFiles, toast]);

  const handleOpenFile = useCallback(() => {
    if (!contextMenuNode || contextMenuNode.type === 'dir') { closeContextMenu(); return; }
    if (compact && onOpenFile) {
      onOpenFile(contextMenuNode.path);
    } else {
      setSelectedFile(contextMenuNode);
      editorTabsRef.current?.openFile(contextMenuNode.path, contextMenuNode.name);
    }
    closeContextMenu();
  }, [contextMenuNode, compact, onOpenFile, closeContextMenu]);

  // Guarded clipboard write — navigator.clipboard is undefined in non-secure contexts
  const copyToClipboard = useCallback((text: string) => {
    const p = navigator.clipboard?.writeText(text);
    if (p) p.then(() => toast.success('Path copied')).catch(() => toast.error('Copy failed'));
    else toast.error('Copy failed');
  }, [toast]);

  const handleCopyPath = useCallback(() => {
    if (!contextMenuNode) { closeContextMenu(); return; }
    copyToClipboard(contextMenuNode.path);
    closeContextMenu();
  }, [contextMenuNode, closeContextMenu, copyToClipboard]);

  const handleCopyRelativePath = useCallback(() => {
    if (!contextMenuNode) { closeContextMenu(); return; }
    const rel = contextMenuNode.path.startsWith(projectPath)
      ? contextMenuNode.path.slice(projectPath.length + 1)
      : contextMenuNode.path;
    copyToClipboard(rel);
    closeContextMenu();
  }, [contextMenuNode, projectPath, closeContextMenu, copyToClipboard]);

  const handleDuplicate = useCallback(async () => {
    const pathsToDuplicate = selectedPaths.size > 1
      ? Array.from(selectedPaths)
      : contextMenuNode ? [contextMenuNode.path] : [];
    if (pathsToDuplicate.length === 0) { closeContextMenu(); return; }
    try {
      await Promise.all(pathsToDuplicate.map(p => filesApi.duplicate(p)));
      await loadFiles();
    } catch (err: unknown) {
      console.error('Failed to duplicate:', err);
      toast.error(`Duplicate failed: ${errMessage(err)}`);
    }
    closeContextMenu();
  }, [contextMenuNode, selectedPaths, closeContextMenu, loadFiles, toast]);

  // Collapse all
  const handleCollapseAll = useCallback(() => {
    replaceExpanded([]);
  }, [replaceExpanded]);

  // Collapse a specific directory and all its descendants
  const handleCollapseDir = useCallback((dirPath: string) => {
    replaceExpanded(
      [...expandedDirsRef.current].filter(p => p !== dirPath && !p.startsWith(dirPath + '/')),
    );
  }, [replaceExpanded]);

  // Drag and drop
  const handleDragStart = useCallback((e: React.DragEvent, node: FileNode) => {
    // If dragging a selected item, drag all selected; otherwise just this one
    if (selectedPaths.has(node.path) && selectedPaths.size > 1) {
      draggedPathsRef.current = Array.from(selectedPaths);
    } else {
      draggedPathsRef.current = [node.path];
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedPathsRef.current.join('\n'));
    // Make the drag image slightly transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '0.5';
    }
  }, [selectedPaths]);

  const isChildOf = useCallback((childPath: string, parentPath: string) => {
    return childPath.startsWith(parentPath + '/');
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, node: FileNode) => {
    e.preventDefault();
    const isExternal = e.dataTransfer.types.includes('Files') && draggedPathsRef.current.length === 0;
    if (isExternal) {
      e.dataTransfer.dropEffect = 'copy';
      if (!externalDragRef.current) { externalDragRef.current = true; setIsExternalDrag(true); }
      setDragOverPath(node.path);
      setRootDragOver(false);
      return;
    }
    if (externalDragRef.current) { externalDragRef.current = false; setIsExternalDrag(false); }
    if (node.type !== 'dir') return;
    const invalid = draggedPathsRef.current.some(p => p === node.path || isChildOf(node.path, p));
    if (invalid) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.dataTransfer.dropEffect = 'move';
    setDragOverPath(node.path);
  }, [isChildOf]);

  const handleDragEnter = useCallback((e: React.DragEvent, node: FileNode) => {
    e.preventDefault();
    const isExternal = e.dataTransfer.types.includes('Files') && draggedPathsRef.current.length === 0;
    if (isExternal) {
      if (!externalDragRef.current) { externalDragRef.current = true; setIsExternalDrag(true); }
      setDragOverPath(node.path);
    } else if (node.type === 'dir') {
      const invalid = draggedPathsRef.current.some(p => p === node.path || isChildOf(node.path, p));
      if (!invalid) setDragOverPath(node.path);
    }
  }, [isChildOf]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // During external drag, don't clear on individual node leave — dragEnter/dragOver on the
    // next node will update the path. Clearing here causes flash between sibling nodes.
    if (externalDragRef.current) return;
    // Only clear if leaving the actual element (not entering a child)
    const related = e.relatedTarget as Node | null;
    if (e.currentTarget instanceof HTMLElement && related && e.currentTarget.contains(related)) return;
    setDragOverPath(null);
  }, []);

  // Recursively read a dropped directory via webkitGetAsEntry
  const readDirectoryEntries = useCallback(async (entry: FileSystemDirectoryEntry, basePath: string): Promise<{ file: File; relativePath: string }[]> => {
    const results: { file: File; relativePath: string }[] = [];
    try {
      const reader = entry.createReader();
      const readBatch = (): Promise<FileSystemEntry[]> => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      let batch = await readBatch();
      while (batch.length > 0) {
        for (const child of batch) {
          const childPath = basePath ? `${basePath}/${child.name}` : child.name;
          try {
            if (child.isFile) {
              const file = await new Promise<File>((resolve, reject) => (child as FileSystemFileEntry).file(resolve, reject));
              results.push({ file, relativePath: childPath });
            } else if (child.isDirectory) {
              const nested = await readDirectoryEntries(child as FileSystemDirectoryEntry, childPath);
              results.push(...nested);
            }
          } catch (err) {
            console.warn(`Failed to read entry ${childPath}:`, err);
          }
        }
        batch = await readBatch();
      }
    } catch (err) {
      console.warn(`Failed to read directory ${basePath}:`, err);
    }
    return results;
  }, []);

  const uploadExternalFiles = useCallback(async (e: React.DragEvent, targetDir: string) => {
    const items = e.dataTransfer.items;
    const allFiles: File[] = [];
    const allRelPaths: string[] = [];
    const emptyDirs: string[] = []; // track empty directories to create
    const droppedDirNames: string[] = [];

    // Try webkitGetAsEntry for directory support
    if (items && items.length > 0) {
      for (let i = 0; i < items.length; i++) {
        try {
          const entry = items[i].webkitGetAsEntry?.();
          if (entry?.isDirectory) {
            droppedDirNames.push(entry.name);
            const dirEntries = await readDirectoryEntries(entry as FileSystemDirectoryEntry, entry.name);
            if (dirEntries.length === 0) {
              // Empty folder — still create it on the server
              emptyDirs.push(entry.name);
            } else {
              for (const { file, relativePath } of dirEntries) {
                allFiles.push(file);
                allRelPaths.push(relativePath);
              }
            }
          } else if (entry?.isFile) {
            const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
            allFiles.push(file);
            allRelPaths.push(file.name);
          } else {
            // webkitGetAsEntry returned null — try as regular file
            const file = items[i].getAsFile?.();
            if (file && (file.size > 0 || file.type)) {
              allFiles.push(file);
              allRelPaths.push(file.name);
            }
          }
        } catch (err) {
          console.warn('Failed to read dropped item:', err);
        }
      }
    }

    // Fallback to dataTransfer.files if webkitGetAsEntry didn't produce results
    if (allFiles.length === 0 && emptyDirs.length === 0 && e.dataTransfer.files.length > 0) {
      let skippedFolders = 0;
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const f = e.dataTransfer.files[i];
        if (f.size === 0 && !f.type) {
          skippedFolders++;
          continue;
        }
        allFiles.push(f);
        allRelPaths.push(f.name);
      }
      if (skippedFolders > 0 && allFiles.length === 0) {
        toast.warning('Folder drop not supported in this browser. Drag individual files instead.');
        return;
      }
    }

    if (allFiles.length === 0 && emptyDirs.length === 0) {
      toast.warning('No files detected in drop.');
      return;
    }

    const label = droppedDirNames.length > 0
      ? droppedDirNames.join(', ')
      : allFiles.length === 1 ? allFiles[0].name : `${allFiles.length} files`;
    toast.info(`Uploading ${label}...`);
    try {
      await filesApi.uploadFiles(targetDir, allFiles, allRelPaths, emptyDirs);
      await loadFiles();
      toast.success(`Uploaded ${label}`);
    } catch (err: unknown) {
      console.error('External file drop failed:', err);
      toast.error(`Upload failed: ${errMessage(err) || 'Unknown error'}`);
    }
  }, [readDirectoryEntries, loadFiles, toast]);

  const handleDrop = useCallback(async (e: React.DragEvent, node: FileNode) => {
    e.preventDefault();
    // A node consumed this drop — stop it bubbling to the scroll container's
    // handleRootDrop, which would upload the same files a second time to the
    // project root (files landing in both the target dir AND root).
    e.stopPropagation();
    setDragOverPath(null);
    externalDragRef.current = false;
    setIsExternalDrag(false);

    // External file drop — accept on any node (use parent dir for files)
    const isExternal = e.dataTransfer.types.includes('Files') && draggedPathsRef.current.length === 0;
    if (isExternal) {
      const targetDir = node.type === 'dir' ? node.path : node.path.substring(0, node.path.lastIndexOf('/'));
      await uploadExternalFiles(e, targetDir);
      return;
    }

    // Internal move — only onto directories
    if (node.type !== 'dir') return;
    const paths = draggedPathsRef.current;
    if (paths.length === 0) return;
    const invalid = paths.some(p => p === node.path || isChildOf(node.path, p));
    if (invalid) return;

    try {
      await Promise.all(paths.map(p => {
        const name = basename(p);
        return filesApi.move(p, node.path + '/' + name);
      }));
      setSelectedPaths(new Set());
      await loadFiles();
    } catch (err: unknown) {
      console.error('Failed to move:', err);
      toast.error(`Move failed: ${errMessage(err)}`);
    }
  }, [isChildOf, loadFiles, uploadExternalFiles, toast]);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = '';
    }
    setDragOverPath(null);
    draggedPathsRef.current = [];
    if (externalDragRef.current) { externalDragRef.current = false; setIsExternalDrag(false); }
  }, []);

  // Copy / Cut / Paste keyboard shortcuts
  const getTargetDir = useCallback((): string => {
    // Target directory for paste: focused/selected directory, or parent of selected file
    const sel = Array.from(selectedPaths);
    if (sel.length === 1) {
      // Find the node to check if it's a dir
      const flat = flattenTree(files);
      const node = flat.find(f => f.path === sel[0]);
      if (node?.type === 'dir') return node.path;
      return getParentDir(sel[0]);
    }
    if (focusedPath) {
      const flat = flattenTree(files);
      const node = flat.find(f => f.path === focusedPath);
      if (node?.type === 'dir') return node.path;
      return getParentDir(focusedPath);
    }
    return projectPath;
  }, [selectedPaths, focusedPath, flattenTree, files, getParentDir, projectPath]);

  const handlePaste = useCallback(async () => {
    const cb = clipboardRef.current;
    if (!cb || cb.paths.length === 0) return;
    const targetDir = getTargetDir();
    try {
      if (cb.mode === 'copy') {
        await Promise.all(cb.paths.map(p => {
          const name = basename(p);
          return filesApi.copy(p, targetDir + '/' + name);
        }));
      } else {
        // cut = move
        await Promise.all(cb.paths.map(p => {
          const name = basename(p);
          return filesApi.move(p, targetDir + '/' + name);
        }));
        clipboardRef.current = null;
        setCutPaths(new Set());
      }
      await loadFiles();
    } catch (err: unknown) {
      console.error('Failed to paste:', err);
      toast.error(`Paste failed: ${errMessage(err)}`);
    }
  }, [getTargetDir, loadFiles, toast]);

  // Dismissal for the file context menu (right-click, positioned at the cursor).
  useDismissable({
    open: !!contextMenuPos,
    onClose: closeContextMenu,
    refs: [contextMenuRef],
    restoreFocus: false,
  });

  // Keyboard shortcuts for copy/cut/paste
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      // Only when tree is focused
      if (!el.contains(document.activeElement) && document.activeElement !== el) return;
      // Don't hijack keys while editing an inline input (rename / new item)
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && e.key === 'c') {
        e.preventDefault();
        const paths = Array.from(selectedPaths);
        if (paths.length > 0) {
          clipboardRef.current = { paths, mode: 'copy' };
          setCutPaths(new Set());
        }
      } else if (isMeta && e.key === 'x') {
        e.preventDefault();
        const paths = Array.from(selectedPaths);
        if (paths.length > 0) {
          clipboardRef.current = { paths, mode: 'cut' };
          setCutPaths(new Set(paths));
        }
      } else if (isMeta && e.key === 'v') {
        e.preventDefault();
        handlePaste();
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [selectedPaths, handlePaste]);

  // Compute adjusted context menu position to stay within viewport
  const contextMenuStyle = useCallback(() => {
    if (!contextMenuPos) return { left: 0, top: 0 };
    const menuWidth = 200;
    const menuHeight = 320;
    let x = contextMenuPos.x;
    let y = contextMenuPos.y;
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;
    if (x < 0) x = 8;
    if (y < 0) y = 8;
    return { left: x, top: y };
  }, [contextMenuPos]);

  // Open file from external source (e.g. Context Inspector memory tree)
  // Retry briefly to handle the case where EditorTabs hasn't mounted yet
  useEffect(() => {
    if (!pendingFile || compact) return;
    const tryOpen = () => {
      if (editorTabsRef.current) {
        const name = basename(pendingFile) || pendingFile;
        editorTabsRef.current.openFile(pendingFile, name);
        // Set selectedFile so the tree collapses to max-h-[200px]
        setSelectedFile({ name, path: pendingFile, type: 'file' });
        onPendingFileConsumed?.();
        return true;
      }
      return false;
    };
    if (tryOpen()) return;
    // Retry a few times for lazy-loaded EditorTabs
    let attempts = 0;
    const interval = setInterval(() => {
      if (tryOpen() || ++attempts > 10) {
        clearInterval(interval);
        if (attempts > 10) onPendingFileConsumed?.();
      }
    }, 100);
    return () => clearInterval(interval);
  }, [pendingFile, onPendingFileConsumed, compact]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't hijack navigation keys while editing an inline input (rename / new item)
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    // Let copy/cut/paste bubble to the native handler above
    const isMeta = e.metaKey || e.ctrlKey;
    if (isMeta && (e.key === 'c' || e.key === 'x' || e.key === 'v')) return;

    const flat = flattenTree(files);
    const currentIdx = flat.findIndex(f => f.path === focusedPath);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(currentIdx + 1, flat.length - 1);
      setFocusedPath(flat[next]?.path || null);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = Math.max(currentIdx - 1, 0);
      setFocusedPath(flat[prev]?.path || null);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const node = flat[currentIdx];
      if (node?.type === 'dir' && !expandedDirs.has(node.path)) {
        handleToggleDir(node.path);
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const node = flat[currentIdx];
      if (node?.type === 'dir' && expandedDirs.has(node.path)) {
        handleToggleDir(node.path);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const node = flat[currentIdx];
      if (node) {
        if (node.type === 'dir') handleToggleDir(node.path);
        else {
          setSelectedPaths(new Set([node.path]));
          lastClickedPathRef.current = node.path;
          if (compact && onOpenFile) {
            onOpenFile(node.path);
          } else {
            setSelectedFile(node);
            editorTabsRef.current?.openFile(node.path, node.name);
          }
        }
      }
    }
  }, [files, focusedPath, expandedDirs, flattenTree, handleToggleDir, compact, onOpenFile]);

  // Hover button handlers for new file/folder on directory rows
  // MUST be before any early returns to respect Rules of Hooks
  const handleHoverNewFile = useCallback((dirPath: string) => {
    setDirExpanded(dirPath, true);
    setNewItemParent(dirPath);
    setNewItemType('file');
  }, [setDirExpanded]);

  const handleHoverNewFolder = useCallback((dirPath: string) => {
    setDirExpanded(dirPath, true);
    setNewItemParent(dirPath);
    setNewItemType('dir');
  }, [setDirExpanded]);

  // Imperative handle for parent components (e.g. ProjectSidebar toolbar)
  useImperativeHandle(ref, () => ({
    newFile: () => handleHoverNewFile(projectPath),
    newFolder: () => handleHoverNewFolder(projectPath),
    collapseAll: handleCollapseAll,
    refresh: loadFiles,
  }), [projectPath, handleHoverNewFile, handleHoverNewFolder, handleCollapseAll, loadFiles]);

  // Root drop zone handlers (drop on empty area → upload to project root)
  // MUST be before early returns to respect Rules of Hooks
  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    const isExternal = e.dataTransfer.types.includes('Files') && draggedPathsRef.current.length === 0;
    if (!isExternal) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    // Always show root highlight during external drag when not on a specific node
    setRootDragOver(true);
  }, []);

  const handleRootDragLeave = useCallback((e: React.DragEvent) => {
    const related = e.relatedTarget as Node | null;
    if (e.currentTarget instanceof HTMLElement && related && e.currentTarget.contains(related)) return;
    // Left the tree container entirely — reset all drag state
    setRootDragOver(false);
    setDragOverPath(null);
    externalDragRef.current = false;
    setIsExternalDrag(false);
  }, []);

  const handleRootDrop = useCallback(async (e: React.DragEvent) => {
    const isExternal = e.dataTransfer.types.includes('Files') && draggedPathsRef.current.length === 0;
    if (!isExternal) return;
    e.preventDefault();
    e.stopPropagation();
    setRootDragOver(false);
    setDragOverPath(null);
    externalDragRef.current = false;
    setIsExternalDrag(false);
    await uploadExternalFiles(e, projectPath);
  }, [projectPath, uploadExternalFiles]);

  if (loading) {
    // Uno scheletro e non un anello centrato: qui sotto arriva un ALBERO, e
    // l'anello non lo diceva — al suo posto compariva di colpo una colonna di
    // righe, che è il salto. Le classi della riga finta sono quelle vere del
    // nodo (`px-2 py-[3px] min-h-[28px]`, indentazione `SIDEBAR_INDENT_STEP`),
    // copiate dal `FileNode` qui sopra: stessa altezza, stesso passo.
    return (
      <SkeletonRows
        count={12}
        rowClassName={`flex items-center gap-1.5 ${TREE_ROW_CARD} px-2 py-[3px] min-h-[28px]`}
        glyph={14}
        indentStep={SIDEBAR_INDENT_STEP}
        depths={[0, 0, 1, 1, 2, 1, 0, 1, 2, 2, 1, 0]}
      />
    );
  }

  // L'errore sostituisce l'albero SOLO se un albero non ce l'ho.
  //
  // Prima l'early return era incondizionato, e `loadFiles` faceva `setError`
  // anche su una revalidazione di sfondo: una richiesta caduta buttava via un
  // albero completo e corretto. Su questa macchina succede spesso —
  // `TOPICS_SERVER_WATCH=1` fa ripartire il server a ogni salvataggio sotto
  // `server/`, e in quella finestra la porta non accetta connessioni. Ora
  // quell'errore e' una banda sopra l'albero (piu' in basso), e lo store
  // ritenta da solo dopo 2s: la finestra di riavvio non si vede nemmeno.
  if (error && files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-red-500 text-[13px]">{error}</p>
        <button onClick={loadFiles} className="text-[12px] text-primary hover:underline">Retry</button>
      </div>
    );
  }

  const multiSelectCount = selectedPaths.size;
  const isMultiSelect = multiSelectCount > 1;

  // Render the context menu portal
  const contextMenuPortal = contextMenuPos && contextMenuNode && createPortal(
    <div
      ref={contextMenuRef}
      role="menu"
      className="fixed glass-surface border border-app-border rounded-lg shadow-lg py-1 min-w-[200px]"
      style={{ ...contextMenuStyle(), zIndex: Z_CONTEXT_MENU }}
    >
      {/* Header */}
      <div className="px-3 py-1.5 text-[11px] text-app-text-tertiary font-medium truncate border-b border-app-border mb-1">
        {isMultiSelect ? `${multiSelectCount} items selected` : contextMenuNode.name}
      </div>

      {/* Open */}
      {!isMultiSelect && contextMenuNode.type !== 'dir' && (
        <button
          role="menuitem"
          onClick={handleOpenFile}
          className="w-full text-left px-3 py-1.5 text-[12px] text-app-text-body hover:bg-app-hover transition-colors flex items-center gap-2"
        >
          <FileText size={14} className="text-app-text-tertiary" /> Open
        </button>
      )}

      {/* Copy Path / Copy Relative Path */}
      {!isMultiSelect && (
        <>
          <button
            role="menuitem"
            onClick={handleCopyPath}
            className="w-full text-left px-3 py-1.5 text-[12px] text-app-text-body hover:bg-app-hover transition-colors flex items-center gap-2"
          >
            <Copy size={14} className="text-app-text-tertiary" /> Copy Path
          </button>
          <button
            role="menuitem"
            onClick={handleCopyRelativePath}
            className="w-full text-left px-3 py-1.5 text-[12px] text-app-text-body hover:bg-app-hover transition-colors flex items-center gap-2"
          >
            <Copy size={14} className="text-app-text-tertiary" /> Copy Relative Path
          </button>
          <button
            role="menuitem"
            onClick={() => { filesApi.reveal(contextMenuNode.path); setContextMenuPos(null); }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-app-text-body hover:bg-app-hover transition-colors flex items-center gap-2"
          >
            <ExternalLink size={14} className="text-app-text-tertiary" /> Show in Finder
          </button>
          <div className="border-t border-app-border my-1" />
        </>
      )}

      {/* New File / New Folder */}
      <button
        role="menuitem"
        onClick={() => handleNewItem('file')}
        className="w-full text-left px-3 py-1.5 text-[12px] text-app-text-body hover:bg-app-hover transition-colors flex items-center gap-2"
      >
        <FilePlus size={14} className="text-app-text-tertiary" /> New File
      </button>
      <button
        role="menuitem"
        onClick={() => handleNewItem('dir')}
        className="w-full text-left px-3 py-1.5 text-[12px] text-app-text-body hover:bg-app-hover transition-colors flex items-center gap-2"
      >
        <FolderPlus size={14} className="text-app-text-tertiary" /> New Folder
      </button>

      <div className="border-t border-app-border my-1" />

      {/* Duplicate */}
      <button
        role="menuitem"
        onClick={handleDuplicate}
        className="w-full text-left px-3 py-1.5 text-[12px] text-app-text-body hover:bg-app-hover transition-colors flex items-center gap-2"
      >
        <Copy size={14} className="text-app-text-tertiary" /> Duplicate{isMultiSelect ? ` (${multiSelectCount})` : ''}
      </button>

      {/* Rename — single only */}
      {!isMultiSelect && (
        <button
          role="menuitem"
          onClick={handleRename}
          className="w-full text-left px-3 py-1.5 text-[12px] text-app-text-body hover:bg-app-hover transition-colors flex items-center gap-2"
        >
          <Pencil size={14} className="text-app-text-tertiary" /> Rename
        </button>
      )}

      {/* Delete */}
      <button
        role="menuitem"
        onClick={handleDelete}
        className="w-full text-left px-3 py-1.5 text-[12px] text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-2"
      >
        <Trash2 size={14} /> {tr('files.trash')}{isMultiSelect ? ` (${multiSelectCount})` : ''}
      </button>
    </div>,
    document.body
  );

  const deleteConfirmPortal = deleteConfirm && createPortal(
    <DeleteConfirmDialog
      paths={deleteConfirm}
      onConfirm={() => executeDelete(deleteConfirm)}
      onCancel={() => setDeleteConfirm(null)}
    />,
    document.body,
  );

  const treeNodeProps = {
    expandedDirs,
    expandedOverflow,
    onToggleDir: handleToggleDir,
    onExpandOverflow: handleExpandOverflow,
    onSelectFile: handleSelectFile,
    focusedPath,
    onContextMenu: handleContextMenu,
    renamingPath,
    onRenameSubmit: handleRenameSubmit,
    onRenameCancel: handleRenameCancel,
    newItemParent,
    newItemType,
    onNewItemSubmit: handleNewItemSubmit,
    onNewItemCancel: handleNewItemCancel,
    gitFileMap,
    gitDirSet,
    selectedPaths,
    cutPaths,
    dragOverPath,
    isExternalDrag,
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDragEnter: handleDragEnter,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
    onDragEnd: handleDragEnd,
    onNewFile: handleHoverNewFile,
    onNewFolder: handleHoverNewFolder,
    onCollapseDir: handleCollapseDir,
  };

  /**
   * La banda dell'errore: sta SOPRA l'albero e non al posto suo.
   *
   * Compare solo quando dei dati ci sono — se non ci sono, l'errore e' gia' un
   * cartello a piena altezza piu' in su. E' il caso della finestra di riavvio
   * del server: l'albero resta a schermo, la banda dice che l'ultimo
   * aggiornamento non e' passato, lo store ritenta da solo.
   */
  const bandaErrore = error ? (
    <div
      data-testid="file-tree-error-banner"
      /* `amber-800` in chiaro, non `amber-600`: la banda ha un fondo suo
         (`amber-500/10`), e su quel fondo composto — #faf0e1 in chiaro —
         amber-600 misura 2,84:1 e amber-700 si ferma a 4,49:1, cioè manca il
         4,5 di WCAG AA per un capello. amber-800 dà 6,34:1 in chiaro e
         amber-400 7,78:1 in scuro. È la stessa lettura che serve a chi legge
         un errore, nei due temi. */
      className="px-3 py-1 text-[11px] text-amber-800 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between gap-2 flex-shrink-0"
    >
      <span className="truncate">{error}</span>
      <button onClick={loadFiles} className="text-[11px] text-primary hover:underline flex-shrink-0">{tr('common.retry')}</button>
    </div>
  ) : null;

  if (compact) {
    return (
      <>
        {bandaErrore}
        <div
          ref={treeRef}
          className={`flex-1 overflow-y-auto${rootDragOver ? ' ring-2 ring-primary/40 bg-primary/5' : ''}`}
          role="tree"
          data-testid="file-tree"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          {newItemParent === projectPath && newItemType && (
            <InlineInput
              depth={0}
              icon={newItemType === 'dir'
                ? <Folder size={14} className="text-app-text-tertiary" />
                : (() => { const d = getFileIconDef(''); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()
              }
              onSubmit={handleNewItemSubmit}
              onCancel={handleNewItemCancel}
            />
          )}
          {files.map(node => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              loadingDirs={loadingDirs}
              selectedPath={selectedFile?.path || null}
              {...treeNodeProps}
            />
          ))}
        </div>
        {contextMenuPortal}
        {deleteConfirmPortal}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col h-full">
        {bandaErrore}
        {/* File tree */}
        <div
          ref={treeRef}
          className={`flex-shrink-0 overflow-y-auto border-b border-app-border ${selectedFile ? 'max-h-[200px]' : ''}${rootDragOver ? ' ring-2 ring-primary/40 bg-primary/5' : ''}`}
          role="tree"
          data-testid="file-tree"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          <div className="flex items-center justify-between px-2 py-1.5 border-b border-app-border sticky top-0 bg-surface z-10">
            <span className="text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">Explorer</span>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => handleNewItem('file')}
                className="p-1 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors"
                title="New file"
              >
                <FilePlus size={12} />
              </button>
              <button
                onClick={() => handleNewItem('dir')}
                className="p-1 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors"
                title="New folder"
              >
                <FolderPlus size={12} />
              </button>
              <button
                onClick={handleCollapseAll}
                className="p-1 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors"
                title="Collapse All"
              >
                <ChevronsDownUp size={12} />
              </button>
              <button
                onClick={loadFiles}
                className="p-1 rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text-hover transition-colors"
                title="Refresh"
              >
                <RefreshCw size={12} />
              </button>
            </div>
          </div>
          {newItemParent === projectPath && newItemType && (
            <InlineInput
              depth={0}
              icon={newItemType === 'dir'
                ? <Folder size={14} className="text-app-text-tertiary" />
                : (() => { const d = getFileIconDef(''); const I = d.icon; return <I size={14} style={{ color: d.color }} />; })()
              }
              onSubmit={handleNewItemSubmit}
              onCancel={handleNewItemCancel}
            />
          )}
          {files.map(node => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              loadingDirs={loadingDirs}
              selectedPath={selectedFile?.path || null}
              {...treeNodeProps}
            />
          ))}
        </div>

        {/* Editor tabs */}
        <div className="flex-1 min-w-0 min-h-[300px] flex flex-col overflow-hidden">
          <Suspense fallback={<SpinnerFallback />}>
            <EditorTabs ref={editorTabsRef} projectPath={projectPath} />
          </Suspense>
        </div>
      </div>
      {contextMenuPortal}
      {deleteConfirmPortal}
    </>
  );
});

// «This cannot be undone» adesso sarebbe una bugia: il server sposta nel
// cestino di sistema (server/lib/trash.ts) invece di cancellare. Il testo dice
// dove finisce la roba, perche' e' l'unica informazione che serve a decidere.
function DeleteConfirmDialog({ paths, onConfirm, onCancel }: { paths: string[]; onConfirm: () => void; onCancel: () => void }) {
  const tr = useT();
  return (
    <ConfirmDialog
      title={tr('files.trash')}
      confirmLabel={tr('files.trash')}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {paths.length === 1
        ? <>{tr('files.trashOneLead')}<span className="font-mono">{basename(paths[0])}</span>{tr('files.trashOneTail')}</>
        : <>{tr('files.trashMany', { n: paths.length })}</>}
    </ConfirmDialog>
  );
}
