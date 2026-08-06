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
  /** `on` / `cooldown` = la CLI la sta servendo (o è in pausa dopo un limite). */
  state: 'off' | 'on' | 'cooldown';
  /** La frase da mostrare, già in italiano. */
  title: string;
  /** Il bottone va disegnato acceso? */
  pressed: boolean;
  /** Quanto costa rispetto alla velocità normale (2 = il doppio), o `null`. */
  costMultiplier: number | null;
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
 * Che cosa mostrare sul bottone, o `null` per NON mostrarlo affatto.
 *
 * Se la fast mode non è servibile il bottone non esiste: un comando spento con
 * accanto la spiegazione del perché è comunque una cosa che occupa spazio e non
 * si può usare. Il motivo resta a disposizione di chi indaga
 * (`fastModeReasonText`), non della riga di icone.
 *
 * `providerOverride` decide da quale riga dello snapshot leggere: la fast mode
 * è un fatto del provider che serve QUESTA chat.
 *
 * Quando lo snapshot non dice niente — nessuna sessione ha ancora parlato — il
 * bottone RESTA: «non lo so» non è «non si può», e farlo sparire per ignoranza
 * lo farebbe lampeggiare via al primo evento.
 */
export function fastModeUi(args: {
  snapshot: ProvidersSnapshot | null;
  providerOverride?: { provider: string; model: string } | null;
  /** Il flag della topic: quello che l'utente ha chiesto. */
  requested: boolean;
}): FastModeUi | null {
  const { snapshot, providerOverride, requested } = args;
  const providerName = providerOverride?.provider ?? snapshot?.defaultProvider ?? null;
  const entry = providerName ? snapshot?.providers.find((p) => p.name === providerName) : undefined;
  const status = entry?.fastMode ?? null;

  if (status?.reason) return null; // non servibile → non c'è
  const state = status?.state ?? 'off';

  // Il prezzo vale per il modello che serve QUESTA chat: se ne è stato fissato
  // uno fuori dalla famiglia Opus, la fast mode lì non esiste e il numero non
  // si mostra (l'autorità resta la CLI, che risponderebbe `model_not_allowed`).
  const pinned = providerOverride?.model;
  const applies = !pinned || /opus/i.test(pinned);
  const costMultiplier = applies ? status?.costMultiplier ?? null : null;
  const prezzo = costMultiplier ? ` Costa ${costMultiplier}× lo stesso modello a velocità normale.` : '';

  if (state === 'cooldown') {
    return {
      state,
      title: `Fast mode in pausa dopo un limite di frequenza: riprende da sola.${prezzo}`,
      pressed: true,
      costMultiplier,
    };
  }
  return {
    state,
    title: (requested
      ? 'Fast mode ON: stesso modello, fino a 2,5× più veloce in uscita.'
      : 'Fast mode OFF: premi per chiederla su questa chat.') + prezzo,
    pressed: requested,
    costMultiplier,
  };
}
