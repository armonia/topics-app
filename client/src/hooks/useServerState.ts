import { useState, useEffect, useRef, useCallback } from 'react';
import type { WSMessage } from '../types';
import { BOOT_READ_TTL_MS, coalescedFetch } from '../lib/coalesceFetch';

interface UseServerStateOptions {
  /** localStorage key for fast-paint cache */
  localStorageKey?: string;
  /** Debounce ms for PUT calls (default 500) */
  debounceMs?: number;
  /** WS message handler registration */
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

/**
 * Hook for state backed by server /api/ui-state/:key. // PANE-01-ALLOWED: generic hook — callers supply non-pane keys only (pane-store-v2 uses dedicated middleware, not this hook).
 * - Fast paint from localStorage
 * - Fetches from server on mount
 * - Listens for WS ui-state:init / ui-state:updated
 * - Debounced PUT on change
 */
export function useServerState<T>(
  key: string,
  defaultValue: T,
  options: UseServerStateOptions = {},
): [T, (value: T | ((prev: T) => T)) => void] {
  const { localStorageKey, debounceMs = 500, onMessage } = options;

  // Initialize from localStorage (fast paint) or default
  const [value, setValueRaw] = useState<T>(() => {
    if (localStorageKey) {
      try {
        const raw = localStorage.getItem(localStorageKey);
        if (raw !== null) return JSON.parse(raw);
      } catch {}
    }
    return defaultValue;
  });

  const valueRef = useRef(value);
  // eslint-disable-next-line react-hooks/refs -- intentional state→ref mirror so async/WS callbacks read the latest committed value without re-subscribing
  valueRef.current = value;

  // Track whether the change is from server (skip PUT)
  const isFromServerRef = useRef(false);
  // Conta le modifiche LOCALI (solo `setValue`, mai le scritture che arrivano
  // dal server). Serve alla fetch di mount qui sotto per accorgersi che
  // l'utente ha cambiato il valore MENTRE lei era in volo.
  const localWritesRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  /**
   * Applica un valore che arriva dal SERVER (idratazione di mount, WS, altra
   * tab), alzando il flag che dice all'effetto di PUT «questo non è tuo, non
   * rimandarlo indietro».
   *
   * Il controllo di uguaglianza NON è un'ottimizzazione, chiude un guasto:
   * quando il valore in arrivo è identico a quello corrente React salta il
   * re-render, quindi l'effetto di PUT non gira e non consuma mai il flag, che
   * resta alzato. La PROSSIMA modifica dell'utente entra nell'effetto, trova il
   * flag di qualcun altro, lo abbassa e ESCE: niente scrittura su localStorage,
   * niente PUT. Sintomo: il primo click sul tema dopo il caricamento cambia
   * l'aspetto ma non viene salvato da nessuna parte, e al reload torna indietro.
   * (Con gli oggetti il riferimento è sempre nuovo, quindi il caso si vede solo
   * sulle primitive — cioè su `theme` e `claude-prefs-skip`, le uniche due
   * chiavi che passano di qui.)
   */
  const applyFromServer = useCallback((incoming: unknown) => {
    if (localStorageKey) {
      try { localStorage.setItem(localStorageKey, JSON.stringify(incoming)); } catch {}
    }
    if (Object.is(valueRef.current, incoming)) return;
    isFromServerRef.current = true;
    setValueRaw(incoming as T);
  }, [localStorageKey]);

  // Fetch from server on mount
  // PANE-01-ALLOWED: generic non-pane ui-state key. The server
  // GET /api/ui-state/:key endpoint returns { value, payload_version, server_seq } // PANE-01-ALLOWED
  // as of migration 012; unwrap .value for the legacy consumer shape.
  useEffect(() => {
    // Fotografia del contatore PRIMA della fetch: se al ritorno è cambiato,
    // l'utente ha scelto qualcosa nel frattempo e la sua scelta vince.
    const writesAtStart = localWritesRef.current;
    // Coalesced: `claude-prefs-skip` is read by App, every project window and
    // the add-menu, all mounting in the same frame — five GETs of one value.
    coalescedFetch(`/api/ui-state/${encodeURIComponent(key)}`, undefined, { ttlMs: BOOT_READ_TTL_MS }) // PANE-01-ALLOWED: generic non-pane key supplied by caller
      .then(r => r.ok ? r.json() : null)
      .then(envelope => {
        // PANE-01-ALLOWED: unwrap v2 envelope { value, payload_version, server_seq }
        const serverValue = envelope && typeof envelope === 'object' && 'value' in envelope ? (envelope as { value: unknown }).value : envelope;
        if (!mountedRef.current || serverValue === null || serverValue === undefined) return;
        // L'idratazione di mount NON deve calpestare una scelta fatta mentre
        // era in volo. Apri l'app, clicca il tema entro i primi millisecondi:
        // la risposta arrivava dopo, faceva `setValueRaw(valoreDelServer)` e
        // riscriveva anche il localStorage — il tema tornava indietro da solo.
        // Prima non si vedeva perché per `theme` il server rispondeva SEMPRE
        // null: la sua PUT era rifiutata con 400 (vedi ui-state.scalar.test.ts),
        // quindi non c'era niente da idratare. Chiuso quel buco, la corsa è
        // diventata raggiungibile — e infatti ha fatto cadere CMD-03.
        if (localWritesRef.current !== writesAtStart) return;
        applyFromServer(serverValue);
      })
      .catch(() => {});
  }, [key, localStorageKey, applyFromServer]);

  // WS listener
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: WSMessage) => {
      // The server-side store is opaque to the type system; this hook is
      // typed generic on `T` per-key. The cast inside applyFromServer is the
      // cost of having a single dispatcher route every keyed value type
      // through one WSMessage variant — alternative is one variant per key.
      if (msg.type === 'ui-state:updated' && msg.key === key) applyFromServer(msg.value);
      if (msg.type === 'ui-state:init' && msg.data && key in msg.data) applyFromServer(msg.data[key]);
    });
  }, [key, onMessage, applyFromServer]);

  // Cross-tab sync via storage events (same browser, no server roundtrip)
  useEffect(() => {
    if (!localStorageKey) return;
    const handler = (e: StorageEvent) => {
      if (e.key !== localStorageKey || !e.newValue) return;
      try {
        applyFromServer(JSON.parse(e.newValue));
      } catch {}
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [localStorageKey, applyFromServer]);

  // Debounced PUT to server on local change
  useEffect(() => {
    if (isFromServerRef.current) {
      isFromServerRef.current = false;
      return;
    }

    // Write localStorage immediately
    if (localStorageKey) {
      try { localStorage.setItem(localStorageKey, JSON.stringify(value)); } catch {}
    }

    // Debounce server PUT
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      // PANE-01-ALLOWED: generic non-pane key (supplied by caller). Pane state uses dedicated middleware, not this hook.
      fetch(`/api/ui-state/${encodeURIComponent(key)}`, { // PANE-01-ALLOWED
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      }).catch(() => {});
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [value, key, localStorageKey, debounceMs]);

  const setValue = useCallback((updater: T | ((prev: T) => T)) => {
    localWritesRef.current++;
    setValueRaw(updater);
  }, []);

  return [value, setValue];
}
