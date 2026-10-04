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
import type { ApiProviderName } from '../../../../shared/api-provider-credentials';

/** The status dot, the same colour for the same state in the selector and in
 *  the providers level (model selector revision 2026-10-04, §4.4). */
export const STATUS_COLORS: Record<ProviderStatus, string> = {
  ready: 'bg-emerald-600 dark:bg-emerald-400',
  unavailable: 'bg-zinc-400 dark:bg-zinc-500',
  error: 'bg-red-600 dark:bg-red-400',
  loading: 'bg-blue-600 dark:bg-blue-400 animate-pulse motion-reduce:animate-none',
};

/** The active ink of the selector and of the providers level (revision §4.4):
 *  4.5:1 on the popover in both themes. */
export const ACTIVE_INK = 'text-blue-800 dark:text-blue-300';

/** Il valore sentinella delle tendine della scheda: «Auto» non è una scelta, è
 *  l'assenza di override — cancella il valore salvato e lascia vincere la env
 *  var (o il default interno). */
export const AUTO = '__auto__';

/** Setup metadata, never a substitute for a registered provider snapshot. */
export const API_PROVIDERS = {
  openai: { label: 'OpenAI API', placeholder: 'sk-...', requirement: 'OPENAI_API_KEY' },
  claude: { label: 'Claude API', placeholder: 'sk-ant-...', requirement: 'ANTHROPIC_API_KEY' },
} as const;

export type { ApiProviderName } from '../../../../shared/api-provider-credentials';

export function isApiProvider(name: string): name is ApiProviderName {
  return Object.hasOwn(API_PROVIDERS, name);
}

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

/**
 * «12 s fa», «3 min fa»: the freshness of a snapshot entry as a DISTANCE, in
 * the reader's language (`Intl.RelativeTimeFormat`, §7 of the revision). An
 * absolute timestamp would make the reader do the subtraction.
 */
export function relativeTime(iso: string, locale: string, now: number = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' });
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return format.format(-sec, 'second');
  const min = Math.floor(sec / 60);
  if (min < 60) return format.format(-min, 'minute');
  const hr = Math.floor(min / 60);
  if (hr < 24) return format.format(-hr, 'hour');
  return format.format(-Math.floor(hr / 24), 'day');
}
