/**
 * `server/context/` — canonical topic context module.
 *
 * Public surface (re-exported here):
 *   - Types from `envelope.ts`
 *
 * Implementation modules added in subsequent commits:
 *   - `assemble.ts`           — assembleTopicContext()
 *   - `adapt.ts`              — adaptEnvelope()
 *   - `snapshots.ts`          — in-memory ring buffer
 *   - `provider-strategy.ts`  — getProviderStrategy()
 */

export type {
  ContextDiagnostics,
  ContextEnvelope,
  HistoryEntryDiagnostic,
  HistoryExcludeReason,
  ProviderContextStrategy,
  ProviderPayload,
  SessionMeta,
  SystemBlock,
  SystemBlockCategory,
} from "./envelope";

export { getProviderStrategy } from "./provider-strategy";

export {
  assembleTopicContext,
  browserInstructionContent,
  planModeContent,
  projectMarkersContent,
  topicSwitchContent,
} from "./assemble";
export type { AssembleArgs } from "./assemble";

export { adaptEnvelope, composeSystemMessages } from "./adapt";

export {
  RING_SIZE,
  clearSnapshots,
  getSnapshots,
  pushSnapshot,
  snapshotCounts,
} from "./snapshots";
