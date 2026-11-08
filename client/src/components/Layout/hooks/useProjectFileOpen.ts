/**
 * useProjectFileOpen — aprire un file, un diff o il log di un processo dentro
 * una ProjectWindow, e i tre eventi `window` che lo chiedono da fuori.
 * Estratto da `useProjectLayout` (~230 righe, tre handler quasi identici).
 *
 * Possiede:
 *  - I tre handler `openFile` / `openDiff` / `openProcessLog`, ognuno ridotto a
 *    «costruisci la pane, chiedi il piano, applicalo».
 *  - L'unico applicatore del piano (`applyPlan`): tre scritture di stato, in un
 *    posto solo.
 *  - I listener `open-file`, `open-file-diff` e `pin-file-pane`, con la guardia
 *    di finestra: sono eventi GLOBALI e ogni ProjectWindow montata li riceve —
 *    senza guardia, con due progetti affiancati un click apriva il file in
 *    ENTRAMBI.
 *
 * NON possiede:
 *  - La regola di collocazione (`planOpenPane`, puro e testato).
 *  - La regola di instradamento (`shouldHandleOpenFile` / `shouldHandleOpenDiff`,
 *    già unit-testate in `fileOpenScope.ts`).
 *  - I gruppi vuoti e gli orfani: se non c'è ancora nessun gruppo la pane resta
 *    orfana e la colloca l'orphan-sync.
 *
 * Le tre `useCallback` hanno dipendenze `[]` di proposito, non per
 * dimenticanza: leggono lo stato vivo dalle ref e scrivono solo con setState
 * funzionale, quindi non chiudono su niente che possa diventare stantio. In
 * cambio l'identità dell'handler resta stabile — e questa passa a ogni pane
 * dell'albero: farla cambiare a ogni modifica del layout vorrebbe dire
 * ri-renderizzare tutto a ogni tab spostata.
 */
import { useCallback, useEffect } from 'react';
import type { Pane, PaneGroup } from '../../../types';
import { createPaneId } from '../../../state/pane/adapters';
import { basename } from '../../../lib/path-utils';
import { shouldHandleOpenFile, shouldHandleOpenDiff } from '../fileOpenScope';
import { planOpenPane } from './paneOpenPlan';

export interface UseProjectFileOpenArgs {
  /** Id della pane sotto cui questa ProjectWindow è montata nel layout padre. */
  wrapperPaneId: string;
  panesRef: React.RefObject<Pane[]>;
  groupsRef: React.RefObject<PaneGroup[]>;
  focusedGroupIdRef: React.RefObject<string | null>;
  /** Pannello a fuoco a livello di APP (quale finestra di progetto comanda),
   *  distinto dal gruppo a fuoco dentro questa finestra. */
  focusedPanelIdRef: React.RefObject<string | null>;
  setPanes: React.Dispatch<React.SetStateAction<Pane[]>>;
  setGroups: React.Dispatch<React.SetStateAction<PaneGroup[]>>;
  setFocusedGroupId: React.Dispatch<React.SetStateAction<string | null>>;
}

export interface UseProjectFileOpenReturn {
  openFile: (path: string) => void;
  openDiff: (filePath: string, diffProjectPath: string) => void;
  openProcessLog: (processId: string, scriptName: string) => void;
}

export function useProjectFileOpen({
  wrapperPaneId,
  panesRef,
  groupsRef,
  focusedGroupIdRef,
  focusedPanelIdRef,
  setPanes,
  setGroups,
  setFocusedGroupId,
}: UseProjectFileOpenArgs): UseProjectFileOpenReturn {
  /** L'unico punto che scrive stato per un'apertura. */
  const applyPlan = useCallback(
    (newPane: Pane, opts: { matchExisting: (p: Pane) => boolean; replacePreviewOfType?: Pane['type'] }) => {
      const plan = planOpenPane(
        panesRef.current ?? [],
        groupsRef.current ?? [],
        focusedGroupIdRef.current,
        newPane,
        opts,
      );
      if (plan.kind === 'focus') {
        if (!plan.groupId) return;
        const gid = plan.groupId;
        setFocusedGroupId(gid);
        setGroups(prev => prev.map(g => (g.id === gid ? { ...g, activePaneId: plan.paneId } : g)));
        return;
      }
      if (plan.kind === 'replace-preview') {
        setPanes(prev => prev.map(p => (p.id === plan.replacedPaneId ? plan.pane : p)));
        setGroups(prev =>
          prev.map(g =>
            g.id === plan.groupId ? { ...g, paneIds: plan.paneIds, activePaneId: plan.pane.id } : g,
          ),
        );
        setFocusedGroupId(plan.groupId);
        return;
      }
      setPanes(prev => [...prev, plan.pane]);
      // Nessun gruppo ancora: la pane resta orfana e la colloca l'orphan-sync.
      if (!plan.groupId) return;
      const gid = plan.groupId;
      setGroups(prev =>
        prev.map(g =>
          g.id === gid ? { ...g, paneIds: [...g.paneIds, plan.pane.id], activePaneId: plan.pane.id } : g,
        ),
      );
      setFocusedGroupId(gid);
    },
    // Refs-only + setState funzionale: vedi l'intestazione del file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const openFile = useCallback((path: string) => {
    applyPlan(
      {
        id: createPaneId('file'),
        type: 'file',
        filePath: path,
        title: basename(path) || path,
        preview: true,
      },
      {
        matchExisting: p => p.type === 'file' && p.filePath === path,
        replacePreviewOfType: 'file',
      },
    );
  }, [applyPlan]);

  const openDiff = useCallback((filePath: string, diffProjectPath: string) => {
    const diffKey = `diff:${filePath}`;
    const filename = basename(filePath) || filePath;
    applyPlan(
      {
        id: diffKey,
        type: 'file',
        filePath: `${diffProjectPath}/${filePath}`,
        title: `${filename} (diff)`,
        diff: true,
        diffProjectPath,
        preview: true,
      },
      {
        matchExisting: p => p.type === 'file' && p.id === diffKey,
        replacePreviewOfType: 'file',
      },
    );
  }, [applyPlan]);

  const openProcessLog = useCallback((processId: string, scriptName: string) => {
    const paneKey = `process-log:${processId}`;
    applyPlan(
      { id: paneKey, type: 'process-log', processId, title: scriptName },
      // Un log di processo non è mai un'anteprima: non scalza niente.
      { matchExisting: p => p.id === paneKey },
    );
  }, [applyPlan]);

  // --- File-event listeners ---

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string; topicId?: string };
      if (!detail?.path) return;
      // SCOPE to THIS project window. 'open-file' is a GLOBAL window event and
      // every mounted project window subscribes to it — so with two projects in
      // split view a single dispatch would open the file in BOTH ("file opens on
      // all splits"). Routing rule extracted to the unit-tested
      // `shouldHandleOpenFile`; mirrors the projectPath scoping the
      // global-tab:focus-inner listener already uses.
      if (!shouldHandleOpenFile(detail, wrapperPaneId, focusedPanelIdRef.current)) return;
      openFile(detail.path);
    };
    window.addEventListener('open-file', handler);
    return () => window.removeEventListener('open-file', handler);
  }, [openFile, wrapperPaneId, focusedPanelIdRef]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { filePath: string; projectPath: string };
      if (!detail?.filePath) return;
      // SCOPE a QUESTA finestra di progetto — la guardia che il gemello
      // 'open-file' aveva e questo no. Senza, con due finestre affiancate un
      // click nel pannello Git di B faceva comparire la tab diff anche in A, e
      // quella tab portava il `diffProjectPath` di B pur essendo ospitata in A.
      if (!shouldHandleOpenDiff(detail, wrapperPaneId, focusedPanelIdRef.current, p => createPaneId('project', p))) return;
      openDiff(detail.filePath, detail.projectPath);
    };
    window.addEventListener('open-file-diff', handler);
    return () => window.removeEventListener('open-file-diff', handler);
  }, [openDiff, wrapperPaneId, focusedPanelIdRef]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string };
      const path = detail?.path;
      setPanes(prev =>
        prev.map(p => (p.type === 'file' && p.filePath === path ? { ...p, preview: false } : p)),
      );
    };
    window.addEventListener('pin-file-pane', handler);
    return () => window.removeEventListener('pin-file-pane', handler);
  }, [setPanes]);

  return { openFile, openDiff, openProcessLog };
}
