import { useMemo } from 'react';
import { shellProcessKey } from '../../../shared/background-shell-registry';
import { useScripts } from './useScripts';
import type { ScriptProcessInfo } from '../lib/api';

/**
 * Lo stato VIVO del processo che un `wait_for_process` sta aspettando.
 *
 * La card di un'attesa, senza questo, mostrerebbe lo scatto del momento in cui
 * il tool ha risposto: e il caso piu' interessante e' proprio quello in cui la
 * risposta e' «ancora vivo». Il registro dei processi sa com'e' andata a
 * finire, e la stessa lista che disegna il pannello Processi risponde anche
 * qui: `useScripts` e' un singleton, N card pagano UN poll.
 *
 * Quando il processo non risulta al registro — chat riaperta dopo un riavvio,
 * id di una sessione diversa — si torna `known: false` e la card resta il
 * ricordo che era, senza inventare uno stato.
 */
export interface LiveWaitedProcess {
  known: boolean;
  status: 'running' | 'done' | 'error' | null;
  exitCode?: number;
  scriptName?: string;
  /** Quando il processo e' partito: e' l'ancora del cronometro della card. */
  startedAt?: string;
  /** Quando e' finito: ferma il cronometro sul tempo VERO invece che su
   *  «adesso», che per una chat riaperta domani sarebbe un numero assurdo. */
  completedAt?: string;
}

const IDLE: LiveWaitedProcess = { known: false, status: null };

/**
 * Quale voce del registro e' IL processo di questa card.
 *
 * Prima l'id di processo, che e' unico. Poi la traduzione dell'id di una shell
 * in background nella sua chiave (sessione + id): l'agente puo' passare l'uno o
 * l'altra, la rotta accetta entrambi, e la card deve saper ritrovare la riga
 * nello stesso modo. A parita' di chiave vince la voce viva: lo stesso processo
 * compare due volte, vivo e poi fra i «recenti».
 */
export function pickWaitedEntry(
  scripts: ScriptProcessInfo[],
  id: string | undefined,
  sessionKey?: string,
): ScriptProcessInfo | undefined {
  if (!id) return undefined;
  const byId = scripts.filter(s => s.processId === id);
  if (byId.length) return byId.find(s => s.status === 'running') ?? byId[0];
  if (sessionKey) {
    const key = shellProcessKey(sessionKey, id);
    const byShell = scripts.filter(s => s.processId === key);
    if (byShell.length) return byShell.find(s => s.status === 'running') ?? byShell[0];
  }
  return undefined;
}

export function useWaitedProcess(processId: string | undefined, sessionKey?: string): LiveWaitedProcess {
  const { allScripts } = useScripts();
  const entry = useMemo(
    () => pickWaitedEntry(allScripts, processId, sessionKey),
    [allScripts, processId, sessionKey],
  );
  if (!entry) return IDLE;
  return {
    known: true,
    status: entry.status,
    ...(entry.exitCode != null ? { exitCode: entry.exitCode } : {}),
    scriptName: entry.scriptName,
    startedAt: entry.startedAt,
    ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
  };
}
