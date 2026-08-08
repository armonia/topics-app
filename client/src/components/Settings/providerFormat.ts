/**
 * Le costanti e il formattatore della scheda «AI Providers», fuori dal file
 * del componente.
 *
 * Stanno qui per la stessa ragione di `nightModeText.ts`: un modulo che esporta
 * un componente E altro spegne il fast refresh di Vite, quindi ogni salvataggio
 * rimonterebbe la scheda invece di aggiornarla. Non vanno ri-esportate da
 * `AIProvidersSection.tsx` — una ri-esportazione riporterebbe il modulo misto
 * esattamente com'era.
 */
import type { ProviderStatus } from '../../types';

/** Il pallino accanto al nome del provider. */
export const STATUS_COLORS: Record<ProviderStatus, string> = {
  ready: 'bg-green-500',
  loading: 'bg-yellow-500',
  error: 'bg-red-500',
  unavailable: 'bg-gray-400',
};

/** Lo stato a parole. `unavailable` è «not set up», non «errore»: mancano i
 *  requisiti, non è rotto. */
export const STATUS_LABELS: Record<ProviderStatus, string> = {
  ready: 'ready',
  loading: 'loading…',
  error: 'error',
  unavailable: 'not set up',
};

/** Il valore sentinella delle tendine della scheda: «Auto» non è una scelta, è
 *  l'assenza di override — cancella il valore salvato e lascia vincere la env
 *  var (o il default interno). */
export const AUTO = '__auto__';

/** I campi di `app_settings` che portano il modello di default di un provider. */
export type ProviderModelField = 'claudeModel' | 'openaiModel' | 'codexModel';

/**
 * Quale campo di `app_settings` è il «modello di default» di ogni provider.
 *
 * È la tabella che rende il modello un controllo della RIGA del provider invece
 * che un'impostazione globale senza padrone. Chi non è qui dentro non ha una
 * colonna (openclaw e gli agenti ACP): il modello lo decide l'altro capo, e una
 * tendina che scrive su una colonna inesistente sarebbe una scrittura morta.
 *
 * `claude` e `claude-code` puntano allo STESSO campo, e non è una svista: sul
 * server `resolveClaudeModel` (services/app-settings.ts) e `resolveClaudeCodeModel`
 * (providers/index.ts) leggono entrambi `settings.claudeModel` — è la colonna
 * canonica dietro `CLAUDE_MODEL`. Quando tutti e due i provider sono registrati
 * la scheda lo DICE, invece di lasciar credere che siano due tendine separate.
 */
export const PROVIDER_MODEL_FIELD: Record<string, ProviderModelField> = {
  claude: 'claudeModel',
  'claude-code': 'claudeModel',
  openai: 'openaiModel',
  codex: 'codexModel',
};

/** «2m ago» — la freschezza dello snapshot come DISTANZA, che è come la si
 *  legge: un timestamp assoluto obbligherebbe a fare la sottrazione a mente. */
export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  if (ms < 1500) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
