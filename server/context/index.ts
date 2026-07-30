/**
 * `server/context/` — canonical topic context module.
 *
 * Public surface (re-exported here):
 *   - `ContextEnvelope` — l'unico tipo che i consumatori del barile chiedono
 *     qui. Gli altri tipi dell'envelope si importano da `shared/context-envelope`
 *     (o da `./envelope`), che è dove sono dichiarati: ri-esportarli anche da
 *     qui creava una seconda porta d'ingresso che nessuno usava.
 *
 * Implementation modules added in subsequent commits:
 *   - `assemble.ts`           — assembleTopicContext()
 *   - `adapt.ts`              — adaptEnvelope()
 *   - `snapshots.ts`          — in-memory ring buffer
 *   - `provider-strategy.ts`  — getProviderStrategy()
 */

export type { ContextEnvelope } from "./envelope";

export { getProviderStrategy } from "./provider-strategy";

export {
  assembleTopicContext,
  browserInstructionContent,
  planModeContent,
  projectMarkersContent,
  topicSwitchContent,
} from "./assemble";

export { adaptEnvelope, composeSystemMessages, composeSystemSlots } from "./adapt";

export {
  getInlineSentState,
  hashSlot,
  inlineScope,
  markInlineSent,
  rekeyInlineSent,
  resetInlineSent,
} from "./inline-sent-state";

export {
  RING_SIZE,
  clearSnapshots,
  getSnapshots,
  pushSnapshot,
  snapshotCounts,
} from "./snapshots";
