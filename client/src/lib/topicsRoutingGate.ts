/** AICTRL-05 + MSEL-06: lo switch lato client, logica pura. Ogni lettura passa da `topicsRoute` (shared/task-coding-models.ts): un bersaglio che il motore non raggiunge va diretto e la strada si dichiara, l'invio non si blocca piu'. allow-italian: contratto dello switch, prosa gia' italiana in tutto il modulo */
import type { ProviderSnapshotEntry, ProvidersSnapshot } from "../types";
import { resolveEffectiveProvider, type ProviderSelection } from "./effortTiers";
import { effectiveTopicsRouting, topicsRoute, type TopicsRoute } from "../../../shared/task-coding-models";

/** Lo switch del default BOARD: una board mai toccata (null) col dispatchModel legacy `topics:<model>` si legge ON, che un `!!` mostrava spenta. allow-italian: il difetto che questa funzione ripara */
export function boardTopicsRoutingEnabled(
  dispatchTopicsRouting: boolean | null | undefined,
  dispatchModel: string | null | undefined,
): boolean {
  return effectiveTopicsRouting(dispatchTopicsRouting, dispatchModel, 'task');
}

/** La cascata scelta locale > default board > prefisso legacy, per composer e cassetto: una funzione sola, perche' due copie divergono al primo cambio. `'auto'` non e' un modello e non porta nessun prefisso. allow-italian: ordine di risoluzione e trappola di `auto` */
export function surfaceTopicsRoutingEnabled(
  explicit: boolean | null | undefined,
  boardDefault: boolean | null | undefined,
  model: string | null | undefined,
  boardModel: string | null | undefined,
): boolean {
  const boardLegacy = boardModel && boardModel !== 'auto' ? boardModel : undefined;
  return effectiveTopicsRouting(explicit ?? boardDefault, model ?? boardLegacy, 'task');
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

/** The board settings a card is judged with: its own board's, never the
 *  pane's. The all-boards view lists every board's cards while a project pane
 *  holds its own board's settings, so a card of another board waits for that
 *  board's (`fetched`); until then its default is unknown (null), as on the
 *  global board. */
export function cardBoardSettings<T>(
  cardBoardId: string | null | undefined,
  paneBoardId: string,
  paneSettings: T | null,
  fetched: { projectId: string; settings: T } | null,
): T | null {
  if (!cardBoardId || cardBoardId === paneBoardId) return paneSettings;
  return fetched?.projectId === cardBoardId ? fetched.settings : null;
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

/** MSEL-06: the route of a chat turn, as the selector band and the chip show it.
 *  Automatic with no pin is the snapshot's default, resolved BEFORE the route,
 *  as the server resolver does (`resolveTopicProvider`). */
export function chatTopicsRoute(
  topicsRouting: boolean | null | undefined,
  override: ProviderSelection | null,
  defaultProviderLabel: string | undefined,
  snapshot: ProvidersSnapshot | null,
): TopicsRoute {
  const target = resolveTopicsRoutingTarget(snapshot?.providers ?? [], override, defaultProviderLabel);
  return topicsRoute(
    topicsRouting,
    target ?? { provider: snapshot?.defaultProvider ?? null, model: null },
    snapshot,
    'chat',
  );
}

/** The one send the switch still refuses: a legacy chat pinned to the engine
 *  itself (`provider: "topics"`, AICTRL-04) while the engine is down, where
 *  no "direct" exists. Every other target runs direct (MSEL-06). */
export function topicsRoutingBlocked(
  topicsRouting: boolean | null | undefined,
  override: ProviderSelection | null,
  defaultProviderLabel: string | undefined,
  snapshot: ProvidersSnapshot | null,
): boolean {
  if ((override?.provider ?? defaultProviderLabel) !== 'topics') return false;
  return topicsRoute(topicsRouting, { provider: 'topics', model: override?.model ?? null }, snapshot, 'chat').via !== 'topics';
}
