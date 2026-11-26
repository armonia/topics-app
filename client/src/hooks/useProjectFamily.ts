// Relative imports, not `@/`: `bun test` does not resolve the alias.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from './useT';
import { useToast } from '../components/Shared/Toast';
import { listProjectRows, setProjectFamily, toFamilyRow } from '../lib/projectFamilyApi';
import { refreshBoardFamilies } from '../lib/boardProjectsStore';
import { boardIdOfRow, parentChoices, type MergeMode } from '../../../shared/project-family';
import type { Project } from '../types';

/**
 * ACCORPA / SEPARA: where a project sits among the others.
 *
 * `useProjectFamily` is the one piece of logic, shared by the sidebar menu and
 * the board settings panel: it reads the project rows, finds this project by its
 * folder, and offers the three gestures (put under a parent, flip the mode,
 * detach). A change only touches the `projects` row; every card keeps its
 * project, and the boards re-read when the server announces the row.
 */
export function useProjectFamily(match: { path?: string; boardId?: string }) {
  const tr = useT();
  const toast = useToast();
  const [rows, setRows] = useState<Project[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    listProjectRows().then((r) => { if (alive) setRows(r); }).catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [match.path, match.boardId]);

  const family = useMemo(() => (rows ?? []).map(toFamilyRow), [rows]);
  const own: Project | null = useMemo(() => {
    if (!rows) return null;
    const wanted = match.boardId ?? (match.path ? boardIdOfRow({ path: match.path }) : null);
    return wanted ? rows.find((p) => boardIdOfRow(p) === wanted) ?? null : null;
  }, [rows, match.path, match.boardId]);
  const parent = own?.parentId ? rows?.find((p) => p.id === own.parentId) ?? null : null;
  const hasChildren = !!own && family.some((r) => r.parentId === own.id && !r.archived);
  // The merged children have no row of their own in the sidebar, so the parent is where they are separated from.
  const mergedChildren = useMemo(
    () => (own ? (rows ?? []).filter((p) => p.parentId === own.id && !p.archived && (p.mergeMode ?? 'accorpa') === 'accorpa') : []),
    [rows, own],
  );
  const choices = useMemo(() => (own ? parentChoices(family, own.id) : { suggested: [], others: [] }), [family, own]);

  const apply = useCallback(async (change: { parentId?: string | null; mergeMode?: MergeMode }, targetId?: string) => {
    const id = targetId ?? own?.id;
    if (!id) return;
    setBusy(true);
    try {
      const next = await setProjectFamily(id, change);
      setRows((cur) => (cur ?? []).map((p) => (p.id === next.id ? next : p)));
      void refreshBoardFamilies();
    } catch (e) {
      toast.error(tr('family.failed', { why: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }, [own?.id, toast, tr]);

  return { loaded: rows !== null && own !== null, own, parent, hasChildren, mergedChildren, choices, busy, apply };
}

