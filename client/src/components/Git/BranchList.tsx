import { useState, useEffect, useCallback, useRef } from 'react';
import { GitBranch, Check, RefreshCw, Globe, Monitor, Plus, Trash2, Link } from 'lucide-react';
import { gitApi } from '../../lib/api';
import { useToast } from '../Shared/Toast';
import { useConfirm } from '../../hooks/useConfirm';
import { SELECTED_SURFACE } from '../../lib/selectionStyles';
import { Spinner } from '../Shared/Spinner';
import { ContextMenuPortal } from '../Shared/ContextMenuPortal';
import { useMobile } from '../../hooks/useMobile';
import { useLongPress, openContextMenuAt } from '../../hooks/useLongPress';
import { hoverRevealClass } from '../../lib/hoverReveal';

interface Branch {
  name: string;
  current: boolean;
  isRemote: boolean;
  /** Solo per i remoti: il nome senza il prefisso del remote, dal server. */
  shortName?: string;
  remote?: string;
  ahead?: number;
  behind?: number;
}

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

interface BranchListProps {
  projectPath: string;
  onBranchSwitch?: () => void;
  remotes?: { name: string; fetchUrl: string; pushUrl: string }[];
  onAddRemote?: (name: string, url: string) => Promise<void>;
  onRemoveRemote?: (name: string) => Promise<void>;
}

export function BranchList({ projectPath, onBranchSwitch, remotes, onAddRemote, onRemoveRemote }: BranchListProps) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const [showNewInput, setShowNewInput] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  /**
   * IL MENU DI RIGA — l'unico percorso che «cancella branch» ha col dito.
   *
   * Cancellare un branch e togliere un remote vivevano solo dentro un bottone
   * `opacity-0 group-hover:opacity-100`: una classe che sta dentro
   * `@media (hover: hover)` e che quindi, senza puntatore, non si accende mai.
   * Il comando non era «meno visibile», era irraggiungibile — e l'`opacity: 0`
   * lasciava comunque un bersaglio da 14px cliccabile alla cieca a 8px dal
   * bordo di una riga il cui tocco fa checkout.
   *
   * Il gesto e' quello standard dell'app: tasto destro col mouse, «tieni
   * premuto» col dito, e `openContextMenuAt` sintetizza il `contextmenu` che
   * l'handler qui sotto gia' ascolta — quindi e' LO STESSO menu, non un
   * secondo da tenere allineato.
   */
  const [rowMenu, setRowMenu] = useState<
    { kind: 'branch' | 'remote'; name: string; x: number; y: number } | null
  >(null);
  const [showRemoteInput, setShowRemoteInput] = useState(false);
  const [newRemoteName, setNewRemoteName] = useState('origin');
  const [newRemoteUrl, setNewRemoteUrl] = useState('');
  const [addingRemote, setAddingRemote] = useState(false);

  const loadBranches = useCallback(async () => {
    try {
      setLoading(true);
      const result = await gitApi.branches(projectPath);
      setBranches(result);
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectPath, toast]);

  useEffect(() => {
    loadBranches();
  }, [loadBranches]);

  useEffect(() => {
    if (showNewInput && newInputRef.current) {
      newInputRef.current.focus();
    }
  }, [showNewInput]);

  const handleCheckout = async (branchName: string) => {
    try {
      setSwitching(branchName);
      await gitApi.checkout(projectPath, branchName);
      await loadBranches();
      onBranchSwitch?.();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setSwitching(null);
    }
  };

  const handleCreateBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    try {
      setCreating(true);
      await gitApi.createBranch(projectPath, name, true);
      setNewBranchName('');
      setShowNewInput(false);
      await loadBranches();
      onBranchSwitch?.();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const removeRemote = useCallback(async (name: string) => {
    if (!onRemoveRemote) return;
    try {
      await onRemoveRemote(name);
      toast.success(`Remote "${name}" removed`);
    } catch (err) {
      toast.error(errMessage(err) || 'Failed to remove remote');
    }
  }, [onRemoveRemote, toast]);

  /**
   * IL DIALOGO DI CONFERMA NON DEVE MORIRE COL PANNELLO CHE L'HA APERTO.
   *
   * Prima erano due stati locali piu' due `createPortal`, montati da questa
   * lista — che vive dentro la tendina dei rami. Scegliere «Delete branch» dal
   * menu di riga chiude la tendina (il menu e' un portal su `<body>`, quindi
   * per `useDismissable` quel click e' «fuori»), e con la tendina se ne andava
   * anche il dialogo: il comando non arrivava mai a chiedere conferma.
   * `useConfirm` vive nel provider in cima all'app, quindi sopravvive.
   */
  const askDeleteBranch = useCallback(async (name: string) => {
    const ok = await confirm({
      title: 'Delete Branch',
      confirmLabel: 'Delete',
      body: <>Delete branch <span className="font-mono">{name}</span>? This cannot be undone.</>,
    });
    if (!ok) return;
    let nonUnito = false;
    try {
      setDeleting(name);
      await gitApi.deleteBranch(projectPath, name);
      await loadBranches();
    } catch (err) {
      const message = errMessage(err);
      // `git branch -d` refuses branches with unmerged commits — that failure
      // is exactly the case where a silent force-retry would destroy work, so
      // surface it as its own explicit confirmation instead of auto-retrying.
      nonUnito = /not fully merged/i.test(message);
      if (!nonUnito) toast.error(message);
    } finally {
      setDeleting(null);
    }
    if (!nonUnito) return;

    const forza = await confirm({
      title: 'Force Delete Branch',
      confirmLabel: 'Force Delete',
      body: <>The branch <span className="font-mono">{name}</span> has unmerged commits. Force delete anyway? This will permanently discard those commits.</>,
    });
    if (!forza) return;
    try {
      setDeleting(name);
      await gitApi.deleteBranch(projectPath, name, true);
      await loadBranches();
    } catch (err) {
      toast.error(errMessage(err));
    } finally {
      setDeleting(null);
    }
  }, [projectPath, loadBranches, confirm, toast]);

  const handleAddRemoteSubmit = async () => {
    const name = newRemoteName.trim();
    const url = newRemoteUrl.trim();
    if (!name || !url || !onAddRemote) return;
    try {
      setAddingRemote(true);
      await onAddRemote(name, url);
      setNewRemoteName('origin');
      setNewRemoteUrl('');
      setShowRemoteInput(false);
      toast.success(`Remote "${name}" added`);
    } catch (err) {
      toast.error(errMessage(err) || 'Failed to add remote');
    } finally {
      setAddingRemote(false);
    }
  };

  const localBranches = branches.filter(b => !b.isRemote);
  const remoteBranches = branches.filter(b => b.isRemote);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-app-text-tertiary">
        <Spinner size="sm" />
        Loading branches...
      </div>
    );
  }

  return (
    <>
    <div className="text-[12px]">
      {/* New branch input */}
      {showNewInput && (
        <div className="px-2 py-1.5 border-b border-app-border flex items-center gap-1">
          <input
            ref={newInputRef}
            type="text"
            value={newBranchName}
            onChange={e => setNewBranchName(e.target.value)}
            placeholder="branch-name"
            className="flex-1 min-w-0 h-[22px] px-1.5 text-[11px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); handleCreateBranch(); }
              if (e.key === 'Escape') { setShowNewInput(false); setNewBranchName(''); }
            }}
            disabled={creating}
          />
          <button
            onClick={handleCreateBranch}
            disabled={creating || !newBranchName.trim()}
            className="px-1.5 h-[22px] text-[11px] font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 transition-colors"
          >
            {creating ? <Spinner size="xs" tone="current" /> : 'Create'}
          </button>
        </div>
      )}

      {/* Local branches */}
      <div className="px-2 py-1 flex items-center justify-between">
        <div className="flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">
          <Monitor size={10} />
          Local ({localBranches.length})
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowNewInput(!showNewInput)}
            className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary hover:text-primary transition-colors"
            title="New branch"
          >
            <Plus size={10} />
          </button>
          <button
            onClick={loadBranches}
            className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary"
            title="Refresh branches"
          >
            <RefreshCw size={10} />
          </button>
        </div>
      </div>
      {localBranches.map(branch => (
        <BranchRow
          key={branch.name}
          branch={branch}
          switching={switching === branch.name}
          deleting={deleting === branch.name}
          onCheckout={() => handleCheckout(branch.name)}
          onDelete={() => { void askDeleteBranch(branch.name); }}
          onOpenMenu={(x, y) => setRowMenu({ kind: 'branch', name: branch.name, x, y })}
        />
      ))}

      {/* Remote branches */}
      {remoteBranches.length > 0 && (
        <>
          <div className="px-2 py-1 mt-1 flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">
            <Globe size={10} />
            Remote ({remoteBranches.length})
          </div>
          {remoteBranches.map(branch => {
            // Checkout runs on the STRIPPED name — `switching` holds that, so
            // the spinner compare must use it too (matching against the raw
            // `remotes/origin/…` name never succeeded → zero feedback during a
            // multi-second remote checkout).
            //
            // Il nome corto ora arriva DAL SERVER (`shortName`), che è l'unico
            // a sapere come si chiama il remote. Qui si tirava via un prefisso
            // `remotes/origin/` che il server non produce: `%(refname:short)`
            // dà `origin/foo`, la regex non matchava mai, e il checkout partiva
            // su `origin/foo` — cioè HEAD staccato, silenzioso, e ogni commit
            // fatto da lì orfano. Il ripiego copre i client vecchi e i remote
            // con un nome qualsiasi, non solo `origin`.
            const localName = branch.shortName ?? branch.name.replace(/^(?:remotes\/)?[^/]+\//, '');
            return (
              <div
                key={branch.name}
                className="flex items-center gap-2 px-2 py-[3px] cursor-pointer hover:bg-app-hover text-app-text-secondary transition-colors"
                onClick={() => handleCheckout(localName)}
              >
                {switching === localName ? (
                  <Spinner size="sm" className="flex-shrink-0" />
                ) : (
                  <Globe size={12} className="flex-shrink-0 opacity-30" />
                )}
                <span className="truncate text-[11px]">{localName}</span>
              </div>
            );
          })}
        </>
      )}

      {/* Remotes (URLs) */}
      {remotes !== undefined && (
        <>
          <div className="px-2 py-1 mt-1 flex items-center justify-between">
            <div className="flex items-center gap-1 text-[11px] font-medium text-app-text-tertiary uppercase tracking-wider">
              <Link size={10} />
              Remotes{remotes.length > 0 ? ` (${remotes.length})` : ''}
            </div>
            {onAddRemote && (
              <button
                onClick={() => setShowRemoteInput(!showRemoteInput)}
                className="p-0.5 rounded hover:bg-app-hover text-app-text-tertiary hover:text-primary transition-colors"
                title="Add remote"
              >
                <Plus size={10} />
              </button>
            )}
          </div>
          {showRemoteInput && onAddRemote && (
            <div className="px-2 py-1">
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={newRemoteName}
                  onChange={e => setNewRemoteName(e.target.value)}
                  placeholder="name"
                  className="w-[50px] h-[20px] px-1 text-[11px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
                />
                <input
                  type="text"
                  value={newRemoteUrl}
                  onChange={e => setNewRemoteUrl(e.target.value)}
                  placeholder="https://github.com/..."
                  className="flex-1 min-w-0 h-[20px] px-1 text-[11px] bg-app-hover dark:bg-app-bg border border-app-border-input rounded focus:outline-none focus:border-primary text-app-text-heading placeholder-app-text-faint"
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); handleAddRemoteSubmit(); }
                    if (e.key === 'Escape') { setShowRemoteInput(false); setNewRemoteName('origin'); setNewRemoteUrl(''); }
                  }}
                  autoFocus
                />
                <button
                  onClick={handleAddRemoteSubmit}
                  disabled={addingRemote || !newRemoteName.trim() || !newRemoteUrl.trim()}
                  className="px-1.5 h-[20px] text-[11px] font-medium rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40 transition-colors"
                >
                  {addingRemote ? <Spinner size="xs" tone="current" /> : 'Add'}
                </button>
              </div>
            </div>
          )}
          {remotes.map(r => (
            <RemoteRow
              key={r.name}
              remote={r}
              canRemove={!!onRemoveRemote}
              onRemove={() => removeRemote(r.name)}
              onOpenMenu={(x, y) => setRowMenu({ kind: 'remote', name: r.name, x, y })}
            />
          ))}
        </>
      )}
    </div>
    <ContextMenuPortal
      open={!!rowMenu}
      x={rowMenu?.x ?? 0}
      y={rowMenu?.y ?? 0}
      onClose={() => setRowMenu(null)}
      // Questa lista vive DENTRO la tendina dei rami: un menu esclusivo la
      // chiuderebbe aprendosi, e morirebbe con lei. Vedi ContextMenuPortal.
      exclusive={false}
    >
      {rowMenu?.kind === 'branch' && (
        <>
          <button
            role="menuitem"
            data-testid="branch-menu-checkout"
            onClick={() => { const n = rowMenu.name; setRowMenu(null); handleCheckout(n); }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-app-text-body hover:bg-app-hover transition-colors flex items-center gap-2"
          >
            <GitBranch size={14} className="text-app-text-tertiary" /> Checkout
          </button>
          <div className="border-t border-app-border my-1" />
          <button
            role="menuitem"
            data-testid="branch-menu-delete"
            onClick={() => { const n = rowMenu.name; setRowMenu(null); void askDeleteBranch(n); }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400 hover:bg-app-hover transition-colors flex items-center gap-2"
          >
            <Trash2 size={14} /> Delete branch
          </button>
        </>
      )}
      {rowMenu?.kind === 'remote' && (
        <button
          role="menuitem"
          data-testid="remote-menu-remove"
          onClick={() => { const n = rowMenu.name; setRowMenu(null); void removeRemote(n); }}
          className="w-full text-left px-3 py-1.5 text-[12px] text-red-600 dark:text-red-400 hover:bg-app-hover transition-colors flex items-center gap-2"
        >
          <Trash2 size={14} /> Remove remote
        </button>
      )}
    </ContextMenuPortal>
    </>
  );
}

/**
 * Una riga di branch, estratta perche' `useLongPress` e' un hook e dentro un
 * `.map()` non ci puo' stare.
 *
 * Il bottone «cancella» resta la scorciatoia del mouse, ma solo quando un
 * puntatore esiste davvero: `hoverRevealClass` gli mette `pointer-events-none`
 * nel ramo senza hover, cosi' non c'e' piu' un bersaglio invisibile sul bordo.
 * Col dito il comando passa dal menu (tieni premuto), che e' lo stesso del
 * tasto destro.
 */
function BranchRow({ branch, switching, deleting, onCheckout, onDelete, onOpenMenu }: {
  branch: Branch;
  switching: boolean;
  deleting: boolean;
  onCheckout: () => void;
  onDelete: () => void;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const { isTouch, hasHover } = useMobile();
  const press = useLongPress(openContextMenuAt, { enabled: isTouch && !branch.current });
  const deleteReveal = hoverRevealClass(hasHover);

  return (
    <div
      data-testid="branch-row"
      data-branch={branch.name}
      className={`flex items-center gap-2 px-2 py-[3px] cursor-pointer transition-colors group select-none ${
        branch.current ? SELECTED_SURFACE : 'hover:bg-app-hover text-app-text-body'
      }`}
      {...press.handlers}
      data-pressing={press.pressed || undefined}
      onContextMenu={e => {
        if (branch.current) return;
        e.preventDefault();
        e.stopPropagation();
        onOpenMenu(e.clientX, e.clientY);
      }}
      onClick={() => {
        // Il `click` sintetico che segue un long-press andato a segno va
        // mangiato, o la riga fa checkout sotto il menu appena aperto.
        if (press.consumeClick()) return;
        if (!branch.current) onCheckout();
      }}
    >
      {branch.current ? (
        <Check size={12} className="flex-shrink-0 text-primary" />
      ) : switching ? (
        <Spinner size="sm" className="flex-shrink-0" />
      ) : (
        <GitBranch size={12} className="flex-shrink-0 opacity-40" />
      )}
      <span className="truncate">{branch.name}</span>
      {(branch.ahead !== undefined && branch.ahead > 0) && (
        <span className="ml-auto text-[11px] text-green-600 dark:text-green-400 flex-shrink-0">↑{branch.ahead}</span>
      )}
      {(branch.behind !== undefined && branch.behind > 0) && (
        <span className={`${branch.ahead ? '' : 'ml-auto'} text-[11px] text-red-600 dark:text-red-400 flex-shrink-0`}>↓{branch.behind}</span>
      )}
      {/* Delete button — only on non-current branches */}
      {!branch.current && (
        <button
          data-testid="branch-delete"
          onClick={e => { e.stopPropagation(); onDelete(); }}
          className={`ml-auto p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-app-text-muted hover:text-red-500 flex-shrink-0 ${deleteReveal}`}
          title={`Delete ${branch.name}`}
        >
          {deleting ? (
            <Spinner size="xs" tone="current" className="text-red-500" />
          ) : (
            <Trash2 size={10} />
          )}
        </button>
      )}
    </div>
  );
}

/** Stessa storia della riga di branch, per un remote. */
function RemoteRow({ remote, canRemove, onRemove, onOpenMenu }: {
  remote: { name: string; fetchUrl: string; pushUrl: string };
  canRemove: boolean;
  onRemove: () => void;
  onOpenMenu: (x: number, y: number) => void;
}) {
  const { isTouch, hasHover } = useMobile();
  const press = useLongPress(openContextMenuAt, { enabled: isTouch && canRemove });
  const removeReveal = hoverRevealClass(hasHover, 'remote');

  return (
    <div
      data-testid="remote-row"
      data-remote={remote.name}
      className="flex items-center gap-1.5 px-2 py-[3px] text-[11px] group/remote hover:bg-app-hover transition-colors select-none"
      {...press.handlers}
      data-pressing={press.pressed || undefined}
      onContextMenu={e => {
        if (!canRemove) return;
        e.preventDefault();
        e.stopPropagation();
        onOpenMenu(e.clientX, e.clientY);
      }}
    >
      <Link size={10} className="text-app-text-muted flex-shrink-0" />
      <span className="font-medium text-app-text-heading">{remote.name}</span>
      <span className="truncate text-app-text-muted text-[11px] min-w-0">{remote.fetchUrl}</span>
      {canRemove && (
        <button
          data-testid="remote-remove"
          onClick={e => { e.stopPropagation(); onRemove(); }}
          className={`ml-auto p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-app-text-muted hover:text-red-500 flex-shrink-0 ${removeReveal}`}
          title={`Remove ${remote.name}`}
        >
          <Trash2 size={10} />
        </button>
      )}
    </div>
  );
}
