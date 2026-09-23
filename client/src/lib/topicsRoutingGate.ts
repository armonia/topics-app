/** AICTRL-05: il cancello dello switch, logica pura. ON verso un bersaglio non instradabile blocca il send finche' non lo si spegne: provider e modello non cambiano mai da soli. Lo chiamano ChatPane (gate) e ChatInput (banner) con lo stesso esito. allow-italian: contratto dello switch ON, prosa gia' italiana in tutto il modulo */
import type { ProviderSnapshotEntry, ProvidersSnapshot } from "../types";
import { resolveEffectiveProvider, type ProviderSelection } from "./effortTiers";
import { effectiveTopicsRouting, topicsRoutingAvailable } from "../../../shared/task-coding-models";

/** Lo switch del default BOARD: una board mai toccata (null) col dispatchModel legacy `topics:<model>` si legge ON, che un `!!` mostrava spenta. allow-italian: il difetto che questa funzione ripara */
export function boardTopicsRoutingEnabled(
  dispatchTopicsRouting: boolean | null | undefined,
  dispatchModel: string | null | undefined,
): boolean {
  return effectiveTopicsRouting(dispatchTopicsRouting, dispatchModel);
}

/** La cascata scelta locale > default board > prefisso legacy, per composer e cassetto: una funzione sola, perche' due copie divergono al primo cambio. `'auto'` non e' un modello e non porta nessun prefisso. allow-italian: ordine di risoluzione e trappola di `auto` */
export function surfaceTopicsRoutingEnabled(
  explicit: boolean | null | undefined,
  boardDefault: boolean | null | undefined,
  model: string | null | undefined,
  boardModel: string | null | undefined,
): boolean {
  const boardLegacy = boardModel && boardModel !== 'auto' ? boardModel : undefined;
  return effectiveTopicsRouting(explicit ?? boardDefault, model ?? boardLegacy);
}

/** La riga dello switch come la passa il pannello: stato canonico e un toggle che scrive SOLO il proprio asse, mai `dispatchModel`. allow-italian: la regola «un toggle, un asse» */
export function boardTopicsRoutingSwitch(
  settings: { dispatchTopicsRouting?: boolean | null; dispatchModel?: string | null },
  patch: (p: { dispatchTopicsRouting: boolean }) => void,
): { enabled: boolean; onToggle: (next: boolean) => void } {
  return {
    enabled: boardTopicsRoutingEnabled(settings.dispatchTopicsRouting, settings.dispatchModel),
    onToggle: (next) => { patch({ dispatchTopicsRouting: next }); },
  };
}

/** Il bersaglio VERO dello switch, che menu e send leggevano diverso. `null` = Automatico vero (nessun override, nessun pin): sempre instradabile, Topics sceglie da solo. Con override o pin vale l'ordine di `resolveEffectiveProvider`. allow-italian: cosa conta come «Automatico vero» */
export function resolveTopicsRoutingTarget(
  entries: ProviderSnapshotEntry[],
  override: ProviderSelection | null,
  defaultProviderLabel: string | undefined,
): ProviderSelection | null {
  if (!override && !defaultProviderLabel) return null;
  return resolveEffectiveProvider(entries, override, defaultProviderLabel);
}

export function topicsRoutingBlocked(
  topicsRouting: boolean | null | undefined,
  override: ProviderSelection | null,
  defaultProviderLabel: string | undefined,
  snapshot: ProvidersSnapshot | null,
): boolean {
  if (!topicsRouting) return false;
  const target = resolveTopicsRoutingTarget(snapshot?.providers ?? [], override, defaultProviderLabel);
  return !topicsRoutingAvailable(target?.provider ?? null, target?.model ?? null, snapshot);
}
