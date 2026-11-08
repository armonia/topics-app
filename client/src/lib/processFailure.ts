import type { ScriptProcessInfo } from './api';

/**
 * Quando un processo concluso è un FALLIMENTO da segnalare.
 *
 * `status === 'error'` da solo non basta, ed è la differenza fra un segnale e
 * un allarme che si impara a ignorare. `-1` è il codice-sentinella di due casi
 * che non chiedono niente a nessuno:
 *
 * - **stop volontario** — chi ferma un processo sa di averlo fermato;
 * - **«è morto mentre il server era giù»** (`loadState` in
 *   `server/routes/processes.ts` riadotta così ogni pid che non risponde più).
 *   Su questa macchina, con `TOPICS_SERVER_WATCH=1`, succede a OGNI salvataggio
 *   sotto `server/`: ogni dev server vivo diventa `error`.
 *
 * Serve anche una finestra temporale: la lista `recent` è persistita su disco e
 * cappata a dieci voci globali, quindi senza limite un fallimento di ieri
 * terrebbe acceso il segnale per sempre.
 *
 * Vive qui, e non dentro un componente, perché i consumatori sono due — la
 * pastiglia rossa della rail collassata e la riga della lista processi — e due
 * copie della stessa soglia divergono al primo che la tocca.
 */
export const FAILURE_WINDOW_MS = 10 * 60 * 1000;

export function isRecentFailure(
  sp: Pick<ScriptProcessInfo, 'status' | 'exitCode' | 'completedAt'>,
  now: number = Date.now(),
): boolean {
  if (sp.status !== 'error') return false;
  if ((sp.exitCode ?? -1) <= 0) return false;
  if (!sp.completedAt) return false;
  const age = now - new Date(sp.completedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < FAILURE_WINDOW_MS;
}

/**
 * L'ultimo fallimento recente per nome di script, per marcare la riga giusta
 * nella lista. A parità di nome vince il più recente.
 */
export function lastFailureByScript(
  scripts: ScriptProcessInfo[],
  now: number = Date.now(),
): Map<string, ScriptProcessInfo> {
  const out = new Map<string, ScriptProcessInfo>();
  for (const sp of scripts) {
    if (!isRecentFailure(sp, now)) continue;
    const prev = out.get(sp.scriptName);
    if (!prev || (sp.completedAt ?? '') > (prev.completedAt ?? '')) out.set(sp.scriptName, sp);
  }
  return out;
}
