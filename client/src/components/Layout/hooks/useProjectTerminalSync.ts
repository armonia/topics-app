/**
 * useProjectTerminalSync — tiene le tab terminale di una ProjectWindow allineate
 * al roster del server. Estratto da `useProjectLayout` (era il primo dei suoi
 * nove effetti, ~130 righe di regole di potatura).
 *
 * Possiede:
 *  - La fetch d'avvio del roster (`/api/terminal/sessions`) e il guard delle
 *    PARCHEGGIATE (`lib/dormantTerminalGuard`), che non si legge una volta
 *    sola: si richiede a ogni sparizione, e alla risposta ripassa il prune.
 *  - La sottoscrizione WS a `terminal:sessions`.
 *  - Le tre memorie che rendono il prune sicuro: id VISTI almeno una volta,
 *    id parcheggiati/confermati morti (nel guard), ultimo roster ricevuto.
 *  - Il prune («vista e poi sparita», o mai vista con roster autorevole), la
 *    rietichettatura dal roster e l'auto-aggiunta delle sessioni del progetto.
 *
 * NON possiede:
 *  - I gruppi, le righe, il fuoco: scrive SOLO `panes`, e solo con un updater
 *    funzionale. Chi ospita le nuove pane in un gruppo è l'orphan-sync.
 *  - La decisione «tenere o potare» in sé: quella è `decideRestoredTerminalPane`.
 *  - La rianimazione di una sessione dormiente — la fa la pane quando diventa
 *    ATTIVA (SingleTerminalPane, gated su `isActive`). Qui le dormienti si
 *    censiscono soltanto: aprire un progetto non deve riaccendere tutti i
 *    processi che il parcheggio per inattività ha appena spento.
 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Pane, PaneType, Topic, WSMessage } from '../../../types';
import { getTerminalSessionFromPaneId, getTerminalTombstones } from '../../../state/pane/adapters';
import { normalizeTerminalAgent, TERMINAL_AGENT_LABELS } from '../../../lib/terminalAgents';
import { createDormantTerminalGuard } from '../../../lib/dormantTerminalGuard';
import { BOOT_READ_TTL_MS, coalescedFetch } from '../../../lib/coalesceFetch';
import { decideRestoredTerminalPane } from './terminalReconcile';

interface TerminalRosterEntry { id: string; cwd: string; name: string; type: string }

export interface UseProjectTerminalSyncArgs {
  projectPath: string;
  /** Ref-mirror dei topic: serve solo a riconoscere un progetto "largo" (una
   *  cartella che è antenata di altri progetti), che non deve adottare per
   *  prefisso i terminali dei progetti sottostanti. */
  topicsRef: React.RefObject<Record<string, Topic>>;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  setPanes: Dispatch<SetStateAction<Pane[]>>;
}

export function useProjectTerminalSync({
  projectPath,
  topicsRef,
  onWSMessage,
  setPanes,
}: UseProjectTerminalSyncArgs): void {
  // Session ids we've POSITIVELY seen in a roster. A terminal pane is pruned
  // only once its session has been seen AND then disappeared — never on a
  // transient empty/partial roster. The server's session map is empty for a
  // moment after a hot-reload (bun --watch restart, reconcile is async) and the
  // WS reconnect after an Electron refresh can deliver a roster before
  // reconcile finishes; pruning on those used to wipe every restored
  // claude-code tab inside a project AND persist the wipe → sessions lost.
  const seenTerminalSessionIdsRef = useRef<Set<string>>(new Set());
  /** Ultimo roster visto, per ripassare il prune quando la lista delle dormienti
   *  risponde (all'avvio, e dopo ogni ri-verifica). */
  const lastRosterRef = useRef<TerminalRosterEntry[]>([]);

  useEffect(() => {
    // A roster entry is only usable if it carries a string `id` and `cwd`.
    // The roster can arrive over both the fetch and WS paths from a server
    // mid-restart (partial shapes) — without this guard `s.cwd.startsWith`
    // throws and a single bad entry wipes the whole sync.
    const isTerminalSession = (s: unknown): s is TerminalRosterEntry =>
      !!s &&
      typeof (s as { id?: unknown }).id === 'string' &&
      typeof (s as { cwd?: unknown }).cwd === 'string';

    const syncTerminals = (rawSessions: TerminalRosterEntry[]) => {
      // Tenuto per poter ripassare il prune quando la lista delle dormienti
      // arriva DOPO il roster (due fetch in volo, nessun ordine garantito).
      lastRosterRef.current = rawSessions;
      const sessions = rawSessions.filter(isTerminalSession);
      const sessionIds = new Set(sessions.map(s => s.id));
      // Live name from the roster, keyed by session id. The server owns the
      // title (auto-derived from the claude/codex transcript or the opencode DB,
      // or a user rename), so this lets an existing project tab relabel when its
      // name lands — a tab spawned as "opencode"/"Claude Code" doesn't stay
      // generic. (The standalone bar already recomputes titles every render;
      // only the project layout set the title once at creation and never again.)
      const nameById = new Map(sessions.map(s => [s.id, s.name] as const));
      const seen = seenTerminalSessionIdsRef.current;
      for (const id of sessionIds) seen.add(id);
      // A NON-EMPTY roster proves the server is up and reconcile has populated
      // its session map — so a restored terminal pane whose id is absent from it
      // (and never seen) is a genuine corpse from a previous run, not a
      // still-loading tab. An EMPTY roster (server mid hot-reload / a reconnect
      // that raced reconcile) is NOT authoritative: keep never-seen panes then,
      // preserving the original refresh/reconnect protection. This is what stops
      // an app restart from resurrecting dead "sessioni morte" project tabs.
      const rosterAuthoritative = sessionIds.size > 0;
      // Tombstoned session ids are sessions the user just closed in
      // this or another window (persisted in localStorage). Don't
      // auto-add panes for them — otherwise close-then-reload
      // resurrects them indefinitely until the server-side dormant
      // reaper kills the session, which can take much longer than the
      // user's patience.
      const tombstones = getTerminalTombstones();
      // Guard against a "broad" project (e.g. the home dir) whose path is an
      // ancestor of other real projects: by prefix-match it would adopt every
      // claude-code/terminal underneath it, dragging unrelated sessions into
      // this split. If a more specific project exists below us, adopt nothing
      // automatically — those terminals belong to their own project window.
      const isBroadProject = Object.values(topicsRef.current ?? {}).some(
        t => t.projectPath && t.projectPath.startsWith(projectPath + '/'),
      );
      const projectSessions = isBroadProject ? [] : sessions.filter(
        s => (s.cwd === projectPath || s.cwd.startsWith(projectPath + '/'))
          && !tombstones.has(s.id),
      );
      // Ids whose session left the roster and whose fate the dormant list in
      // hand cannot settle: collected here, re-checked after the update. The
      // panes stay meanwhile.
      const toVerify = new Set<string>();
      setPanes(prev => {
        let updated = prev.filter(p => {
          if (p.type !== 'terminal') return true;
          const sid = getTerminalSessionFromPaneId(p.id) || '';
          // Prune a seen-then-gone session (closed in another window) OR a
          // never-seen id that an authoritative (non-empty) roster doesn't list
          // (a dead session restored from a previous run). Keep never-seen ids
          // while the roster is empty/unproven — see terminalReconcile for why
          // this stops a refresh from losing live tabs.
          // NOTHING IS PRUNED UNTIL THE PARKED LIST IS IN.
          //
          // The roster and the dormant list are fetched together and answer in
          // no guaranteed order - and in practice the roster wins: its fetch is
          // issued first and reads an in-memory Map. At that instant
          // `rosterAuthoritative` is already true and the dormant set is still
          // empty, so a PARKED tab falls through to the last branch of
          // `decideRestoredTerminalPane` and is pruned.
          //
          // And the second pass below cannot put it back: the prune is
          // destructive (`prev.filter`), so that pass gets a `prev` the pane has
          // already left, and the only re-add path (`toAdd`) is built from the
          // ROSTER - where a dormant session is absent by construction. By then
          // the loss is already written down: `projectPersistence` saves
          // localStorage with no debounce, so on the NEXT reload the tab is gone
          // from the snapshot too.
          //
          // Reported: "se faccio ricarica su una claude code si perde". allow-italian: the report is quoted verbatim
          // In the live DB the terminal sessions are 1 active and 35 dormant,
          // every one of them claude-code: the tab that disappears is almost
          // always a parked one.
          //
          // So the prune waits until it knows. If the dormant fetch fails the
          // flag is raised anyway with an empty set: from there on the behaviour
          // is exactly what it was - never worse.
          //
          // AND THE SAME HOLDS FOR EVERY LATER DISAPPEARANCE, not just for the
          // race at mount. `/exit` in a live claude tab parks the row and
          // rebroadcasts a roster without it: with a dormant set read at mount
          // that is plain seen-then-gone, so the tab was deleted within the
          // second and the layout saved the deletion (no debounce). Hence
          // `verify`: keep the pane, ask the dormant list again, decide then.
          if (!guard.loaded) return true;
          const verdict = decideRestoredTerminalPane(
            sid, sessionIds, seen, rosterAuthoritative, guard.dormantIds, guard.confirmedGoneIds,
          );
          if (verdict === 'verify') toVerify.add(sid);
          return verdict !== 'prune';
        });
        // Relabel existing terminal tabs from the live roster. Returns the same
        // object when unchanged, so the identity check below still short-circuits
        // a no-op broadcast into a no-render.
        updated = updated.map(p => {
          if (p.type !== 'terminal') return p;
          const sid = getTerminalSessionFromPaneId(p.id) || '';
          const name = nameById.get(sid);
          return name && name !== p.title ? { ...p, title: name } : p;
        });
        const existingTermIds = new Set(
          updated.filter(p => p.type === 'terminal').map(p => getTerminalSessionFromPaneId(p.id)),
        );
        const toAdd: Pane[] = [];
        for (const s of projectSessions) {
          if (existingTermIds.has(s.id)) continue;
          toAdd.push({
            id: `terminal:${s.id}`,
            type: 'terminal' as PaneType,
            title: s.name || TERMINAL_AGENT_LABELS[normalizeTerminalAgent(s.type)],
            preview: false,
            // claude-code-team intentionally maps to 'shell' here (not a
            // user-creatable agent); codex keeps its own type → OpenAI glyph.
            terminalType: normalizeTerminalAgent(s.type),
          });
        }
        if (toAdd.length > 0) updated = [...updated, ...toAdd];
        return updated.length === prev.length && updated.every((p, i) => p === prev[i]) ? prev : updated;
      });
      // Outside the updater on purpose: React can invoke it twice (StrictMode),
      // and this must fire once per real disappearance. `recheck` ignores ids it
      // has already settled, so a repeated call costs nothing.
      if (toVerify.size > 0) guard.recheck(toVerify);
    };

    // Le sessioni PARCHEGGIATE si censiscono, non si rianimano: la lista serve
    // al prune (una dormiente è fuori dal roster per costruzione), non a
    // rimettere in piedi i processi che il parcheggio ha appena spento. A
    // rianimare ci pensa la pane quando diventa ATTIVA (SingleTerminalPane,
    // gated su `isActive`), con `--resume` ed esattamente dov'era.
    const guard = createDormantTerminalGuard({
      // Ripassa il prune sull'ultimo roster: è così che una risposta fresca
      // diventa una tab tenuta (parcheggiata) o potata (sparita davvero).
      onUpdate: () => syncTerminals(lastRosterRef.current),
    });
    // Coalesced with the App-level roster read (useTerminalLifecycle) and with
    // every other project window mounting in the same frame: one GET, not N+1.
    coalescedFetch('/api/terminal/sessions', undefined, { ttlMs: BOOT_READ_TTL_MS })
      .then(r => r.json()).then(syncTerminals).catch(() => {});

    // Prima lettura: finché non risponde, `guard.loaded` è false e il prune non
    // toglie niente. Alla risposta il guard richiama `onUpdate`, quindi questa è
    // la PRIMA passata che pota qualcosa, non una seconda che prova a rimettere.
    guard.load();

    return onWSMessage((msg: WSMessage) => {
      const m = msg as unknown as { type?: string; sessions?: unknown };
      if (m.type === 'terminal:sessions' && Array.isArray(m.sessions)) {
        syncTerminals(m.sessions as TerminalRosterEntry[]);
      }
    });
  }, [onWSMessage, projectPath, topicsRef, setPanes]);
}
