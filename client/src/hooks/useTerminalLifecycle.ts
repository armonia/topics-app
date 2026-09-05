/**
 * useTerminalLifecycle — owns terminal session state + grace-period ref +
 * terminal:sessions WS subscription + a pure prune helper.
 *
 * Extracted from App.tsx during Phase 3 (hook 2 of 4). Per CRITIQUE C5:
 * NO `setOpenPanels` argument. Cleanup lives in `usePanelLifecycle` and
 * uses `pruneStaleTerminalPanes` — a pure function that returns the panes
 * to KEEP (preserving array reference equality on no-op, required by
 * CRITIQUE C4 to avoid spuriously triggering the validation effect).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalSessionInfo, WSMessage } from '../types';
import type { TerminalOps } from './appHookTypes';
import { createDormantTerminalGuard, type DormantKnowledge } from '../lib/dormantTerminalGuard';
import { BOOT_READ_TTL_MS, coalescedFetch } from '../lib/coalesceFetch';
import { decideRosterTrust } from './rosterTrust';
import { useRefMirror } from './useRefMirror';

export interface UseTerminalLifecycleArgs {
  wsStatus: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  /**
   * Istante dell'ultimo `ws.onopen`, da `useWebSocket`. È il trigger di re-fetch
   * del roster, e sostituisce `wsStatus` in quel ruolo per una ragione precisa:
   * `wsStatus` è `displayStatus`, che sopprime lo sfarfallio tenendo 'connected'
   * per 3 s prima di ammettere una disconnessione (`useWebSocket.ts:341-356`).
   * Un ciclo cade-e-torna più breve di 3 s non lo cambia MAI — e un hot-reload del
   * server è esattamente quello. Risultato: dopo la riconnessione il roster non
   * veniva mai richiesto di nuovo, e restava quello di prima della caduta.
   * `lastConnectedAt` cambia a ogni handshake, quindi non può mancarne uno.
   */
  lastConnectedAt: number | null;
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
}

export interface UseTerminalLifecycleReturn {
  sessions: TerminalSessionInfo[];
  /**
   * Il roster può essere creduto quando è VUOTO?
   *
   * `sessions: []` ha due significati che il tipo non distingue: "non ci sono
   * sessioni" e "non lo so ancora". Il server risponde `200 []` finché
   * `reconcileSessions` non ha finito — `Bun.serve` non lo attende — quindi il
   * secondo caso è reale e frequente a ogni riavvio.
   *
   * Chi prende decisioni IRREVERSIBILI su un roster vuoto (dichiarare scaduta una
   * pane, potarne una) deve guardare questo prima. Chi mostra soltanto una lista
   * non ha bisogno di guardarlo.
   */
  rosterAuthoritative: boolean;
  refs: {
    /** Read-only ref. Lets pruneStaleTerminalPanes know whether the
     *  initial fetch completed (so it doesn't drop optimistic terminals
     *  before the first /api/terminal/sessions response). */
    terminalSessionsLoadedRef: React.MutableRefObject<boolean>;
    /** Map of recently-created terminal session ids → timestamp. The
     *  panel hook writes via `ops.markRecentlyCreated`; the prune helper
     *  reads + expires entries during cleanup. */
    recentlyCreatedTerminalsRef: React.MutableRefObject<Map<string, number>>;
  };
  ops: TerminalOps;
  /**
   * Pure helper. Given the current pane id list, returns the list to
   * KEEP (filtered for stale terminal panes, with a 5s grace exception
   * for sessions just created by `markRecentlyCreated`).
   *
   * INVARIANT (CRITIQUE C4): returns the input array unchanged on no-op
   * — callers rely on `filtered === input` reference equality so
   * downstream effects don't loop.
   */
  pruneStaleTerminalPanes: (currentPaneIds: string[]) => string[];
}

const GRACE_MS = 5000;

export function useTerminalLifecycle(args: UseTerminalLifecycleArgs): UseTerminalLifecycleReturn {
  const { wsStatus, lastConnectedAt, onWSMessage } = args;

  const [sessions, setSessions] = useState<TerminalSessionInfo[]>(() => {
    try {
      const cached = localStorage.getItem('terminal-sessions-cache');
      if (cached) { const p = JSON.parse(cached); if (Array.isArray(p)) return p; }
    } catch {}
    return [];
  });

  const terminalSessionsLoadedRef = useRef(false);
  /**
   * Il roster è stato confermato almeno una volta? Deliberatamente SEPARATO da
   * `terminalSessionsLoadedRef`: quello dice "una fetch è tornata" (e torna anche
   * col `200 []` prematuro), questo dice "un vuoto qui va creduto". Tenerli
   * distinti evita di cambiare il comportamento di `pruneStaleTerminalPanes`, che
   * usa il primo e non ha bisogno del secondo.
   *
   * È stato, non ref, perché chi decide se dichiarare morta una pane sta in un
   * altro albero e deve ri-renderizzarsi quando la promozione arriva. Il ref
   * gemello serve solo a leggerlo dentro le callback senza aggiungere dipendenze.
   */
  const [rosterAuthoritative, setRosterAuthoritative] = useState(false);
  const rosterAuthoritativeRef = useRef(false);
  // ISSUE 13 fix: track recently created terminal session IDs with timestamps
  // to avoid cleanup race when server WS broadcast hasn't caught up yet.
  const recentlyCreatedTerminalsRef = useRef<Map<string, number>>(new Map());

  /**
   * PARKED sessions, and the knowledge that puts the prune back in motion when
   * more of it lands.
   *
   * The roster cannot contain them by construction (it is the server's
   * in-memory map, and a parked session has left it), so without this the prune
   * below read a parking as a death. And the guard is not a list read once: it
   * is asked again at every disappearance, which is the only moment the
   * question means anything.
   *
   * STATE, not a ref, on purpose: the answer arrives async and the pass that
   * actually prunes is the NEXT one - with no re-render the cleanup effect
   * would never run it.
   */
  const [parked, setParked] = useState<DormantKnowledge>(() => ({
    dormantIds: new Set<string>(), confirmedGoneIds: new Set<string>(),
  }));
  const [dormantGuard] = useState(() => createDormantTerminalGuard({ onUpdate: setParked }));

  // Internal mirror so the pure helper can be a stable callback (no deps,
  // never re-created — keeps the panel hook's terminal-cleanup effect
  // from re-firing every render). useRefMirror is the canonical helper
  // for this state→ref bridge.
  const sessionsRef = useRefMirror(sessions);

  // Merge an authoritative list with any OPTIMISTIC entries still inside
  // their creation grace: a roster fetched (or broadcast) before the server
  // registered a just-created terminal would otherwise wholesale-replace the
  // optimistic entry away — the pane survives via recentlyCreatedTerminalsRef,
  // but its name/cwd metadata (read from `sessions`) blanked until the next
  // real broadcast. Entries past the grace defer to server truth.
  const mergeWithOptimistic = useCallback((incoming: TerminalSessionInfo[]): TerminalSessionInfo[] => {
    const now = Date.now();
    const ids = new Set(incoming.map(s => s.id));
    const keep = sessionsRef.current.filter(s => {
      if (ids.has(s.id)) return false;
      const ts = recentlyCreatedTerminalsRef.current.get(s.id);
      return ts !== undefined && now - ts <= GRACE_MS;
    });
    return keep.length ? [...incoming, ...keep] : incoming;
  }, [sessionsRef]);

  /**
   * Applica un roster in arrivo secondo `decideRosterTrust`, che è dove sta la
   * regola. Qui c'è solo l'effetto: un vuoto sospetto non tocca né lo stato né la
   * cache, così non distrugge ciò che sapevamo su sessioni ancora vive.
   */
  const applyRoster = useCallback((incoming: TerminalSessionInfo[], reconciled?: boolean): boolean => {
    const merged = mergeWithOptimistic(incoming);
    const d = decideRosterTrust({
      incoming: merged,
      reconciled,
      previous: sessionsRef.current,
      wasAuthoritative: rosterAuthoritativeRef.current,
    });
    if (d.authoritative && !rosterAuthoritativeRef.current) {
      rosterAuthoritativeRef.current = true;
      setRosterAuthoritative(true);
    }
    if (!d.accept) return false;
    setSessions(merged);
    if (d.cache) {
      try { localStorage.setItem('terminal-sessions-cache', JSON.stringify(merged)); } catch {}
    }
    // TORNA LA DECISIONE, e serve a chi arma la potatura: un roster RIFIUTATO
    // (vuoto sospetto) non deve valere come «adesso so quali terminali esistono».
    return true;
  }, [mergeWithOptimistic, sessionsRef]);

  const fetchTerminalSessions = useCallback(() => {
    // TRE GUARDIE, e ognuna chiude un modo diverso di armare una POTATURA su una
    // risposta che non era un roster. `terminalSessionsLoadedRef` e' l'unico
    // cancello di `pruneStaleTerminalPanes`, che toglie le pane terminale dal
    // layout: alzarlo per sbaglio non produce un errore, produce pane sparite.
    //
    //  · `r.ok`      — un 500 con un corpo JSON (`{"error": ...}`) passava da
    //                  `r.json()` senza un fiato.
    //  · `Array.isArray` — quel corpo poi arrivava ad `applyRoster` come se
    //                  fosse un elenco di sessioni.
    //  · l'ORDINE    — la bandiera si alzava PRIMA di applicare il roster, e
    //                  restava alzata anche quando `decideRosterTrust` lo
    //                  RIFIUTAVA. Un vuoto sospetto non e' una conoscenza.
    //
    // Coalesced: the mount read, the WebSocket-open read (~700 ms later) and
    // every project window's own roster read are the same question at boot.
    coalescedFetch('/api/terminal/sessions', undefined, { ttlMs: BOOT_READ_TTL_MS })
      .then(r => {
        if (!r.ok) throw new Error(`roster ${r.status}`);
        return r.json();
      })
      .then((data: TerminalSessionInfo[]) => {
        if (!Array.isArray(data)) return;
        // Nessun `reconciled` da questa via: il corpo è un array nudo e cambiargli
        // forma romperebbe MCP, mobile e i test. Lo porta il broadcast.
        if (applyRoster(data)) terminalSessionsLoadedRef.current = true;
      })
      .catch(() => {});
  }, [applyRoster]);

  // Fetch on mount
  useEffect(() => { fetchTerminalSessions(); }, [fetchTerminalSessions]);

  // Re-fetch a OGNI handshake della WebSocket principale, non al cambio di
  // `wsStatus`: quello è `displayStatus`, che tiene 'connected' per 3 s per
  // sopprimere lo sfarfallio, quindi un hot-reload del server (cade e torna in
  // meno di 3 s) non lo cambiava mai e il roster non veniva mai richiesto di
  // nuovo. `lastConnectedAt` cambia a ogni `ws.onopen`, quindi non se ne perde uno.
  useEffect(() => {
    if (lastConnectedAt === null) return;
    fetchTerminalSessions();
  }, [lastConnectedAt, fetchTerminalSessions]);
  // `wsStatus` resta negli argomenti: è ancora il segnale giusto per il primo
  // caricamento quando la WS era già connessa prima che questo hook montasse.
  useEffect(() => {
    if (wsStatus === 'connected' && lastConnectedAt === null) fetchTerminalSessions();
  }, [wsStatus, lastConnectedAt, fetchTerminalSessions]);

  // WS terminal:sessions subscription — same optimistic-grace merge as the
  // fetch path (an unrelated broadcast can land before a new terminal's
  // registration reaches the roster).
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'terminal:sessions') {
        // Questa è la via che porta `reconciled`, ed è anche quella su cui il
        // server manda un broadcast al solo momento della promozione: un client
        // già connesso durante il boot viene raggiunto senza dover richiedere.
        applyRoster(msg.sessions, msg.reconciled);
      }
    });
  }, [onWSMessage, applyRoster]);

  // Ops exposed to the panel hook (written via handleQuickCreateTerminal /
  // handleCloseTerminal — which live in usePanelLifecycle).
  const addOptimisticSession = useCallback((session: TerminalSessionInfo) => {
    setSessions(prev => prev.some(s => s.id === session.id) ? prev : [...prev, session]);
  }, []);

  const markRecentlyCreated = useCallback((sessionId: string) => {
    recentlyCreatedTerminalsRef.current.set(sessionId, Date.now());
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => prev.filter(s => s.id !== sessionId));
  }, []);

  const pruneStaleTerminalPanes = useCallback((currentPaneIds: string[]): string[] => {
    if (!terminalSessionsLoadedRef.current) return currentPaneIds;
    const sessionIds = new Set(sessionsRef.current.map(s => s.id));
    const now = Date.now();
    // Prune expired entries from recentlyCreated
    for (const [id, ts] of recentlyCreatedTerminalsRef.current) {
      if (now - ts > GRACE_MS) recentlyCreatedTerminalsRef.current.delete(id);
    }
    // Ids that left the roster and are neither parked nor confirmed dead yet.
    const toVerify: string[] = [];
    const filtered = currentPaneIds.filter(id => {
      if (!id.startsWith('terminal:')) return true;
      const sessionId = id.slice('terminal:'.length);
      if (sessionIds.has(sessionId) || recentlyCreatedTerminalsRef.current.has(sessionId)) return true;
      // OUT OF THE ROSTER IS NOT DEAD. The roster mirrors the server's live
      // session map, which a claude session leaves the instant it exits - while
      // its row stays `dormant` and resumable. This prune saw only the map, so
      // typing `/exit` deleted the tab within the second, taking the "Session
      // ended / Resume" overlay (and the uuid it prints for `--resume`) with it.
      // Ask the dormant list, keep the pane until it answers.
      if (parked.dormantIds.has(sessionId)) return true;
      if (parked.confirmedGoneIds.has(sessionId)) return false;
      toVerify.push(sessionId);
      return true;
    });
    if (toVerify.length > 0) dormantGuard.recheck(toVerify);
    return filtered.length === currentPaneIds.length ? currentPaneIds : filtered;
    // sessionsRef is a stable ref object and `dormantGuard` a stable state
    // value (identity never changes), so listing them keeps the callback's
    // identity stable — this stays a zero-churn callback as the cleanup effect
    // requires while satisfying exhaustive-deps. `parked` is the one deliberate
    // churn: a fresh dormant answer must re-run the cleanup effect, which is
    // the pass that finally prunes a session confirmed gone.
  }, [sessionsRef, dormantGuard, parked]);

  return {
    sessions,
    rosterAuthoritative,
    refs: { terminalSessionsLoadedRef, recentlyCreatedTerminalsRef },
    ops: { addOptimisticSession, markRecentlyCreated, removeSession },
    pruneStaleTerminalPanes,
  };
}
