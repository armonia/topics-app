/**
 * La fast mode di Claude Code — quella VERA, non un modello più economico.
 *
 * Che cos'è: la CLI tiene lo stesso modello (Opus) e ne accelera l'uscita, a un
 * prezzo diverso. Si accende con `/fast [on|off]`, e la CLI la RACCONTA da sola:
 * ogni evento `system/init` e ogni `result` portano `fast_mode_state` e, quando
 * qualcosa la blocca, `fast_mode_disabled_reason`. Questo modulo legge quei due
 * campi e basta: nessuna deduzione nostra, nessuna copia della sua politica.
 *
 * Perché non la si può accendere QUI, oggi (misurato sulla 2.1.223, non
 * ipotizzato): le chat di Topics girano `claude --print --input-format
 * stream-json`, cioè la via Agent SDK, e in quella via la CLI risponde
 *
 *     fast_mode_state = off · fast_mode_disabled_reason = sdk_opt_in_required
 *     /fast on → «Fast mode unavailable: Fast mode is not available in the Agent SDK»
 *
 * Il cancello dentro il binario è `if (isSdk && … && !flagSettings.fastMode)
 * return "sdk_opt_in_required"`: si apre solo con un flag che arriva dal server
 * di Anthropic. Non esiste un `--fast`, e l'unica variabile d'ambiente in tema
 * (`CLAUDE_CODE_DISABLE_FAST_MODE`) serve a spegnerla.
 *
 * Da qui la regola di casa: il toggle non fa MAI qualcosa d'altro sotto lo
 * stesso nome (prima scambiava il modello con haiku, che è l'opposto di «stesso
 * modello, più veloce»). Dice la verità della CLI, e il giorno che quel flag si
 * apre manda `/fast on` e segue lo stato che la CLI riporta.
 */

/**
 * Il listino della fast mode, USD per 1M token. Non è dedotto: lo scrive la
 * CLI stessa, nel testo di migrazione che porta dentro il binario 2.1.223 —
 *
 *   «Fast mode on {{OPUS_NAME}} is priced at $10 / $50 per MTok. Fast mode runs
 *    the same model at up to 2.5x higher output tokens per second, at premium
 *    pricing.»
 *
 * Contro i 5$/25$ di Opus standard fa esattamente 2× su input E su output: un
 * numero solo, senza medie da spiegare. È il numero che il composer mostra
 * sotto il ⚡ — «più veloce» da solo non è un'informazione finché non dici
 * quanto costa.
 *
 * Il guadagno di velocità (fino a 2,5× token/s in uscita) resta una frase, non
 * una costante: non entra in nessun calcolo, e a scriverla nel tooltip è il
 * client. Un numero esportato che nessuno importa è codice morto travestito da
 * documentazione — la documentazione è questa.
 */
export const FAST_MODE_PRICING = { input: 10, output: 50 } as const;

/**
 * Il moltiplicatore di costo della fast mode su `model`, o `null` se su quel
 * modello la fast mode non esiste.
 *
 * Esiste solo sulla famiglia Opus (la CLI: «available on Opus 5/4.8», e il suo
 * enum ha un `model_not_allowed` per gli altri). Il rapporto si CALCOLA dai due
 * listini invece di scrivere «2» a mano: il giorno che uno dei due cambia, il
 * numero mostrato cambia con lui — una costante scritta a mano no.
 */
export function fastModeMultiplier(
  model: string | null | undefined,
  priceOf: (m: string) => { input: number; output: number } | null,
): number | null {
  if (!model || !/opus/i.test(model)) return null;
  const std = priceOf(model);
  if (!std || std.output <= 0) return null;
  return FAST_MODE_PRICING.output / std.output;
}

/** Gli stati che la CLI dichiara. `cooldown` = in pausa dopo un rate limit. */
export type FastModeState = "off" | "on" | "cooldown";

/**
 * I motivi per cui la fast mode non può servire ADESSO, verbatim dall'enum
 * della CLI. Assente = niente la blocca (una richiesta può comunque scegliere
 * la velocità normale).
 */
export type FastModeReason =
  | "free"
  | "preference"
  | "extra_usage_disabled"
  | "network_error"
  | "unknown"
  | "not_first_party"
  | "disabled_by_env"
  | "model_not_allowed"
  | "sdk_opt_in_required"
  | "pending";

export interface FastModeStatus {
  state: FastModeState;
  /** `null` quando niente la blocca. */
  reason: FastModeReason | null;
}

/** Quello che il client riceve: stato + prezzo, in un pezzo solo. */
export interface FastModeInfo extends FastModeStatus {
  /** 2 = costa il doppio. `null` se su questo modello la fast mode non c'è. */
  costMultiplier: number | null;
}

const STATES = new Set<string>(["off", "on", "cooldown"]);
const REASONS = new Set<string>([
  "free", "preference", "extra_usage_disabled", "network_error", "unknown",
  "not_first_party", "disabled_by_env", "model_not_allowed", "sdk_opt_in_required", "pending",
]);

/**
 * Legge lo stato da un evento della CLI (`system/init` o `result`). `null` se
 * l'evento non ne parla — che NON è «spenta»: è «non lo so», e chi rende deve
 * distinguerli (un bottone spento per ignoranza è un bottone rotto).
 *
 * Uno stato fuori enum viene ignorato invece di essere inoltrato: se la CLI
 * introduce un valore nuovo, il client non deve doverlo indovinare.
 */
export function readFastMode(event: unknown): FastModeStatus | null {
  if (!event || typeof event !== "object") return null;
  const e = event as { fast_mode_state?: unknown; fast_mode_disabled_reason?: unknown };
  if (typeof e.fast_mode_state !== "string" || !STATES.has(e.fast_mode_state)) return null;
  const raw = e.fast_mode_disabled_reason;
  const reason = typeof raw === "string" && REASONS.has(raw) ? (raw as FastModeReason) : null;
  return { state: e.fast_mode_state as FastModeState, reason };
}

/**
 * Si può accendere? Il criterio è quello scritto nella CLI: il motivo è
 * «perché non può servire adesso», quindi motivo assente = niente la blocca.
 *
 * `null` (non lo sappiamo ancora, nessuna sessione ha parlato) NON è
 * «indisponibile»: torna `true`, così il bottone resta vivo finché non c'è una
 * ragione VERA per spegnerlo.
 */
export function fastModeAvailable(status: FastModeStatus | null | undefined): boolean {
  if (!status) return true;
  return status.reason === null;
}

/** Sono cambiati davvero? Serve a non ri-emettere snapshot identici. */
export function sameFastMode(a: FastModeStatus | null, b: FastModeStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.state === b.state && a.reason === b.reason;
}

/**
 * Il comando da mandare per portare la sessione allo stato voluto, o `null` se
 * c'è già (o se non si può). Esplicito `on`/`off`: `/fast` nudo INVERTE, e un
 * comando che inverte non è idempotente — su una sessione riattaccata non
 * sapremmo da dove sta invertendo.
 */
export function fastModeCommand(current: FastModeStatus | null, want: boolean): string | null {
  if (!fastModeAvailable(current)) return null;
  if (!current) return null; // finché non l'ha detto lei, non le si parla
  const isOn = current.state !== "off";
  if (isOn === want) return null;
  return want ? "/fast on" : "/fast off";
}
