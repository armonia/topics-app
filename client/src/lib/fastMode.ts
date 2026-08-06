/**
 * Il bottone ⚡ dice la verità della CLI, e nient'altro.
 *
 * La fast mode di Claude Code tiene lo stesso modello e ne accelera l'uscita.
 * Il toggle NON scambia il modello — lo faceva, e sotto lo stesso nome faceva
 * una cosa opposta: chi lo accendeva per andare più veloce si ritrovava un
 * modello più debole (haiku al posto di opus).
 *
 * Lo stato arriva dallo snapshot dei provider, dove il server ricopia i due
 * campi che la CLI dichiara in ogni `system/init` e in ogni `result`
 * (`fast_mode_state`, `fast_mode_disabled_reason`). Vedi
 * `server/providers/fast-mode.ts` per il perché oggi, nelle chat, il motivo è
 * sempre `sdk_opt_in_required`.
 */
import type { ProvidersSnapshot } from '../types';

export interface FastModeUi {
  /** Si può accendere? Un motivo presente = qualcosa la blocca adesso. */
  available: boolean;
  /** `on` / `cooldown` = la CLI la sta servendo (o è in pausa dopo un limite). */
  state: 'off' | 'on' | 'cooldown';
  /** La frase da mostrare, già in italiano. */
  title: string;
  /** Il bottone va disegnato acceso? Mai, se non si può: sarebbe una bugia. */
  pressed: boolean;
}

/**
 * Le ragioni, con le parole della CLI tradotte una a una. Nessuna frase
 * generica: un «non disponibile» senza il perché manda l'utente a cercare un
 * guasto che non c'è.
 */
const REASON_TEXT: Record<string, string> = {
  sdk_opt_in_required:
    "Fast mode non è disponibile nell'Agent SDK — ed è così che Topics lancia la CLI per le chat.",
  not_first_party: 'Fast mode è disponibile solo usando l’API Anthropic diretta.',
  model_not_allowed: 'Il modello di questa chat non è fra quelli permessi dalla tua organizzazione.',
  disabled_by_env: "Fast mode è spenta dall'ambiente in cui gira la CLI.",
  extra_usage_disabled: 'Fast mode è spenta: i crediti extra sono disabilitati.',
  free: 'Fast mode non è inclusa in questo piano.',
  preference: 'Fast mode è spenta nelle preferenze di Claude Code.',
  network_error: 'Non riesco a verificare la disponibilità della fast mode (rete).',
  pending: 'Sto verificando se la fast mode è disponibile…',
  unknown: 'Fast mode non è disponibile.',
};

export function fastModeReasonText(reason: string): string {
  return REASON_TEXT[reason] ?? REASON_TEXT.unknown;
}

/**
 * Che cosa mostrare sul bottone. `providerOverride` decide da quale riga dello
 * snapshot leggere: la fast mode è un fatto del provider che serve QUESTA chat.
 *
 * Quando lo snapshot non dice niente (nessuna sessione ha ancora parlato, o un
 * provider che non ne ha il concetto) il bottone resta VIVO: «non lo so» non è
 * «non si può», e spegnere un comando per ignoranza è il modo più veloce per
 * farlo sembrare rotto.
 */
export function fastModeUi(args: {
  snapshot: ProvidersSnapshot | null;
  providerOverride?: { provider: string; model: string } | null;
  /** Il flag della topic: quello che l'utente ha chiesto. */
  requested: boolean;
}): FastModeUi {
  const { snapshot, providerOverride, requested } = args;
  const providerName = providerOverride?.provider ?? snapshot?.defaultProvider ?? null;
  const entry = providerName ? snapshot?.providers.find((p) => p.name === providerName) : undefined;
  const status = entry?.fastMode ?? null;

  const available = !status?.reason;
  const state = status?.state ?? 'off';

  if (!available) {
    return { available: false, state, title: fastModeReasonText(status!.reason!), pressed: false };
  }
  if (state === 'cooldown') {
    return {
      available: true,
      state,
      title: 'Fast mode in pausa dopo un limite di frequenza: riprende da sola.',
      pressed: true,
    };
  }
  return {
    available: true,
    state,
    title: requested
      ? 'Fast mode ON: stesso modello, uscita più rapida.'
      : 'Fast mode OFF: premi per chiederla su questa chat.',
    pressed: requested,
  };
}
