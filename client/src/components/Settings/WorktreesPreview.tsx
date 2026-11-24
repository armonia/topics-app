import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderInput, GitPullRequestArrow, Trash2 } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useConfirm } from '../../hooks/useConfirm';
import { worktreesApi } from '../../lib/apiSystem';
import { formatSize } from '../Browser/downloadsModel';
import { Spinner } from '../Shared/Spinner';
import type { RelocateAction, RelocateCheckPayload, WorktreePlanPayload, WorktreePlanEntryPayload } from '../../../../shared/worktree-plan';

/** How many lines show before «show all»: a root can hold hundreds of folders. */
const FIRST_LINES = 40;

/** The last two segments of a path: enough to tell worktrees apart; the full path is the tooltip. */
const tail = (p: string): string => p.split('/').filter(Boolean).slice(-2).join('/');

/**
 * CLEANUP PREVIEW (change worktree-standard, T3 and T7): for every folder of the
 * worktree root and every row, the class it has, what the next pass would do and
 * what it weighs. Worktrees made by another tool (outside the root) get three
 * hand actions: adopt (a row, so the cleanup sees it), move (into the root) and
 * remove. Each asks the server for a preview first and shows why when refused.
 */
export function WorktreesPreview() {
  const t = useT();
  const confirm = useConfirm();
  const [plan, setPlan] = useState<WorktreePlanPayload | null>(null);
  const [shown, setShown] = useState(false);
  const [weighed, setWeighed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);
  /** One message per path: why a click was refused, or what failed. */
  const [notes, setNotes] = useState<Record<string, string>>({});
  const alive = useRef(true);

  const load = useCallback(async (weigh: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      const next = await worktreesApi.cleanupPreview(weigh);
      if (alive.current) { setPlan(next); setWeighed(weigh); }
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  // The count of folders outside the root needs no weighing: it comes with the first mount.
  useEffect(() => {
    alive.current = true;
    void load(false);
    return () => { alive.current = false; };
  }, [load]);

  const refusal = useCallback((check: RelocateCheckPayload) => check.refusals.map((r) => t(`worktrees.refuse.${r}`)).join(' · '), [t]);

  const act = useCallback(async (entry: WorktreePlanEntryPayload, action: RelocateAction) => {
    const setNote = (msg: string) => setNotes((n) => ({ ...n, [entry.absPath]: msg }));
    setNote('');
    try {
      const check = await worktreesApi.relocateCheck(entry.absPath, action);
      if (!check.ok) { setNote(refusal(check)); return; }
      if (action !== 'adopt') {
        const ok = await confirm({
          title: t(action === 'move' ? 'worktrees.move.title' : 'worktrees.remove.title'),
          body: t(action === 'move' ? 'worktrees.move.body' : 'worktrees.remove.body', { from: check.from, to: check.to ?? '' }),
          confirmLabel: t(action === 'move' ? 'worktrees.move' : 'worktrees.remove'),
          tone: action === 'remove' ? 'danger' : 'default',
        });
        if (!ok) return;
      }
      const res = await worktreesApi.relocate(entry.absPath, action);
      if (!res.ok) { setNote(res.error ? t('worktrees.action.failed', { reason: res.error }) : refusal(res.check)); return; }
      await load(weighed);
    } catch (err) {
      setNote(t('worktrees.action.failed', { reason: err instanceof Error ? err.message : String(err) }));
    }
  }, [confirm, load, refusal, t, weighed]);

  const lines = plan ? [...plan.entries].sort(byWeight) : [];
  const visible = all ? lines : lines.slice(0, FIRST_LINES);

  return (
    <div className="space-y-2 border-t border-app-border pt-3" data-testid="worktrees-preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-compact text-app-text-muted" data-testid="worktrees-preview-summary">
          {plan ? t(plan.entries.length === 1 ? 'worktrees.preview.summaryOne' : 'worktrees.preview.summary', { n: String(plan.entries.length), foreign: String(plan.foreignCount) }) : ''}
        </span>
        <button
          type="button"
          data-testid="worktrees-preview-open"
          disabled={busy}
          onClick={() => { setShown(true); void load(true); }}
          className="inline-flex items-center gap-1.5 rounded-sm border border-app-border px-2.5 py-1.5 text-compact text-app-text hover:bg-app-hover disabled:opacity-40 coarse:min-h-11"
        >
          {busy && shown ? <Spinner size="sm" box={14} tone="current" /> : <GitPullRequestArrow size={14} />}
          {t('worktrees.preview.open')}
        </button>
      </div>
      {failed && <div className="text-compact text-red-600 dark:text-red-400">{t('worktrees.preview.failed')}</div>}
      {shown && busy && <div className="text-compact text-app-text-muted">{t('worktrees.preview.loading')}</div>}
      {shown && plan && plan.overCap.length > 0 && (
        <div className="text-compact text-app-text-muted">
          {t('worktrees.preview.overCap', { projects: plan.overCap.map((o) => `${o.projectName ?? t('worktrees.preview.noProject')} ${o.count}/${o.max}`).join(', ') })}
        </div>
      )}
      {shown && plan && lines.length === 0 && !busy && <div className="text-compact text-app-text-muted">{t('worktrees.preview.empty')}</div>}
      {shown && plan && lines.length > 0 && (
        <ul className="space-y-1" data-testid="worktrees-preview-list">
          {visible.map((e) => (
            <PreviewLine key={e.absPath} entry={e} note={notes[e.absPath] ?? ''} onAct={(a) => { void act(e, a); }} />
          ))}
        </ul>
      )}
      {shown && !all && lines.length > FIRST_LINES && (
        <button type="button" onClick={() => setAll(true)} className="text-compact text-app-text-muted underline-offset-2 hover:text-app-text hover:underline">
          {t('worktrees.preview.more', { n: String(lines.length) })}
        </button>
      )}
    </div>
  );
}

/** Heaviest first; folders never weighed last. */
function byWeight(a: WorktreePlanEntryPayload, b: WorktreePlanEntryPayload): number {
  return (b.bytes ?? -1) - (a.bytes ?? -1);
}

function PreviewLine({ entry, note, onAct }: { entry: WorktreePlanEntryPayload; note: string; onAct: (action: RelocateAction) => void }) {
  const t = useT();
  const foreign = entry.cls === 'foreign';
  const action = entry.cls === 'tracked' && entry.plannedAction ? entry.plannedAction : entry.rootAction;
  const size = entry.bytes === null ? undefined : formatSize(entry.bytes);
  return (
    <li className="border border-app-border px-2 py-1.5" data-testid="worktrees-preview-line" data-class={entry.cls}>
      <div className="break-all text-compact text-app-text" title={entry.absPath}>{tail(entry.absPath)}</div>
      <div className="text-mini break-words text-app-text-muted" title={entry.reason}>
        {[
          entry.projectName ?? t('worktrees.preview.noProject'),
          t(`worktrees.cls.${entry.cls}`),
          t(`worktrees.act.${action}`),
          size,
          foreign && entry.rowId ? t('worktrees.adopted') : undefined,
        ].filter(Boolean).join(' · ')}
      </div>
      {foreign && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {!entry.rowId && <LineButton testId="worktrees-adopt" icon={<FolderInput size={13} />} label={t('worktrees.adopt')} title={t('worktrees.adopt.hint')} onClick={() => onAct('adopt')} />}
          <LineButton testId="worktrees-move" icon={<FolderInput size={13} />} label={t('worktrees.move')} onClick={() => onAct('move')} />
          <LineButton testId="worktrees-remove" icon={<Trash2 size={13} />} label={t('worktrees.remove')} onClick={() => onAct('remove')} />
        </div>
      )}
      {note && <div className="mt-1 text-mini text-red-600 dark:text-red-400" data-testid="worktrees-line-note">{note}</div>}
    </li>
  );
}

function LineButton({ testId, icon, label, title, onClick }: { testId: string; icon: React.ReactNode; label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={title}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-sm border border-app-border px-2 py-1 text-mini text-app-text hover:bg-app-hover coarse:min-h-11 coarse:px-3"
    >
      {icon}
      {label}
    </button>
  );
}
