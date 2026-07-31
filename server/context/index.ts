/**
 * `server/context/` — canonical topic context module.
 *
 * Public surface (re-exported here):
 *   - `ContextEnvelope` — l'unico tipo che i consumatori del barile chiedono
 *     qui. Gli altri tipi dell'envelope si importano da `shared/context-envelope`
 *     (o da `./envelope`), che è dove sono dichiarati: ri-esportarli anche da
 *     qui creava una seconda porta d'ingresso che nessuno usava. Stessa regola
 *     per le funzioni: il barile ri-esporta SOLO ciò che qualcuno importa da
 *     qui. I costruttori di singoli blocchi (`browserInstructionContent`,
 *     `planModeContent`, `projectMarkersContent`, `topicSwitchContent`), i
 *     helper di test (`resetInlineSent`, `snapshotCounts`, `hashSlot`) e le
 *     costanti interne (`RING_SIZE`) si prendono dal loro modulo, che è già
 *     quello che fanno i chiamanti veri.
 *
 * Implementation modules added in subsequent commits:
 *   - `assemble.ts`           — assembleTopicContext()
 *   - `adapt.ts`              — adaptEnvelope()
 *   - `snapshots.ts`          — in-memory ring buffer
 *   - `provider-strategy.ts`  — getProviderStrategy()
 */

export type { ContextEnvelope } from "./envelope";

export { getProviderStrategy } from "./provider-strategy";

export { assembleTopicContext } from "./assemble";

export { adaptEnvelope, composeSystemMessages } from "./adapt";

export {
  getInlineSentState,
  inlineScope,
  markInlineSent,
  rekeyInlineSent,
} from "./inline-sent-state";

export { clearSnapshots, getSnapshots, pushSnapshot } from "./snapshots";
